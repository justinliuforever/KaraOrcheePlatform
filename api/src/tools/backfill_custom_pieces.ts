#!/usr/bin/env tsx
// FG-17 runner. Dry-run by default: it prints the distinct-label list a human reads
// before anything is written, and `--write` is the only thing that writes.
//
//   npx tsx src/tools/backfill_custom_pieces.ts            # print the list
//   npx tsx src/tools/backfill_custom_pieces.ts --write    # after the review
import { createDb, createPool } from "../db/client";
import { planBackfill, renderPlan, writeBackfill } from "./backfillCustomPieces";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is unset — nothing was read and nothing was proved.");
    return 2;
  }
  const db = createDb(createPool(url));
  const plan = await planBackfill(db.orm);
  console.log(renderPlan(plan));
  if (!process.argv.includes("--write")) {
    console.log("\ndry run — re-run with --write once the list above is reviewed");
    return 0;
  }
  const result = await writeBackfill(db.orm, plan);
  console.log(`\nwrote ${result.entitiesWritten} entities, stamped ${result.lessonsStamped} lessons`);
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(2);
});
