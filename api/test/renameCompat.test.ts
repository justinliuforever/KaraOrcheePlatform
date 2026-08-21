import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./testdb";
import { users, notes, noteJobs, lessonSessions } from "../src/db/schema";
import type { Db } from "../src/db/client";

/// This file used to prove the OLD name still worked, because the worker wrote it by hand while the
/// rename was in flight. That window closed when the worker's SQL moved and its predecessor lost its
/// last replica, so the guard inverts: the old name must now be gone, or something is still reaching
/// for a table that is not there.
describe("the old table name is gone, and nothing may reach for it again", () => {
  let db: Db;
  let noteId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const [teacher] = await db.orm.insert(users)
      .values({ oid: "rename-t", email: "t@rename.test", isTeacher: true }).returning();
    const [lesson] = await db.orm.insert(lessonSessions)
      .values({ teacherId: teacher!.id }).returning();
    const [job] = await db.orm.insert(noteJobs)
      .values({ lessonSessionId: lesson!.id, status: "ready_for_review", createdBy: teacher!.id })
      .returning();
    const [note] = await db.orm.insert(notes).values({
      noteJobId: job!.id, lessonSessionId: lesson!.id, teacherId: teacher!.id,
      status: "draft", contentOriginal: {}, content: {},
    }).returning();
    noteId = note!.id;
  });

  it("no longer answers to note_annotations, by table or by view", async () => {
    const found = await db.orm.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'note_annotations'`);
    expect(found.rows).toHaveLength(0);
  });

  it("still takes the worker's own insert under the name the worker now uses", async () => {
    await db.orm.execute(sql`
      INSERT INTO practice_items (note_id, idx, category, instruction, quote)
      VALUES (${noteId}::uuid, 0, 'rhythm', 'Even it out', 'those bars')`);

    const rows = await db.orm.execute(sql`SELECT * FROM practice_items WHERE note_id = ${noteId}::uuid`);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as Record<string, unknown>;
    expect(row.source).toBe("transcript");
    expect(row.location).toEqual({});
  });
});
