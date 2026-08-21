import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./testdb";
import { users, notes, noteJobs, lessonSessions } from "../src/db/schema";
import type { Db } from "../src/db/client";

/// The notes worker writes this table by hand, by its OLD name, and a draining replica keeps consuming
/// for minutes after a new revision reports healthy. Until that image is gone, the old name must work.
describe("the old table name still works, because an old worker is still using it", () => {
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

  it("accepts the insert the worker actually writes, naming only the columns it knows", async () => {
    await db.orm.execute(sql`
      INSERT INTO note_annotations (note_id, idx, category, instruction, quote)
      VALUES (${noteId}::uuid, 0, 'rhythm', 'Even it out', 'those bars')`);

    const rows = await db.orm.execute(sql`SELECT * FROM practice_items WHERE note_id = ${noteId}::uuid`);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as Record<string, unknown>;
    // Every default the base table carries has to survive the view, or the insert above fails on NOT NULL.
    expect(row.id).toBeTruthy();
    expect(row.source).toBe("transcript");
    expect(row.location).toEqual({});
    expect(row.created_at).toBeTruthy();
  });

  it("reads back through the old name what the new name wrote", async () => {
    await db.orm.execute(sql`
      INSERT INTO practice_items (note_id, idx, category, instruction, quote)
      VALUES (${noteId}::uuid, 1, 'reading', 'Check the key', 'the key')`);

    const rows = await db.orm.execute(sql`
      SELECT instruction FROM note_annotations WHERE note_id = ${noteId}::uuid`);
    expect((rows.rows[0] as { instruction: string }).instruction).toBe("Check the key");
  });

  it("carries a delete and an update through, which the worker's replace_draft does on every retry", async () => {
    await db.orm.execute(sql`
      INSERT INTO note_annotations (note_id, idx, category, instruction, quote)
      VALUES (${noteId}::uuid, 0, 'rhythm', 'First', 'q')`);
    await db.orm.execute(sql`
      UPDATE note_annotations SET instruction = 'Second' WHERE note_id = ${noteId}::uuid`);
    const updated = await db.orm.execute(sql`SELECT instruction FROM practice_items`);
    expect((updated.rows[0] as { instruction: string }).instruction).toBe("Second");

    await db.orm.execute(sql`DELETE FROM note_annotations WHERE note_id = ${noteId}::uuid`);
    const left = await db.orm.execute(sql`SELECT count(*)::int AS n FROM practice_items`);
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });
});
