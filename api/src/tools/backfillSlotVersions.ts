import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Orm } from "../db/client";
import { notedPieces, notes } from "../db/schema";
import { versionAt } from "../notes/slot_version";

export interface VersionFill {
  slotId: string;
  noteId: string;
  pieceId: string;
  version: number | null;
}

/// Only sent notes: a draft is stamped when it is sent, and stamping one now would pin bars the
/// teacher has not finished writing.
export async function planVersionBackfill(orm: Orm): Promise<VersionFill[]> {
  const rows = await orm
    .select({
      slotId: notedPieces.id,
      noteId: notes.id,
      pieceId: notedPieces.pieceId,
      sentAt: notes.sentAt,
    })
    .from(notedPieces)
    .innerJoin(notes, eq(notes.id, notedPieces.noteId))
    .where(and(
      isNull(notedPieces.pieceVersion),
      isNotNull(notedPieces.pieceId),
      isNotNull(notes.sentAt),
    ));
  const out: VersionFill[] = [];
  for (const r of rows) {
    out.push({
      slotId: r.slotId,
      noteId: r.noteId,
      pieceId: r.pieceId!,
      version: await versionAt(orm, r.pieceId!, r.sentAt!),
    });
  }
  return out;
}

/// Writes only what the plan resolved: a slot whose piece had no version published by send time keeps
/// its null rather than borrowing a number from an engraving the student was never shown.
export async function writeVersionBackfill(orm: Orm, plan: VersionFill[]): Promise<number> {
  let written = 0;
  for (const fill of plan) {
    if (fill.version === null) continue;
    await orm
      .update(notedPieces)
      .set({ pieceVersion: fill.version })
      .where(and(eq(notedPieces.id, fill.slotId), isNull(notedPieces.pieceVersion)));
    written++;
  }
  return written;
}
