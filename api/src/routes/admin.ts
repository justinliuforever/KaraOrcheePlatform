import { Router } from "express";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireAdmin, audit } from "../admin";
import { books, pieces, pieceVersions, users } from "../db/schema";

const bookSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_]{2,63}$/, "lowercase slug"),
  title: z.string().min(1).max(200),
  author: z.string().max(120).optional(),
  publisher: z.string().max(120).optional(),
  edition: z.string().max(120).optional(),
  rights: z.enum(["public_domain", "licensed", "unknown", "blocked"]).default("unknown"),
  rightsNote: z.string().max(2000).optional(),
  sortIndex: z.number().int().optional(),
});

export function adminRouter(deps: Deps): Router {
  const router = Router();
  router.use("/admin", requireAuth(deps.auth), requireAdmin(deps));

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
        })
        .from(pieces)
        .leftJoin(books, eq(pieces.bookId, books.id))
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
        items: rows.map(({ piece, bookTitle }) => ({
          ...piece,
          bookTitle,
          versionCount: byPiece.get(piece.id)?.count ?? 0,
          latestVersion: byPiece.get(piece.id)?.latest ?? null,
        })),
      });
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
      res.json({ items: rows.map((b) => ({ ...b, pieceCount: byBook.get(b.id) ?? 0 })) });
    }),
  );

  router.post(
    "/admin/books",
    wrap(async (req, res) => {
      const parsed = bookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_book", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const [existing] = await db
        .select()
        .from(books)
        .where(eq(books.id, parsed.data.id))
        .limit(1);
      if (existing) {
        res.status(409).json({ error: "book_exists" });
        return;
      }
      const [row] = await db.insert(books).values(parsed.data).returning();
      await audit(deps, req.adminUser!, "book.create", { type: "book", id: parsed.data.id });
      res.status(201).json(row);
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
      const versions = await db
        .select()
        .from(pieceVersions)
        .where(eq(pieceVersions.pieceId, piece.id))
        .orderBy(desc(pieceVersions.version));
      const book = piece.bookId
        ? (await db.select().from(books).where(eq(books.id, piece.bookId)).limit(1))[0] ?? null
        : null;

      res.json({ ...piece, book, versions });
    }),
  );

  return router;
}
