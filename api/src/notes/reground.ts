import { eq, sql } from "drizzle-orm";
import { noteAnnotations } from "../db/schema";
import type { Orm } from "../db/client";

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];

export const REGROUND_HINT = "This pointed past the end of the piece — place it on the score.";

/// A bar number survives only while the score it was written against is still this slot's score; `bound === null` means there is no engraving to check it against, so nothing grounded survives.
export async function reground(tx: Tx, noteId: string, bound: number | null): Promise<number> {
  const rows = await tx.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, noteId));
  let n = 0;
  for (const a of rows) {
    const loc = (a.location ?? {}) as Record<string, unknown>;
    // No pinnedBy exemption: a teacher pin placed against the app's 999 fallback had nothing checking it either.
    if (loc.grounded !== true) continue;
    if (bound !== null) {
      const end = typeof loc.measureEnd === "number"
        ? loc.measureEnd
        : typeof loc.measureStart === "number"
          ? loc.measureStart
          : null;
      if (end === null || end <= bound) continue;
    }
    const { measureStart: _s, measureEnd: _e, pinnedBy: _p, ...rest } = loc;
    await tx
      .update(noteAnnotations)
      .set({ location: { ...rest, grounded: false, hint: REGROUND_HINT }, updatedAt: sql`now()` })
      .where(eq(noteAnnotations.id, a.id));
    n++;
  }
  return n;
}
