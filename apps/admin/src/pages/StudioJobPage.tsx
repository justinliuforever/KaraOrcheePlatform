import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, type StudioJob } from "../api";
import { Badge, Card, ErrorNote, PageHeader, Spinner, rightsTone } from "../components/ui";
import { jobTone } from "./StudioPage";

const GATES: { key: string; label: string; blurb: string }[] = [
  { key: "sanity", label: "1 · Upload sanity", blurb: "files parse; score is non-empty" },
  { key: "alignment", label: "2 · Score events", blurb: "followable timeline built from MIDI (or notated score)" },
  { key: "geometry", label: "3 · Staff geometry", blurb: "engraving + cursor anchors; timelines must agree (median <12ms)" },
  { key: "render", label: "4 · Real render", blurb: "cursor-on-staff verified in headless WebKit" },
];

export default function StudioJobPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [confirmPublish, setConfirmPublish] = useState(false);

  const query = useQuery<StudioJob, Error>({
    queryKey: ["studio-job", id],
    queryFn: () => api(`/admin/studio/jobs/${id}`),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "queued" || s === "running" ? 2500 : false;
    },
  });

  const act = useMutation<StudioJob, Error, "retry" | "publish">({
    mutationFn: (action) => api(`/admin/studio/jobs/${id}/${action}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["studio-job", id] });
      qc.invalidateQueries({ queryKey: ["studio-jobs"] });
      qc.invalidateQueries({ queryKey: ["pieces"] });
      setConfirmPublish(false);
    },
  });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorNote message={query.error.message} />;
  const job = query.data;
  const m = job.metadata;
  const publishable = job.status === "ready_for_review" && (m.rights === "public_domain" || m.rights === "licensed");
  const svgPreviews = (job.previews ?? []).filter((p) => p.role === "svg");

  return (
    <>
      <div className="mb-4">
        <Link to="/studio" className="text-sm text-brand hover:underline">← Studio</Link>
      </div>
      <PageHeader
        title={m.title || job.pieceId}
        subtitle={`${m.composer}${m.subtitle ? ` · ${m.subtitle}` : ""} · ${job.pieceId}`}
        right={
          <div className="flex items-center gap-2">
            <Badge tone={rightsTone(m.rights)}>{m.rights.replace("_", " ")}</Badge>
            <Badge tone={jobTone(job.status)}>{job.status.replaceAll("_", " ")}</Badge>
          </div>
        }
      />

      {job.status === "failed" && job.error && <div className="mb-4"><ErrorNote message={job.error} /></div>}

      <div className="grid grid-cols-4 gap-3 mb-6">
        {GATES.map((g) => {
          const entry = job.gates?.[g.key];
          const tone =
            entry?.status === "pass" ? "border-emerald-200" :
            entry?.status === "fail" ? "border-red-300" :
            entry?.status === "running" ? "border-amber-300" : "border-line";
          return (
            <Card key={g.key} className={`p-3.5 border ${tone}`}>
              <p className="text-xs font-semibold mb-0.5">{g.label}</p>
              <p className="text-[11px] text-ink-faint leading-snug mb-2">{g.blurb}</p>
              {entry ? (
                <>
                  <Badge tone={entry.status === "pass" ? "ok" : entry.status === "fail" ? "bad" : "warn"}>
                    {entry.status}
                  </Badge>
                  {entry.metrics && Object.keys(entry.metrics).length > 0 && (
                    <dl className="mt-2 space-y-0.5">
                      {Object.entries(entry.metrics)
                        .filter(([k]) => k !== "duration_ms")
                        .slice(0, 5)
                        .map(([k, v]) => (
                          <div key={k} className="flex justify-between text-[11px]">
                            <dt className="text-ink-faint">{k}</dt>
                            <dd className="tabular-nums text-ink-soft">{String(v)}</dd>
                          </div>
                        ))}
                    </dl>
                  )}
                  {entry.error && <p className="text-[11px] text-bad mt-1.5 leading-snug">{entry.error}</p>}
                </>
              ) : (
                <Badge>pending</Badge>
              )}
            </Card>
          );
        })}
      </div>

      {job.status === "ready_for_review" && (
        <Card className="p-4 mb-6 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">All gates passed — review the engraving below, then publish.</p>
            <p className="text-xs text-ink-soft mt-0.5">
              {publishable
                ? "Publishing creates an immutable bundle version and updates the app catalog."
                : `Rights are "${m.rights}" — resolve the copyright status before this can be published.`}
            </p>
          </div>
          {!confirmPublish ? (
            <button
              className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-40"
              disabled={!publishable}
              onClick={() => setConfirmPublish(true)}
            >
              Publish…
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button className="text-sm text-ink-soft" onClick={() => setConfirmPublish(false)}>Cancel</button>
              <button
                className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-40"
                disabled={act.isPending}
                onClick={() => act.mutate("publish")}
              >
                {act.isPending ? "Publishing…" : "Confirm publish"}
              </button>
            </div>
          )}
        </Card>
      )}

      {job.status === "failed" && (
        <Card className="p-4 mb-6 flex items-center justify-between">
          <p className="text-sm text-ink-soft">Fix the input (or transient failure) and run the gates again.</p>
          <button
            className="rounded-lg border border-line text-sm font-medium px-4 py-2 hover:bg-paper disabled:opacity-40"
            disabled={act.isPending}
            onClick={() => act.mutate("retry")}
          >
            {act.isPending ? "Requeuing…" : "Retry gates"}
          </button>
        </Card>
      )}

      {act.isError && <div className="mb-4"><ErrorNote message={act.error.message} /></div>}

      {svgPreviews.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">
            Engraving preview (human gate — check clefs, beams, measure numbers look right)
          </p>
          {svgPreviews.map((p) => (
            <Card key={p.variant ?? p.role} className="mb-4">
              <div className="px-4 py-2 border-b border-line bg-paper/50 text-xs font-medium text-ink-soft">
                {p.variant}
              </div>
              <div className="max-h-140 overflow-y-auto bg-white">
                <img src={p.url} alt={`${job.pieceId} ${p.variant}`} className="w-full" />
              </div>
            </Card>
          ))}
        </>
      )}

      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">Sources</p>
      <Card className="p-4 mb-6">
        {job.sources.map((s) => (
          <p key={s.path} className="text-sm text-ink-soft font-mono text-xs py-0.5">
            {s.kind}: {s.originalName} · {(s.bytes / 1024).toFixed(0)} KB
          </p>
        ))}
      </Card>
    </>
  );
}
