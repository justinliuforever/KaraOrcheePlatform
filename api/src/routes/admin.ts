import { Router } from "express";
import multer from "multer";
import { and, asc, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireAdmin, audit } from "../admin";
import { auditEvents, books, pieces, pieceVersions, studioJobs, users, works } from "../db/schema";
import { processCover, CoverError } from "../covers";
import { bookSlug, likeEsc, normalizeCatalogue, slugify } from "../slug";
import { rebuildCatalog } from "../catalog_build";

const workSchema = z.object({
  title: z.string().min(1).max(200),
  composer: z.string().min(1).max(120),
  catalogue: z.string().max(60).nullable().optional(),
  workType: z
    .enum(["sonata", "suite", "etude_set", "prelude_fugue", "variations", "cycle", "concerto", "collection", "other"])
    .default("other"),
  sortIndex: z.number().int().nullable().optional(),
});

// Work slug per the locked grammar: {composer-surname}_{catalogue} when catalogued,
// else surname + title tokens.
function workSlugFor(composer: string, title: string, catalogue: string | null | undefined): string {
  const surname = slugify(composer).split("_").pop() ?? "work";
  const tail = catalogue ? normalizeCatalogue(catalogue) : slugify(title).split("_").slice(0, 4).join("_");
  return `${surname}_${tail}`.slice(0, 64).replace(/_+$/, "");
}

// Registry-owned edits: display/catalog fields only. Anything baked into the bundle
// (score files) must go through the studio as a new version — never patched here.
const pieceEditSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    composer: z.string().min(1).max(120).optional(),
    subtitle: z.string().max(200).optional(),
    difficulty: z.number().int().min(1).max(5).nullable().optional(),
    tracking: z.enum(["validated", "experimental"]).optional(),
    bookId: z.string().regex(/^[a-z0-9][a-z0-9_]{2,63}$/).nullable().optional(),
    bookIndex: z.number().int().min(0).nullable().optional(),
    rights: z.enum(["public_domain", "licensed", "unknown", "blocked"]).optional(),
    rightsNote: z.string().max(2000).nullable().optional(),
    // Work membership is catalog metadata (like book membership) — editable here,
    // no re-upload needed. Content changes are what require a new version.
    workId: z.string().regex(/^[a-z0-9][a-z0-9_]{2,63}$/).nullable().optional(),
    workIndex: z.number().int().min(0).nullable().optional(),
    // Same work + same movement + same instrument is usually a duplicate; the editor
    // must explicitly confirm to override (arrangements legitimately share numbers).
    confirmMovementClash: z.boolean().optional(),
    // Optimistic-concurrency token: the updated_at the editor loaded. A stale token
    // means another admin changed the row since — reject instead of clobbering.
    expectedUpdatedAt: z.string().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "no fields given" });

// Post-creation edits: display/catalog fields only. The id is permanent — it names
// the cover blobs and every piece reference; the cover has its own endpoint.
const bookEditSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    author: z.string().max(120).nullable().optional(),
    publisher: z.string().max(120).nullable().optional(),
    edition: z.string().max(120).nullable().optional(),
    rights: z.enum(["public_domain", "licensed", "unknown", "blocked"]).optional(),
    rightsNote: z.string().max(2000).nullable().optional(),
    sortIndex: z.number().int().nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "no fields given" });

const numberingSchema = z.object({
  entries: z
    .array(
      z.object({
        pieceId: z.string().min(1),
        bookIndex: z.number().int().min(0).nullable(),
      }),
    )
    .min(1)
    .max(500),
});

const mergeSchema = z.object({
  targetWorkId: z.string().min(1),
  // Same escape hatch as the piece editor: colliding movement numbers are usually
  // a duplicate, but arrangements legitimately share them.
  confirmMovementClash: z.boolean().optional(),
});

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

// Only explicit role flags are patchable here; identity/status changes get their
// own endpoints when account-deletion lands in Phase B.
const rolesSchema = z
  .object({
    isAdmin: z.boolean().optional(),
    isTeacher: z.boolean().optional(),
    isStudent: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "no role fields given",
  });

// id is server-derived from the title; covers are mandatory at creation (the app's
// bookshelf has no empty-cover state).
const bookSchema = z.object({
  title: z.string().min(1).max(200),
  author: z.string().max(120).optional(),
  publisher: z.string().max(120).optional(),
  edition: z.string().max(120).optional(),
  rights: z.enum(["public_domain", "licensed", "unknown", "blocked"]).default("unknown"),
  rightsNote: z.string().max(2000).optional(),
  sortIndex: z.coerce.number().int().optional(),
});

export function adminRouter(deps: Deps): Router {
  const router = Router();
  router.use("/admin", requireAuth(deps.auth), requireAdmin(deps));

  // Every audit list ships the actor's email — "what happened" without "who did
  // it" is half an audit trail.
  const auditWithActor = (db: NonNullable<Deps["db"]>["orm"]) =>
    db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        subjectType: auditEvents.subjectType,
        subjectId: auditEvents.subjectId,
        detail: auditEvents.detail,
        createdAt: auditEvents.createdAt,
        actorEmail: users.email,
      })
      .from(auditEvents)
      .leftJoin(users, eq(auditEvents.actorUserId, users.id));

  router.get(
    "/admin/me",
    wrap(async (req, res) => {
      res.json(req.adminUser);
    }),
  );

  router.get(
    "/admin/users",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const filter = q
        ? or(ilike(users.email, `%${q}%`), ilike(users.displayName, `%${q}%`))
        : undefined;

      const items = await db
        .select()
        .from(users)
        .where(filter)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);
      const [countRow] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(users)
        .where(filter);

      res.json({ items, total: countRow?.total ?? 0 });
    }),
  );

  router.get(
    "/admin/pieces",
    wrap(async (_req, res) => {
      const db = deps.db!.orm;
      const rows = await db
        .select({
          piece: pieces,
          bookTitle: books.title,
          workTitle: works.title,
          workCatalogue: works.catalogue,
        })
        .from(pieces)
        .leftJoin(books, eq(pieces.bookId, books.id))
        .leftJoin(works, eq(pieces.workId, works.id))
        .orderBy(pieces.title);
      const versions = await db
        .select({
          pieceId: pieceVersions.pieceId,
          count: sql<number>`count(*)::int`,
          latest: sql<number>`max(${pieceVersions.version})::int`,
        })
        .from(pieceVersions)
        .groupBy(pieceVersions.pieceId);
      const byPiece = new Map(versions.map((v) => [v.pieceId, v]));

      res.json({
        items: rows.map(({ piece, bookTitle, workTitle, workCatalogue }) => ({
          ...piece,
          bookTitle,
          workTitle,
          workCatalogue,
          versionCount: byPiece.get(piece.id)?.count ?? 0,
          latestVersion: byPiece.get(piece.id)?.latest ?? null,
        })),
      });
    }),
  );

  router.get(
    "/admin/users/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (!user) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Admin actions ABOUT this user (role changes, future comps/disables) — not actions BY them.
      const recentAudit = await auditWithActor(db)
        .where(and(eq(auditEvents.subjectType, "user"), eq(auditEvents.subjectId, id)))
        .orderBy(desc(auditEvents.createdAt))
        .limit(20);
      res.json({ user, recentAudit });
    }),
  );

  router.patch(
    "/admin/users/:id/roles",
    wrap(async (req, res) => {
      const parsed = rolesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_roles", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (!target) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // An admin cannot remove their own admin bit — prevents locking the console.
      if (parsed.data.isAdmin === false && target.id === req.adminUser!.id) {
        res.status(409).json({ error: "cannot_demote_self" });
        return;
      }
      const [updated] = await db
        .update(users)
        .set({ ...parsed.data, updatedAt: sql`now()` })
        .where(eq(users.id, id))
        .returning();
      await audit(deps, req, "user.set_roles", { type: "user", id }, {
        changes: parsed.data,
        email: target.email,
      });
      res.json(updated);
    }),
  );

  function signCover(path: string | null): { coverUrl: string | null; coverThumbUrl: string | null } {
    if (!path || !deps.studio || !deps.catalog) return { coverUrl: null, coverThumbUrl: null };
    const thumbPath = path.replace(/cover\.webp$/, "cover_thumb.webp");
    return {
      coverUrl: deps.catalog.signReadUrl(deps.studio.bundleUrl(path)),
      coverThumbUrl: deps.catalog.signReadUrl(deps.studio.bundleUrl(thumbPath)),
    };
  }

  router.get(
    "/admin/works",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const rows = await db
        .select()
        .from(works)
        .where(q ? or(ilike(works.title, `%${q}%`), ilike(works.composer, `%${q}%`), ilike(works.catalogue, `%${q}%`)) : undefined)
        .orderBy(works.composer, works.sortIndex, works.title)
        .limit(100);
      const counts = await db
        .select({ workId: pieces.workId, count: sql<number>`count(*)::int` })
        .from(pieces)
        .groupBy(pieces.workId);
      const byWork = new Map(counts.map((c) => [c.workId, c.count]));
      res.json({ items: rows.map((w) => ({ ...w, pieceCount: byWork.get(w.id) ?? 0 })) });
    }),
  );

  router.post(
    "/admin/works",
    wrap(async (req, res) => {
      const parsed = workSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_work", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const w = parsed.data;
      // Dup check: normalized catalogue within composer — the check that stops a bulk
      // upload fragmenting one sonata into three works.
      if (w.catalogue) {
        const norm = normalizeCatalogue(w.catalogue);
        const siblings = await db
          .select()
          .from(works)
          .where(ilike(works.composer, `%${likeEsc(w.composer.split(" ").pop()!)}%`));
        const dup = siblings.find((s) => s.catalogue && normalizeCatalogue(s.catalogue) === norm);
        if (dup) {
          res.status(409).json({
            error: "work_exists",
            work: dup,
            message: `"${dup.title}" (${dup.catalogue}) already exists — select it instead of creating a duplicate.`,
          });
          return;
        }
      }
      const id = workSlugFor(w.composer, w.title, w.catalogue);
      const [existing] = await db.select().from(works).where(eq(works.id, id)).limit(1);
      if (existing) {
        res.status(409).json({ error: "work_exists", work: existing });
        return;
      }
      const [row] = await db
        .insert(works)
        .values({ id, title: w.title, composer: w.composer, catalogue: w.catalogue ?? null, workType: w.workType, sortIndex: w.sortIndex ?? null })
        .returning();
      await audit(deps, req, "work.create", { type: "work", id });
      res.status(201).json(row);
    }),
  );

  router.patch(
    "/admin/works/:id",
    wrap(async (req, res) => {
      const parsed = workSchema.partial().safeParse(req.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        res.status(400).json({ error: "invalid_work" });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [existing] = await db.select().from(works).where(eq(works.id, id)).limit(1);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [row] = await db
        .update(works)
        .set({ ...parsed.data, updatedAt: sql`now()` })
        .where(eq(works.id, id))
        .returning();
      // Works feed the app's collapse headers — edits rebuild the catalog like pieces do.
      if (deps.studio) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, "work.update", { type: "work", id }, { changes: parsed.data });
      res.json(row);
    }),
  );

  router.delete(
    "/admin/works/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [attached] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(pieces)
        .where(eq(pieces.workId, id));
      // RESTRICT: a navigation container must never be able to take content down.
      if ((attached?.count ?? 0) > 0) {
        res.status(409).json({ error: "work_has_pieces", count: attached!.count });
        return;
      }
      await db.delete(works).where(eq(works.id, id));
      await audit(deps, req, "work.delete", { type: "work", id });
      res.json({ ok: true });
    }),
  );

  const soloOf = (instrumentation: unknown): string =>
    (instrumentation as { solo?: string } | null)?.solo ?? "piano";

  router.get(
    "/admin/works/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
      if (!work) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const items = await db
        .select({
          id: pieces.id,
          title: pieces.title,
          subtitle: pieces.subtitle,
          composer: pieces.composer,
          workIndex: pieces.workIndex,
          status: pieces.status,
          publishedVersion: pieces.publishedVersion,
          difficulty: pieces.difficulty,
          instrumentation: pieces.instrumentation,
          updatedAt: pieces.updatedAt,
        })
        .from(pieces)
        .where(eq(pieces.workId, id))
        .orderBy(asc(pieces.workIndex), asc(pieces.id));
      const children = await db.select().from(works).where(eq(works.parentWorkId, id));
      const recentAudit = await auditWithActor(db)
        .where(and(eq(auditEvents.subjectType, "work"), eq(auditEvents.subjectId, id)))
        .orderBy(desc(auditEvents.createdAt))
        .limit(20);
      res.json({ ...work, pieces: items, children, recentAudit });
    }),
  );

  // Absorb a duplicate work into the canonical one: every piece moves over with its
  // movement number unchanged, then the emptied duplicate is deleted — one atomic
  // operation instead of N per-piece re-attaches plus a manual delete.
  router.post(
    "/admin/works/:id/merge",
    wrap(async (req, res) => {
      const parsed = mergeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_merge", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const sourceId = String(req.params.id);
      const targetId = parsed.data.targetWorkId;
      if (sourceId === targetId) {
        res.status(400).json({ error: "merge_self", message: "A work cannot be merged into itself." });
        return;
      }
      const [source] = await db.select().from(works).where(eq(works.id, sourceId)).limit(1);
      if (!source) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [target] = await db.select().from(works).where(eq(works.id, targetId)).limit(1);
      if (!target) {
        res.status(400).json({ error: "target_missing", message: "That target work no longer exists — refresh and pick again." });
        return;
      }
      const [child] = await db
        .select({ id: works.id, title: works.title })
        .from(works)
        .where(eq(works.parentWorkId, sourceId))
        .limit(1);
      if (child) {
        res.status(409).json({
          error: "work_has_children",
          message: `"${child.title}" is nested under this work — re-point its parent before merging.`,
        });
        return;
      }
      const moved = await db
        .select({ id: pieces.id, title: pieces.title, subtitle: pieces.subtitle, workIndex: pieces.workIndex, instrumentation: pieces.instrumentation })
        .from(pieces)
        .where(eq(pieces.workId, sourceId));
      if (!parsed.data.confirmMovementClash) {
        const existing = await db
          .select({ title: pieces.title, workIndex: pieces.workIndex, instrumentation: pieces.instrumentation })
          .from(pieces)
          .where(eq(pieces.workId, targetId));
        const clash = moved.find(
          (m) =>
            m.workIndex != null &&
            existing.some((e) => e.workIndex === m.workIndex && soloOf(e.instrumentation) === soloOf(m.instrumentation)),
        );
        if (clash) {
          res.status(409).json({
            error: "movement_taken",
            message: `Both works have a No. ${clash.workIndex} on the same instrument ("${clash.title}") — that usually means these aren't duplicates. Confirm to merge anyway (arrangements can legitimately share numbers).`,
            clashPieceId: clash.id,
          });
          return;
        }
      }
      await db.transaction(async (tx) => {
        await tx
          .update(pieces)
          .set({ workId: targetId, updatedAt: sql`now()` })
          .where(eq(pieces.workId, sourceId));
        await tx.delete(works).where(eq(works.id, sourceId));
      });
      if (deps.studio) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, "work.merge", { type: "work", id: targetId }, {
        absorbed: sourceId,
        absorbedTitle: source.title,
        movedPieces: moved.map((m) => m.id),
      });
      res.json({ ok: true, moved: moved.length });
    }),
  );

  router.get(
    "/admin/books",
    wrap(async (_req, res) => {
      const db = deps.db!.orm;
      const rows = await db.select().from(books).orderBy(books.sortIndex, books.title);
      const counts = await db
        .select({ bookId: pieces.bookId, count: sql<number>`count(*)::int` })
        .from(pieces)
        .groupBy(pieces.bookId);
      const byBook = new Map(counts.map((c) => [c.bookId, c.count]));
      res.json({
        items: rows.map((b) => ({
          ...b,
          pieceCount: byBook.get(b.id) ?? 0,
          ...signCover(b.coverPath),
        })),
      });
    }),
  );

  router.get(
    "/admin/books/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
      if (!book) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // The book's table of contents, ordered the way the app's bookshelf renders
      // it (numbered first, unnumbered trailing).
      const items = await db
        .select({
          id: pieces.id,
          title: pieces.title,
          subtitle: pieces.subtitle,
          composer: pieces.composer,
          bookIndex: pieces.bookIndex,
          status: pieces.status,
          publishedVersion: pieces.publishedVersion,
          difficulty: pieces.difficulty,
          instrumentation: pieces.instrumentation,
          updatedAt: pieces.updatedAt,
        })
        .from(pieces)
        .where(eq(pieces.bookId, id))
        .orderBy(asc(pieces.bookIndex), asc(pieces.title));
      const recentAudit = await auditWithActor(db)
        .where(and(eq(auditEvents.subjectType, "book"), eq(auditEvents.subjectId, id)))
        .orderBy(desc(auditEvents.createdAt))
        .limit(20);
      res.json({ ...book, ...signCover(book.coverPath), pieces: items, recentAudit });
    }),
  );

  router.patch(
    "/admin/books/:id",
    wrap(async (req, res) => {
      const parsed = bookEditSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_book", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [existing] = await db.select().from(books).where(eq(books.id, id)).limit(1);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [row] = await db
        .update(books)
        .set({ ...parsed.data, updatedAt: sql`now()` })
        .where(eq(books.id, id))
        .returning();
      // Title/author/sort feed the app's bookshelf — edits rebuild like work edits do.
      if (deps.studio) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, "book.update", { type: "book", id }, { changes: parsed.data });
      res.json({ ...row!, ...signCover(row!.coverPath) });
    }),
  );

  router.delete(
    "/admin/books/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
      if (!book) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [attached] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(pieces)
        .where(eq(pieces.bookId, id));
      // RESTRICT, same as works: a shelf must never be able to take content down.
      if ((attached?.count ?? 0) > 0) {
        res.status(409).json({ error: "book_has_pieces", count: attached!.count });
        return;
      }
      await db.delete(books).where(eq(books.id, id));
      if (book.coverPath && deps.studio?.deleteBundleBlob) {
        await deps.studio.deleteBundleBlob(book.coverPath);
        await deps.studio.deleteBundleBlob(book.coverPath.replace(/cover\.webp$/, "cover_thumb.webp"));
      }
      await audit(deps, req, "book.delete", { type: "book", id }, { title: book.title });
      res.json({ ok: true });
    }),
  );

  // Bulk renumber: the FINAL state of the whole book is validated before anything
  // is written, so swaps (3↔7) can't trip a per-piece clash guard halfway through.
  router.put(
    "/admin/books/:id/numbering",
    wrap(async (req, res) => {
      const parsed = numberingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_numbering", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
      if (!book) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const members = await db
        .select({ id: pieces.id, bookIndex: pieces.bookIndex, status: pieces.status })
        .from(pieces)
        .where(eq(pieces.bookId, id));
      const memberIds = new Set(members.map((m) => m.id));
      const seen = new Set<string>();
      for (const e of parsed.data.entries) {
        if (!memberIds.has(e.pieceId)) {
          res.status(400).json({ error: "not_in_book", pieceId: e.pieceId });
          return;
        }
        if (seen.has(e.pieceId)) {
          res.status(400).json({ error: "invalid_numbering", message: `"${e.pieceId}" appears twice.` });
          return;
        }
        seen.add(e.pieceId);
      }
      const final = new Map(members.map((m) => [m.id, m.bookIndex]));
      for (const e of parsed.data.entries) final.set(e.pieceId, e.bookIndex);
      const used = new Map<number, string>();
      for (const [pieceId, idx] of final) {
        if (idx == null) continue;
        if (used.has(idx)) {
          res.status(409).json({
            error: "book_index_taken",
            message: `No. ${idx} would be assigned to both "${used.get(idx)}" and "${pieceId}".`,
          });
          return;
        }
        used.set(idx, pieceId);
      }
      const changes = parsed.data.entries.filter(
        (e) => members.find((m) => m.id === e.pieceId)!.bookIndex !== e.bookIndex,
      );
      await db.transaction(async (tx) => {
        for (const e of changes) {
          await tx
            .update(pieces)
            .set({ bookIndex: e.bookIndex, updatedAt: sql`now()` })
            .where(eq(pieces.id, e.pieceId));
        }
      });
      if (changes.length > 0 && members.some((m) => m.status === "published") && deps.studio) {
        await rebuildCatalog(db, deps.studio);
      }
      await audit(deps, req, "book.renumber", { type: "book", id }, { changes });
      res.json({ ok: true, changed: changes.length });
    }),
  );

  async function storeCover(bookId: string, file: Express.Multer.File): Promise<string> {
    const processed = await processCover(file.buffer);
    const coverPath = `books/${bookId}/cover.webp`;
    await deps.studio!.putBundleBlob(coverPath, processed.cover, "image/webp");
    await deps.studio!.putBundleBlob(
      `books/${bookId}/cover_thumb.webp`,
      processed.thumb,
      "image/webp",
    );
    return coverPath;
  }

  router.post(
    "/admin/books",
    coverUpload.single("cover"),
    wrap(async (req, res) => {
      if (!deps.studio) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const parsed = bookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_book", detail: parsed.error.issues });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "cover_required" });
        return;
      }
      const id = bookSlug(parsed.data.title);
      if (!id) {
        res.status(400).json({ error: "invalid_book", detail: "title yields an empty id" });
        return;
      }
      const db = deps.db!.orm;
      const [existing] = await db.select().from(books).where(eq(books.id, id)).limit(1);
      if (existing) {
        res.status(409).json({ error: "book_exists", id });
        return;
      }
      let coverPath: string;
      try {
        coverPath = await storeCover(id, req.file);
      } catch (err) {
        if (err instanceof CoverError) {
          res.status(400).json({ error: "invalid_cover", message: err.message });
          return;
        }
        throw err;
      }
      const [row] = await db
        .insert(books)
        .values({ ...parsed.data, id, coverPath })
        .returning();
      await audit(deps, req, "book.create", { type: "book", id });
      res.status(201).json({ ...row, ...signCover(coverPath) });
    }),
  );

  router.put(
    "/admin/books/:id/cover",
    coverUpload.single("cover"),
    wrap(async (req, res) => {
      if (!deps.studio) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
      if (!book) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "cover_required" });
        return;
      }
      let coverPath: string;
      try {
        coverPath = await storeCover(id, req.file);
      } catch (err) {
        if (err instanceof CoverError) {
          res.status(400).json({ error: "invalid_cover", message: err.message });
          return;
        }
        throw err;
      }
      const [row] = await db
        .update(books)
        .set({ coverPath, updatedAt: sql`now()` })
        .where(eq(books.id, id))
        .returning();
      // A previously coverless book (created implicitly at publish) just became
      // presentable — its catalog entry gains cover_url. Same-path replacements
      // need no rebuild: the emitted URL is unchanged and signed per request.
      if (!book.coverPath && deps.studio) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, "book.set_cover", { type: "book", id });
      res.json({ ...row, ...signCover(coverPath) });
    }),
  );

  router.patch(
    "/admin/pieces/:id",
    wrap(async (req, res) => {
      const parsed = pieceEditSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_edit", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [piece] = await db.select().from(pieces).where(eq(pieces.id, id)).limit(1);
      if (!piece) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const p = parsed.data;
      if (p.expectedUpdatedAt) {
        const expected = new Date(p.expectedUpdatedAt).getTime();
        if (Number.isNaN(expected)) {
          res.status(400).json({ error: "invalid_edit", message: "Malformed concurrency token — reload the page." });
          return;
        }
        if (expected !== piece.updatedAt.getTime()) {
          res.status(409).json({
            error: "stale_edit",
            message: "Someone else changed this piece since you opened it — reload and re-apply your edits.",
          });
          return;
        }
      }
      const finalRights = p.rights ?? piece.rights;
      const finalNote = p.rightsNote === undefined ? piece.rightsNote : p.rightsNote;
      // Takedown goes through Archive (fast, explicit) — a published piece can't
      // quietly hold non-publishable rights.
      if (piece.status === "published" && (finalRights === "unknown" || finalRights === "blocked")) {
        res.status(409).json({
          error: "archive_first",
          message: "This piece is live — archive it before marking its rights unresolved/blocked.",
        });
        return;
      }
      if (finalRights === "public_domain" && !(finalNote ?? "").trim()) {
        res.status(400).json({
          error: "provenance_required",
          message: "Public-domain pieces need a provenance note (which edition the score came from).",
        });
        return;
      }
      // Work membership: clearing the work clears the movement number with it; a
      // movement number without a work is meaningless.
      const finalWorkId = p.workId === undefined ? piece.workId : p.workId;
      const finalWorkIndex =
        finalWorkId == null ? null : p.workIndex === undefined ? piece.workIndex : p.workIndex;
      if (p.workIndex != null && finalWorkId == null) {
        res.status(400).json({
          error: "work_index_without_work",
          message: "A movement number needs a work — pick the work first.",
        });
        return;
      }
      if (finalWorkId && finalWorkId !== piece.workId) {
        const [work] = await db.select().from(works).where(eq(works.id, finalWorkId)).limit(1);
        if (!work) {
          res.status(400).json({ error: "work_missing", message: "That work no longer exists — refresh and pick again." });
          return;
        }
      }
      const membershipChanged = finalWorkId !== piece.workId || finalWorkIndex !== piece.workIndex;
      if (finalWorkId && finalWorkIndex != null && membershipChanged && !p.confirmMovementClash) {
        const myInstrument = ((piece.instrumentation as { solo?: string } | null)?.solo ?? "piano");
        const siblings = await db
          .select({ id: pieces.id, title: pieces.title, subtitle: pieces.subtitle, status: pieces.status, instrumentation: pieces.instrumentation })
          .from(pieces)
          .where(and(eq(pieces.workId, finalWorkId), eq(pieces.workIndex, finalWorkIndex), ne(pieces.id, id)));
        const clash = siblings.find(
          (s) => ((s.instrumentation as { solo?: string } | null)?.solo ?? "piano") === myInstrument,
        );
        if (clash) {
          res.status(409).json({
            error: "movement_taken",
            message: `No. ${finalWorkIndex} in this work is already "${clash.title}${clash.subtitle ? ` · ${clash.subtitle}` : ""}" (${clash.status}) on the same instrument — same movement + same instrument is usually a duplicate. Confirm to apply anyway (arrangements can legitimately share numbers).`,
            clashPieceId: clash.id,
          });
          return;
        }
      }

      // Same rule as works: detaching the book clears its number — otherwise the
      // stale number silently re-applies on the next attach.
      const finalBookId = p.bookId === undefined ? piece.bookId : p.bookId;
      const finalIndex =
        finalBookId == null ? null : p.bookIndex === undefined ? piece.bookIndex : p.bookIndex;
      if (p.bookIndex != null && finalBookId == null) {
        res.status(400).json({
          error: "book_index_without_book",
          message: "A number-in-book needs a book — pick the book first.",
        });
        return;
      }
      if (finalBookId) {
        const [book] = await db.select().from(books).where(eq(books.id, finalBookId)).limit(1);
        if (!book) {
          res.status(400).json({ error: "book_missing" });
          return;
        }
        if (finalIndex != null) {
          const clash = await db
            .select({ id: pieces.id, title: pieces.title, subtitle: pieces.subtitle })
            .from(pieces)
            .where(and(eq(pieces.bookId, finalBookId), eq(pieces.bookIndex, finalIndex), sql`${pieces.id} <> ${id}`))
            .limit(1);
          if (clash.length > 0) {
            res.status(409).json({
              error: "book_index_taken",
              message: `No. ${finalIndex} in that book is already "${clash[0]!.title}${clash[0]!.subtitle ? ` · ${clash[0]!.subtitle}` : ""}".`,
            });
            return;
          }
        }
      }

      const [updated] = await db
        .update(pieces)
        .set({
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.composer !== undefined ? { composer: p.composer } : {}),
          ...(p.subtitle !== undefined ? { subtitle: p.subtitle } : {}),
          ...(p.difficulty !== undefined ? { difficulty: p.difficulty } : {}),
          ...(p.tracking !== undefined ? { tracking: p.tracking } : {}),
          ...(p.bookId !== undefined || p.bookIndex !== undefined
            ? { bookId: finalBookId, bookIndex: finalIndex }
            : {}),
          ...(p.workId !== undefined || p.workIndex !== undefined
            ? { workId: finalWorkId, workIndex: finalWorkIndex }
            : {}),
          ...(p.rights !== undefined ? { rights: p.rights } : {}),
          ...(p.rightsNote !== undefined ? { rightsNote: p.rightsNote } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(pieces.id, id))
        .returning();

      if (piece.status === "published" && deps.studio) {
        await rebuildCatalog(db, deps.studio);
      }
      await audit(deps, req, "piece.update", { type: "piece", id }, { changes: p });
      res.json(updated);
    }),
  );

  // Plain archive, or a one-step TAKEDOWN when a rights concern is given: removed
  // from the app catalog + rights flagged + reason recorded, atomically.
  router.post(
    "/admin/pieces/:id/archive",
    wrap(async (req, res) => {
      const body = z
        .object({
          rights: z.enum(["unknown", "blocked"]).optional(),
          rightsNote: z.string().max(2000).optional(),
        })
        .safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: "invalid_archive", detail: body.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [piece] = await db.select().from(pieces).where(eq(pieces.id, id)).limit(1);
      if (!piece) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (piece.status !== "published") {
        res.status(409).json({ error: "not_published", status: piece.status });
        return;
      }
      const [updated] = await db
        .update(pieces)
        .set({
          status: "archived",
          ...(body.data.rights ? { rights: body.data.rights } : {}),
          ...(body.data.rightsNote !== undefined ? { rightsNote: body.data.rightsNote } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(pieces.id, id))
        .returning();
      if (deps.studio) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, body.data.rights ? "piece.takedown" : "piece.archive", { type: "piece", id }, {
        ...(body.data.rights ? { rights: body.data.rights, note: body.data.rightsNote } : {}),
      });
      res.json(updated);
    }),
  );

  router.post(
    "/admin/pieces/:id/restore",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [piece] = await db.select().from(pieces).where(eq(pieces.id, id)).limit(1);
      if (!piece) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (piece.status !== "archived") {
        res.status(409).json({ error: "not_archived", status: piece.status });
        return;
      }
      if (piece.publishedVersion == null) {
        res.status(409).json({ error: "no_published_version" });
        return;
      }
      if (piece.rights !== "public_domain" && piece.rights !== "licensed") {
        res.status(409).json({ error: "rights_blocked", rights: piece.rights });
        return;
      }
      const [updated] = await db
        .update(pieces)
        .set({ status: "published", updatedAt: sql`now()` })
        .where(eq(pieces.id, id))
        .returning();
      if (deps.studio) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, "piece.restore", { type: "piece", id });
      res.json(updated);
    }),
  );

  router.get(
    "/admin/pieces/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [piece] = await db
        .select()
        .from(pieces)
        .where(eq(pieces.id, id))
        .limit(1);
      if (!piece) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const sign = (url: string) => (deps.catalog ? deps.catalog.signReadUrl(url) : url);

      const versionRows = await db
        .select({ version: pieceVersions, publishedByEmail: users.email })
        .from(pieceVersions)
        .leftJoin(users, eq(pieceVersions.publishedBy, users.id))
        .where(eq(pieceVersions.pieceId, piece.id))
        .orderBy(desc(pieceVersions.version));
      const versions = versionRows.map(({ version: v, publishedByEmail }) => ({
        ...v,
        publishedByEmail,
        files: (v.files as { role: string; variant?: string; path: string; bytes?: number; sha256?: string }[]).map(
          (f) => ({ ...f, url: deps.studio ? sign(deps.studio.bundleUrl(f.path)) : null }),
        ),
      }));

      const book = piece.bookId
        ? (await db.select().from(books).where(eq(books.id, piece.bookId)).limit(1))[0] ?? null
        : null;
      const bookOut = book
        ? { ...book, ...signCover(book.coverPath) }
        : null;

      // Work membership context: the work row plus every sibling in the same work,
      // so the reviewer sees the whole composition at a glance (missing movements,
      // other-instrument arrangements) without leaving the panel.
      const work = piece.workId
        ? (await db.select().from(works).where(eq(works.id, piece.workId)).limit(1))[0] ?? null
        : null;
      const workSiblings = work
        ? await db
            .select({
              id: pieces.id,
              title: pieces.title,
              subtitle: pieces.subtitle,
              workIndex: pieces.workIndex,
              status: pieces.status,
              publishedVersion: pieces.publishedVersion,
              instrumentation: pieces.instrumentation,
            })
            .from(pieces)
            .where(and(eq(pieces.workId, work.id), ne(pieces.id, piece.id)))
            .orderBy(asc(pieces.workIndex), asc(pieces.id))
        : [];

      // Build history for this piece id (any outcome) — newest first.
      const jobs = await db
        .select({
          id: studioJobs.id,
          status: studioJobs.status,
          checkStatus: studioJobs.checkStatus,
          publishedVersion: studioJobs.publishedVersion,
          error: studioJobs.error,
          createdAt: studioJobs.createdAt,
          updatedAt: studioJobs.updatedAt,
        })
        .from(studioJobs)
        .where(eq(studioJobs.pieceId, piece.id))
        .orderBy(desc(studioJobs.createdAt))
        .limit(20);

      // Original sources, both generations: studio uploads live at
      // staging/<jobId>/ (tracked on the job row, with original filenames); the
      // pre-studio launch pieces were archived at <pieceId>/ in piece-sources.
      const sources: { path: string; bytes: number; url: string | null; kind?: string; originalName?: string; origin: string }[] = [];
      if (deps.studio) {
        const latestWithSources = (
          await db
            .select({ sources: studioJobs.sources })
            .from(studioJobs)
            .where(eq(studioJobs.pieceId, piece.id))
            .orderBy(desc(studioJobs.updatedAt))
            .limit(5)
        ).find((j) => Array.isArray(j.sources) && (j.sources as unknown[]).length > 0);
        for (const s of (latestWithSources?.sources ?? []) as {
          path: string;
          bytes: number;
          kind: string;
          originalName: string;
        }[]) {
          sources.push({
            path: s.path,
            bytes: s.bytes,
            kind: s.kind,
            originalName: s.originalName,
            url: sign(deps.studio.sourceUrl(s.path)),
            origin: "studio_upload",
          });
        }
        for (const b of await deps.studio.listSources(`${piece.id}/`)) {
          sources.push({
            path: b.path,
            bytes: b.bytes,
            originalName: b.path.split("/").pop(),
            url: sign(deps.studio.sourceUrl(b.path)),
            origin: "archive",
          });
        }
      }

      const recentAudit = await auditWithActor(db)
        .where(and(eq(auditEvents.subjectType, "piece"), eq(auditEvents.subjectId, id)))
        .orderBy(desc(auditEvents.createdAt))
        .limit(20);

      // Preview audio never ships in published bundles (the app synthesizes locally
      // from the same score data) — but the latest build's staged render is the exact
      // sound reviewers approved, so surface it for spot-checks while it exists.
      let previewAudio: { url: string; jobId: string; renderedAt: string } | null = null;
      if (deps.studio) {
        const recentJobs = await db
          .select({ id: studioJobs.id, artifacts: studioJobs.artifacts, updatedAt: studioJobs.updatedAt })
          .from(studioJobs)
          .where(eq(studioJobs.pieceId, piece.id))
          .orderBy(desc(studioJobs.updatedAt))
          .limit(10);
        for (const j of recentJobs) {
          const hit = (j.artifacts as { role: string; path: string }[] | null)?.find(
            (a) => a.role === "preview_audio",
          );
          if (hit) {
            previewAudio = {
              url: sign(deps.studio.bundleUrl(hit.path)),
              jobId: j.id,
              renderedAt: j.updatedAt.toISOString(),
            };
            break;
          }
        }
      }

      res.json({ ...piece, book: bookOut, work, workSiblings, previewAudio, versions, jobs, sources, recentAudit });
    }),
  );

  return router;
}
