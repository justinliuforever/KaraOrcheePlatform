import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const DIR = join(__dirname, "..", "drizzle");
const MIGRATION = "0029_late_ogun.sql";

function migrationFiles(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
}

async function applyRange(pglite: PGlite, after: string, through: string): Promise<void> {
  for (const f of migrationFiles()) {
    if (f <= after || f > through) continue;
    for (const stmt of readFileSync(join(DIR, f), "utf8").split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await pglite.exec(s);
    }
  }
}

async function seedDirtyRow(pglite: PGlite): Promise<string> {
  await pglite.exec(`
    INSERT INTO users (id, entra_oid, is_teacher) VALUES ('11111111-1111-1111-1111-111111111111', 'mig-owner', true);
    INSERT INTO pieces (id, title, composer, rights, status)
      VALUES ('mig_piece', 'Practical Method, Op. 599', 'Carl Czerny', 'public_domain', 'published');
    INSERT INTO score_scans (id, owner_id, title, page_count, status)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Czerny 599', 3, 'ready');
    INSERT INTO lesson_sessions (id, teacher_id)
      VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111');
    INSERT INTO note_jobs (id, lesson_session_id, status, created_by)
      VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'ready_for_review', '11111111-1111-1111-1111-111111111111');

    INSERT INTO notes (id, note_job_id, lesson_session_id, teacher_id, status, piece_id, score_scan_id, content_original, content)
      VALUES ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444',
              '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
              'sent', 'mig_piece', '22222222-2222-2222-2222-222222222222', '{}'::jsonb, '{}'::jsonb);
  `);
  return "55555555-5555-5555-5555-555555555555";
}

describe("migration 0029 applied to a database that already holds the forbidden pair", () => {
  it("is reachable before the migration and refused after it", async () => {
    const pglite = new PGlite();
    await applyRange(pglite, "", "0028_dusty_bushwacker.sql");
    const noteId = await seedDirtyRow(pglite);

    const before = await pglite.query<{ score_scan_id: string | null; piece_id: string | null }>(
      `SELECT piece_id, score_scan_id FROM notes WHERE id = '${noteId}'`);
    expect(before.rows[0]!.piece_id).toBe("mig_piece");
    expect(before.rows[0]!.score_scan_id).toBe("22222222-2222-2222-2222-222222222222");

    await applyRange(pglite, "0028_dusty_bushwacker.sql", MIGRATION);

    const after = await pglite.query<{ score_scan_id: string | null; piece_id: string | null }>(
      `SELECT piece_id, score_scan_id FROM notes WHERE id = '${noteId}'`);
    expect(after.rows[0]!.piece_id).toBe("mig_piece");
    expect(after.rows[0]!.score_scan_id).toBeNull();

    await expect(
      pglite.exec(`UPDATE notes SET score_scan_id = '22222222-2222-2222-2222-222222222222' WHERE id = '${noteId}'`),
    ).rejects.toThrow(/ck_note_piece_excludes_scan/);
  });

  it("keeps the scan on a row that names no piece", async () => {
    const pglite = new PGlite();
    await applyRange(pglite, "", "0028_dusty_bushwacker.sql");
    const noteId = await seedDirtyRow(pglite);
    await pglite.exec(`UPDATE notes SET piece_id = NULL WHERE id = '${noteId}'`);

    await applyRange(pglite, "0028_dusty_bushwacker.sql", MIGRATION);

    const after = await pglite.query<{ score_scan_id: string | null }>(
      `SELECT score_scan_id FROM notes WHERE id = '${noteId}'`);
    expect(after.rows[0]!.score_scan_id).toBe("22222222-2222-2222-2222-222222222222");
  });
});
