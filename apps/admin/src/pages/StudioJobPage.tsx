import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type StudioJob } from "../api";
import { Badge, Card, ErrorNote, PageHeader, Spinner, rightsTone } from "../components/ui";
import { ALL_GATES, failureHint, jobTone, statusLabel } from "../studio/gateInfo";

function fmtKB(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-xs text-ink-faint shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-right break-words min-w-0">{value}</span>
    </div>
  );
}

/** Collapsed-by-default engraving preview: fixed-height window with fade + expand. */
function PreviewCard({ variant, url }: { variant: string; url: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card className="mb-3">
      <div className="px-4 py-2 border-b border-line bg-paper/50 flex items-center justify-between">
        <span className="text-xs font-medium text-ink-soft">{variant}</span>
        <button className="text-xs text-brand font-medium" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
      <div className={`relative bg-white ${expanded ? "max-h-160 overflow-y-auto" : "max-h-52 overflow-hidden"}`}>
        <img src={url} alt={`${variant} engraving`} className="w-full" />
        {!expanded && (
          <button
            className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white to-transparent flex items-end justify-center pb-1.5 text-xs text-brand font-medium"
            onClick={() => setExpanded(true)}
          >
            Show full score
          </button>
        )}
      </div>
    </Card>
  );
}

export default function StudioJobPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [confirmPublish, setConfirmPublish] = useState(false);

  const query = useQuery<StudioJob, Error>({
    queryKey: ["studio-job", id],
    queryFn: () => api(`/admin/studio/jobs/${id}`),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "queued" || s === "running" ? 2000 : false;
    },
  });

  const act = useMutation<StudioJob, Error, "retry" | "publish" | "reopen" | "cancel">({
    mutationFn: (action) => api(`/admin/studio/jobs/${id}/${action}`, { method: "POST" }),
    onSuccess: (_res, action) => {
      qc.invalidateQueries({ queryKey: ["studio-job", id] });
      qc.invalidateQueries({ queryKey: ["studio-jobs"] });
      qc.invalidateQueries({ queryKey: ["pieces"] });
      setConfirmPublish(false);
      if (action === "reopen") nav(`/studio/${id}/edit`);
    },
  });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorNote message={query.error.message} />;
  const job = query.data;
  if (job.status === "draft") {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-ink-soft mb-3">This is still a draft.</p>
        <Link className="text-brand text-sm font-medium hover:underline" to={`/studio/${id}/edit`}>
          Continue in the wizard →
        </Link>
      </div>
    );
  }

  const m = job.metadata;
  const publishable =
    job.status === "ready_for_review" && (m.rights === "public_domain" || m.rights === "licensed");
  const svgPreviews = (job.previews ?? []).filter((p) => p.role === "svg");

  return (
    <>
      <div className="mb-4">
        <Link to="/studio" className="text-sm text-brand hover:underline">
          ← Studio
        </Link>
      </div>
      <PageHeader
        title={m.title || job.pieceId}
        subtitle={`${m.composer ?? ""}${m.subtitle ? ` · ${m.subtitle}` : ""} · ${job.pieceId}`}
        right={
          <div className="flex items-center gap-2">
            {m.rights && <Badge tone={rightsTone(m.rights)}>{m.rights.replace("_", " ")}</Badge>}
            <Badge tone={jobTone(job.status)}>{statusLabel(job)}</Badge>
          </div>
        }
      />

      {/* ——— action bar by state ——— */}
      {job.status === "ready_for_review" && (
        <Card className="p-4 mb-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">All checks passed — review below, then publish.</p>
            <p className="text-xs text-ink-soft mt-0.5">
              {publishable
                ? "Publishing creates an immutable bundle version and updates the app catalog."
                : `Rights are "${m.rights}" — resolve the copyright status before this can be published.`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="rounded-lg border border-line text-sm font-medium px-3.5 py-2 hover:bg-paper disabled:opacity-40"
              disabled={act.isPending}
              onClick={() => act.mutate("retry")}
              title="Runs every gate again from the uploaded files"
            >
              Re-run all checks
            </button>
            {!confirmPublish ? (
              <button
                className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-40"
                disabled={!publishable}
                onClick={() => setConfirmPublish(true)}
              >
                Publish…
              </button>
            ) : (
              <>
                <button className="text-sm text-ink-soft" onClick={() => setConfirmPublish(false)}>
                  Cancel
                </button>
                <button
                  className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-40"
                  disabled={act.isPending}
                  onClick={() => act.mutate("publish")}
                >
                  {act.isPending ? "Publishing…" : "Confirm publish"}
                </button>
              </>
            )}
          </div>
        </Card>
      )}

      {job.status === "failed" && (
        <Card className="p-4 mb-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-bad">Verification failed{job.stage ? ` at “${ALL_GATES.find((g) => g.key === job.stage)?.label ?? job.stage}”` : ""}.</p>
              {job.error && <p className="text-xs text-ink-soft mt-1 leading-relaxed">{job.error}</p>}
              {job.stage && job.error && (
                <p className="text-xs mt-2 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2 leading-relaxed">
                  💡 {failureHint(job.stage, job.error)}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <button
                className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-40"
                disabled={act.isPending}
                onClick={() => act.mutate("reopen")}
              >
                Edit & fix files
              </button>
              <button
                className="rounded-lg border border-line text-sm font-medium px-4 py-2 hover:bg-paper disabled:opacity-40"
                disabled={act.isPending}
                onClick={() => act.mutate("retry")}
                title="For transient failures — runs again with the same files"
              >
                Retry as-is
              </button>
            </div>
          </div>
        </Card>
      )}

      {(job.status === "queued" || job.status === "running") && (
        <Card className="p-4 mb-5 flex items-center gap-3">
          <div className="size-4 rounded-full border-2 border-line border-t-brand animate-spin" />
          <p className="text-sm text-ink-soft">
            Running full verification{job.stage ? ` — ${ALL_GATES.find((g) => g.key === job.stage)?.label.toLowerCase() ?? job.stage}` : ""}…
            you can leave this page; the board updates on its own.
          </p>
        </Card>
      )}

      {job.status === "canceled" && (
        <Card className="p-4 mb-5 flex items-center justify-between">
          <p className="text-sm text-ink-soft">This build was canceled.</p>
          <button
            className="rounded-lg border border-line text-sm font-medium px-4 py-2 hover:bg-paper"
            onClick={() => act.mutate("reopen")}
          >
            Reopen as draft
          </button>
        </Card>
      )}

      {job.status === "published" && (
        <Card className="p-4 mb-5 flex items-center justify-between">
          <p className="text-sm">
            Published as <span className="font-semibold tabular-nums">v{job.publishedVersion}</span> — live in the app catalog.
          </p>
          <Link className="text-sm text-brand font-medium hover:underline" to={`/pieces/${job.pieceId}`}>
            View in Pieces →
          </Link>
        </Card>
      )}

      {act.isError && (
        <div className="mb-4">
          <ErrorNote message={act.error.message} />
        </div>
      )}

      {/* ——— two columns: submission | gates ——— */}
      <div className="grid grid-cols-[1fr_1fr] gap-5 items-start mb-6">
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-3">Submission</p>
          <Row label="Title" value={<span className="font-medium">{m.title ?? "—"}</span>} />
          <Row label="Composer" value={m.composer ?? "—"} />
          <Row label="Subtitle" value={m.subtitle || "—"} />
          <Row label="Difficulty" value={m.difficulty ?? "unrated"} />
          <Row label="Shelf" value={m.tracking === "validated" ? "Pieces (validated)" : "Challenge (experimental)"} />
          <Row
            label="Book"
            value={m.book ? `${m.book.id}${m.book.index != null ? ` · No. ${m.book.index}` : ""}` : "—"}
          />
          <Row label="Rights" value={m.rights ? <Badge tone={rightsTone(m.rights)}>{m.rights.replace("_", " ")}</Badge> : "—"} />
          {m.rightsNote && (
            <p className="text-xs text-ink-soft mt-2 rounded-lg bg-paper/60 border border-line px-3 py-2 leading-relaxed">
              {m.rightsNote}
            </p>
          )}
          <div className="border-t border-line mt-3 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Source files</p>
            {job.sources.map((s) => (
              <p key={s.path} className="text-xs font-mono text-ink-soft py-0.5">
                {s.kind}: {s.originalName} · {fmtKB(s.bytes)}
              </p>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-3">Verification</p>
          <div className="space-y-2.5">
            {ALL_GATES.map((g) => {
              const entry = job.gates?.[g.key];
              const icon =
                entry?.status === "pass" ? (
                  <span className="text-ok">✓</span>
                ) : entry?.status === "fail" ? (
                  <span className="text-bad">✗</span>
                ) : entry?.status === "running" ? (
                  <span className="inline-block size-3 rounded-full border-2 border-line border-t-brand animate-spin" />
                ) : (
                  <span className="text-ink-faint">·</span>
                );
              const dur = entry?.metrics?.duration_ms;
              return (
                <div key={g.key} className="rounded-lg border border-line px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium flex items-center gap-2">
                      {icon} {g.label}
                    </p>
                    {typeof dur === "number" && (
                      <span className="text-[11px] text-ink-faint tabular-nums">
                        {dur < 1000 ? `${dur}ms` : `${(dur / 1000).toFixed(1)}s`}
                      </span>
                    )}
                  </div>
                  {entry?.metrics && Object.keys(entry.metrics).length > 0 && (
                    <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5">
                      {Object.entries(entry.metrics)
                        .filter(([k]) => k !== "duration_ms")
                        .slice(0, 6)
                        .map(([k, v]) => (
                          <div key={k} className="flex justify-between text-[11px]">
                            <dt className="text-ink-faint">{k.replaceAll("_", " ")}</dt>
                            <dd className="tabular-nums text-ink-soft">{String(v)}</dd>
                          </div>
                        ))}
                    </dl>
                  )}
                  {entry?.error && <p className="text-[11px] text-bad mt-1.5 leading-relaxed">{entry.error}</p>}
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {svgPreviews.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">
            Engraving — check clefs, beams, and layout look right before publishing
          </p>
          {svgPreviews.map((p) => (
            <PreviewCard key={p.variant ?? p.role} variant={p.variant ?? "score"} url={p.url} />
          ))}
        </>
      )}
    </>
  );
}
