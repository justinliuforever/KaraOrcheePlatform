import { and, asc, eq, gt, sql } from "drizzle-orm";
import { notedPieces } from "../db/schema";
import type { Orm } from "../db/client";

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];

/// New slots are spaced so a later insert between two of them needs no renumber.
export const SLOT_STEP = 1000;

export const MAX_SLOTS = 6;

export interface SlotFacts {
  pieceId?: string | null;
  pieceLabel?: string | null;
  pieceSource?: string | null;
  customPieceId?: string | null;
  scoreScanId?: string | null;
}

export async function slotsOf(tx: Tx, noteId: string) {
  return await tx
    .select()
    .from(notedPieces)
    .where(eq(notedPieces.noteId, noteId))
    .orderBy(asc(notedPieces.sortIndex));
}

export async function nextSortIndex(tx: Tx, noteId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${notedPieces.sortIndex})` })
    .from(notedPieces)
    .where(eq(notedPieces.noteId, noteId));
  const max = row?.max;
  return max === null || max === undefined ? 0 : Number(max) + SLOT_STEP;
}

/// The binding rule, in one place: naming a piece puts the photographs away, and the caller is told which happened.
export function applyBinding(facts: SlotFacts, current: { pieceId: string | null; scoreScanId: string | null }) {
  const values: Record<string, unknown> = {};
  let scoreDetached = false;
  if (facts.pieceId !== undefined) values.pieceId = facts.pieceId;
  if (facts.pieceLabel !== undefined) values.pieceLabel = facts.pieceLabel;
  if (facts.pieceSource !== undefined) values.pieceSource = facts.pieceSource;
  if (facts.customPieceId !== undefined) values.customPieceId = facts.customPieceId;
  if (facts.scoreScanId !== undefined) values.scoreScanId = facts.scoreScanId;

  const namingPiece = values.pieceId != null;
  const holdsScan = values.scoreScanId !== undefined ? values.scoreScanId != null : current.scoreScanId !== null;
  if (namingPiece && holdsScan) {
    values.scoreScanId = null;
    scoreDetached = current.scoreScanId !== null;
  }
  // A photograph never takes a named piece off by itself: clearing the piece is the caller's own act.
  if (values.scoreScanId != null && values.pieceId === undefined && current.pieceId !== null) {
    return { values, scoreDetached, refused: true as const };
  }
  return { values, scoreDetached, refused: false as const };
}

/// Renumbered only when two slots would otherwise collide — a move normally rewrites one row.
export async function moveSlot(tx: Tx, noteId: string, slotId: string, toIndex: number): Promise<void> {
  const clash = await tx
    .select({ id: notedPieces.id })
    .from(notedPieces)
    .where(and(eq(notedPieces.noteId, noteId), eq(notedPieces.sortIndex, toIndex)))
    .limit(1);
  if (clash.length) {
    await tx
      .update(notedPieces)
      .set({ sortIndex: sql`${notedPieces.sortIndex} + ${SLOT_STEP}`, updatedAt: sql`now()` })
      .where(and(eq(notedPieces.noteId, noteId), gt(notedPieces.sortIndex, toIndex - 1)));
  }
  await tx
    .update(notedPieces)
    .set({ sortIndex: toIndex, updatedAt: sql`now()` })
    .where(and(eq(notedPieces.id, slotId), eq(notedPieces.noteId, noteId)));
}
