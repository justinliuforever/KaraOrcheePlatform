import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testdb";
import {
  users,
  pieces,
  scoreScans,
  lessonSessions,
  lessonPieces,
  noteJobs,
  notes,
  notedPieces,
  noteAnnotations,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import { planSlotBackfill, writeSlotBackfill } from "../src/tools/backfillPieceSlots";

let db: Db;

const TEACHER = "11111111-1111-1111-1111-111111111111";
const STUDENT = "33333333-3333-3333-3333-333333333333";

beforeEach(async () => {
  db = await createTestDb();
  await db.orm.insert(users).values([
    { id: TEACHER, entraOid: "bf-teacher", isTeacher: true },
    { id: STUDENT, entraOid: "bf-student", isStudent: true },
  ]);
  await db.orm.insert(pieces).values({
    id: "bf_piece", title: "Practical Method, Op. 599", composer: "Carl Czerny",
    rights: "public_domain", status: "published", publishedVersion: 2,
  });
});

async function seedLesson(opts: { pieceId?: string | null; pieceLabel?: string | null; scoreScanId?: string | null }) {
  const [lesson] = await db.orm
    .insert(lessonSessions)
    .values({ teacherId: TEACHER, pieceId: opts.pieceId ?? null, pieceLabel: opts.pieceLabel ?? null,
              scoreScanId: opts.scoreScanId ?? null })
    .returning();
  return lesson!;
}

async function seedNote(opts: { pieceId?: string | null; pieceLabel?: string | null; quotes?: number }) {
  const lesson = await seedLesson({});
  const [job] = await db.orm
    .insert(noteJobs)
    .values({ lessonSessionId: lesson.id, status: "ready_for_review", createdBy: TEACHER })
    .returning();
  const [note] = await db.orm
    .insert(notes)
    .values({
      noteJobId: job!.id, lessonSessionId: lesson.id, teacherId: TEACHER, studentId: STUDENT,
      pieceId: opts.pieceId ?? null, pieceLabel: opts.pieceLabel ?? null,
      contentOriginal: {}, content: {},
    })
    .returning();
  for (let i = 0; i < (opts.quotes ?? 2); i++) {
    await db.orm.insert(noteAnnotations).values({
      noteId: note!.id, idx: i, category: "rhythm",
      instruction: `Step ${i}`, quote: `bar ${i}`,
    });
  }
  return note!;
}

describe("backfilling the first piece slot", () => {
  it("gives every bound lesson and note a slot, and leaves the empty ones alone", async () => {
    await seedLesson({ pieceId: "bf_piece" });
    await seedLesson({});  // nothing named: no slot to make
    const note = await seedNote({ pieceLabel: "Something typed" });

    const result = await writeSlotBackfill(db.orm);

    expect(result.lessonSlots).toBe(1);
    expect(result.noteSlots).toBe(1);
    const [slot] = await db.orm.select().from(notedPieces).where(eq(notedPieces.noteId, note.id));
    expect(slot!.sortIndex).toBe(0);
    expect(slot!.pieceLabel).toBe("Something typed");
  });

  it("puts every existing item under that slot rather than in General", async () => {
    const note = await seedNote({ pieceId: "bf_piece", quotes: 3 });

    await writeSlotBackfill(db.orm);

    const [slot] = await db.orm.select().from(notedPieces).where(eq(notedPieces.noteId, note.id));
    const items = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, note.id));
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.notePieceId).toBe(slot!.id);
      expect(item.groundedPieceId).toBe(slot!.id);
      expect(item.source).toBe("transcript");
    }
  });

  it("carries the scan pointer rather than the piece when that is what the row held", async () => {
    const [scan] = await db.orm
      .insert(scoreScans)
      .values({ ownerId: TEACHER, title: "Czerny", pageCount: 2, status: "ready" })
      .returning();
    const lesson = await seedLesson({ scoreScanId: scan!.id });

    await writeSlotBackfill(db.orm);

    const [slot] = await db.orm.select().from(lessonPieces).where(eq(lessonPieces.lessonSessionId, lesson.id));
    expect(slot!.scoreScanId).toBe(scan!.id);
    expect(slot!.pieceId).toBeNull();
  });

  it("is idempotent — a second run writes nothing and moves nothing", async () => {
    await seedLesson({ pieceId: "bf_piece" });
    const note = await seedNote({ pieceId: "bf_piece" });
    const first = await writeSlotBackfill(db.orm);
    const [slotAfterFirst] = await db.orm.select().from(notedPieces).where(eq(notedPieces.noteId, note.id));

    const second = await writeSlotBackfill(db.orm);

    expect(first.lessonSlots + first.noteSlots).toBeGreaterThan(0);
    expect(second).toEqual({ lessonSlots: 0, noteSlots: 0, itemsStamped: 0 });
    const slots = await db.orm.select().from(notedPieces).where(eq(notedPieces.noteId, note.id));
    expect(slots).toHaveLength(1);
    expect(slots[0]!.id).toBe(slotAfterFirst!.id);
  });

  it("reports what it would do without writing", async () => {
    await seedLesson({ pieceId: "bf_piece" });
    await seedNote({ pieceId: "bf_piece" });

    const plan = await planSlotBackfill(db.orm);

    // The note's own lesson names nothing, so it is not in the plan — only bound rows are.
    expect(plan.lessons).toHaveLength(1);
    expect(plan.notes).toHaveLength(1);
    const written = await db.orm.select().from(notedPieces);
    expect(written).toHaveLength(0);
  });

  it("repairs a note whose slot arrived without its items being stamped", async () => {
    const note = await seedNote({ pieceId: "bf_piece", quotes: 2 });
    // Exactly what a crash between the insert and the stamp leaves, or a slot minted by the API.
    await db.orm.insert(notedPieces).values({ noteId: note.id, sortIndex: 0, pieceId: "bf_piece" });

    const plan = await planSlotBackfill(db.orm);
    const result = await writeSlotBackfill(db.orm);

    expect(plan.notes).toHaveLength(0);
    expect(plan.unstampedNotes).toContain(note.id);
    expect(result.itemsStamped).toBe(2);
    const items = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, note.id));
    expect(items.every((i) => i.notePieceId !== null)).toBe(true);
  });
});
