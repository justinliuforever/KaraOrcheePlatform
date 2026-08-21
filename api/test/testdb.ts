import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/client";

export async function createTestDb(): Promise<Db> {
  const pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  const dir = join(__dirname, "..", "drizzle");
  // The JOURNAL, never the directory: production's migrator reads this file, so a migration that is
  // only a .sql on disk runs here and silently does not run there. That cost a deploy on 2026-08-20.
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const onDisk = new Set(readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4)));
  const journalled = new Set(journal.entries.map((e) => e.tag));
  for (const f of onDisk) {
    if (!journalled.has(f)) {
      throw new Error(`drizzle/${f}.sql has no entry in meta/_journal.json — production would skip it`);
    }
  }
  for (const entry of journal.entries) {
    const migration = readFileSync(join(dir, `${entry.tag}.sql`), "utf8");
    for (const stmt of migration.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await pglite.exec(s);
    }
  }
  return {
    orm: orm as unknown as Db["orm"],
    async ping() {},
  };
}
