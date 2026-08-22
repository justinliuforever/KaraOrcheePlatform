import { and, desc, eq, lte, sql } from "drizzle-orm";
import { notedPieces, pieceVersions, pieces } from "../db/schema";
import type { Orm } from "../db/client";

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];
type Writer = Tx | Orm;

/// A null version tells the student's app there is nothing to check, so an unstamped slot resolves
/// stale bars in silence — every slot naming an engraving must carry its own.
export async function stampSlotVersions(tx: Writer, noteId: string): Promise<void> {
  const slots = await tx
    .select({ id: notedPieces.id, pieceId: notedPieces.pieceId })
    .from(notedPieces)
    .where(eq(notedPieces.noteId, noteId));
  for (const slot of slots) {
    if (!slot.pieceId) continue;
    const [piece] = await tx
      .select({ publishedVersion: pieces.publishedVersion })
      .from(pieces)
      .where(eq(pieces.id, slot.pieceId))
      .limit(1);
    await tx
      .update(notedPieces)
      .set({ pieceVersion: piece?.publishedVersion ?? null, updatedAt: sql`now()` })
      .where(eq(notedPieces.id, slot.id));
  }
}

/// The version the student was handed, not today's: stamping a republished piece with its CURRENT
/// version would declare bars correct that were written against an engraving nobody can see again.
export async function versionAt(tx: Writer, pieceId: string, at: Date): Promise<number | null> {
  const [row] = await tx
    .select({ version: pieceVersions.version })
    .from(pieceVersions)
    .where(and(eq(pieceVersions.pieceId, pieceId), lte(pieceVersions.publishedAt, at)))
    .orderBy(desc(pieceVersions.version))
    .limit(1);
  return row?.version ?? null;
}
