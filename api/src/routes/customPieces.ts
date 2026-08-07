import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { customPieces, pieces } from "../db/schema";

type Orm = NonNullable<Deps["db"]>["orm"];
type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];

// Identity key. NFC composes the two spellings of one visible label into one row;
// DIACRITICS SURVIVE, so Für Elise and Fur Elise stay two entities that may suggest
// each other and can only ever be joined by the teacher (FG-20). Composition is not
// folding: folding belongs to matching, not identity.
export function normalizeLabel(label: string): string {
  return label.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

// One entity per (teacher, normalized label). A unique-index conflict is the SUCCESS
// path — the teacher typed the same piece again — and the row's display_label follows
// the latest casing they used. Runs inside the caller's transaction so a lesson and
// its entity commit together or not at all.
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

// The entity dies with its owner. `custom_piece_id` is ON DELETE SET NULL everywhere,
// so a sent note that outlives the teacher keeps the piece_label a student reads.
export async function deleteCustomPiecesOf(tx: Tx, teacherId: string): Promise<void> {
  await tx.delete(customPieces).where(eq(customPieces.teacherId, teacherId));
}

export function customPiecesRouter(deps: Deps): Router {
  const router = Router();
  const guards = [requireAuth(deps.auth), requireUser(deps)];

  // The teacher's own decision that a typed name IS a catalog piece. There is no list
  // endpoint and no unlink UI: nothing this release would consume them, and an idle
  // endpoint is a surface with no reader.
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
      // Scope is in the predicate: someone else's entity is not found, never forbidden.
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
