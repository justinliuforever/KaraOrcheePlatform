import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { listNoteJobs, type NoteJobMetrics, type NoteJobsResponse } from "../api";
import { ErrorNote, Spinner, thCls } from "../components/ui";
import StatusTag from "../components/StatusTag";
import ToneBadge from "../components/ToneBadge";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Input } from "@/components/ui-kit/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui-kit/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-kit/table";
import { timeAgo } from "../studio/gateInfo";
import NoteJobPanel from "./NoteJobPanel";

const STAGES = ["asr", "llm", "gates"] as const;

function metricSummary(m: NoteJobMetrics): string {
  const bits: string[] = [];
  if (typeof m.asr_secs === "number") bits.push(`asr ${m.asr_secs}s`);
  if (typeof m.llm_secs === "number") bits.push(`llm ${m.llm_secs}s`);
  return bits.join(" · ");
}

function FacetGroup({
  title,
  facets,
  selected,
  onSelect,
}: {
  title: string;
  facets: { value: string; count: number }[];
  selected: string;
  onSelect: (value: string | null) => void;
}) {
  return (
    <div>
      <p className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">{title}</p>
      <button
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          selected === "" ? "bg-brand-soft text-brand font-medium" : "text-ink-soft hover:bg-paper",
        )}
        onClick={() => onSelect(null)}
      >
        <span className="min-w-0 flex-1 truncate">all</span>
        <span className="tabular-nums text-ink-faint">
          {facets.reduce((a, f) => a + f.count, 0)}
        </span>
      </button>
      {facets.length === 0 && <p className="px-1.5 py-1 text-xs text-ink-faint">—</p>}
      {facets.map((f) => {
        const active = selected === f.value;
        return (
          <button
            key={f.value}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active ? "bg-brand-soft text-brand font-medium" : "text-ink-soft hover:bg-paper",
            )}
            onClick={() => onSelect(active ? null : f.value)}
          >
            <span className="min-w-0 flex-1 truncate">{f.value.replaceAll("_", " ")}</span>
            <span className={cn("tabular-nums", active ? "text-brand/70" : "text-ink-faint")}>{f.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Self-contained notes-jobs lane inside /ops. It does NOT ride the OpsState machine
 * (no time-range / histogram / severity): status + stage + q are its own query state,
 * with the selected job id in ?sel for a shareable deep link. */
export default function NotesJobsView() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const stage = params.get("stage") ?? "";
  const ownerRole = params.get("ownerRole") ?? "";
  const failureCode = params.get("failureCode") ?? "";
  const sel = params.get("sel");
  const q = params.get("q") ?? "";

  // The input echoes locally; the trimmed term is debounced into ?q so it's deep-linkable
  // and stays consistent with facet clicks (which rebuild the URL from current params).
  // replace:true keeps per-keystroke writes out of the history stack.
  const [search, setSearch] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => {
      const v = search.trim();
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v) next.set("q", v);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => clearTimeout(t);
  }, [search, setParams]);

  const query = useQuery<NoteJobsResponse, Error>({
    queryKey: ["note-jobs", status, stage, ownerRole, failureCode, q],
    queryFn: () => listNoteJobs({ status, stage, ownerRole, failureCode, q }),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    next.set("view", "notes-jobs");
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next);
  };

  const statusFacets = query.data?.facets.status ?? [];
  const ownerRoleFacets = query.data?.facets.ownerRole ?? [];
  const failureCodeFacets = query.data?.facets.failureCode ?? [];

  return (
    <>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Input
          className="w-72"
          placeholder="Search recorder email / name or job id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={stage || "all"} onValueChange={(v) => set({ stage: v === "all" ? null : v, sel: null })}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="Any stage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any stage</SelectItem>
            {STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.toUpperCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={cn(query.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {query.isError && <ErrorNote message={query.error.message} />}

      <div className="flex items-start gap-4">
        <div className="w-52 shrink-0 rounded-xl border border-line bg-card p-2">
          <FacetGroup
            title="Status"
            facets={statusFacets}
            selected={status}
            onSelect={(v) => set({ status: v, sel: null })}
          />
          <div className="mt-2 border-t border-line/50 pt-2">
            <FacetGroup
              title="Recorder"
              facets={ownerRoleFacets}
              selected={ownerRole}
              onSelect={(v) => set({ ownerRole: v, sel: null })}
            />
          </div>
          {failureCodeFacets.length > 0 && (
            <div className="mt-2 border-t border-line/50 pt-2">
              <FacetGroup
                title="Failure"
                facets={failureCodeFacets}
                selected={failureCode}
                onSelect={(v) => set({ failureCode: v, sel: null })}
              />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {query.isPending ? (
            <Spinner />
          ) : (
            <Card className={cn("overflow-hidden p-0 gap-0", query.isFetching && "opacity-60")}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={thCls}>Job</TableHead>
                    <TableHead className={thCls}>Status</TableHead>
                    <TableHead className={thCls}>Stage</TableHead>
                    <TableHead className={`${thCls} text-right`}>Attempts</TableHead>
                    <TableHead className={thCls}>Recorder</TableHead>
                    <TableHead className={thCls}>Piece</TableHead>
                    <TableHead className={thCls}>Timings</TableHead>
                    <TableHead className={`${thCls} text-right`}>Annot.</TableHead>
                    <TableHead className={`${thCls} text-right`}>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(query.data?.items ?? []).map((j) => (
                    <TableRow
                      key={j.id}
                      className={cn("cursor-pointer", sel === j.id && "bg-brand-soft/40 hover:bg-brand-soft/50")}
                      onClick={() => set({ sel: j.id })}
                    >
                      <TableCell className="px-4 py-2.5 font-mono text-xs" title={j.id}>
                        {j.id.slice(0, 8)}
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <StatusTag value={j.status} family="lifecycle" label={j.status.replaceAll("_", " ")} />
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-xs text-ink-soft">
                        {j.failureCode ? (
                          <ToneBadge tone="bad">{j.failureCode}</ToneBadge>
                        ) : (
                          (j.stage ?? "—")
                        )}
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-right text-xs text-ink-soft tabular-nums">
                        {j.attempts}
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-xs text-ink-soft">
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate max-w-40" title={j.ownerEmail ?? undefined}>
                            {j.ownerEmail ?? "—"}
                          </span>
                          {j.ownerRole && (
                            <ToneBadge tone={j.ownerRole === "teacher" ? "ok" : "muted"}>{j.ownerRole}</ToneBadge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-xs text-ink-soft">
                        <span className="block truncate max-w-40" title={j.pieceLabel ?? j.pieceId ?? undefined}>
                          {j.pieceLabel ?? j.pieceId ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-xs text-ink-soft tabular-nums">
                        {metricSummary(j.metrics) || "—"}
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-right text-xs text-ink-soft tabular-nums">
                        {typeof j.metrics.annotations === "number"
                          ? `${j.metrics.grounded ?? 0}/${j.metrics.annotations}`
                          : "—"}
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-right text-xs text-ink-soft tabular-nums">
                        <span title={new Date(j.createdAt).toLocaleString()}>{timeAgo(j.createdAt)}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                  {query.data && query.data.items.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell className="px-4 py-10 text-center whitespace-normal" colSpan={9}>
                        <p className="text-sm font-medium text-ink">No note jobs found</p>
                        <p className="text-sm text-ink-soft mt-1">
                          Jobs appear when a lesson is submitted for notes.
                        </p>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>
      </div>

      {sel && <NoteJobPanel key={sel} id={sel} onClose={() => set({ sel: null })} />}
    </>
  );
}
