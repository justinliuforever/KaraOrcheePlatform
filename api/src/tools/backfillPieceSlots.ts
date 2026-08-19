import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Orm } from "../db/client";
import { lessonPieces, lessonSessions, noteAnnotations, notedPieces, notes } from "../db/schema";

/// Slot 0, never General: a row's piece is known with certainty from the columns being collapsed, and discarding it would start every cross-lesson view from zero.
export const FIRST_SLOT = 0;

export interface SlotPlan {
  lessons: { id: string; pieceId: string | null; pieceLabel: string | null; scoreScanId: string | null }[];
  notes: { id: string; pieceId: string | null; pieceLabel: string | null; scoreScanId: string | null }[];
  /// Notes that already own a slot but still have items pointing at nothing — a crash or a concurrent run leaves exactly this.
  unstampedNotes: string[];
}

function bound(row: { pieceId: string | null; pieceLabel: string | null; scoreScanId: string | null }): boolean {
  return row.pieceId !== null || row.pieceLabel !== null || row.scoreScanId !== null;
}

export async function planSlotBackfill(orm: Orm): Promise<SlotPlan> {
  const lessonRows = await orm
    .select({
      id: lessonSessions.id,
      pieceId: lessonSessions.pieceId,
      pieceLabel: lessonSessions.pieceLabel,
      scoreScanId: lessonSessions.scoreScanId,
      slotId: lessonPieces.id,
    })
    .from(lessonSessions)
    .leftJoin(lessonPieces, eq(lessonPieces.lessonSessionId, lessonSessions.id))
    .where(isNull(lessonPieces.id));
  const noteRows = await orm
    .select({
      id: notes.id,
      pieceId: notes.pieceId,
      pieceLabel: notes.pieceLabel,
      scoreScanId: notes.scoreScanId,
      slotId: notedPieces.id,
    })
    .from(notes)
    .leftJoin(notedPieces, eq(notedPieces.noteId, notes.id))
    .where(isNull(notedPieces.id));
  const orphaned = await orm
    .selectDistinct({ noteId: noteAnnotations.noteId })
    .from(noteAnnotations)
    .innerJoin(notedPieces, eq(notedPieces.noteId, noteAnnotations.noteId))
    .where(isNull(noteAnnotations.notePieceId));
  return {
    lessons: lessonRows.filter(bound).map(({ slotId: _s, ...r }) => r),
    notes: noteRows.filter(bound).map(({ slotId: _s, ...r }) => r),
    unstampedNotes: orphaned.map((r) => r.noteId),
  };
}

export function renderSlotPlan(plan: SlotPlan): string {
  const lines = [
    `lessons needing a slot: ${plan.lessons.length}`,
    `notes needing a slot:   ${plan.notes.length}`,
  ];
  const unbound = plan.lessons.filter((l) => l.pieceId === null && l.scoreScanId === null).length;
  lines.push(`  of the lessons, ${unbound} carry only a typed label`);
  lines.push(`notes with items still pointing at nothing: ${plan.unstampedNotes.length}`);
  return lines.join("\n");
}

export interface SlotWriteResult {
  lessonSlots: number;
  noteSlots: number;
  itemsStamped: number;
}

/// Idempotent by the same predicate the plan uses: a row that already owns a slot is skipped, so a re-run after a partial write costs nothing.
export async function writeSlotBackfill(orm: Orm): Promise<SlotWriteResult> {
  const plan = await planSlotBackfill(orm);
  let lessonSlots = 0;
  let noteSlots = 0;
  let itemsStamped = 0;

  for (const lesson of plan.lessons) {
    const [row] = await orm.select().from(lessonSessions).where(eq(lessonSessions.id, lesson.id)).limit(1);
    if (!row) continue;
    const written = await orm
      .insert(lessonPieces)
      .values({
        lessonSessionId: row.id,
        sortIndex: FIRST_SLOT,
        pieceId: row.pieceId,
        pieceLabel: row.pieceLabel,
        pieceSource: row.pieceSource,
        customPieceId: row.customPieceId,
        scoreScanId: row.scoreScanId,
      })
      .onConflictDoNothing()
      .returning({ id: lessonPieces.id });
    lessonSlots += written.length;
  }

  for (const note of plan.notes) {
    const [row] = await orm.select().from(notes).where(eq(notes.id, note.id)).limit(1);
    if (!row) continue;
    const written = await orm
      .insert(notedPieces)
      .values({
        noteId: row.id,
        sortIndex: FIRST_SLOT,
        pieceId: row.pieceId,
        pieceLabel: row.pieceLabel,
        customPieceId: row.customPieceId,
        scoreScanId: row.scoreScanId,
        scoreScanDetachedAt: row.scoreScanDetachedAt,
        pieceVersion: row.pieceVersion,
        pieceSuggestionDismissed: row.pieceSuggestionDismissed,
      })
      .onConflictDoNothing()
      .returning({ id: notedPieces.id });
    noteSlots += written.length;
  }

  // Keyed on the state, not on "I just inserted": a note whose slot arrived by any other route is repaired here too.
  for (const noteId of (await planSlotBackfill(orm)).unstampedNotes) {
    const [slot] = await orm
      .select({ id: notedPieces.id })
      .from(notedPieces)
      .where(eq(notedPieces.noteId, noteId))
      .orderBy(asc(notedPieces.sortIndex))
      .limit(1);
    if (!slot) continue;
    const stamped = await orm
      .update(noteAnnotations)
      .set({ notePieceId: slot.id, groundedPieceId: sql`coalesce(${noteAnnotations.groundedPieceId}, ${slot.id})` })
      .where(and(eq(noteAnnotations.noteId, noteId), isNull(noteAnnotations.notePieceId)))
      .returning({ id: noteAnnotations.id });
    itemsStamped += stamped.length;
  }

  return { lessonSlots, noteSlots, itemsStamped };
}
