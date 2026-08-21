import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/client";

export async function createTestDb(): Promise<Db> {
  const pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  const dir = join(__dirname, "..", "drizzle");
  // Production's migrator reads this file, never the directory: an unjournalled .sql runs here and not there.
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const onDisk = new Set(readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4)));
  const journalled = new Set(journal.entries.map((e) => e.tag));
  for (const f of onDisk) {
    if (!journalled.has(f)) {
      throw new Error(`drizzle/${f}.sql has no entry in meta/_journal.json — production would skip it`);
    }
  }
  // drizzle-kit diffs schema.ts against the NEWEST snapshot: one missing leaves `generate` proposing changes already shipped.
  const newest = journal.entries[journal.entries.length - 1]!;
  const snapshot = `${String(newest.idx).padStart(4, "0")}_snapshot.json`;
  if (!existsSync(join(dir, "meta", snapshot))) {
    throw new Error(`drizzle/meta/${snapshot} is missing — db:generate would diff against an older schema`);
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
