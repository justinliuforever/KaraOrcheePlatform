import { Router } from "express";
import multer from "multer";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ilike, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireAdmin, audit } from "../admin";
import { books, pieces, pieceVersions, studioJobs } from "../db/schema";
import { rebuildCatalog, type BundleFile } from "../catalog_build";
import { pieceSlug, bookSlug } from "../slug";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 2 },
});

// Both files are mandatory in the wizard: professional notation software exports
// MusicXML and MIDI from the same project, and the alignment gate cross-verifies
// them. (The worker's XML-only route survives for CLI/edge use, not the wizard.)
const metadataSchema = z
  .object({
    title: z.string().min(1).max(200),
    composer: z.string().min(1).max(120),
    subtitle: z.string().max(200).default(""),
    mode: z.literal("solo").default("solo"), // concerto needs stems; out of studio scope
    difficulty: z.number().int().min(1).max(5).nullable().default(null),
    tracking: z.enum(["validated", "experimental"]).default("experimental"),
    rights: z.enum(["public_domain", "licensed", "unknown"]), // required — no default
    rightsNote: z.string().max(2000).default(""),
    book: z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9_]{2,63}$/),
        title: z.string().max(200).optional(),
        index: z.number().int().min(0).nullable().default(null),
      })
      .nullable()
      .default(null),
  })
  .superRefine((v, ctx) => {
    if (v.rights === "public_domain" && !v.rightsNote.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rightsNote"],
        message: "public-domain pieces need a provenance note (which edition the score came from)",
      });
    }
  });
export type StudioMetadata = z.infer<typeof metadataSchema>;

const patchSchema = z.object({
  title: z.string().max(200).optional(),
  composer: z.string().max(120).optional(),
  subtitle: z.string().max(200).optional(),
  difficulty: z.number().int().min(1).max(5).nullable().optional(),
  tracking: z.enum(["validated", "experimental"]).optional(),
  rights: z.enum(["public_domain", "licensed", "unknown"]).optional(),
  rightsNote: z.string().max(2000).optional(),
  book: z
    .object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_]{2,63}$/),
      title: z.string().max(200).optional(),
      index: z.number().int().min(0).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const checksSchema = z.object({
  title: z.string().optional(),
  composer: z.string().optional(),
  subtitle: z.string().optional(),
  book: z
    .object({
      id: z.string().optional(), // existing book selected
      title: z.string().optional(), // creating a new book
      index: z.number().int().min(0).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const XML_EXT = /\.(musicxml|xml|mxl)$/i;
const MIDI_EXT = /\.(mid|midi)$/i;
const PUBLISHABLE_RIGHTS = new Set(["public_domain", "licensed"]);

function safeName(original: string): string {
  const base = original.split("/").pop()!.split("\\").pop()!;
  return base.replace(/[^A-Za-z0-9._-]/g, "_");
}

interface SourceEntry {
  kind: "musicxml" | "midi";
  path: string;
  bytes: number;
  sha256: string;
  originalName: string;
}

export function studioRouter(deps: Deps): Router {
  const router = Router();
  router.use("/admin/studio", requireAuth(deps.auth), requireAdmin(deps));

  async function uploadSources(
    jobId: string,
    files: Record<string, Express.Multer.File[]> | undefined,
  ): Promise<SourceEntry[] | { error: string }> {
    const musicxml = files?.musicxml?.[0];
    const midi = files?.midi?.[0];
    if (!musicxml || !XML_EXT.test(musicxml.originalname)) {
      return { error: "musicxml_required" };
    }
    if (!midi || !MIDI_EXT.test(midi.originalname)) {
      return { error: "midi_required" };
    }
    const sources: SourceEntry[] = [];
    for (const [kind, file] of [
      ["musicxml", musicxml],
      ["midi", midi],
    ] as const) {
      const path = `staging/${jobId}/${safeName(file.originalname)}`;
      await deps.studio!.uploadSource(path, file.buffer, file.mimetype);
      sources.push({
        kind,
        path,
        bytes: file.size,
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
        originalName: file.originalname,
      });
    }
    return sources;
  }

  // Step-1 entry point: files only. Metadata arrives later via PATCH while the
  // preflight gates already run.
  router.post(
    "/admin/studio/drafts",
    upload.fields([
      { name: "musicxml", maxCount: 1 },
      { name: "midi", maxCount: 1 },
    ]),
    wrap(async (req, res) => {
      if (!deps.studio || !deps.piecesQueue) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const jobId = randomUUID();
      const uploaded = await uploadSources(
        jobId,
        req.files as Record<string, Express.Multer.File[]> | undefined,
      );
      if ("error" in uploaded) {
        res.status(400).json({ error: uploaded.error });
        return;
      }

      const [job] = await db
        .insert(studioJobs)
        .values({
          id: jobId,
          pieceId: `draft_${jobId.slice(0, 8)}`,
          status: "draft",
          checkStatus: "pending",
          metadata: {},
          sources: uploaded,
          createdBy: req.adminUser!.id,
        })
        .returning();

      await deps.piecesQueue.sendPreflight({ jobId });
      await audit(deps, req.adminUser!, "studio.draft.create", { type: "studio_job", id: jobId });
      res.status(201).json(job);
    }),
  );

  // A failed (or canceled) run goes BACK to draft on the same row — one board row per
  // piece, attempt history stays in audit_events. Sources are already staged; the
  // wizard reopens prefilled and preflight re-runs.
  router.post(
    "/admin/studio/jobs/:id/reopen",
    wrap(async (req, res) => {
      if (!deps.piecesQueue) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (job.status !== "failed" && job.status !== "canceled") {
        res.status(409).json({ error: "not_reopenable", status: job.status });
        return;
      }
      const [updated] = await db
        .update(studioJobs)
        .set({
          status: "draft",
          checkStatus: "pending",
          gates: {},
          artifacts: [],
          stage: null,
          error: null,
          updatedAt: sql`now()`,
        })
        .where(eq(studioJobs.id, id))
        .returning();
      await deps.piecesQueue.sendPreflight({ jobId: id });
      await audit(deps, req.adminUser!, "studio.job.reopen", { type: "studio_job", id });
      res.json(updated);
    }),
  );

  // Replace the uploaded files on a draft (bad export → fix → re-check).
  router.put(
    "/admin/studio/jobs/:id/files",
    upload.fields([
      { name: "musicxml", maxCount: 1 },
      { name: "midi", maxCount: 1 },
    ]),
    wrap(async (req, res) => {
      if (!deps.studio || !deps.piecesQueue) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (job.status !== "draft") {
        res.status(409).json({ error: "not_a_draft", status: job.status });
        return;
      }
      const uploaded = await uploadSources(
        id,
        req.files as Record<string, Express.Multer.File[]> | undefined,
      );
      if ("error" in uploaded) {
        res.status(400).json({ error: uploaded.error });
        return;
      }
      const [updated] = await db
        .update(studioJobs)
        .set({
          sources: uploaded,
          checkStatus: "pending",
          gates: {},
          artifacts: [],
          stage: null,
          error: null,
          updatedAt: sql`now()`,
        })
        .where(eq(studioJobs.id, id))
        .returning();
      await deps.piecesQueue.sendPreflight({ jobId: id });
      res.json(updated);
    }),
  );

  // Metadata lands section-by-section as the wizard progresses; the slug is derived
  // server-side from composer/title/subtitle and is never client-writable.
  router.patch(
    "/admin/studio/jobs/:id/metadata",
    wrap(async (req, res) => {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_metadata", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (job.status !== "draft") {
        res.status(409).json({ error: "not_a_draft", status: job.status });
        return;
      }
      const merged = { ...(job.metadata as Record<string, unknown>), ...parsed.data };
      const title = typeof merged.title === "string" ? merged.title : "";
      const composer = typeof merged.composer === "string" ? merged.composer : "";
      const subtitle = typeof merged.subtitle === "string" ? merged.subtitle : "";
      const pieceId = title && composer ? pieceSlug(composer, title, subtitle) : job.pieceId;

      const [updated] = await db
        .update(studioJobs)
        .set({ metadata: merged, pieceId, updatedAt: sql`now()` })
        .where(eq(studioJobs.id, id))
        .returning();
      res.json(updated);
    }),
  );

  // Section-level duplicate checks the wizard calls before unlocking the next step.
  router.post(
    "/admin/studio/checks",
    wrap(async (req, res) => {
      const parsed = checksSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_checks", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const { title, composer, subtitle, book } = parsed.data;
      const findings: { level: "info" | "warn" | "error"; code: string; message: string }[] = [];
      let slug: string | null = null;

      if (title && composer) {
        slug = pieceSlug(composer, title, subtitle ?? "");
        const [existing] = await db.select().from(pieces).where(eq(pieces.id, slug)).limit(1);
        if (existing) {
          findings.push({
            level: "info",
            code: "piece_exists",
            message: `This identity already exists as "${existing.title}${existing.subtitle ? ` · ${existing.subtitle}` : ""}" (${existing.status}${existing.publishedVersion ? `, v${existing.publishedVersion} live` : ""}). Publishing will create its next version — intended for score fixes, not for a different piece.`,
          });
        } else {
          const similar = await db
            .select()
            .from(pieces)
            .where(and(ilike(pieces.title, title), ilike(pieces.composer, composer), ne(pieces.id, slug)))
            .limit(3);
          for (const s of similar) {
            findings.push({
              level: "warn",
              code: "title_similar",
              message: `A piece with the same title and composer exists: "${s.title}${s.subtitle ? ` · ${s.subtitle}` : ""}" (${s.id}). If yours is a different movement/number, make sure the subtitle distinguishes it.`,
            });
          }
        }
      }

      if (book?.id) {
        const [b] = await db.select().from(books).where(eq(books.id, book.id)).limit(1);
        if (!b) {
          findings.push({ level: "error", code: "book_missing", message: "Selected book no longer exists — refresh and pick again." });
        } else if (book.index != null) {
          const clash = await db
            .select()
            .from(pieces)
            .where(and(eq(pieces.bookId, book.id), eq(pieces.bookIndex, book.index), slug ? ne(pieces.id, slug) : undefined))
            .limit(1);
          if (clash.length > 0) {
            findings.push({
              level: "error",
              code: "book_index_taken",
              message: `No. ${book.index} in "${b.title}" is already "${clash[0]!.title}${clash[0]!.subtitle ? ` · ${clash[0]!.subtitle}` : ""}". Pick the correct number or the correct book.`,
            });
          }
        }
      } else if (book?.title) {
        const newId = bookSlug(book.title);
        const [byId] = await db.select().from(books).where(eq(books.id, newId)).limit(1);
        const byTitle = byId ? [byId] : await db.select().from(books).where(ilike(books.title, book.title)).limit(1);
        if (byTitle.length > 0) {
          findings.push({
            level: "error",
            code: "book_exists",
            message: `"${byTitle[0]!.title}" already exists — select it from the list instead of creating a duplicate.`,
          });
        }
      }

      res.json({ pieceId: slug, bookId: book?.title ? bookSlug(book.title) : (book?.id ?? null), findings });
    }),
  );

  // Final submit: metadata must be complete, preflight must have passed. The full
  // run re-verifies the fast gates (deliberate redundancy) and adds the render gate.
  router.post(
    "/admin/studio/jobs/:id/submit",
    wrap(async (req, res) => {
      if (!deps.piecesQueue) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (job.status !== "draft") {
        res.status(409).json({ error: "not_a_draft", status: job.status });
        return;
      }
      if (job.checkStatus !== "pass") {
        res.status(409).json({ error: "preflight_not_passed", checkStatus: job.checkStatus });
        return;
      }
      const meta = metadataSchema.safeParse(job.metadata);
      if (!meta.success) {
        res.status(400).json({ error: "metadata_incomplete", detail: meta.success ? [] : meta.error.issues });
        return;
      }
      const pieceId = pieceSlug(meta.data.composer, meta.data.title, meta.data.subtitle);
      // Slug collision guard: same id must mean the same musical identity. A version
      // bump (re-upload of the same piece) passes; a different piece that happens to
      // derive the same slug must NOT silently overwrite it at publish.
      const [existing] = await db.select().from(pieces).where(eq(pieces.id, pieceId)).limit(1);
      if (
        existing &&
        (existing.title.toLowerCase() !== meta.data.title.toLowerCase() ||
          existing.composer.toLowerCase() !== meta.data.composer.toLowerCase() ||
          existing.subtitle.toLowerCase() !== meta.data.subtitle.toLowerCase())
      ) {
        res.status(409).json({
          error: "slug_collision",
          message: `The derived id "${pieceId}" belongs to "${existing.title}${existing.subtitle ? ` · ${existing.subtitle}` : ""}" — adjust the subtitle so the two pieces are distinguishable.`,
        });
        return;
      }
      const [updated] = await db
        .update(studioJobs)
        .set({ status: "queued", pieceId, stage: null, error: null, updatedAt: sql`now()` })
        .where(eq(studioJobs.id, id))
        .returning();
      await deps.piecesQueue.send({ jobId: id, pieceId });
      await audit(deps, req.adminUser!, "studio.job.submit", { type: "studio_job", id }, { pieceId });
      res.json(updated);
    }),
  );

  router.get(
    "/admin/studio/jobs",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      // Board projection: everything except artifacts/sources (detail-only payloads).
      const items = await db
        .select({
          id: studioJobs.id,
          pieceId: studioJobs.pieceId,
          status: studioJobs.status,
          checkStatus: studioJobs.checkStatus,
          stage: studioJobs.stage,
          metadata: studioJobs.metadata,
          gates: studioJobs.gates,
          error: studioJobs.error,
          publishedVersion: studioJobs.publishedVersion,
          createdAt: studioJobs.createdAt,
          updatedAt: studioJobs.updatedAt,
        })
        .from(studioJobs)
        .where(status ? eq(studioJobs.status, status) : undefined)
        .orderBy(desc(studioJobs.updatedAt))
        .limit(Math.min(Number(req.query.limit) || 100, 200));
      res.json({ items });
    }),
  );

  router.get(
    "/admin/studio/jobs/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const [job] = await db
        .select()
        .from(studioJobs)
        .where(eq(studioJobs.id, String(req.params.id)))
        .limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      let previews: { role: string; variant?: string; url: string }[] = [];
      if (deps.studio && deps.catalog && Array.isArray(job.artifacts)) {
        previews = (job.artifacts as BundleFile[]).map((a) => ({
          role: a.role,
          ...(a.variant ? { variant: a.variant } : {}),
          url: deps.catalog!.signReadUrl(deps.studio!.bundleUrl(a.path)),
        }));
      }
      res.json({ ...job, previews });
    }),
  );

  // Re-run all gates: recovery from failed, or paranoia re-verification from review.
  router.post(
    "/admin/studio/jobs/:id/retry",
    wrap(async (req, res) => {
      if (!deps.piecesQueue) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (job.status !== "failed" && job.status !== "ready_for_review") {
        res.status(409).json({ error: "not_retryable", status: job.status });
        return;
      }
      const [updated] = await db
        .update(studioJobs)
        .set({ status: "queued", stage: null, error: null, updatedAt: sql`now()` })
        .where(eq(studioJobs.id, id))
        .returning();
      await deps.piecesQueue.send({ jobId: id, pieceId: job.pieceId });
      await audit(deps, req.adminUser!, "studio.job.retry", { type: "studio_job", id });
      res.json(updated);
    }),
  );

  router.post(
    "/admin/studio/jobs/:id/cancel",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (!["draft", "failed", "ready_for_review"].includes(job.status)) {
        res.status(409).json({ error: "not_cancelable", status: job.status });
        return;
      }
      const [updated] = await db
        .update(studioJobs)
        .set({ status: "canceled", updatedAt: sql`now()` })
        .where(eq(studioJobs.id, id))
        .returning();
      await audit(deps, req.adminUser!, "studio.job.cancel", { type: "studio_job", id });
      res.json(updated);
    }),
  );

  router.post(
    "/admin/studio/jobs/:id/publish",
    wrap(async (req, res) => {
      if (!deps.studio) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (job.status !== "ready_for_review") {
        res.status(409).json({ error: "not_publishable", status: job.status });
        return;
      }
      const meta = metadataSchema.parse(job.metadata);
      if (!PUBLISHABLE_RIGHTS.has(meta.rights)) {
        res.status(409).json({ error: "rights_blocked", rights: meta.rights });
        return;
      }
      const artifacts = job.artifacts as BundleFile[];
      if (!Array.isArray(artifacts) || artifacts.length === 0) {
        res.status(409).json({ error: "no_artifacts" });
        return;
      }
      const pieceId = job.pieceId;

      const [maxRow] = await db
        .select({ maxVersion: sql<number | null>`max(${pieceVersions.version})::int` })
        .from(pieceVersions)
        .where(eq(pieceVersions.pieceId, pieceId));
      const version = (maxRow?.maxVersion ?? 0) + 1;

      // Blob copies before the DB transaction: immutable v<N> layout, re-copy on a
      // failed publish retry is harmless.
      const versionFiles: BundleFile[] = [];
      for (const a of artifacts) {
        const filename = a.path.split("/").pop()!;
        const toPath = `${pieceId}/v${version}/${filename}`;
        await deps.studio.copyWithinBundles(a.path, toPath);
        versionFiles.push({ ...a, path: toPath });
      }

      const engineSha =
        (job.gates as Record<string, { metrics?: { engine_sha?: string } }>)?.geometry?.metrics
          ?.engine_sha ?? null;

      await db.transaction(async (tx) => {
        if (meta.book) {
          await tx
            .insert(books)
            .values({ id: meta.book.id, title: meta.book.title ?? meta.book.id })
            .onConflictDoNothing();
        }
        await tx
          .insert(pieces)
          .values({
            id: pieceId,
            title: meta.title,
            composer: meta.composer,
            subtitle: meta.subtitle,
            mode: meta.mode,
            difficulty: meta.difficulty,
            tracking: meta.tracking,
            bookId: meta.book?.id ?? null,
            bookIndex: meta.book?.index ?? null,
            rights: meta.rights,
            rightsNote: meta.rightsNote || null,
            status: "published",
            publishedVersion: version,
          })
          .onConflictDoUpdate({
            target: pieces.id,
            set: {
              title: meta.title,
              composer: meta.composer,
              subtitle: meta.subtitle,
              difficulty: meta.difficulty,
              tracking: meta.tracking,
              bookId: meta.book?.id ?? null,
              bookIndex: meta.book?.index ?? null,
              rights: meta.rights,
              rightsNote: meta.rightsNote || null,
              status: "published",
              publishedVersion: version,
              updatedAt: sql`now()`,
            },
          });
        await tx.insert(pieceVersions).values({
          pieceId,
          version,
          engineSha,
          files: versionFiles,
          publishedBy: req.adminUser!.id,
        });
        await tx
          .update(studioJobs)
          .set({ status: "published", publishedVersion: version, updatedAt: sql`now()` })
          .where(eq(studioJobs.id, id));
      });

      await rebuildCatalog(db, deps.studio);
      await audit(deps, req.adminUser!, "piece.publish", { type: "piece", id: pieceId }, {
        version,
        jobId: id,
      });

      const [updated] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      res.json(updated);
    }),
  );

  return router;
}
