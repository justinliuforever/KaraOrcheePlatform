import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, type StudioJob } from "../api";
import { ErrorNote, PageHeader, Spinner, thCls } from "../components/ui";
import StatusTag from "../components/StatusTag";
import { ALL_GATES, statusLabel, timeAgo } from "../studio/gateInfo";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Input } from "@/components/ui-kit/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-kit/table";

export function GateDots({ job }: { job: StudioJob }) {
  return (
    <div className="flex items-center gap-1">
      {ALL_GATES.map((g) => {
        const entry = job.gates?.[g.key];
        const color =
          entry?.status === "pass"
            ? "bg-ok"
            : entry?.status === "fail"
              ? "bg-bad"
              : entry?.status === "running"
                ? "bg-warn animate-pulse"
                : "bg-line";
        return <div key={g.key} className={`size-2 rounded-full ${color}`} title={`${g.label}: ${entry?.status ?? "pending"}`} />;
      })}
    </div>
  );
}

type Stage = "all" | "draft" | "verifying" | "review" | "published" | "failed" | "canceled";

// The board filter IS the pipeline: Draft → Verifying → Review → Published, with
// Failed and Canceled as off-ramp chips. The buckets are a strict PARTITION (a
// check-failed draft counts as Failed, not Draft) so counts never double-count.
// All EXCLUDES discarded builds — they are dead ends, not work in progress;
// the Canceled chip is the one place that shows them (Reopen lives there).
function inStage(j: StudioJob, stage: Stage): boolean {
  switch (stage) {
    case "draft":
      return j.status === "draft" && j.checkStatus !== "fail";
    case "verifying":
      return j.status === "queued" || j.status === "running";
    case "review":
      return j.status === "ready_for_review";
    case "published":
      return j.status === "published";
    case "failed":
      return j.status === "failed" || (j.status === "draft" && j.checkStatus === "fail");
    case "canceled":
      return j.status === "canceled";
    case "all":
      return j.status !== "canceled";
  }
}

function PipelineFilter({
  items,
  stage,
  onStage,
}: {
  items: StudioJob[];
  stage: Stage;
  onStage: (s: Stage) => void;
}) {
  const count = (s: Stage) => items.filter((j) => inStage(j, s)).length;
  const stages: { key: Stage; label: string }[] = [
    { key: "draft", label: "Draft" },
    { key: "verifying", label: "Verifying" },
    { key: "review", label: "Review" },
    { key: "published", label: "Published" },
  ];
  const failedCount = count("failed");
  const canceledCount = count("canceled");
  const chip = (key: Stage, label: string, extra = "") => {
    const active = stage === key;
    return (
      <Button
        key={key}
        variant={active ? "secondary" : "ghost"}
        size="sm"
        className={cn(active ? "text-brand" : "text-ink-soft", extra)}
        onClick={() => onStage(key)}
      >
        {label}
        <span className="ml-1.5 text-xs tabular-nums opacity-70">{count(key)}</span>
      </Button>
    );
  };
  return (
    <div className="flex items-center gap-0.5">
      {chip("all", "All")}
      <span className="w-px h-5 bg-line mx-2.5" />
      {stages.map((s, i) => (
        <span key={s.key} className="flex items-center">
          {chip(s.key, s.label)}
          {i < stages.length - 1 && <span className="text-ink-faint text-xs mx-0.5">→</span>}
        </span>
      ))}
      <span className="w-px h-5 bg-line mx-2.5" />
      {failedCount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn("text-bad hover:bg-red-50", stage === "failed" && "bg-red-50")}
          onClick={() => onStage("failed")}
        >
          ✗ Failed<span className="ml-1.5 text-xs tabular-nums opacity-70">{failedCount}</span>
        </Button>
      ) : (
        <span className="text-xs text-ink-faint px-2">no failures</span>
      )}
      {canceledCount > 0 &&
        chip("canceled", "Canceled", "opacity-60")}
    </div>
  );
}

export default function StudioPage() {
  const nav = useNavigate();
  const [stage, setStage] = useState<Stage>("all");
  const [q, setQ] = useState("");

  const query = useQuery<{ items: StudioJob[] }, Error>({
    queryKey: ["studio-jobs"],
    queryFn: () => api("/admin/studio/jobs"),
    refetchInterval: (qr) =>
      qr.state.data?.items.some(
        (j) =>
          j.status === "queued" ||
          j.status === "running" ||
          (j.status === "draft" && (j.checkStatus === "pending" || j.checkStatus === "running")),
      )
        ? 3000
        : 15000,
  });

  const items = useMemo(() => {
    const all = query.data?.items ?? [];
    const needle = q.trim().toLowerCase();
    return all
      .filter((j) => inStage(j, stage))
      .filter(
        (j) =>
          !needle ||
          j.pieceId.toLowerCase().includes(needle) ||
          (j.metadata?.title ?? "").toLowerCase().includes(needle) ||
          (j.metadata?.composer ?? "").toLowerCase().includes(needle),
      );
  }, [query.data, stage, q]);

  return (
    <>
      <PageHeader
        title="Pieces Studio"
        subtitle="Upload → automated checks → your review → publish to the app."
        right={
          <Button asChild variant="default">
            <Link to="/studio/new">New piece</Link>
          </Button>
        }
      />

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <PipelineFilter items={query.data?.items ?? []} stage={stage} onStage={setStage} />
        <Input
          className="w-56"
          placeholder="Search title, composer, id…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {query.isPending && <Spinner />}
      {query.isError && <ErrorNote message={query.error.message} />}
      {query.data && items.length === 0 && (
        <Card className="items-center gap-1 p-10 text-center">
          {q.trim() ? (
            <>
              <p className="text-sm font-medium">No builds match</p>
              <p className="text-sm text-ink-soft">Nothing here for "{q.trim()}" — try a title, composer, or piece id.</p>
            </>
          ) : stage === "all" ? (
            <>
              <p className="text-sm font-medium">No builds yet</p>
              <p className="text-sm text-ink-soft">Upload a score to start the first verification run.</p>
              <Button asChild size="sm" className="mt-2">
                <Link to="/studio/new">New piece</Link>
              </Button>
            </>
          ) : (
            <p className="text-sm text-ink-soft">
              {stage === "draft" && "No drafts — everything in flight has been submitted."}
              {stage === "verifying" && "Nothing verifying right now — submitted builds show up here while checks run."}
              {stage === "review" && "Nothing waiting on you — builds land here when every check passes."}
              {stage === "published" && "Nothing published from the Studio yet."}
              {stage === "failed" && "No failures."}
              {stage === "canceled" && "No canceled builds."}
            </p>
          )}
        </Card>
      )}
      {items.length > 0 && (
        <Card className="overflow-hidden p-0 gap-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={thCls}>Piece</TableHead>
                <TableHead className={thCls}>Composer</TableHead>
                <TableHead className={thCls}>Book</TableHead>
                <TableHead className={thCls}>Checks</TableHead>
                <TableHead className={thCls}>Status</TableHead>
                <TableHead className={thCls}>By</TableHead>
                <TableHead className={`${thCls} text-right`}>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((j) => {
                const isDraft = j.status === "draft";
                return (
                  <TableRow
                    key={j.id}
                    className="cursor-pointer"
                    onClick={() => nav(isDraft ? `/studio/${j.id}/edit` : `/studio/${j.id}`)}
                  >
                    <TableCell className="px-4 py-3 font-medium whitespace-normal">
                      {j.metadata?.title || <span className="text-ink-faint italic">untitled draft</span>}
                      {j.metadata?.subtitle && <span className="text-ink-soft font-normal"> · {j.metadata.subtitle}</span>}
                      {!j.pieceId.startsWith("draft_") && (
                        <span className="block text-[11px] font-mono text-ink-faint">{j.pieceId}</span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-ink-soft">{j.metadata?.composer ?? "—"}</TableCell>
                    <TableCell className="px-4 py-3 text-ink-soft">
                      {j.metadata?.book ? `${j.metadata.book.id}${j.metadata.book.index != null ? ` #${j.metadata.book.index}` : ""}` : "—"}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <GateDots job={j} />
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <StatusTag value={j.status} family="lifecycle" label={statusLabel(j)} />
                      {j.publishedVersion != null && (
                        <span className="text-xs text-ink-faint ml-1.5 tabular-nums">v{j.publishedVersion}</span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-ink-soft text-xs">
                      {j.createdByEmail ? (
                        <span title={j.createdByEmail}>{j.createdByEmail.split("@")[0]}</span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right text-ink-soft text-xs tabular-nums">
                      <span title={new Date(j.updatedAt).toLocaleString()}>{timeAgo(j.updatedAt)}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
