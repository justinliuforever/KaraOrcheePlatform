#!/usr/bin/env tsx
/// Dry-run by default; only stamps NULLs, so a re-run after a partial write is safe and free.
import { createDb, createPool } from "../db/client";
import { planVersionBackfill, writeVersionBackfill } from "./backfillSlotVersions";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is unset — nothing was read and nothing was proved.");
    return 2;
  }
  const db = createDb(createPool(url));
  const plan = await planVersionBackfill(db.orm);
  const resolvable = plan.filter((f) => f.version !== null);
  console.log(`${plan.length} sent-note slot(s) missing a version; ${resolvable.length} resolvable from piece_versions`);
  for (const f of plan.slice(0, 20)) {
    console.log(`  slot ${f.slotId.slice(0, 8)} note ${f.noteId.slice(0, 8)} piece ${f.pieceId} -> ${f.version ?? "UNRESOLVABLE (stays null)"}`);
  }
  if (plan.length > 20) console.log(`  … and ${plan.length - 20} more`);
  if (!process.argv.includes("--write")) {
    console.log("\ndry run — re-run with --write once the lines above are read");
    return 0;
  }
  const written = await writeVersionBackfill(db.orm, plan);
  const after = await planVersionBackfill(db.orm);
  console.log(`\nwrote ${written}; remaining unstamped: ${after.length} (unresolvable slots keep their null)`);
  return 0;
}

main().then((code) => process.exit(code));
