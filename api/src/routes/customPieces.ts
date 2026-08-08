import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { customPieces, pieces } from "../db/schema";

type Orm = NonNullable<Deps["db"]>["orm"];
type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];

// NFC only — do not fold diacritics here; Für/Fur must stay distinct identities (folding belongs to piece_suggestion's fold()).
export function normalizeLabel(label: string): string {
  return label.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

// onConflictDoUpdate is intentional — a duplicate label is success, and display_label must follow the latest casing typed.
export async function upsertCustomPiece(
  tx: Tx,
  teacherId: string,
  label: string,
): Promise<string | null> {
  const display = label.trim();
  if (!display) return null;
  const [row] = await tx
    .insert(customPieces)
    .values({ teacherId, displayLabel: display, normalizedLabel: normalizeLabel(display) })
    .onConflictDoUpdate({
      target: [customPieces.teacherId, customPieces.normalizedLabel],
      set: { displayLabel: display, updatedAt: sql`now()` },
    })
    .returning({ id: customPieces.id });
  return row?.id ?? null;
}

// Relies on custom_piece_id ON DELETE SET NULL (schema) — deleting here must not orphan notes that reference it.
export async function deleteCustomPiecesOf(tx: Tx, teacherId: string): Promise<void> {
  await tx.delete(customPieces).where(eq(customPieces.teacherId, teacherId));
}

export function customPiecesRouter(deps: Deps): Router {
  const router = Router();
  const guards = [requireAuth(deps.auth), requireUser(deps)];

  router.post(
    "/v1/custom-pieces/:id/link",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const body = req.body ?? {};
      if (!("pieceId" in body)) {
        res.status(400).json({ error: "piece_id_required" });
        return;
      }
      const pieceId = typeof body.pieceId === "string" ? body.pieceId : null;
      // Scope is in the predicate — don't split id/teacherId checks, or a 404 would become a 403 that leaks existence.
      const [entity] = await db
        .select()
        .from(customPieces)
        .where(and(eq(customPieces.id, String(req.params.id)), eq(customPieces.teacherId, me.id)))
        .limit(1);
      if (!entity) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (pieceId) {
        const [piece] = await db.select({ id: pieces.id }).from(pieces).where(eq(pieces.id, pieceId)).limit(1);
        if (!piece) {
          res.status(400).json({ error: "unknown_piece" });
          return;
        }
      }
      const [updated] = await db
        .update(customPieces)
        .set({
          linkedPieceId: pieceId,
          linkedAt: pieceId ? sql`now()` : null,
          updatedAt: sql`now()`,
        })
        .where(eq(customPieces.id, entity.id))
        .returning();
      await userAudit(deps, req, "custom_piece.link", { type: "custom_piece", id: entity.id }, {
        from: entity.linkedPieceId,
        to: pieceId,
      });
      res.json({ customPiece: updated });
    }),
  );

  return router;
}
