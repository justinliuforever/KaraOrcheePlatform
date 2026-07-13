import { Router } from "express";
import multer from "multer";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ilike, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireAdmin, audit } from "../admin";
import { books, pieces, pieceVersions, studioJobs, users, works } from "../db/schema";
import { rebuildCatalog, type BundleFile } from "../catalog_build";
import { pieceSlug, bookSlug, normalizeCatalogue, likeEsc } from "../slug";

const PUBLISH_ROLES = new Set(["score_events", "accompaniment_events", "geometry", "svg", "reference_audio", "audio_map"]);
const INSTRUMENTS = ["piano", "violin", "guitar"] as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024, files: 3 }, // audio can be tens of MB
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
    instrument: z.enum(INSTRUMENTS).default("piano"),
    soloPart: z.string().max(80).nullable().default(null),
    work: z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9_]{2,63}$/),
        index: z.number().int().min(0).nullable().default(null),
      })
      .nullable()
      .default(null),
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
  instrument: z.enum(INSTRUMENTS).optional(),
  // Solo part id from the XML part-list. Changing it invalidates every built artifact
  // (display, timeline, preview) — the PATCH handler resets and re-preflights.
  soloPart: z.string().max(80).nullable().optional(),
  work: z
    .object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_]{2,63}$/),
      index: z.number().int().min(0).nullable().optional(),
    })
    .nullable()
    .optional(),
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
  instrument: z.string().optional(),
  work: z
    .object({
      id: z.string().optional(), // existing work selected
      catalogue: z.string().optional(), // creating a new work
      index: z.number().int().min(0).nullable().optional(),
    })
    .nullable()
    .optional(),
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
const AUDIO_EXT = /\.(m4a|mp3|wav|aac)$/i;
const PUBLISHABLE_RIGHTS = new Set(["public_domain", "licensed"]);

function safeName(original: string): string {
  const base = original.split("/").pop()!.split("\\").pop()!;
  return base.replace(/[^A-Za-z0-9._-]/g, "_");
}

interface SourceEntry {
  kind: "musicxml" | "midi" | "audio";
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
    const audio = files?.audio?.[0];
    if (audio && !AUDIO_EXT.test(audio.originalname)) {
      return { error: "audio_bad_extension" };
    }
    const sources: SourceEntry[] = [];
    for (const [kind, file] of [
      ["musicxml", musicxml],
      ["midi", midi],
      ["audio", audio],
    ] as const) {
      if (!file) continue;
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
  // preflight gates already run. ?piece=<id> PINS the draft to an existing piece
  // ("upload new version"): identity is carried by the immutable id, never re-derived
  // from title strings — renaming a piece can't break its version chain.
  router.post(
    "/admin/studio/drafts",
    upload.fields([
      { name: "musicxml", maxCount: 1 },
      { name: "midi", maxCount: 1 },
      { name: "audio", maxCount: 1 },
    ]),
    wrap(async (req, res) => {
      if (!deps.studio || !deps.piecesQueue) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const jobId = randomUUID();

      let pieceId = `draft_${jobId.slice(0, 8)}`;
      let metadata: Record<string, unknown> = {};
      const pin = typeof req.query.piece === "string" ? req.query.piece : null;
      if (pin) {
        const [piece] = await db.select().from(pieces).where(eq(pieces.id, pin)).limit(1);
        if (!piece) {
          res.status(404).json({ error: "piece_not_found" });
          return;
        }
        // One open build per piece: two parallel pinned drafts would race publishes and
        // the last writer's metadata (incl. work membership) silently wins the row.
        const [open] = await db
          .select({ id: studioJobs.id, status: studioJobs.status })
          .from(studioJobs)
          .where(and(eq(studioJobs.pieceId, pin),
            sql`${studioJobs.status} IN ('draft','queued','running','ready_for_review')`))
          .limit(1);
        if (open) {
          res.status(409).json({ error: "piece_has_open_draft", jobId: open.id, status: open.status });
          return;
        }
        pieceId = piece.id;
        const inst = piece.instrumentation as { solo?: string } | null;
        const facts = piece.facts as { solo_part?: string } | null;
        metadata = {
          pinnedPieceId: piece.id,
          // Registry concurrency token: publish rejects if the Library row changed
          // after this snapshot was taken (409 stale_registry), so a draft can never
          // silently revert committed Library edits. Refreshed on reopen.
          pinnedPieceUpdatedAt: piece.updatedAt.toISOString(),
          title: piece.title,
          composer: piece.composer,
          subtitle: piece.subtitle,
          difficulty: piece.difficulty,
          tracking: piece.tracking,
          rights: piece.rights,
          rightsNote: piece.rightsNote ?? "",
          instrument: inst?.solo ?? "piano",
          soloPart: facts?.solo_part ?? null,
          work: piece.workId ? { id: piece.workId, index: piece.workIndex } : null,
          book: piece.bookId ? { id: piece.bookId, index: piece.bookIndex } : null,
        };
      }

      // Instrument is chosen BEFORE upload so the very first preflight renders the
      // preview with the right soundfont; pinned drafts inherit it from the piece.
      if (!pin) {
        const inst = req.body?.instrument as string | undefined;
        if (inst !== undefined && !(INSTRUMENTS as readonly string[]).includes(inst)) {
          res.status(400).json({ error: "invalid_instrument" });
          return;
        }
        metadata = { instrument: inst ?? "piano" };
      }

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
          pieceId,
          status: "draft",
          checkStatus: "pending",
          metadata,
          sources: uploaded,
          createdBy: req.adminUser!.id,
        })
        .returning();

      await deps.piecesQueue.sendPreflight({ jobId, reqId: req.reqId });
      await audit(deps, req, "studio.draft.create", { type: "studio_job", id: jobId }, {
        ...(pin ? { newVersionOf: pin } : {}),
      });
      res.status(201).json(job);
    }),
  );

  // Back to draft on the same row — one board row per piece, attempt history stays in
  // audit_events. Covers the failed/canceled fix loop AND "edit details before publish"
  // from review (sources are already staged; the wizard reopens prefilled, preflight
  // re-runs, submit re-verifies everything).
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
      if (!["failed", "canceled", "ready_for_review"].includes(job.status)) {
        res.status(409).json({ error: "not_reopenable", status: job.status });
        return;
      }
      // Reopening means the admin is deliberately revising — refresh the registry
      // concurrency token so their next publish reflects awareness of current state.
      const prevMeta = job.metadata as Record<string, unknown>;
      let metadata = prevMeta;
      if (prevMeta.pinnedPieceId) {
        const [live] = await db
          .select({ updatedAt: pieces.updatedAt })
          .from(pieces)
          .where(eq(pieces.id, String(prevMeta.pinnedPieceId)))
          .limit(1);
        if (live) metadata = { ...prevMeta, pinnedPieceUpdatedAt: live.updatedAt.toISOString() };
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
          metadata,
          updatedAt: sql`now()`,
        })
        .where(and(eq(studioJobs.id, id), eq(studioJobs.status, job.status)))
        .returning();
      if (!updated) {
        res.status(409).json({ error: "status_changed", message: "The job changed state under you — reload the page." });
        return;
      }
      await deps.piecesQueue.sendPreflight({ jobId: id, reqId: req.reqId });
      await audit(deps, req, "studio.job.reopen", { type: "studio_job", id });
      res.json(updated);
    }),
  );

  // Replace the uploaded files on a draft (bad export → fix → re-check).
  router.put(
    "/admin/studio/jobs/:id/files",
    upload.fields([
      { name: "musicxml", maxCount: 1 },
      { name: "midi", maxCount: 1 },
      { name: "audio", maxCount: 1 },
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
      await deps.piecesQueue.sendPreflight({ jobId: id, reqId: req.reqId });
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
      const prev = job.metadata as Record<string, unknown>;
      const merged = { ...prev, ...parsed.data };
      const title = typeof merged.title === "string" ? merged.title : "";
      const composer = typeof merged.composer === "string" ? merged.composer : "";
      const subtitle = typeof merged.subtitle === "string" ? merged.subtitle : "";
      // A pinned draft keeps its piece id no matter how the display fields change.
      const pinnedId = (merged as Record<string, unknown>).pinnedPieceId;
      const pieceId = pinnedId
        ? String(pinnedId)
        : title && composer
          ? pieceSlug(composer, title, subtitle)
          : job.pieceId;

      // Solo part and instrument are metadata that CHANGE artifacts — flipping either
      // invalidates the preflight (display, timeline, preview were built from the old
      // choice; the preview soundfont follows the instrument).
      const soloChanged =
        parsed.data.soloPart !== undefined && parsed.data.soloPart !== (prev.soloPart ?? null);
      const instrumentChanged =
        parsed.data.instrument !== undefined &&
        parsed.data.instrument !== ((prev.instrument as string | undefined) ?? "piano");
      const invalidated = soloChanged || instrumentChanged;

      const [updated] = await db
        .update(studioJobs)
        .set({
          metadata: merged,
          pieceId,
          ...(invalidated
            ? { checkStatus: "pending", gates: {}, artifacts: [], stage: null, error: null }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(studioJobs.id, id))
        .returning();
      if (invalidated && deps.piecesQueue) {
        await deps.piecesQueue.sendPreflight({ jobId: id, reqId: req.reqId });
      }
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
      const { title, composer, subtitle, book, work, instrument } = parsed.data;
      const findings: { level: "info" | "warn" | "error"; code: string; message: string }[] = [];
      let slug: string | null = null;

      if (work?.catalogue && composer) {
        // Creating a new work: the (composer + normalized catalogue) check that keeps a
        // bulk upload from fragmenting one sonata into N works.
        const norm = normalizeCatalogue(work.catalogue);
        const siblings = await db
          .select()
          .from(works)
          .where(ilike(works.composer, `%${likeEsc(composer.split(" ").pop()!)}%`));
        const dup = siblings.find((s) => s.catalogue && normalizeCatalogue(s.catalogue) === norm);
        if (dup) {
          findings.push({
            level: "error",
            code: "work_exists",
            message: `"${dup.title}" (${dup.catalogue}) already exists — select it in the Work field instead of creating a duplicate.`,
          });
        }
      }
      if (work?.id && work.index != null) {
        const at = await db
          .select({ id: pieces.id, title: pieces.title, subtitle: pieces.subtitle, status: pieces.status, instrumentation: pieces.instrumentation })
          .from(pieces)
          .where(and(eq(pieces.workId, work.id), eq(pieces.workIndex, work.index)));
        for (const p of at) {
          const pInst = (p.instrumentation as { solo?: string } | null)?.solo ?? "piano";
          if (pInst === (instrument ?? "piano")) {
            findings.push({
              level: "warn",
              code: "movement_taken",
              message: `Movement ${work.index} already exists for ${pInst}: "${p.title}${p.subtitle ? ` · ${p.subtitle}` : ""}" (${p.status}). Same movement + same instrument is probably a duplicate upload${p.status === "archived" ? " — consider restoring it instead" : ""}.`,
            });
          } else {
            findings.push({
              level: "info",
              code: "movement_other_instrument",
              message: `Movement ${work.index} exists on ${pInst} ("${p.title}") — uploading the ${instrument ?? "piano"} version of the same movement is expected for arrangements.`,
            });
          }
        }
      }

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
            .where(and(ilike(pieces.title, likeEsc(title)), ilike(pieces.composer, likeEsc(composer)), ne(pieces.id, slug)))
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
        const byTitle = byId ? [byId] : await db.select().from(books).where(ilike(books.title, likeEsc(book.title))).limit(1);
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
        res.status(409).json({
          error: "preflight_not_passed",
          checkStatus: job.checkStatus,
          message:
            job.checkStatus === "fail"
              ? "The automated checks failed — fix the reported problem (or replace the files) first."
              : "The automated checks are still running — wait for them to pass, then submit.",
        });
        return;
      }
      const meta = metadataSchema.safeParse(job.metadata);
      if (!meta.success) {
        const missing = meta.error.issues.map((i) => i.path.join(".")).join(", ");
        res.status(400).json({
          error: "metadata_incomplete",
          detail: meta.error.issues,
          message: `Some required fields haven't been saved yet (${missing}) — click into each and make sure it saves, then submit again.`,
        });
        return;
      }
      // Reviewed = published: the artifacts on this row must have been built from the
      // CURRENT solo-part choice.
      const stamp = (job.gates as Record<string, { metrics?: { solo_part?: string } }>)?.sanity
        ?.metrics?.solo_part;
      if (meta.data.soloPart && stamp && meta.data.soloPart !== stamp) {
        res.status(409).json({
          error: "stale_preflight",
          message: "The checks ran against a different solo-part choice — they are re-running; submit again when they pass.",
        });
        return;
      }
      const pinned = (job.metadata as Record<string, unknown>).pinnedPieceId;
      const pieceId = pinned
        ? String(pinned)
        : pieceSlug(meta.data.composer, meta.data.title, meta.data.subtitle);
      // Slug collision guard (unpinned drafts only): same id must mean the same
      // musical identity. A pinned draft IS an intentional version bump of its piece,
      // whatever the display fields now say.
      if (!pinned) {
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
      }
      // One open build per PIECE, pinned or not — two parallel builds of the same
      // identity would race publishes and the loser's metadata silently wins the row.
      const [openDup] = await db
        .select({ id: studioJobs.id, status: studioJobs.status })
        .from(studioJobs)
        .where(and(eq(studioJobs.pieceId, pieceId), ne(studioJobs.id, id),
          sql`${studioJobs.status} IN ('queued','running','ready_for_review')`))
        .limit(1);
      if (openDup) {
        res.status(409).json({
          error: "piece_has_open_build",
          jobId: openDup.id,
          message: `Another build for this piece is already ${openDup.status.replaceAll("_", " ")} — finish or discard it first.`,
        });
        return;
      }
      const [updated] = await db
        .update(studioJobs)
        .set({ status: "queued", pieceId, stage: null, error: null, updatedAt: sql`now()` })
        .where(and(eq(studioJobs.id, id), eq(studioJobs.status, "draft")))
        .returning();
      if (!updated) {
        res.status(409).json({ error: "status_changed", message: "The job changed state while you were submitting — reload the page." });
        return;
      }
      try {
        await deps.piecesQueue.send({ jobId: id, pieceId, reqId: req.reqId });
      } catch (err) {
        // Never leave the row wedged in 'queued' with no message in flight — no
        // route accepts 'queued', so roll back and let the admin retry.
        await db
          .update(studioJobs)
          .set({ status: "draft", updatedAt: sql`now()` })
          .where(eq(studioJobs.id, id));
        console.error("submit: queue send failed, rolled back to draft", err);
        res.status(503).json({ error: "queue_unavailable", message: "The verification queue is briefly unavailable — try submitting again in a moment." });
        return;
      }
      await audit(deps, req, "studio.job.submit", { type: "studio_job", id }, { pieceId });
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
          createdByEmail: users.email,
        })
        .from(studioJobs)
        .leftJoin(users, eq(studioJobs.createdBy, users.id))
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
      const [row] = await db
        .select({ job: studioJobs, createdByEmail: users.email })
        .from(studioJobs)
        .leftJoin(users, eq(studioJobs.createdBy, users.id))
        .where(eq(studioJobs.id, String(req.params.id)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const job = row.job;
      const createdByEmail = row.createdByEmail;
      let previews: { role: string; variant?: string; url: string }[] = [];
      if (deps.studio && deps.catalog && Array.isArray(job.artifacts)) {
        previews = (job.artifacts as BundleFile[]).map((a) => ({
          role: a.role,
          ...(a.variant ? { variant: a.variant } : {}),
          url: deps.catalog!.signReadUrl(deps.studio!.bundleUrl(a.path)),
        }));
      }
      // Registry cross-check: what this piece id looks like in the LIVE catalog right
      // now — lets the UI say "you published v1, current live is v3 / piece archived".
      let piece: { status: string; publishedVersion: number | null } | null = null;
      if (!job.pieceId.startsWith("draft_")) {
        const [p] = await db
          .select({ status: pieces.status, publishedVersion: pieces.publishedVersion })
          .from(pieces)
          .where(eq(pieces.id, job.pieceId))
          .limit(1);
        piece = p ?? null;
      }
      res.json({ ...job, createdByEmail, previews, piece });
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
        .where(and(eq(studioJobs.id, id), eq(studioJobs.status, job.status)))
        .returning();
      if (!updated) {
        res.status(409).json({ error: "status_changed", message: "The job changed state under you — reload the page." });
        return;
      }
      try {
        await deps.piecesQueue.send({ jobId: id, pieceId: job.pieceId, reqId: req.reqId });
      } catch (err) {
        await db
          .update(studioJobs)
          .set({ status: job.status, updatedAt: sql`now()` })
          .where(eq(studioJobs.id, id));
        console.error("retry: queue send failed, rolled back", err);
        res.status(503).json({ error: "queue_unavailable", message: "The verification queue is briefly unavailable — try again in a moment." });
        return;
      }
      await audit(deps, req, "studio.job.retry", { type: "studio_job", id });
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
        .where(and(eq(studioJobs.id, id), eq(studioJobs.status, job.status)))
        .returning();
      if (!updated) {
        res.status(409).json({ error: "status_changed", message: "The job changed state under you — reload the page." });
        return;
      }
      await audit(deps, req, "studio.job.cancel", { type: "studio_job", id });
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
      // The draft metadata is a SNAPSHOT — the live registry row is the truth for
      // rights and for concurrent Library edits. Without these guards a stale draft
      // could silently reverse a takedown or revert committed Library edits.
      const [livePiece] = await db.select().from(pieces).where(eq(pieces.id, job.pieceId)).limit(1);
      if (livePiece && !PUBLISHABLE_RIGHTS.has(livePiece.rights)) {
        res.status(409).json({
          error: "rights_blocked_live",
          rights: livePiece.rights,
          message: `This piece's rights were marked "${livePiece.rights}" in the Library after this draft was created${livePiece.status === "archived" ? " (it was taken down)" : ""} — resolve the rights question in Pieces Library before publishing.`,
        });
        return;
      }
      const rawMeta = job.metadata as Record<string, unknown>;
      if (rawMeta.pinnedPieceId && rawMeta.pinnedPieceUpdatedAt && livePiece &&
          livePiece.updatedAt.toISOString() !== String(rawMeta.pinnedPieceUpdatedAt)) {
        res.status(409).json({
          error: "stale_registry",
          message: "The Library entry for this piece changed after this draft was created (someone edited it). Check the piece in Pieces Library, then use Edit details — it refreshes this draft — and resubmit.",
        });
        return;
      }
      const allArtifacts = job.artifacts as BundleFile[];
      if (!Array.isArray(allArtifacts) || allArtifacts.length === 0) {
        res.status(409).json({ error: "no_artifacts" });
        return;
      }
      // Role allowlist: preview audio is a review aid — it must never enter the
      // immutable bundle or the fielded catalog.
      const artifacts = allArtifacts.filter((a) => PUBLISH_ROLES.has(a.role));
      // Reviewed = published, publish-side re-assertion.
      const publishStamp = (job.gates as Record<string, { metrics?: { solo_part?: string } }>)
        ?.sanity?.metrics?.solo_part;
      if (meta.soloPart && publishStamp && meta.soloPart !== publishStamp) {
        res.status(409).json({ error: "stale_artifacts", message: "Artifacts were built from a different solo-part choice — re-run the checks." });
        return;
      }
      const pieceId = job.pieceId;

      const gates = job.gates as Record<string, { metrics?: Record<string, unknown> }>;
      // Hard server-side block BEFORE any side effect (blob copies included): repeat
      // pieces build and review fine, but the shipped app assumes one measure = one
      // playback time (its FOLLOW mode treats the exact repeat twins as tracker
      // poison). Publishing waits for the app-side repeat capability.
      const structureMetrics = gates?.structure?.metrics as
        | { kind?: string; written_measures?: number; played_measures?: number;
            max_passes?: number; n_spans?: number; expanded_duration_sec?: number;
            expansion_source?: string }
        | undefined;
      if (structureMetrics?.kind === "repeats" && !deps.appSupportsRepeats) {
        res.status(409).json({
          error: "repeats_not_supported_yet",
          message: "This piece plays repeats (" + String(structureMetrics.written_measures) +
            " written / " + String(structureMetrics.played_measures) + " played measures). " +
            "It builds and previews correctly, but the app cannot follow repeat structures yet — " +
            "publishing unlocks with the app-side repeat update.",
        });
        return;
      }

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

      const engineSha = (gates?.geometry?.metrics?.engine_sha as string | undefined) ?? null;
      // Assemble facts from gate metrics: XML ground truth + computed duration + the
      // part choice this bundle was built from.
      const xm = (gates?.sanity?.metrics?.xml_meta ?? {}) as Record<string, unknown>;
      const facts = {
        key: xm.key ?? null,
        time: xm.time ?? null,
        measures: xm.measures ?? null,
        tempo_bpm: xm.tempo_bpm ?? null,
        tempo_text: xm.tempo_text ?? null,
        tempo_source: xm.tempo_source ?? "default",
        duration_sec: gates?.alignment?.metrics?.duration_sec ?? null,
        solo_part: gates?.sanity?.metrics?.solo_part ?? null,
        parts: ((xm.parts as { name?: string | null }[] | undefined) ?? []).map((p) => p.name).filter(Boolean),
        // Structure facts only for repeat pieces — linear pieces keep their exact
        // pre-repeat facts shape.
        ...(structureMetrics?.kind === "repeats"
          ? {
              structure: {
                type: "repeats",
                written_measures: structureMetrics.written_measures ?? null,
                played_measures: structureMetrics.played_measures ?? null,
                max_passes: structureMetrics.max_passes ?? null,
                n_spans: structureMetrics.n_spans ?? null,
                expanded_duration_sec: structureMetrics.expanded_duration_sec ?? null,
                expansion_source: structureMetrics.expansion_source ?? null,
              },
            }
          : {}),
      };
      const instrumentation = {
        solo: meta.instrument,
        parts: (xm.n_parts as number | undefined) && (xm.n_parts as number) > 1
          ? [meta.instrument, "piano"]
          : [meta.instrument],
      };

      // Work membership referenced at publish must exist (created earlier via the
      // wizard's Work lane / POST /admin/works).
      if (meta.work) {
        const [w] = await db.select().from(works).where(eq(works.id, meta.work.id)).limit(1);
        if (!w) {
          res.status(409).json({ error: "work_missing", workId: meta.work.id });
          return;
        }
      }

      const txResult = await db.transaction(async (tx) => {
        if (meta.book) {
          await tx
            .insert(books)
            .values({ id: meta.book.id, title: meta.book.title ?? meta.book.id })
            .onConflictDoNothing();
        }
        const pieceCols = {
          title: meta.title,
          composer: meta.composer,
          subtitle: meta.subtitle,
          difficulty: meta.difficulty,
          tracking: meta.tracking,
          bookId: meta.book?.id ?? null,
          bookIndex: meta.book?.index ?? null,
          workId: meta.work?.id ?? null,
          workIndex: meta.work?.index ?? null,
          instrumentation,
          facts,
          rights: meta.rights,
          rightsNote: meta.rightsNote || null,
          status: "published",
          publishedVersion: version,
        };
        await tx
          .insert(pieces)
          .values({ id: pieceId, mode: meta.mode, ...pieceCols })
          .onConflictDoUpdate({
            target: pieces.id,
            set: { ...pieceCols, updatedAt: sql`now()` },
          });
        await tx.insert(pieceVersions).values({
          pieceId,
          version,
          engineSha,
          files: versionFiles,
          publishedBy: req.adminUser!.id,
        });
        // Status predicate: if a concurrent cancel/reopen moved the job during the
        // blob copies, abort the whole publish instead of overriding the admin.
        const [flipped] = await tx
          .update(studioJobs)
          .set({ status: "published", publishedVersion: version, updatedAt: sql`now()` })
          .where(and(eq(studioJobs.id, id), eq(studioJobs.status, "ready_for_review")))
          .returning({ id: studioJobs.id });
        if (!flipped) throw Object.assign(new Error("job_state_changed"), { statusCode: 409 });
      }).catch((err: Error & { statusCode?: number }) => {
        if (err.statusCode !== 409) throw err;
        return "conflict" as const;
      });
      if (txResult === "conflict") {
        res.status(409).json({ error: "status_changed", message: "The job was canceled or reopened while publishing — nothing went live. Reload the page." });
        return;
      }

      // The piece is committed as published; a transient catalog failure must not
      // read as a failed publish (re-publish would 409). Any later catalog-touching
      // mutation heals it — surface the warning instead.
      let catalogWarning: string | null = null;
      try {
        await rebuildCatalog(db, deps.studio);
      } catch (err) {
        console.error("publish: catalog rebuild failed (piece IS published)", err);
        catalogWarning =
          "Published, but refreshing the app catalog failed — it will self-heal on the next publish or Library edit. If urgent, edit any field of any piece in the Library.";
      }
      await audit(deps, req, "piece.publish", { type: "piece", id: pieceId }, {
        version,
        jobId: id,
      });

      const [updated] = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      res.json({ ...updated, ...(catalogWarning ? { catalogWarning } : {}) });
    }),
  );

  return router;
}
