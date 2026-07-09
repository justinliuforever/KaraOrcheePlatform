/**
 * One-shot backfill (2026-07-08): works rows for the launch pieces + memberships +
 * instrumentation=piano on all pre-v3 rows, then an EXPLICIT catalog rebuild (raw SQL
 * writes don't trigger one). czerny_599_41 deliberately gets NO work — method-book
 * numbers are book members only.
 *
 * Run from api/: DATABASE_URL=... STORAGE_CONNECTION_STRING=... npx tsx ../tools/publisher/backfill_works.ts
 */
import { eq } from "drizzle-orm";
import { createPool, createDb } from "../../api/src/db/client";
import { createBlobStudioStore } from "../../api/src/storage";
import { rebuildCatalog } from "../../api/src/catalog_build";
import { pieces, works } from "../../api/src/db/schema";

const WORKS = [
  { id: "mozart_k330", title: "Piano Sonata No. 10 in C major", composer: "W. A. Mozart", catalogue: "K. 330", workType: "sonata" },
  { id: "schubert_d894", title: "Piano Sonata No. 18 in G major", composer: "Franz Schubert", catalogue: "D. 894", workType: "sonata" },
  { id: "chopin_op58", title: "Piano Sonata No. 3 in B minor", composer: "Frédéric Chopin", catalogue: "Op. 58", workType: "sonata" },
  { id: "bach_bwv846", title: "Prelude and Fugue No. 1 in C major", composer: "J. S. Bach", catalogue: "BWV 846", workType: "prelude_fugue" },
  { id: "chopin_op25", title: "12 Études, Op. 25", composer: "Frédéric Chopin", catalogue: "Op. 25", workType: "etude_set" },
  { id: "liszt_s139", title: "Transcendental Études", composer: "Franz Liszt", catalogue: "S. 139", workType: "etude_set" },
];

const MEMBERSHIPS: [string, string, number][] = [
  ["mozart_k330_mvt1", "mozart_k330", 1],
  ["schubert_sonata_894_mvt2", "schubert_d894", 2],
  ["chopin_sonata3_mvt4", "chopin_op58", 4],
  ["bach_bwv_846", "bach_bwv846", 1],
  ["bach_fugue_bwv_846", "bach_bwv846", 2],
  ["chopin_etude_op25_12_ocean", "chopin_op25", 12],
  ["liszt_trans_5_feux_follets", "liszt_s139", 5],
];

async function main() {
  const pool = createPool(process.env.DATABASE_URL!);
  const db = createDb(pool).orm;

  for (const w of WORKS) {
    await db.insert(works).values(w).onConflictDoNothing();
  }
  console.log(`works: ${WORKS.length} upserted`);

  for (const [pieceId, workId, idx] of MEMBERSHIPS) {
    await db.update(pieces).set({ workId, workIndex: idx }).where(eq(pieces.id, pieceId));
  }
  console.log(`memberships: ${MEMBERSHIPS.length} set`);

  const all = await db.select({ id: pieces.id, instrumentation: pieces.instrumentation }).from(pieces);
  let stamped = 0;
  for (const p of all) {
    if (!p.instrumentation) {
      await db
        .update(pieces)
        .set({ instrumentation: { solo: "piano", parts: ["piano"] } })
        .where(eq(pieces.id, p.id));
      stamped += 1;
    }
  }
  console.log(`instrumentation=piano stamped on ${stamped} rows`);

  const studio = createBlobStudioStore(process.env.STORAGE_CONNECTION_STRING!);
  const cat = (await rebuildCatalog(db, studio)) as { pieces: unknown[]; works: unknown[] };
  console.log(`catalog rebuilt: ${cat.pieces.length} pieces, ${cat.works.length} works`);
  await pool.end();
}

main();
