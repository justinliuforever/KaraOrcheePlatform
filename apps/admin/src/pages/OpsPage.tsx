import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams, type SetURLSearchParams } from "react-router-dom";
import {
  ApiError,
  getOpsFacets,
  getOpsHistogram,
  getOpsLogs,
  type OpsFacetsResponse,
  type OpsHistogramResponse,
  type OpsLogsResponse,
} from "../api";
import { ErrorNote, PageHeader } from "../components/ui";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui-kit/tabs";
import { cn } from "@/lib/utils";
import FilterBar from "../ops/FilterBar";
import Histogram from "../ops/Histogram";
import FacetRail from "../ops/FacetRail";
import LogTable from "../ops/LogTable";
import LogDrawer from "../ops/LogDrawer";
import RequestTimeline from "../ops/RequestTimeline";
import QueuePanel from "../ops/QueuePanel";
import SavedViews from "../ops/SavedViews";
import {
  opsParamsString,
  parseOpsState,
  resolveWindow,
  toApiFilters,
  type FilterKey,
  type OpsState,
  type RangeKey,
} from "../ops/opsState";

export default function OpsPage() {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseOpsState(params), [params]);

  // Tabs are state seeds: switching rewrites the query string to that view's defaults.
  const switchView = (v: string) => {
    if (v === state.view) return;
    if (v === "queue") setParams({ view: "queue" });
    else if (v === "errors") setParams({ view: "errors", severity: "error", range: "24h" });
    else setParams({ view: "logs", range: "1h" });
  };

  return (
    <>
      <PageHeader
        title="Ops"
        subtitle="Logs, request timelines, and queue health"
        right={<SavedViews />}
      />
      <div className="mb-4">
        <Tabs value={state.view} onValueChange={switchView}>
          <TabsList>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="errors">Errors</TabsTrigger>
            <TabsTrigger value="queue">Queue</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {state.view === "queue" ? (
        <QueuePanel />
      ) : (
        <LogsView state={state} params={params} setParams={setParams} />
      )}
    </>
  );
}

function LogsView({
  state,
  params,
  setParams,
}: {
  state: OpsState;
  params: URLSearchParams;
  setParams: SetURLSearchParams;
}) {
  const qc = useQueryClient();
  const qs = opsParamsString(state);

  const selRaw = params.get("sel");
  const sel = selRaw != null && /^\d+$/.test(selRaw) ? Number(selRaw) : null;
  // Timeline overlay: tl=1 rides on the reqId filter param, so the deep link
  // carries reqId= and the table underneath shows that request's raw rows.
  const timelineReqId = params.get("tl") === "1" ? state.filters.reqId ?? null : null;
  const drawerOpen = sel != null || timelineReqId != null;

  const [auto, setAuto] = useState(false);
  const interval = auto && !drawerOpen ? 10_000 : false;

  const logsQ = useQuery<OpsLogsResponse, Error>({
    queryKey: ["ops-logs", qs],
    // toApiFilters resolves a live range's from/to at fetch time, so every
    // refetch of the same key slides the window to "now".
    queryFn: ({ signal }) => getOpsLogs(toApiFilters(state), { signal }),
    staleTime: 0,
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: interval,
  });
  const histQ = useQuery<OpsHistogramResponse, Error>({
    queryKey: ["ops-histogram", qs],
    queryFn: ({ signal }) => getOpsHistogram(toApiFilters(state), signal),
    staleTime: 0,
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: interval,
  });
  const facetsQ = useQuery<OpsFacetsResponse, Error>({
    queryKey: ["ops-facets", qs],
    queryFn: ({ signal }) => getOpsFacets(toApiFilters(state), signal),
    staleTime: 0,
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: interval,
  });

  const update = useCallback(
    (mutate: (p: URLSearchParams) => void, replace = false) => {
      const next = new URLSearchParams(params);
      mutate(next);
      setParams(next, { replace });
    },
    [params, setParams],
  );

  const setFilter = useCallback(
    (key: FilterKey, value: string | null) =>
      update((p) => {
        if (value) p.set(key, value);
        // Clearing severity on the Errors tab must beat the tab's seed default,
        // so it becomes an explicit empty param instead of disappearing.
        else if (key === "severity" && state.view === "errors") p.set(key, "");
        else p.delete(key);
        if (key === "reqId" && !value) p.delete("tl");
        p.delete("sel"); // row indexes shift under a new filter
      }),
    [update, state.view],
  );

  // Push the raw value: trimming here would fight the input's echo-sync while
  // the operator is mid-word ("bach " would snap back before "bach x").
  const onText = useCallback(
    (text: string) =>
      update((p) => {
        if (text) p.set("text", text);
        else p.delete("text");
        p.delete("sel");
      }, true),
    [update],
  );

  // Remember the last live preset so a histogram-brush freeze can be undone.
  const prevRange = useRef<RangeKey>(state.range ?? (state.view === "errors" ? "24h" : "1h"));
  useEffect(() => {
    if (state.range) prevRange.current = state.range;
  }, [state.range]);

  const onRange = useCallback(
    (key: RangeKey) =>
      update((p) => {
        p.set("range", key);
        p.delete("from");
        p.delete("to");
        p.delete("sel");
      }),
    [update],
  );

  const onAbsolute = useCallback(
    (from: string, to: string) =>
      update((p) => {
        p.set("from", from);
        p.set("to", to);
        p.delete("range");
        p.delete("sel");
      }),
    [update],
  );

  const onHalve = () => {
    const w = resolveWindow(state);
    const from = Date.parse(w.from);
    const to = Date.parse(w.to);
    onAbsolute(new Date(to - (to - from) / 2).toISOString(), w.to);
  };

  const onRefresh = () => {
    void logsQ.refetch();
    void histQ.refetch();
    void facetsQ.refetch();
  };

  // Slow-query affordance: after 5s of fetching, show elapsed time + Cancel.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!logsQ.isFetching) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [logsQ.isFetching]);

  const cancel = () => {
    void qc.cancelQueries({ queryKey: ["ops-logs", qs] });
    void qc.cancelQueries({ queryKey: ["ops-histogram", qs] });
    void qc.cancelQueries({ queryKey: ["ops-facets", qs] });
  };

  const rows = logsQ.data?.rows ?? [];

  const openRow = (idx: number) =>
    update((p) => {
      p.set("sel", String(idx));
      p.delete("tl");
    });
  const stepRow = (dir: 1 | -1) => {
    if (sel == null) return;
    const next = Math.min(rows.length - 1, Math.max(0, sel + dir));
    if (next !== sel) update((p) => p.set("sel", String(next)), true);
  };
  const closeDrawer = () =>
    update((p) => {
      p.delete("sel");
      p.delete("tl");
    });
  const openTimeline = (reqId: string) =>
    update((p) => {
      p.set("reqId", reqId);
      p.set("tl", "1");
      p.delete("sel");
    });

  const [railOpen, setRailOpen] = useState(true);
  const selectedRow = sel != null && sel < rows.length ? rows[sel] : null;

  return (
    <>
      <FilterBar
        state={state}
        onRemoveFilter={(k) => setFilter(k, null)}
        onText={onText}
        onRange={onRange}
        onAbsolute={onAbsolute}
        onRefresh={onRefresh}
        fetching={logsQ.isFetching}
        auto={auto}
        onAutoChange={setAuto}
        autoPaused={drawerOpen}
      />

      {histQ.data && (
        <div className={cn("transition-opacity", histQ.isFetching && "opacity-60")}>
          <Histogram
            buckets={histQ.data.buckets}
            binMinutes={histQ.data.binMinutes}
            onBrush={onAbsolute}
            onReset={() => onRange(prevRange.current)}
          />
        </div>
      )}

      {logsQ.isFetching && elapsed >= 5 && (
        <div className="mb-2 flex items-center gap-3 text-xs text-ink-soft">
          <span className="tabular-nums">Still loading… {elapsed}s</span>
          <Button variant="outline" size="xs" onClick={cancel}>
            Cancel
          </Button>
        </div>
      )}
      {logsQ.isError && (
        <div className="mb-3">
          <OpsQueryError error={logsQ.error} onHalve={onHalve} />
        </div>
      )}

      <div className="flex items-start gap-4">
        {railOpen ? (
          <div className="shrink-0">
            <button
              className="mb-1.5 px-1 text-xs text-ink-faint hover:text-ink-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm"
              onClick={() => setRailOpen(false)}
            >
              Hide facets
            </button>
            <FacetRail facets={facetsQ.data?.facets} state={state} onToggle={setFilter} />
          </div>
        ) : (
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setRailOpen(true)}>
            Facets
          </Button>
        )}

        {logsQ.isPending ? (
          <SkeletonTable />
        ) : (
          <LogTable
            rows={rows}
            truncated={logsQ.data?.truncated ?? false}
            dim={logsQ.isFetching}
            selIdx={sel}
            keysDisabled={drawerOpen}
            onOpen={openRow}
            onTimeline={openTimeline}
          />
        )}
      </div>

      {timelineReqId && (
        <RequestTimeline reqId={timelineReqId} onClose={() => update((p) => p.delete("tl"))} />
      )}
      {!timelineReqId && selectedRow && (
        <LogDrawer
          row={selectedRow}
          idx={sel!}
          count={rows.length}
          onClose={closeDrawer}
          onStep={stepRow}
          onFilter={(k, v) => setFilter(k, v)}
          onTimeline={openTimeline}
        />
      )}
    </>
  );
}

function OpsQueryError({ error, onHalve }: { error: Error; onHalve: () => void }) {
  if (error instanceof ApiError && error.code === "query_timeout") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-bad">
        <span className="min-w-0 flex-1">{error.message}</span>
        <Button variant="outline" size="sm" className="shrink-0" onClick={onHalve}>
          Halve time range
        </Button>
      </div>
    );
  }
  if (error instanceof ApiError && error.code === "busy") {
    return <ErrorNote message="Query service busy — retry in a few seconds." />;
  }
  return <ErrorNote message={error.message} />;
}

// First-load placeholder only; refetches dim the existing table instead so
// rows never blank out mid-investigation.
function SkeletonTable() {
  return (
    <Card className="min-w-0 flex-1 gap-0 overflow-hidden p-0">
      <div className="px-3 py-2">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 py-2">
            <div className="h-3 w-16 animate-pulse rounded bg-paper" />
            <div className="h-3 w-10 animate-pulse rounded bg-paper" />
            <div className="h-3 w-14 animate-pulse rounded bg-paper" />
            <div className="h-3 flex-1 animate-pulse rounded bg-paper" />
            <div className="h-3 w-16 animate-pulse rounded bg-paper" />
          </div>
        ))}
      </div>
    </Card>
  );
}
