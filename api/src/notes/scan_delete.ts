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
