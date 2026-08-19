import { asc, eq, inArray } from "drizzle-orm";
import { lessonPieces, notedPieces } from "../db/schema";
import type { Orm } from "../db/client";

type Reader = Orm | Parameters<Parameters<Orm["transaction"]>[0]>[0];

/// Derived, never stored: the four labels the requirement document names are a reading of which fields a slot carries.
export type SlotKind = "engraved" | "scanned" | "titled" | "none";

export function slotKind(slot: { pieceId: string | null; scoreScanId: string | null; pieceLabel: string | null }): SlotKind {
  if (slot.pieceId) return "engraved";
  if (slot.scoreScanId) return "scanned";
  if (slot.pieceLabel) return "titled";
  return "none";
}

/// Additive on the wire: every existing key stays, and an installed binary ignores this one.
export function notePieceWire(slot: typeof notedPieces.$inferSelect) {
  return {
    id: slot.id,
    sortIndex: slot.sortIndex,
    kind: slotKind(slot),
    pieceId: slot.pieceId,
    pieceLabel: slot.pieceLabel,
    pieceVersion: slot.pieceVersion,
    scoreScanId: slot.scoreScanId,
    scoreScanDetachedAt: slot.scoreScanDetachedAt,
    summary: slot.summary,
  };
}

/// The student never learns a scan id — the same rule the singular projection already follows.
export function studentPieceWire(slot: typeof notedPieces.$inferSelect) {
  const { scoreScanId: _s, ...rest } = notePieceWire(slot);
  return rest;
}

export function lessonPieceWire(slot: typeof lessonPieces.$inferSelect) {
  return {
    id: slot.id,
    sortIndex: slot.sortIndex,
    kind: slotKind(slot),
    pieceId: slot.pieceId,
    pieceLabel: slot.pieceLabel,
    pieceSource: slot.pieceSource,
    scoreScanId: slot.scoreScanId,
  };
}

/// Synthesised when no slot exists yet: during dual-write the singular columns are the truth, and a
/// plural view that reads empty while they name a piece is a trap for every client that trusts it.
export async function notePieces(
  db: Reader,
  note: { id: string; pieceId: string | null; pieceLabel: string | null; scoreScanId: string | null;
          pieceVersion: number | null; scoreScanDetachedAt: Date | null },
): Promise<(typeof notedPieces.$inferSelect)[]> {
  const rows = await db
    .select()
    .from(notedPieces)
    .where(eq(notedPieces.noteId, note.id))
    .orderBy(asc(notedPieces.sortIndex));
  if (rows.length) return rows;
  if (!note.pieceId && !note.pieceLabel && !note.scoreScanId) return [];
  return [{
    id: `pending:${note.id}`,
    noteId: note.id,
    sortIndex: 0,
    practiceSubjectId: null,
    pieceId: note.pieceId,
    pieceLabel: note.pieceLabel,
    pieceSource: null,
    customPieceId: null,
    scoreScanId: note.scoreScanId,
    scoreScanDetachedAt: note.scoreScanDetachedAt,
    pieceVersion: note.pieceVersion,
    pieceSuggestionDismissed: [],
    summary: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }];
}

export async function lessonPiecesFor(db: Reader, lessonIds: string[]) {
  if (!lessonIds.length) return [];
  return await db
    .select()
    .from(lessonPieces)
    .where(inArray(lessonPieces.lessonSessionId, lessonIds))
    .orderBy(asc(lessonPieces.sortIndex));
}
