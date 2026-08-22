import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testdb";
import { lessonSessions, noteJobs, notedPieces, notes, pieceVersions, pieces, users } from "../src/db/schema";
import { planVersionBackfill, writeVersionBackfill } from "../src/tools/backfillSlotVersions";
import type { Db } from "../src/db/client";

let db: Db;
let teacherId: string;

const T = (iso: string) => new Date(iso);

beforeEach(async () => {
  db = await createTestDb();
  const [t] = await db.orm.insert(users).values({ oid: "bf-t", name: "T", role: "teacher" }).returning();
  teacherId = t!.id;
  await db.orm.insert(pieces).values([
    { id: "bf_piece", title: "Sonatina", composer: "C", status: "published", publishedVersion: 4 },
    { id: "bf_late", title: "Arabesque", composer: "B", status: "published", publishedVersion: 1 },
  ]);
  await db.orm.insert(pieceVersions).values([
    { pieceId: "bf_piece", version: 1, files: {}, publishedAt: T("2026-01-01T00:00:00Z") },
    { pieceId: "bf_piece", version: 2, files: {}, publishedAt: T("2026-03-01T00:00:00Z") },
    { pieceId: "bf_piece", version: 3, files: {}, publishedAt: T("2026-07-01T00:00:00Z") },
    { pieceId: "bf_piece", version: 4, files: {}, publishedAt: T("2026-08-20T00:00:00Z") },
    { pieceId: "bf_late", version: 1, files: {}, publishedAt: T("2026-08-21T00:00:00Z") },
  ]);
});

async function sentNote(sentAt: Date | null) {
  const [lesson] = await db.orm.insert(lessonSessions).values({ teacherId }).returning();
  const [job] = await db.orm.insert(noteJobs)
    .values({ lessonSessionId: lesson!.id, status: "ready_for_review", createdBy: teacherId }).returning();
  const [note] = await db.orm.insert(notes).values({
    noteJobId: job!.id, lessonSessionId: lesson!.id, teacherId,
    status: sentAt ? "sent" : "draft", contentOriginal: {}, content: {}, sentAt,
  }).returning();
  return note!;
}

describe("backfilling the versions a sent note never stamped", () => {
  it("gives each slot the version that was live when the note was sent", async () => {
    const note = await sentNote(T("2026-04-01T00:00:00Z"));
    const [slot] = await db.orm.insert(notedPieces)
      .values({ noteId: note.id, sortIndex: 0, pieceId: "bf_piece" }).returning();

    const plan = await planVersionBackfill(db.orm);
    expect(plan).toEqual([{ slotId: slot!.id, noteId: note.id, pieceId: "bf_piece", version: 2 }]);
    expect(await writeVersionBackfill(db.orm, plan)).toBe(1);

    const [row] = await db.orm.select().from(notedPieces).where(eq(notedPieces.id, slot!.id));
    expect(row!.pieceVersion).toBe(2);
  });

  it("leaves a draft alone", async () => {
    const note = await sentNote(null);
    await db.orm.insert(notedPieces).values({ noteId: note.id, sortIndex: 0, pieceId: "bf_piece" });
    expect(await planVersionBackfill(db.orm)).toEqual([]);
  });

  it("never overwrites a version already stamped", async () => {
    const note = await sentNote(T("2026-08-22T00:00:00Z"));
    await db.orm.insert(notedPieces)
      .values({ noteId: note.id, sortIndex: 0, pieceId: "bf_piece", pieceVersion: 1 });
    expect(await planVersionBackfill(db.orm)).toEqual([]);
  });

  it("leaves a slot whose piece had no version by send time unstamped", async () => {
    const note = await sentNote(T("2026-08-01T00:00:00Z"));
    const [slot] = await db.orm.insert(notedPieces)
      .values({ noteId: note.id, sortIndex: 0, pieceId: "bf_late" }).returning();

    const plan = await planVersionBackfill(db.orm);
    expect(plan[0]!.version).toBeNull();
    expect(await writeVersionBackfill(db.orm, plan)).toBe(0);
    const [row] = await db.orm.select().from(notedPieces).where(eq(notedPieces.id, slot!.id));
    expect(row!.pieceVersion).toBeNull();
  });

  it("leaves a slot showing photographs alone", async () => {
    const note = await sentNote(T("2026-08-22T00:00:00Z"));
    await db.orm.insert(notedPieces).values({ noteId: note.id, sortIndex: 0, pieceLabel: "Photos" });
    expect(await planVersionBackfill(db.orm)).toEqual([]);
  });
});
