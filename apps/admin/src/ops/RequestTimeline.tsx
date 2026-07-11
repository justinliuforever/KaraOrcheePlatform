import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui-kit/button";
import SlideOver from "../components/SlideOver";
import { ErrorNote, Spinner } from "../components/ui";
import { getOpsRequest, type OpsRequestResponse, type OpsTimelineEvent } from "../api";
import { SEV_META, fmtClock } from "./opsState";

// Lanes are told apart by shape + fill + text, never color alone: API is a square
// outline, WORKER a pill outline, AUDIT the one filled badge so admin actions pop.
const LANE_META: Record<OpsTimelineEvent["lane"], { label: string; cls: string }> = {
  api: { label: "API", cls: "rounded-sm border border-line bg-card text-ink-soft" },
  worker: { label: "WORKER", cls: "rounded-full border border-line bg-card text-ink-soft" },
  audit: { label: "AUDIT", cls: "rounded-sm bg-ink text-white" },
};

function eventMeta(e: OpsTimelineEvent): string | null {
  const bits: string[] = [];
  if (e.method || e.route) bits.push(`${e.method ?? "?"} ${e.route ?? "?"}`);
  if (e.status != null) bits.push(`→ ${e.status}`);
  if (e.ms != null) bits.push(`· ${e.ms}ms`);
  if (e.event) bits.push(e.event);
  if (e.job) bits.push(`job ${e.job.slice(0, 8)}`);
  return bits.length > 0 ? bits.join(" ") : null;
}

export default function RequestTimeline({ reqId, onClose }: { reqId: string; onClose: () => void }) {
  const [relative, setRelative] = useState(false);
  const q = useQuery<OpsRequestResponse, Error>({
    queryKey: ["ops-request", reqId],
    queryFn: ({ signal }) => getOpsRequest(reqId, signal),
    staleTime: 0,
  });

  const events = q.data?.events ?? [];
  const t0 = events.length > 0 ? Date.parse(events[0].t) : 0;

  return (
    <SlideOver
      width="min(52vw, 720px)"
      onClose={onClose}
      header={
        <div className="flex items-center gap-2.5">
          <p className="text-sm font-semibold">Request timeline</p>
          <span className="rounded border border-line bg-paper px-1.5 py-px font-mono text-[11px] text-ink-soft" title={reqId}>
            {reqId}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label="Copy request id"
            onClick={() => void navigator.clipboard.writeText(reqId).then(() => toast("Copied"))}
          >
            <Copy />
          </Button>
          <span className="ml-auto" />
          {events.length > 0 && (
            <Button variant="outline" size="xs" onClick={() => setRelative((v) => !v)}>
              {relative ? "Relative to first event" : "Absolute time"}
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
      }
    >
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNote message={q.error.message} />}
      {q.data && events.length === 0 && (
        <div className="rounded-xl border border-line bg-card px-4 py-10 text-center text-sm text-ink-soft">
          No events found for this request (logs older than 30 days are gone).
        </div>
      )}
      {events.length > 0 && (
        <div className="rounded-xl border border-line bg-card overflow-hidden">
          {events.map((e, i) => {
            const sev = e.severity ? SEV_META[e.severity] : null;
            const lane = LANE_META[e.lane];
            const meta = eventMeta(e);
            return (
              <div
                key={`${e.t}-${i}`}
                className="relative flex items-start gap-3 border-b border-line/50 py-2 pl-4 pr-4 last:border-b-0"
              >
                {sev && <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", sev.bar)} />}
                <span className="w-20 shrink-0 pt-0.5 text-xs tabular-nums text-ink-soft" title={e.t}>
                  {relative ? `+${((Date.parse(e.t) - t0) / 1000).toFixed(1)}s` : fmtClock(e.t)}
                </span>
                <span
                  className={cn(
                    "w-16 shrink-0 px-1.5 py-px text-center text-[10px] font-medium",
                    lane.cls,
                  )}
                >
                  {lane.label}
                </span>
                <div className="min-w-0 flex-1">
                  {e.lane === "audit" ? (
                    <p className="break-words text-sm">
                      <span className="font-medium">{e.action ?? e.msg}</span>
                      {e.actorEmail && <span className="text-ink-soft"> · {e.actorEmail}</span>}
                    </p>
                  ) : (
                    <p className="break-words text-sm">{e.msg}</p>
                  )}
                  {meta && <p className="text-xs text-ink-faint tabular-nums">{meta}</p>}
                  {e.detail && Object.keys(e.detail).length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-[11px] text-ink-faint hover:text-ink-soft">
                        detail
                      </summary>
                      <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-paper px-3 py-2 font-mono text-[11px]">
                        {JSON.stringify(e.detail, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SlideOver>
  );
}
