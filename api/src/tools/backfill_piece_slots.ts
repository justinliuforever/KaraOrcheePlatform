#!/usr/bin/env tsx
/// Dry-run by default; idempotent, so a re-run after a partial write is safe and free. `--write` is the only thing that writes.
import { createDb, createPool } from "../db/client";
import { planSlotBackfill, renderSlotPlan, writeSlotBackfill } from "./backfillPieceSlots";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is unset — nothing was read and nothing was proved.");
    return 2;
  }
  const db = createDb(createPool(url));
  console.log(renderSlotPlan(await planSlotBackfill(db.orm)));
  if (!process.argv.includes("--write")) {
    console.log("\ndry run — re-run with --write once the counts above are read");
    return 0;
  }
  const result = await writeSlotBackfill(db.orm);
  console.log(`\nwrote ${result.lessonSlots} lesson slots, ${result.noteSlots} note slots, stamped ${result.itemsStamped} items, ${result.planRows} plan rows`);
  const after = await planSlotBackfill(db.orm);
  console.log(`remaining: ${after.lessons.length} lessons, ${after.notes.length} notes, ` +
              `${after.unstampedNotes.length} notes with unstamped items`);
  const clean = after.lessons.length === 0 && after.notes.length === 0 && after.unstampedNotes.length === 0;
  return clean ? 0 : 1;
}

main().then((code) => process.exit(code));
