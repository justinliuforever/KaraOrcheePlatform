import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, type StudioJob } from "../api";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Td, Th } from "../components/ui";
import { ALL_GATES, jobTone, statusLabel, timeAgo } from "../studio/gateInfo";

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
// check-failed draft counts as Failed, not Draft) so counts never double-count;
// All = the union including canceled.
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
      return true;
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
      <button
        key={key}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
          active ? "bg-brand-soft text-brand" : "text-ink-soft hover:bg-paper"
        } ${extra}`}
        onClick={() => onStage(key)}
      >
        {label}
        <span className="ml-1.5 text-xs tabular-nums opacity-70">{count(key)}</span>
      </button>
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
        <button
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            stage === "failed" ? "bg-red-50 text-bad" : "text-bad hover:bg-red-50"
          }`}
          onClick={() => onStage("failed")}
        >
          ✗ Failed<span className="ml-1.5 text-xs tabular-nums opacity-70">{failedCount}</span>
        </button>
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
          <Link to="/studio/new" className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90">
            New piece
          </Link>
        }
      />

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <PipelineFilter items={query.data?.items ?? []} stage={stage} onStage={setStage} />
        <input
          className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm w-56 outline-none focus:border-brand"
          placeholder="Search title, composer, id…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {query.isPending && <Spinner />}
      {query.isError && <ErrorNote message={query.error.message} />}
      {query.data && items.length === 0 && (
        <Card className="p-10 text-center text-sm text-ink-soft">
          {stage === "failed" ? "No failures. 🎉" : "No builds here yet."}
        </Card>
      )}
      {items.length > 0 && (
        <Card>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Piece</Th>
                <Th>Composer</Th>
                <Th>Book</Th>
                <Th>Checks</Th>
                <Th>Status</Th>
                <Th className="text-right">Updated</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((j) => {
                const isDraft = j.status === "draft";
                return (
                  <tr
                    key={j.id}
                    className="hover:bg-paper/60 cursor-pointer"
                    onClick={() => nav(isDraft ? `/studio/${j.id}/edit` : `/studio/${j.id}`)}
                  >
                    <Td className="font-medium">
                      {j.metadata?.title || <span className="text-ink-faint italic">untitled draft</span>}
                      {j.metadata?.subtitle && <span className="text-ink-soft font-normal"> · {j.metadata.subtitle}</span>}
                      {!j.pieceId.startsWith("draft_") && (
                        <span className="block text-[11px] font-mono text-ink-faint">{j.pieceId}</span>
                      )}
                    </Td>
                    <Td className="text-ink-soft">{j.metadata?.composer ?? "—"}</Td>
                    <Td className="text-ink-soft">
                      {j.metadata?.book ? `${j.metadata.book.id}${j.metadata.book.index != null ? ` #${j.metadata.book.index}` : ""}` : "—"}
                    </Td>
                    <Td>
                      <GateDots job={j} />
                    </Td>
                    <Td>
                      <Badge tone={jobTone(j.status)}>{statusLabel(j)}</Badge>
                      {j.publishedVersion != null && (
                        <span className="text-xs text-ink-faint ml-1.5 tabular-nums">v{j.publishedVersion}</span>
                      )}
                    </Td>
                    <Td className="text-right text-ink-soft text-xs tabular-nums" >
                      <span title={new Date(j.updatedAt).toLocaleString()}>{timeAgo(j.updatedAt)}</span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
