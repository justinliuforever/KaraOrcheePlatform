import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { lessonPieces, lessonSessions, noteAnnotations, notedPieces, notes } from "../db/schema";
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
  // The LOWEST slot, not literally index 0 — once slots can be reordered or inserted before, the mirror is whichever comes first.
  const [existing] = await tx
    .select({ id: lessonPieces.id })
    .from(lessonPieces)
    .where(eq(lessonPieces.lessonSessionId, lesson.id))
    .orderBy(asc(lessonPieces.sortIndex))
    .limit(1);
  if (existing) {
    await tx.update(lessonPieces).set({ ...values, updatedAt: sql`now()` }).where(eq(lessonPieces.id, existing.id));
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
    .where(eq(notedPieces.noteId, note.id))
    .orderBy(asc(notedPieces.sortIndex))
    .limit(1);
  if (existing) {
    await tx.update(notedPieces).set({ ...values, updatedAt: sql`now()` }).where(eq(notedPieces.id, existing.id));
    return;
  }
  if (!named(note)) return;
  const [minted] = await tx
    .insert(notedPieces)
    .values({ noteId: note.id, sortIndex: FIRST_SLOT, ...values })
    .onConflictDoNothing()
    .returning({ id: notedPieces.id });
  if (!minted) return;
  // The note's existing items belong to the piece it just named — leaving them unstamped strands them in General where no later backfill looks.
  // Correct only while a note holds ONE slot: delete this when the review screen can create a second.
  await tx
    .update(noteAnnotations)
    .set({ notePieceId: minted.id, groundedPieceId: sql`coalesce(${noteAnnotations.groundedPieceId}, ${minted.id})` })
    .where(and(eq(noteAnnotations.noteId, note.id), isNull(noteAnnotations.notePieceId)));
}

/// The other half of the dual-write. The columns are still the truth every read path and the send gate
/// consult, so a slot edit that never reached them would name a piece the rest of the server cannot see.
export async function syncNoteSingular(tx: Writer, noteId: string): Promise<void> {
  const [first] = await tx
    .select()
    .from(notedPieces)
    .where(eq(notedPieces.noteId, noteId))
    .orderBy(asc(notedPieces.sortIndex))
    .limit(1);
  await tx
    .update(notes)
    .set({
      pieceId: first?.pieceId ?? null,
      pieceLabel: first?.pieceLabel ?? null,
      customPieceId: first?.customPieceId ?? null,
      scoreScanId: first?.scoreScanId ?? null,
      pieceVersion: first?.pieceVersion ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(notes.id, noteId));
}
