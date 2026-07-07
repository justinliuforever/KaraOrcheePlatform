import { Router } from "express";
import multer from "multer";
import { createHash, randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireAdmin, audit } from "../admin";
import { books, pieces, pieceVersions, studioJobs } from "../db/schema";
import { rebuildCatalog, type BundleFile } from "../catalog_build";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 2 },
});

const metadataSchema = z.object({
  pieceId: z.string().regex(/^[a-z0-9][a-z0-9_]{2,63}$/, "lowercase slug"),
  title: z.string().min(1).max(200),
  composer: z.string().min(1).max(120),
  subtitle: z.string().max(200).default(""),
  mode: z.literal("solo").default("solo"), // concerto needs stems; out of studio scope
  difficulty: z.number().int().min(1).max(5).nullable().default(null),
  tracking: z.enum(["validated", "experimental"]).default("experimental"),
  rights: z.enum(["public_domain", "licensed", "unknown", "blocked"]),
  rightsNote: z.string().max(2000).default(""),
  book: z
    .object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_]{2,63}$/),
      title: z.string().max(200).optional(),
      index: z.number().int().min(0).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type StudioMetadata = z.infer<typeof metadataSchema>;

const XML_EXT = /\.(musicxml|xml|mxl)$/i;
const MIDI_EXT = /\.(mid|midi)$/i;
const PUBLISHABLE_RIGHTS = new Set(["public_domain", "licensed"]);

function safeName(original: string): string {
  const base = original.split("/").pop()!.split("\\").pop()!;
  return base.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function studioRouter(deps: Deps): Router {
  const router = Router();
  router.use("/admin/studio", requireAuth(deps.auth), requireAdmin(deps));

  router.post(
    "/admin/studio/jobs",
    upload.fields([
      { name: "musicxml", maxCount: 1 },
      { name: "midi", maxCount: 1 },
    ]),
    wrap(async (req, res) => {
      if (!deps.studio || !deps.piecesQueue) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const parsed = metadataSchema.safeParse(
        JSON.parse(typeof req.body.metadata === "string" ? req.body.metadata : "{}"),
      );
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_metadata", detail: parsed.error.issues });
        return;
      }
      const meta = parsed.data;
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const musicxml = files?.musicxml?.[0];
      const midi = files?.midi?.[0];
      if (!musicxml || !XML_EXT.test(musicxml.originalname)) {
        res.status(400).json({ error: "musicxml_required" });
        return;
      }
      if (midi && !MIDI_EXT.test(midi.originalname)) {
        res.status(400).json({ error: "midi_bad_extension" });
        return;
      }

      const jobId = randomUUID();
      const sources = [];
      for (const [kind, file] of [
        ["musicxml", musicxml],
        ["midi", midi],
      ] as const) {
        if (!file) continue;
        const path = `staging/${jobId}/${safeName(file.originalname)}`;
        await deps.studio.uploadSource(path, file.buffer, file.mimetype);
        sources.push({
          kind,
          path,
          bytes: file.size,
          sha256: createHash("sha256").update(file.buffer).digest("hex"),
          originalName: file.originalname,
        });
      }

      const db = deps.db!.orm;
      const [job] = await db
        .insert(studioJobs)
        .values({
          id: jobId,
          pieceId: meta.pieceId,
          metadata: meta,
          sources,
          createdBy: req.adminUser!.id,
        })
        .returning();

      try {
        await deps.piecesQueue.send({ jobId, pieceId: meta.pieceId });
      } catch (err) {
        await db
          .update(studioJobs)
          .set({ status: "failed", error: "enqueue_failed", updatedAt: sql`now()` })
          .where(eq(studioJobs.id, jobId));
        throw err;
      }

      await audit(deps, req.adminUser!, "studio.job.create", { type: "studio_job", id: jobId }, {
        pieceId: meta.pieceId,
      });
      res.status(201).json(job);
    }),
  );

  router.get(
    "/admin/studio/jobs",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const items = await db
        .select()
        .from(studioJobs)
        .where(status ? eq(studioJobs.status, status) : undefined)
        .orderBy(desc(studioJobs.createdAt))
        .limit(Math.min(Number(req.query.limit) || 50, 200));
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
      // Signed preview links for staged artifacts, minted at read time only.
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
      if (job.status !== "failed") {
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

      const [maxRow] = await db
        .select({ maxVersion: sql<number | null>`max(${pieceVersions.version})::int` })
        .from(pieceVersions)
        .where(eq(pieceVersions.pieceId, meta.pieceId));
      const version = (maxRow?.maxVersion ?? 0) + 1;

      // Blob copies before the DB transaction: immutable v<N> layout, re-copy on a
      // failed publish retry is harmless.
      const versionFiles: BundleFile[] = [];
      for (const a of artifacts) {
        const filename = a.path.split("/").pop()!;
        const toPath = `${meta.pieceId}/v${version}/${filename}`;
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
            id: meta.pieceId,
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
          pieceId: meta.pieceId,
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
      await audit(deps, req.adminUser!, "piece.publish", { type: "piece", id: meta.pieceId }, {
        version,
        jobId: id,
      });

      const [updated] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      res.json(updated);
    }),
  );

  return router;
}
