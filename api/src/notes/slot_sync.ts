import { and, eq } from "drizzle-orm";
import { lessonPieces, lessonSessions, notedPieces, notes } from "../db/schema";
import type { Orm } from "../db/client";

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];
/// Some writers run outside a transaction; the sync is idempotent either way.
type Writer = Tx | Orm;

/// Slot 0 mirrors the singular columns for the whole dual-write era; the columns stay the truth until they retire, so nothing here may fail a request.
export const FIRST_SLOT = 0;

function named(row: { pieceId: string | null; pieceLabel: string | null; scoreScanId: string | null }): boolean {
  return row.pieceId !== null || row.pieceLabel !== null || row.scoreScanId !== null;
}

export async function syncLessonSlot(tx: Writer, lesson: typeof lessonSessions.$inferSelect): Promise<void> {
  const values = {
    pieceId: lesson.pieceId,
    pieceLabel: lesson.pieceLabel,
    pieceSource: lesson.pieceSource,
    customPieceId: lesson.customPieceId,
    scoreScanId: lesson.scoreScanId,
  };
  const [existing] = await tx
    .select({ id: lessonPieces.id })
    .from(lessonPieces)
    .where(and(eq(lessonPieces.lessonSessionId, lesson.id), eq(lessonPieces.sortIndex, FIRST_SLOT)))
    .limit(1);
  if (existing) {
    await tx.update(lessonPieces).set(values).where(eq(lessonPieces.id, existing.id));
    return;
  }
  if (!named(lesson)) return;
  await tx
    .insert(lessonPieces)
    .values({ lessonSessionId: lesson.id, sortIndex: FIRST_SLOT, ...values })
    .onConflictDoNothing();
}

export async function syncNoteSlot(tx: Writer, note: typeof notes.$inferSelect): Promise<void> {
  const values = {
    pieceId: note.pieceId,
    pieceLabel: note.pieceLabel,
    customPieceId: note.customPieceId,
    scoreScanId: note.scoreScanId,
    scoreScanDetachedAt: note.scoreScanDetachedAt,
    pieceVersion: note.pieceVersion,
    pieceSuggestionDismissed: note.pieceSuggestionDismissed,
  };
  const [existing] = await tx
    .select({ id: notedPieces.id })
    .from(notedPieces)
    .where(and(eq(notedPieces.noteId, note.id), eq(notedPieces.sortIndex, FIRST_SLOT)))
    .limit(1);
  if (existing) {
    await tx.update(notedPieces).set(values).where(eq(notedPieces.id, existing.id));
    return;
  }
  if (!named(note)) return;
  await tx
    .insert(notedPieces)
    .values({ noteId: note.id, sortIndex: FIRST_SLOT, ...values })
    .onConflictDoNothing();
}
