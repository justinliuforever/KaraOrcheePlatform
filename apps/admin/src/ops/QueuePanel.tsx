import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-kit/table";
import { ErrorNote, Spinner, thCls } from "../components/ui";
import StatusTag from "../components/StatusTag";
import { resolveTag } from "@/lib/tags";
import { getOpsQueue, type OpsQueueResponse } from "../api";
import { timeAgo } from "../studio/gateInfo";
import { fmtLocal } from "./opsState";

const CELL = "px-3 py-1.5";

export default function QueuePanel() {
  const [auto, setAuto] = useState(true);
  const q = useQuery<OpsQueueResponse, Error>({
    queryKey: ["ops-queue"],
    queryFn: ({ signal }) => getOpsQueue(signal),
    staleTime: 0,
    placeholderData: keepPreviousData,
    refetchInterval: auto ? 10_000 : false,
  });

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={cn(q.isFetching && "animate-spin")} />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={auto}
          className={cn(auto && "border-brand/40 bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand")}
          title="Refetch every 10 seconds"
          onClick={() => setAuto((v) => !v)}
        >
          {auto ? "Auto 10s" : "Auto off"}
        </Button>
      </div>

      {q.isPending && <Spinner />}
      {q.isError && <ErrorNote message={q.error.message} />}
      {q.data && (
        <div className={cn("space-y-4 transition-opacity", q.isFetching && !q.isPending && "opacity-60")}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {q.data.queues.map((queue) => (
              <Card key={queue.name} className="gap-2 p-4">
                <p className="font-mono text-sm font-medium truncate" title={queue.name}>
                  {queue.name}
                </p>
                <div className="flex items-center gap-4">
                  <Stat label="active" value={queue.active} />
                  <Stat label="scheduled" value={queue.scheduled} />
                  <div>
                    <p className="text-[11px] text-ink-faint">dead-lettered</p>
                    {queue.deadLettered > 0 ? (
                      <span className="inline-flex rounded-full border border-bad bg-bad px-2 py-0.5 text-xs font-medium text-white tabular-nums">
                        {queue.deadLettered}
                      </span>
                    ) : (
                      <p className="text-lg font-semibold tabular-nums">0</p>
                    )}
                  </div>
                </div>
              </Card>
            ))}
            {q.data.queues.length === 0 && (
              <Card className="items-center p-6 text-sm text-ink-soft">No queues reported.</Card>
            )}
          </div>

          <Card className="gap-0 overflow-hidden p-0">
            <p className="border-b border-line px-4 py-3 text-sm font-semibold">
              Dead-letter messages
              <span className="ml-2 text-xs font-normal text-ink-faint tabular-nums">{q.data.dlq.length}</span>
            </p>
            {q.data.dlq.length === 0 && (
              <p className="px-4 py-6 text-sm text-ink-soft">Dead-letter queue is empty.</p>
            )}
            {q.data.dlq.map((m) => (
              <div key={`${m.queue}-${m.sequenceNumber}`} className="border-b border-line/50 px-4 py-2.5 last:border-b-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-mono text-ink-soft">{m.queue}</span>
                  <span className="text-ink-faint tabular-nums">seq {m.sequenceNumber}</span>
                  <span className="text-ink-faint tabular-nums" title={m.enqueuedAt}>
                    {fmtLocal(m.enqueuedAt)}
                  </span>
                  {m.jobId && (
                    <Link
                      to={`/studio/${m.jobId}`}
                      className="font-mono text-brand hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm"
                    >
                      {m.jobId.slice(0, 8)}
                    </Link>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-bad break-words">{m.reason ?? "No reason recorded"}</p>
                {m.body && Object.keys(m.body).length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer select-none text-[11px] text-ink-faint hover:text-ink-soft">
                      body
                    </summary>
                    <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-paper px-3 py-2 font-mono text-[11px]">
                      {JSON.stringify(m.body, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </Card>

          <Card className="gap-0 overflow-hidden p-0">
            <p className="border-b border-line px-4 py-3 text-sm font-semibold">
              Recent jobs
              <span className="ml-2 text-xs font-normal text-ink-faint tabular-nums">{q.data.recentJobs.length}</span>
            </p>
            {q.data.recentJobs.length === 0 && (
              <p className="px-4 py-6 text-sm text-ink-soft">No recent jobs.</p>
            )}
            {q.data.recentJobs.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={thCls}>Job</TableHead>
                    <TableHead className={thCls}>Piece</TableHead>
                    <TableHead className={thCls}>Status</TableHead>
                    <TableHead className={thCls}>Check</TableHead>
                    <TableHead className={thCls}>Error</TableHead>
                    <TableHead className={`${thCls} text-right`}>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.recentJobs.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className={CELL}>
                        <Link
                          to={`/studio/${j.id}`}
                          className="font-mono text-xs text-brand hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm"
                          title={j.id}
                        >
                          {j.id.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className={CELL}>
                        <Link
                          to={`/pieces/${j.pieceId}`}
                          className="font-mono text-xs text-brand hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm"
                          title={j.pieceId}
                        >
                          {j.pieceId}
                        </Link>
                      </TableCell>
                      <TableCell className={CELL}>
                        {resolveTag(j.status, "lifecycle") ? (
                          <StatusTag value={j.status} family="lifecycle" />
                        ) : (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-ink-soft">
                            {j.status}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={`${CELL} text-xs text-ink-soft`}>{j.checkStatus}</TableCell>
                      <TableCell className={`${CELL} max-w-0 w-full`}>
                        {j.error ? (
                          <span className="block truncate text-xs text-bad" title={j.error}>
                            {j.error}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-faint">—</span>
                        )}
                      </TableCell>
                      <TableCell className={`${CELL} text-right text-xs text-ink-soft tabular-nums`}>
                        <span title={new Date(j.updatedAt).toLocaleString()}>{timeAgo(j.updatedAt)}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[11px] text-ink-faint">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
