import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/client";

// In-memory Postgres with the real migration chain applied — route tests run
// against the same SQL the dev/prod databases execute.
export async function createTestDb(): Promise<Db> {
  const pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  const dir = join(__dirname, "..", "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const migration = readFileSync(join(dir, f), "utf8");
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
