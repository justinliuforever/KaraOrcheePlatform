import { useEffect } from "react";
import { ChevronDown, ChevronUp, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui-kit/button";
import SlideOver from "../components/SlideOver";
import type { OpsLogRow } from "../api";
import { SEV_META, fmtLocal, type FilterKey } from "./opsState";

function copyText(v: string) {
  void navigator.clipboard.writeText(v).then(() => toast("Copied"));
}

interface Field {
  label: string;
  value: string;
  mono?: boolean;
  filterKey?: FilterKey;
  filterValue?: string;
}

function fieldsOf(r: OpsLogRow): Field[] {
  const out: Field[] = [];
  if (r.method) out.push({ label: "method", value: r.method, filterKey: "method", filterValue: r.method });
  if (r.route) out.push({ label: "route", value: r.route, mono: true, filterKey: "route", filterValue: r.route });
  if (r.status != null) {
    // No exact-status filter exists server-side — filtering pivots to the status class.
    out.push({
      label: "status",
      value: String(r.status),
      filterKey: "statusClass",
      filterValue: `${Math.floor(r.status / 100)}xx`,
    });
  }
  if (r.ms != null) out.push({ label: "ms", value: `${r.ms}ms` });
  if (r.reqId) out.push({ label: "reqId", value: r.reqId, mono: true, filterKey: "reqId", filterValue: r.reqId });
  if (r.oid) out.push({ label: "oid", value: r.oid, mono: true, filterKey: "oid", filterValue: r.oid });
  if (r.admin) out.push({ label: "admin", value: r.admin, filterKey: "admin", filterValue: r.admin });
  if (r.job) out.push({ label: "job", value: r.job, mono: true, filterKey: "job", filterValue: r.job });
  if (r.event) out.push({ label: "event", value: r.event, filterKey: "event", filterValue: r.event });
  return out;
}

export default function LogDrawer({
  row,
  idx,
  count,
  onClose,
  onStep,
  onFilter,
  onTimeline,
}: {
  row: OpsLogRow;
  idx: number;
  count: number;
  onClose: () => void;
  onStep: (dir: 1 | -1) => void;
  onFilter: (key: FilterKey, value: string) => void;
  onTimeline: (reqId: string) => void;
}) {
  // ↑/↓ walk prev/next row without closing; the table's own arrow handling is
  // suspended while the drawer is open so a single keypress moves exactly one row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      onStep(e.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStep]);

  const sev = SEV_META[row.severity];
  const fields = fieldsOf(row);

  return (
    <SlideOver
      width="min(48vw, 640px)"
      onClose={onClose}
      header={
        <div className="flex items-center gap-2.5">
          <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", sev.badge)}>{sev.label}</span>
          <span className="text-sm font-semibold tabular-nums" title={row.t}>
            {fmtLocal(row.t)}
          </span>
          <span
            className={cn(
              "rounded border px-1 py-px text-[10px] font-medium uppercase",
              row.source === "worker" ? "border-brand/40 text-brand" : "border-line text-ink-soft",
            )}
          >
            {row.source}
          </span>
          <span className="ml-auto text-xs text-ink-faint tabular-nums">
            {idx + 1} / {count}
          </span>
          <Button variant="outline" size="icon-xs" aria-label="Previous entry" disabled={idx <= 0} onClick={() => onStep(-1)}>
            <ChevronUp />
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Next entry"
            disabled={idx >= count - 1}
            onClick={() => onStep(1)}
          >
            <ChevronDown />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
      }
    >
      {fields.length > 0 && (
        <div className="rounded-xl border border-line bg-card px-4 py-3 mb-3">
          <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5">
            {fields.map((f) => (
              <div key={f.label} className="contents">
                <span className="py-0.5 text-xs text-ink-faint">{f.label}</span>
                <div className="group flex min-w-0 items-center gap-1.5 py-0.5">
                  <span
                    className={cn("min-w-0 truncate text-xs", f.mono && "font-mono")}
                    title={f.value}
                  >
                    {f.value}
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                    {f.filterKey && f.filterValue && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="h-5 px-1.5 text-[10px] text-ink-soft"
                        onClick={() => onFilter(f.filterKey!, f.filterValue!)}
                      >
                        Filter
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-5"
                      aria-label={`Copy ${f.label}`}
                      onClick={() => copyText(f.label === "ms" ? f.value.replace(/ms$/, "") : f.value)}
                    >
                      <Copy />
                    </Button>
                  </span>
                </div>
              </div>
            ))}
          </div>
          {row.reqId && (
            <Button size="sm" className="mt-3" onClick={() => onTimeline(row.reqId!)}>
              View request timeline
            </Button>
          )}
        </div>
      )}

      <div className="rounded-xl border border-line bg-card px-4 py-3 mb-3">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">Message</p>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label="Copy message"
            onClick={() => copyText(row.msg)}
          >
            <Copy />
          </Button>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm">{row.msg || "—"}</p>
      </div>

      <details className="rounded-xl border border-line bg-card overflow-hidden">
        <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-3 text-sm font-semibold">
          Raw JSON
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label="Copy raw JSON"
            onClick={(e) => {
              e.preventDefault();
              copyText(JSON.stringify(row, null, 2));
            }}
          >
            <Copy />
          </Button>
        </summary>
        <pre className="max-h-96 overflow-auto border-t border-line bg-paper px-4 py-3 font-mono text-xs">
          {JSON.stringify(row, null, 2)}
        </pre>
      </details>
    </SlideOver>
  );
}
