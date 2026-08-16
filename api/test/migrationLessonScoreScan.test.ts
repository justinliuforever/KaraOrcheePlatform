import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const DIR = join(__dirname, "..", "drizzle");
const PRIOR = "0029_late_ogun.sql";
const MIGRATION = "0030_lesson_score_scan.sql";

const OWNER = "11111111-1111-1111-1111-111111111111";
const SCAN = "22222222-2222-2222-2222-222222222222";
const PIECED_LESSON = "33333333-3333-3333-3333-333333333333";
const BARE_LESSON = "44444444-4444-4444-4444-444444444444";

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

async function seedLessons(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    INSERT INTO users (id, entra_oid, is_teacher) VALUES ('${OWNER}', 'mig-lesson-owner', true);
    INSERT INTO pieces (id, title, composer, rights, status)
      VALUES ('mig_piece', 'Practical Method, Op. 599', 'Carl Czerny', 'public_domain', 'published');
    INSERT INTO score_scans (id, owner_id, title, page_count, status, blob_prefix)
      VALUES ('${SCAN}', '${OWNER}', 'Czerny 599', 3, 'ready', '${OWNER}/${SCAN}/');
    INSERT INTO lesson_sessions (id, teacher_id, piece_id) VALUES ('${PIECED_LESSON}', '${OWNER}', 'mig_piece');
    INSERT INTO lesson_sessions (id, teacher_id) VALUES ('${BARE_LESSON}', '${OWNER}');
  `);
}

async function scanOf(pglite: PGlite, lessonId: string): Promise<string | null | undefined> {
  const res = await pglite.query<{ score_scan_id: string | null }>(
    `SELECT score_scan_id FROM lesson_sessions WHERE id = '${lessonId}'`);
  return res.rows[0]?.score_scan_id;
}

describe("migration 0030 applied to a database that already holds lessons", () => {
  it("leaves every existing lesson standing and refuses the forbidden pair after", async () => {
    const pglite = new PGlite();
    await applyRange(pglite, "", PRIOR);
    await seedLessons(pglite);

    await applyRange(pglite, PRIOR, MIGRATION);

    expect(await scanOf(pglite, PIECED_LESSON)).toBeNull();
    expect(await scanOf(pglite, BARE_LESSON)).toBeNull();
    await expect(
      pglite.exec(`UPDATE lesson_sessions SET score_scan_id = '${SCAN}' WHERE id = '${PIECED_LESSON}'`),
    ).rejects.toThrow(/ck_lesson_piece_excludes_scan/);
  });

  it("admits the scan on a lesson that names no piece", async () => {
    const pglite = new PGlite();
    await applyRange(pglite, "", MIGRATION);
    await seedLessons(pglite);

    await pglite.exec(`UPDATE lesson_sessions SET score_scan_id = '${SCAN}' WHERE id = '${BARE_LESSON}'`);

    expect(await scanOf(pglite, BARE_LESSON)).toBe(SCAN);
  });

  it("keeps the lesson row when the scan it names is deleted", async () => {
    const pglite = new PGlite();
    await applyRange(pglite, "", MIGRATION);
    await seedLessons(pglite);
    await pglite.exec(`UPDATE lesson_sessions SET score_scan_id = '${SCAN}' WHERE id = '${BARE_LESSON}'`);

    await pglite.exec(`DELETE FROM score_scans WHERE id = '${SCAN}'`);

    expect(await scanOf(pglite, BARE_LESSON)).toBeNull();
  });
});
