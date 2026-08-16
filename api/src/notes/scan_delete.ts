import { sql } from "drizzle-orm";
import type { Orm } from "../db/client";
import { notes, scoreScans } from "../db/schema";
import type { ScanStore } from "./scans_store";

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];

export interface DeletedScan {
  id: string;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

// One statement, so no reader can observe the scan gone before the marker that explains its absence.
export async function stampAndDeleteScans(
  tx: Tx,
  args: { ownerId: string; scanId?: string },
): Promise<DeletedScan[]> {
  const scoped = args.scanId
    ? sql`${scoreScans.ownerId} = ${args.ownerId} AND ${scoreScans.id} = ${args.scanId}`
    : sql`${scoreScans.ownerId} = ${args.ownerId}`;
  const result = await tx.execute(sql`
    WITH deleted AS (
      DELETE FROM ${scoreScans}
      WHERE ${scoped}
      RETURNING ${scoreScans.id} AS id, ${scoreScans.status} AS status
    ), stamped AS (
      UPDATE ${notes}
      SET score_scan_detached_at = now(), updated_at = now()
      WHERE ${notes.scoreScanId} IN (SELECT id FROM deleted WHERE status <> 'created')
        AND ${notes.readAt} IS NOT NULL
        AND ${notes.status} IN ('sent', 'retracted')
      RETURNING ${notes.id} AS id
    )
    SELECT id FROM deleted
  `);
  return rowsOf(result).map((row) => ({ id: String(row.id) }));
}

export interface TakenDownScan {
  id: string;
  ownerId: string;
  notesDetached: number;
}

// The row SURVIVES, unlike an owner delete: the owner is entitled to find out on their own shelf what happened to their file. One statement, for the same reason as above.
export async function takeDownScan(tx: Tx, scanId: string): Promise<TakenDownScan | null> {
  const result = await tx.execute(sql`
    WITH pre AS (
      SELECT ${scoreScans.id} AS id, ${scoreScans.status} AS status
      FROM ${scoreScans} WHERE ${scoreScans.id} = ${scanId}
    ), taken AS (
      UPDATE ${scoreScans}
      SET status = 'taken_down', taken_down_at = now(), blob_prefix = NULL, updated_at = now()
      WHERE ${scoreScans.id} = ${scanId} AND ${scoreScans.status} <> 'taken_down'
      RETURNING ${scoreScans.id} AS id, ${scoreScans.ownerId} AS owner_id
    ), detached AS (
      UPDATE ${notes}
      SET score_scan_id = NULL,
          -- Same guard as stampAndDeleteScans: a scan that never finished uploading was never in front of anyone.
          score_scan_detached_at = CASE
            WHEN ${notes.readAt} IS NOT NULL AND ${notes.status} IN ('sent', 'retracted')
              AND EXISTS (SELECT 1 FROM pre WHERE pre.status <> 'created')
            THEN now() ELSE ${notes.scoreScanDetachedAt} END,
          updated_at = now()
      WHERE ${notes.scoreScanId} IN (SELECT id FROM taken)
      RETURNING ${notes.id} AS id
    )
    SELECT taken.id, taken.owner_id, (SELECT count(*) FROM detached) AS notes_detached FROM taken
  `);
  const [row] = rowsOf(result);
  if (!row) return null;
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    notesDetached: Number(row.notes_detached ?? 0),
  };
}

// Both prefixes unconditionally: a commit that died between its promotes and the row flip leaves durable bytes under a row whose blob_prefix is still null.
export function scanPurgePrefixes(
  store: ScanStore,
  ownerId: string,
  deleted: DeletedScan[],
): string[] {
  return deleted.flatMap((scan) => [
    store.blobPrefix(ownerId, scan.id),
    store.incomingPrefix(ownerId, scan.id),
  ]);
}
