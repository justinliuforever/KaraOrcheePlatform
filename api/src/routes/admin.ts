import { Router } from "express";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireAdmin } from "../admin";
import { books, pieces, pieceVersions, users } from "../db/schema";

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
