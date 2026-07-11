import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui-kit/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-kit/table";
import { thCls } from "../components/ui";
import type { OpsLogRow } from "../api";
import { SEV_META, fmtClock } from "./opsState";

const CELL = "px-3 py-1.5";

export function rowWhat(r: OpsLogRow): string {
  if (r.kind === "http") {
    const parts = [`${r.method ?? "?"} ${r.route ?? "?"}`];
    if (r.status != null) parts.push(`→ ${r.status}`);
    if (r.ms != null) parts.push(`· ${r.ms}ms`);
    return parts.join(" ");
  }
  if (r.kind === "worker") {
    const bits = [r.event ?? "worker"];
    if (r.job) bits.push(r.job.slice(0, 8));
    return bits.join(" · ");
  }
  return r.msg;
}

/** Dense log rows. The table is a single tab stop: arrows move row focus,
 * Enter opens the drawer, Esc (handled by the drawer) closes it. */
export default function LogTable({
  rows,
  truncated,
  dim,
  selIdx,
  keysDisabled,
  onOpen,
  onTimeline,
}: {
  rows: OpsLogRow[];
  truncated: boolean;
  dim: boolean;
  selIdx: number | null;
  /** While the drawer is open it owns ArrowUp/Down (walks prev/next row). */
  keysDisabled: boolean;
  onOpen: (idx: number) => void;
  onTimeline: (reqId: string) => void;
}) {
  const [focusIdx, setFocusIdx] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const focus = Math.min(focusIdx, Math.max(0, rows.length - 1));

  const moveFocus = (next: number) => {
    const clamped = Math.min(rows.length - 1, Math.max(0, next));
    setFocusIdx(clamped);
    bodyRef.current
      ?.querySelector(`[data-idx="${clamped}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  return (
    <Card className={cn("min-w-0 flex-1 overflow-hidden p-0 gap-0 transition-opacity", dim && "opacity-60")}>
      <div
        tabIndex={0}
        aria-label="Log entries"
        className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-xl"
        onKeyDown={(e) => {
          if (keysDisabled) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            moveFocus(focus + 1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            moveFocus(focus - 1);
          } else if (e.key === "Enter" && rows.length > 0) {
            e.preventDefault();
            onOpen(focus);
          }
        }}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={`${thCls} w-24`}>Time</TableHead>
              <TableHead className={`${thCls} w-16`}>Sev</TableHead>
              <TableHead className={`${thCls} w-20`}>Source</TableHead>
              <TableHead className={thCls}>What</TableHead>
              <TableHead className={`${thCls} w-24`}>reqId</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody ref={bodyRef}>
            {rows.map((r, i) => {
              const sev = SEV_META[r.severity];
              return (
                <TableRow
                  key={`${r.t}-${i}`}
                  data-idx={i}
                  className={cn(
                    "cursor-pointer",
                    selIdx === i && "bg-brand-soft/40 hover:bg-brand-soft/50",
                    selIdx !== i && focus === i && "bg-paper",
                  )}
                  onClick={() => {
                    setFocusIdx(i);
                    onOpen(i);
                  }}
                >
                  <TableCell className={cn(CELL, "relative pl-4 tabular-nums text-xs text-ink-soft")}>
                    <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", sev.bar)} />
                    <span title={r.t}>{fmtClock(r.t)}</span>
                  </TableCell>
                  <TableCell className={CELL}>
                    <span className={cn("rounded px-1 py-px text-[10px] font-medium", sev.badge)}>
                      {sev.label}
                    </span>
                  </TableCell>
                  <TableCell className={CELL}>
                    <span
                      className={cn(
                        "rounded border px-1 py-px text-[10px] font-medium uppercase",
                        r.source === "worker" ? "border-brand/40 text-brand" : "border-line text-ink-soft",
                      )}
                    >
                      {r.source}
                    </span>
                  </TableCell>
                  <TableCell className={`${CELL} max-w-0 w-full`}>
                    <span className="block truncate text-xs" title={r.kind === "raw" ? r.msg : undefined}>
                      {rowWhat(r)}
                    </span>
                  </TableCell>
                  <TableCell className={CELL}>
                    {r.reqId ? (
                      <button
                        className="rounded border border-line bg-paper px-1.5 py-px font-mono text-[11px] text-ink-soft hover:border-brand/50 hover:text-brand focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        title={`${r.reqId} — view request timeline`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onTimeline(r.reqId!);
                        }}
                      >
                        {r.reqId.slice(0, 8)}
                      </button>
                    ) : (
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {rows.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-ink-soft">No log entries match.</p>
        )}
        {truncated && (
          <p className="border-t border-line px-4 py-2 text-xs text-ink-faint">
            Showing first {rows.length} — narrow the time range to see everything.
          </p>
        )}
      </div>
    </Card>
  );
}
