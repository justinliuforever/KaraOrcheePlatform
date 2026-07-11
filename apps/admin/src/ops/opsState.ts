import type { OpsFilters, OpsSeverity } from "../api";

// The URL query string is the single source of truth for an investigation —
// every filter / time-range / selection change rewrites it, so any state is a
// pasteable link. This module is the one place that reads and writes it.

export type OpsView = "logs" | "errors" | "queue";

export const FILTER_KEYS = [
  "kind",
  "source",
  "severity",
  "statusClass",
  "route",
  "method",
  "reqId",
  "oid",
  "admin",
  "job",
  "event",
  "text",
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export const RANGE_PRESETS = [
  { key: "15m", label: "Last 15m", ms: 15 * 60_000 },
  { key: "1h", label: "Last 1h", ms: 3_600_000 },
  { key: "6h", label: "Last 6h", ms: 6 * 3_600_000 },
  { key: "24h", label: "Last 24h", ms: 24 * 3_600_000 },
  { key: "7d", label: "Last 7d", ms: 7 * 86_400_000 },
  { key: "30d", label: "Last 30d", ms: 30 * 86_400_000 },
] as const;
export type RangeKey = (typeof RANGE_PRESETS)[number]["key"];

export function rangeMs(key: RangeKey): number {
  return RANGE_PRESETS.find((r) => r.key === key)!.ms;
}

export interface OpsState {
  view: OpsView;
  filters: Partial<Record<FilterKey, string>>;
  /** Live relative window — recomputed from now on every (re)fetch. */
  range: RangeKey | null;
  /** Frozen absolute window — wins over range when both ends are present. */
  from: string | null;
  to: string | null;
}

function isRangeKey(v: string | null): v is RangeKey {
  return RANGE_PRESETS.some((r) => r.key === v);
}

// Bare deep links (e.g. "/ops?view=errors" from the command palette) get the
// tab's seed defaults; explicit params always win.
export function parseOpsState(params: URLSearchParams): OpsState {
  const viewParam = params.get("view");
  const view: OpsView = viewParam === "errors" ? "errors" : viewParam === "queue" ? "queue" : "logs";
  const filters: Partial<Record<FilterKey, string>> = {};
  for (const k of FILTER_KEYS) {
    const v = params.get(k);
    if (v) filters[k] = v;
  }
  // Seed only when the param is truly absent — an explicit empty "severity="
  // means the operator cleared the Errors tab's preset and wants all severities.
  if (view === "errors" && !params.has("severity")) filters.severity = "error";
  const from = params.get("from");
  const to = params.get("to");
  const frozen = Boolean(from && to);
  const rangeParam = params.get("range");
  const range = frozen ? null : isRangeKey(rangeParam) ? rangeParam : view === "errors" ? "24h" : "1h";
  return { view, filters, range, from: frozen ? from : null, to: frozen ? to : null };
}

/** Canonical string for query keys: filters + window, stable key order.
 * Live ranges stay symbolic ("range=1h") so the key doesn't churn every tick. */
export function opsParamsString(state: OpsState): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = state.filters[k];
    if (v) p.set(k, v);
  }
  if (state.from && state.to) {
    p.set("from", state.from);
    p.set("to", state.to);
  } else if (state.range) {
    p.set("range", state.range);
  }
  return p.toString();
}

export function resolveWindow(state: OpsState, now = Date.now()): { from: string; to: string } {
  if (state.from && state.to) return { from: state.from, to: state.to };
  const ms = rangeMs(state.range ?? "1h");
  return { from: new Date(now - ms).toISOString(), to: new Date(now).toISOString() };
}

/** API params for the three filtered GETs — resolves the live window at call time. */
export function toApiFilters(state: OpsState): OpsFilters {
  const { text, ...rest } = state.filters;
  return { ...rest, ...(text ? { text } : {}), ...resolveWindow(state) };
}

// ---- severity presentation (label + gutter bar + text color; never color alone) ----

export const SEV_META: Record<OpsSeverity, { label: string; bar: string; text: string; badge: string }> = {
  error: { label: "ERR", bar: "bg-bad", text: "text-bad", badge: "bg-red-100 text-bad" },
  warn: { label: "WARN", bar: "bg-amber-500", text: "text-warn", badge: "bg-amber-100 text-warn" },
  info: { label: "INFO", bar: "bg-gray-300", text: "text-ink-faint", badge: "bg-gray-100 text-ink-soft" },
};

// ---- time helpers ----

export function tzLabel(): string {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtLocal(iso: string): string {
  return new Date(iso).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** ISO → value for <input type="datetime-local"> (local wall time, minute precision). */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
