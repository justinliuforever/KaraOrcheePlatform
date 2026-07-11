import { LogsQueryClient, LogsQueryResultStatus } from "@azure/monitor-query-logs";
import { DefaultAzureCredential } from "@azure/identity";

// Ops log querying against the Log Analytics workspace. Entra-only by platform
// constraint: the Logs Query API has NO key/connection-string auth path (the one
// documented exception to this repo's keys-only convention). Locally
// DefaultAzureCredential falls back to the az CLI login; on Container Apps it
// uses the app's managed identity.
//
// The browser NEVER sends KQL. Routes hand this module a validated filter
// object; KQL is composed here from an allowlist. The dynamic-JSON columns
// (Log_kind_s, ...) are outside Microsoft's documented table contract and have
// regressed before, so every access goes through column_ifexists() — a schema
// regression degrades results, never breaks the page.

export interface OpsFilters {
  kind?: string;
  source?: string;
  severity?: string; // comma-list of error|warn|info
  statusClass?: string; // 2xx|3xx|4xx|5xx
  route?: string;
  method?: string;
  reqId?: string;
  oid?: string;
  admin?: string;
  job?: string;
  event?: string;
  text?: string;
}

export interface OpsLogRow {
  t: string;
  source: "api" | "worker";
  kind: "http" | "worker" | "raw";
  severity: "error" | "warn" | "info";
  reqId: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  ms: number | null;
  oid: string | null;
  admin: string | null;
  job: string | null;
  event: string | null;
  msg: string;
}

export interface OpsHistogramBucket {
  t: string;
  error: number;
  warn: number;
  info: number;
}

export interface OpsFacet {
  value: string;
  count: number;
}

export interface OpsLogsStore {
  queryLogs(
    filters: OpsFilters,
    from: Date,
    to: Date,
    limit: number,
    order: "asc" | "desc",
  ): Promise<{ rows: OpsLogRow[]; truncated: boolean }>;
  queryHistogram(
    filters: OpsFilters,
    from: Date,
    to: Date,
  ): Promise<{ buckets: OpsHistogramBucket[]; binMinutes: number }>;
  queryFacets(filters: OpsFilters, from: Date, to: Date): Promise<Record<string, OpsFacet[]>>;
  queryRequest(reqId: string): Promise<OpsLogRow[]>;
}

export class OpsQueryError extends Error {
  constructor(
    public code: "query_timeout" | "busy" | "query_failed",
    message: string,
  ) {
    super(message);
    this.name = "OpsQueryError";
  }
}

// KQL string literal: double quotes + backslashes escaped, control chars stripped.
// Values only ever appear inside "..." literals — never as bare identifiers.
export function kqlString(v: string): string {
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, "");
  return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const SEVERITIES = new Set(["error", "warn", "info"]);
const KINDS = new Set(["http", "worker", "raw"]);
const SOURCES = new Set(["api", "worker"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const STATUS_CLASSES: Record<string, [number, number]> = {
  "2xx": [200, 300],
  "3xx": [300, 400],
  "4xx": [400, 500],
  "5xx": [500, 600],
};

// Base projection: physical → logical, entirely inside KQL so the API result is
// already logical fields. column_ifexists() tolerates schema regressions.
const BASE = `ContainerAppConsoleLogs_CL
| extend ['raw'] = column_ifexists("Log_s", "")
| extend kind0 = tostring(column_ifexists("Log_kind_s", ""))
| extend ['kind'] = case(kind0 == "http", "http", kind0 == "worker", "worker", "raw")
| extend ['source'] = iff(ContainerAppName_s contains "worker", "worker", "api")
| extend ['status'] = toint(column_ifexists("Log_status_d", ""))
| extend ['ms'] = todouble(column_ifexists("Log_ms_d", ""))
| extend ['reqId'] = tostring(coalesce(column_ifexists("Log_reqId_g", ""), column_ifexists("Log_reqId_s", "")))
| extend ['method'] = tostring(column_ifexists("Log_method_s", ""))
| extend ['route'] = tostring(column_ifexists("Log_route_s", ""))
| extend ['oid'] = tostring(coalesce(column_ifexists("Log_oid_g", ""), column_ifexists("Log_oid_s", "")))
| extend ['admin'] = tostring(coalesce(column_ifexists("Log_admin_g", ""), column_ifexists("Log_admin_s", "")))
| extend ['job'] = tostring(coalesce(column_ifexists("Log_job_g", ""), column_ifexists("Log_job_s", "")))
| extend ['event'] = tostring(column_ifexists("Log_event_s", ""))
| extend ['stream'] = tostring(column_ifexists("Stream_s", "stdout"))
| extend ['severity'] = case(
    ['kind'] == "http" and ['status'] >= 500, "error",
    ['kind'] == "http" and ['status'] >= 400, "warn",
    ['kind'] == "worker" and ['event'] in ("error", "dead-letter", "fail"), "error",
    ['kind'] == "raw" and ['stream'] == "stderr", "warn",
    "info")`;

// Composes the shared filter pipeline. Every value passes through kqlString or a
// closed enum check — operator input can never become KQL syntax.
export function buildWhere(filters: OpsFilters): string {
  const parts: string[] = [];
  if (filters.kind && KINDS.has(filters.kind)) parts.push(`['kind'] == ${kqlString(filters.kind)}`);
  if (filters.source && SOURCES.has(filters.source)) parts.push(`['source'] == ${kqlString(filters.source)}`);
  if (filters.severity) {
    const wanted = filters.severity.split(",").map((s) => s.trim()).filter((s) => SEVERITIES.has(s));
    if (wanted.length > 0 && wanted.length < 3) {
      parts.push(`['severity'] in (${wanted.map(kqlString).join(", ")})`);
    }
  }
  if (filters.statusClass && STATUS_CLASSES[filters.statusClass]) {
    const [lo, hi] = STATUS_CLASSES[filters.statusClass]!;
    parts.push(`['status'] >= ${lo} and ['status'] < ${hi}`);
  }
  if (filters.method && METHODS.has(filters.method)) parts.push(`['method'] == ${kqlString(filters.method)}`);
  if (filters.route) parts.push(`['route'] == ${kqlString(filters.route)}`);
  if (filters.reqId) parts.push(`['reqId'] == ${kqlString(filters.reqId)}`);
  if (filters.oid) parts.push(`['oid'] == ${kqlString(filters.oid)}`);
  if (filters.admin) parts.push(`['admin'] == ${kqlString(filters.admin)}`);
  if (filters.job) parts.push(`['job'] == ${kqlString(filters.job)}`);
  if (filters.event) parts.push(`['event'] == ${kqlString(filters.event)}`);
  if (filters.text) parts.push(`(['raw'] contains ${kqlString(filters.text)} or ['route'] contains ${kqlString(filters.text)})`);
  return parts.length ? `| where ${parts.join(" and ")}` : "";
}

const PROJECT = `| project TimeGenerated, ['source'], ['kind'], ['severity'], ['reqId'], ['method'], ['route'], ['status'], ['ms'], ['oid'], ['admin'], ['job'], ['event'], ['raw']`;

export function buildLogsQuery(filters: OpsFilters, limit: number, order: "asc" | "desc"): string {
  return `${BASE}\n${buildWhere(filters)}\n| order by TimeGenerated ${order}\n| take ${Math.floor(limit)}\n${PROJECT}`;
}

// ~60 buckets, snapped to human-scale bins.
export function pickBinMinutes(from: Date, to: Date): number {
  const spanMin = Math.max(1, (to.getTime() - from.getTime()) / 60_000);
  const steps = [1, 5, 15, 30, 60, 180, 360, 720, 1440];
  for (const s of steps) if (spanMin / s <= 70) return s;
  return 1440;
}

export function buildHistogramQuery(filters: OpsFilters, binMinutes: number): string {
  return `${BASE}\n${buildWhere(filters)}\n| summarize n = count() by ['severity'], t = bin(TimeGenerated, ${Math.floor(binMinutes)}m)\n| order by t asc`;
}

const FACET_FIELDS = ["severity", "source", "statusClass", "route", "event", "admin"] as const;

export function buildFacetsQuery(filters: OpsFilters): string {
  // One round-trip for every facet: union of per-field summarizes over the same
  // filtered base. statusClass is derived from status at facet time.
  const base = `${BASE}\n${buildWhere(filters)}\n| extend ['statusClass'] = case(['status'] >= 500, "5xx", ['status'] >= 400, "4xx", ['status'] >= 300, "3xx", ['status'] >= 200, "2xx", "")`;
  const arms = FACET_FIELDS.map(
    (f) =>
      `(base | where isnotempty(['${f}']) | summarize count_ = count() by value = tostring(['${f}']) | top 8 by count_ | extend facet = "${f}")`,
  );
  return `let base = ${base};\nunion ${arms.join(",\n")}`;
}

function cell(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function toRow(r: Record<string, unknown>): OpsLogRow {
  const num = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => {
    const s = v == null ? "" : String(v);
    return s === "" ? null : s;
  };
  return {
    t: new Date(String(cell(r, "TimeGenerated"))).toISOString(),
    source: cell(r, "source") === "worker" ? "worker" : "api",
    kind: (["http", "worker"].includes(String(cell(r, "kind"))) ? String(cell(r, "kind")) : "raw") as OpsLogRow["kind"],
    severity: (["error", "warn"].includes(String(cell(r, "severity"))) ? String(cell(r, "severity")) : "info") as OpsLogRow["severity"],
    reqId: str(cell(r, "reqId")),
    method: str(cell(r, "method")),
    route: str(cell(r, "route")),
    status: num(cell(r, "status")),
    ms: num(cell(r, "ms")),
    oid: str(cell(r, "oid")),
    admin: str(cell(r, "admin")),
    job: str(cell(r, "job")),
    event: str(cell(r, "event")),
    msg: String(cell(r, "raw") ?? ""),
  };
}

export function createLogAnalyticsOpsStore(workspaceId: string): OpsLogsStore {
  const client = new LogsQueryClient(new DefaultAzureCredential());
  // The whole console shares one service-principal budget (200 req/30s, 5
  // concurrent). Serialize to 3 in-flight so an eager dashboard can't exhaust it.
  let inFlight = 0;
  const waiters: (() => void)[] = [];
  async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (inFlight >= 3) await new Promise<void>((r) => waiters.push(r));
    inFlight++;
    try {
      return await fn();
    } finally {
      inFlight--;
      waiters.shift()?.();
    }
  }

  async function run(query: string, from: Date, to: Date): Promise<Record<string, unknown>[]> {
    return withSlot(async () => {
      let result;
      try {
        result = await client.queryWorkspace(workspaceId, query, {
          startTime: from,
          endTime: to,
        }, { serverTimeoutInSeconds: 30 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/429|throttl/i.test(msg)) throw new OpsQueryError("busy", "Query service busy — retry in a few seconds.");
        if (/timeout|504/i.test(msg)) {
          throw new OpsQueryError("query_timeout", "Query exceeded 30s — try a shorter time range or add a filter.");
        }
        throw new OpsQueryError("query_failed", msg.slice(0, 300));
      }
      if (result.status !== LogsQueryResultStatus.Success) {
        const detail = "partialError" in result ? String(result.partialError?.message ?? "") : "";
        throw new OpsQueryError("query_failed", detail.slice(0, 300) || "Query failed.");
      }
      const table = result.tables[0];
      if (!table) return [];
      const names = table.columnDescriptors.map((c) => c.name);
      return table.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, (row as unknown[])[i]])));
    });
  }

  return {
    async queryLogs(filters, from, to, limit, order) {
      const rows = (await run(buildLogsQuery(filters, limit, order), from, to)).map(toRow);
      return { rows, truncated: rows.length >= limit };
    },
    async queryHistogram(filters, from, to) {
      const binMinutes = pickBinMinutes(from, to);
      const raw = await run(buildHistogramQuery(filters, binMinutes), from, to);
      const byT = new Map<string, OpsHistogramBucket>();
      for (const r of raw) {
        const t = new Date(String(r.t)).toISOString();
        const b = byT.get(t) ?? { t, error: 0, warn: 0, info: 0 };
        const sev = String(r.severity) as "error" | "warn" | "info";
        if (sev === "error" || sev === "warn" || sev === "info") b[sev] += Number(r.n) || 0;
        byT.set(t, b);
      }
      return { buckets: [...byT.values()].sort((a, b) => a.t.localeCompare(b.t)), binMinutes };
    },
    async queryFacets(filters, from, to) {
      const raw = await run(buildFacetsQuery(filters), from, to);
      const out: Record<string, OpsFacet[]> = {};
      for (const r of raw) {
        const facet = String(r.facet);
        (out[facet] ??= []).push({ value: String(r.value), count: Number(r.count_) || 0 });
      }
      for (const k of Object.keys(out)) out[k]!.sort((a, b) => b.count - a.count);
      return out;
    },
    async queryRequest(reqId) {
      // Full interactive retention: a queue job can run long after its request.
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
      const rows = await run(buildLogsQuery({ reqId }, 500, "asc"), from, to);
      return rows.map(toRow);
    },
  };
}
