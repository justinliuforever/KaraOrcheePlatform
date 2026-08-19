import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const DIR = join(__dirname, "..", "drizzle");
const MIGRATION = "0032_multipiece_spine.sql";

function migrationFiles(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
}

async function applyThrough(pglite: PGlite, through: string): Promise<void> {
  for (const f of migrationFiles()) {
    if (f > through) continue;
    for (const stmt of readFileSync(join(DIR, f), "utf8").split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await pglite.exec(s);
    }
  }
}

async function seedNoteWithAnnotation(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    INSERT INTO users (id, entra_oid, is_teacher) VALUES ('11111111-1111-1111-1111-111111111111', 'spine-teacher', true);
    INSERT INTO users (id, entra_oid, is_student) VALUES ('33333333-3333-3333-3333-333333333333', 'spine-student', true);
    INSERT INTO pieces (id, title, composer, rights, status)
      VALUES ('spine_piece', 'Practical Method, Op. 599', 'Carl Czerny', 'public_domain', 'published');
    INSERT INTO score_scans (id, owner_id, title, page_count, status)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Czerny 599', 3, 'ready');
    INSERT INTO lesson_sessions (id, teacher_id)
      VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111');
    INSERT INTO note_jobs (id, lesson_session_id, status, created_by)
      VALUES ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'ready_for_review', '11111111-1111-1111-1111-111111111111');
    INSERT INTO notes (id, note_job_id, lesson_session_id, teacher_id, student_id, content_original, content)
      VALUES ('66666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555',
              '44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
              '33333333-3333-3333-3333-333333333333', '{}'::jsonb, '{}'::jsonb);
    INSERT INTO note_annotations (id, note_id, idx, category, instruction, quote)
      VALUES ('77777777-7777-7777-7777-777777777777', '66666666-6666-6666-6666-666666666666', 0, 'rhythm', 'Even it out', 'those two bars');
  `);
}

describe(MIGRATION, () => {
  it("leaves every existing annotation a transcript row", async () => {
    const pglite = new PGlite();
    await applyThrough(pglite, MIGRATION);
    await seedNoteWithAnnotation(pglite);

    const rows = await pglite.query<{ source: string; note_piece_id: string | null }>(
      "SELECT source, note_piece_id FROM note_annotations",
    );

    expect(rows.rows[0]!.source).toBe("transcript");
    expect(rows.rows[0]!.note_piece_id).toBeNull();
  });

  it("refuses a transcript item with no quote, and accepts a plan item without one", async () => {
    const pglite = new PGlite();
    await applyThrough(pglite, MIGRATION);
    await seedNoteWithAnnotation(pglite);

    await expect(pglite.exec(`
      INSERT INTO note_annotations (note_id, idx, category, instruction, quote, source)
      VALUES ('66666666-6666-6666-6666-666666666666', 1, 'rhythm', 'Unsourced', NULL, 'transcript');
    `)).rejects.toThrow();

    await pglite.exec(`
      INSERT INTO note_annotations (note_id, idx, category, instruction, quote, source, group_label, target)
      VALUES ('66666666-6666-6666-6666-666666666666', 2, 'practice_strategy', 'Hands separate at 60', NULL, 'plan', 'Evenness', 'Four clean runs');
    `);
    const n = await pglite.query<{ count: number }>("SELECT count(*) AS count FROM note_annotations WHERE source = 'plan'");
    expect(Number(n.rows[0]!.count)).toBe(1);
  });

  it("holds one score per slot on both piece tables", async () => {
    const pglite = new PGlite();
    await applyThrough(pglite, MIGRATION);
    await seedNoteWithAnnotation(pglite);

    await expect(pglite.exec(`
      INSERT INTO note_pieces (note_id, sort_index, piece_id, score_scan_id)
      VALUES ('66666666-6666-6666-6666-666666666666', 0, 'spine_piece', '22222222-2222-2222-2222-222222222222');
    `)).rejects.toThrow();

    await expect(pglite.exec(`
      INSERT INTO lesson_pieces (lesson_session_id, sort_index, piece_id, score_scan_id)
      VALUES ('44444444-4444-4444-4444-444444444444', 0, 'spine_piece', '22222222-2222-2222-2222-222222222222');
    `)).rejects.toThrow();
  });

  it("refuses two slots claiming the same position on one note", async () => {
    const pglite = new PGlite();
    await applyThrough(pglite, MIGRATION);
    await seedNoteWithAnnotation(pglite);

    await pglite.exec(`
      INSERT INTO note_pieces (note_id, sort_index, piece_id)
      VALUES ('66666666-6666-6666-6666-666666666666', 1000, 'spine_piece');
    `);
    await expect(pglite.exec(`
      INSERT INTO note_pieces (note_id, sort_index, piece_label)
      VALUES ('66666666-6666-6666-6666-666666666666', 1000, 'Another');
    `)).rejects.toThrow();
  });

  it("makes a practice subject name exactly one identity, once per student and teacher", async () => {
    const pglite = new PGlite();
    await applyThrough(pglite, MIGRATION);
    await seedNoteWithAnnotation(pglite);

    await expect(pglite.exec(`
      INSERT INTO practice_subjects (student_id, teacher_id) VALUES
        ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111');
    `)).rejects.toThrow();

    await pglite.exec(`
      INSERT INTO practice_subjects (student_id, teacher_id, piece_id) VALUES
        ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'spine_piece');
    `);
    await expect(pglite.exec(`
      INSERT INTO practice_subjects (student_id, teacher_id, piece_id) VALUES
        ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'spine_piece');
    `)).rejects.toThrow();
  });

  it("leaves an item in General when its slot is deleted, rather than taking it along", async () => {
    const pglite = new PGlite();
    await applyThrough(pglite, MIGRATION);
    await seedNoteWithAnnotation(pglite);

    const slot = await pglite.query<{ id: string }>(`
      INSERT INTO note_pieces (note_id, sort_index, piece_id)
      VALUES ('66666666-6666-6666-6666-666666666666', 0, 'spine_piece') RETURNING id;
    `);
    const slotId = slot.rows[0]!.id;
    await pglite.exec(`UPDATE note_annotations SET note_piece_id = '${slotId}';`);

    await pglite.exec(`DELETE FROM note_pieces WHERE id = '${slotId}';`);

    const rows = await pglite.query<{ count: number; note_piece_id: string | null }>(
      "SELECT count(*) AS count, min(note_piece_id::text) AS note_piece_id FROM note_annotations",
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
    expect(rows.rows[0]!.note_piece_id).toBeNull();
  });
});

describe("0033_multipiece_spine_repairs.sql", () => {
  const REPAIRS = "0033_multipiece_spine_repairs.sql";

  it("lets a custom piece be deleted without aborting on the subject's own CHECK", async () => {
    const pglite = new PGlite();
    await applyThrough(pglite, REPAIRS);
    await seedNoteWithAnnotation(pglite);
    await pglite.exec(`
      INSERT INTO custom_pieces (id, teacher_id, display_label, normalized_label)
        VALUES ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'Typed', 'typed');
      INSERT INTO practice_subjects (student_id, teacher_id, custom_piece_id)
        VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
                '88888888-8888-8888-8888-888888888888');
    `);

    await pglite.exec("DELETE FROM custom_pieces WHERE id = '88888888-8888-8888-8888-888888888888';");

    const left = await pglite.query<{ count: number }>("SELECT count(*) AS count FROM practice_subjects");
    expect(Number(left.rows[0]!.count)).toBe(0);
  });

  it("refuses an item pointing at a slot that belongs to a different note", async () => {
    const pglite = new PGlite();
    await applyThrough(pglite, REPAIRS);
    await seedNoteWithAnnotation(pglite);
    await pglite.exec(`
      INSERT INTO notes (id, note_job_id, lesson_session_id, teacher_id, student_id, content_original, content)
        VALUES ('99999999-9999-9999-9999-999999999999', '55555555-5555-5555-5555-555555555555',
                '44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
                '33333333-3333-3333-3333-333333333333', '{}'::jsonb, '{}'::jsonb);
    `);
    const other = await pglite.query<{ id: string }>(`
      INSERT INTO note_pieces (note_id, sort_index, piece_id)
      VALUES ('99999999-9999-9999-9999-999999999999', 0, 'spine_piece') RETURNING id;
    `);

    await expect(pglite.exec(
      `UPDATE note_annotations SET note_piece_id = '${other.rows[0]!.id}';`,
    )).rejects.toThrow();
  });
});
