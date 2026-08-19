import { and, eq, isNull } from "drizzle-orm";
import type { Orm } from "../db/client";
import { lessonPieces, lessonSessions, noteAnnotations, notedPieces, notes } from "../db/schema";

/// Slot 0, never General: a row's piece is known with certainty from the columns being collapsed, and discarding it would start every cross-lesson view from zero.
export const FIRST_SLOT = 0;

export interface SlotPlan {
  lessons: { id: string; pieceId: string | null; pieceLabel: string | null; scoreScanId: string | null }[];
  notes: { id: string; pieceId: string | null; pieceLabel: string | null; scoreScanId: string | null }[];
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
  return {
    lessons: lessonRows.filter(bound).map(({ slotId: _s, ...r }) => r),
    notes: noteRows.filter(bound).map(({ slotId: _s, ...r }) => r),
  };
}

export function renderSlotPlan(plan: SlotPlan): string {
  const lines = [
    `lessons needing a slot: ${plan.lessons.length}`,
    `notes needing a slot:   ${plan.notes.length}`,
  ];
  const unbound = plan.lessons.filter((l) => l.pieceId === null && l.scoreScanId === null).length;
  lines.push(`  of the lessons, ${unbound} carry only a typed label`);
  return lines.join("\n");
}

export interface SlotWriteResult {
  lessonSlots: number;
  noteSlots: number;
}

/// Idempotent by the same predicate the plan uses: a row that already owns a slot is skipped, so a re-run after a partial write costs nothing.
export async function writeSlotBackfill(orm: Orm): Promise<SlotWriteResult> {
  const plan = await planSlotBackfill(orm);
  let lessonSlots = 0;
  let noteSlots = 0;

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
    if (written.length) {
      // Every existing item belongs to the piece the note already named; nothing here is General.
      await orm
        .update(noteAnnotations)
        .set({ notePieceId: written[0]!.id, groundedPieceId: written[0]!.id })
        .where(and(eq(noteAnnotations.noteId, row.id), isNull(noteAnnotations.notePieceId)));
    }
  }

  return { lessonSlots, noteSlots };
}
