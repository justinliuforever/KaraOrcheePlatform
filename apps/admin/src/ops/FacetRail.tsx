import { cn } from "@/lib/utils";
import type { OpsFacetKey, OpsFacetsResponse } from "../api";
import type { FilterKey, OpsState } from "./opsState";

const GROUPS: { key: OpsFacetKey; label: string }[] = [
  { key: "severity", label: "Severity" },
  { key: "source", label: "Source" },
  { key: "statusClass", label: "Status" },
  { key: "route", label: "Route" },
  { key: "event", label: "Event" },
  { key: "admin", label: "Admin" },
];

/** Facet groups with counts under the current filters. Single-select per key:
 * clicking a value sets that filter, clicking the active value clears it. */
export default function FacetRail({
  facets,
  state,
  onToggle,
}: {
  facets: OpsFacetsResponse["facets"] | undefined;
  state: OpsState;
  onToggle: (key: FilterKey, value: string | null) => void;
}) {
  return (
    <div className="w-56 shrink-0 space-y-3">
      {GROUPS.map((g) => {
        const values = facets?.[g.key] ?? [];
        const active = state.filters[g.key];
        return (
          <div key={g.key} className="rounded-xl border border-line bg-card p-2">
            <p className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              {g.label}
            </p>
            {values.length === 0 && <p className="px-1.5 pb-1 text-xs text-ink-faint">—</p>}
            <div className="max-h-56 overflow-y-auto">
              {values.map((v) => {
                const isActive = active === v.value;
                return (
                  <button
                    key={v.value}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      isActive ? "bg-brand-soft text-brand font-medium" : "text-ink-soft hover:bg-paper",
                    )}
                    title={v.label ?? v.value}
                    onClick={() => onToggle(g.key, isActive ? null : v.value)}
                  >
                    <span className="min-w-0 flex-1 truncate">{v.label ?? v.value}</span>
                    <span className={cn("tabular-nums", isActive ? "text-brand/70" : "text-ink-faint")}>
                      {v.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
