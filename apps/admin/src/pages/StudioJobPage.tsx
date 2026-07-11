import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, type StudioJob } from "../api";
import { ErrorNote, PageHeader, Spinner, rightsTone } from "../components/ui";
import ToneBadge from "../components/ToneBadge";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { ALL_GATES, failureHint, jobTone, statusLabel } from "../studio/gateInfo";
import Diagnosis, { diagnosisOf } from "../studio/Diagnosis";
import { PipelineStepper } from "../studio/Stepper";

function fmtKB(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
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
    <Card className="mb-3 gap-0 p-0 overflow-hidden">
      <div className="px-4 py-2 border-b border-line bg-paper/50 flex items-center justify-between">
        <span className="text-xs font-medium text-ink-soft">{variant}</span>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </div>
      <div className={`relative bg-white ${expanded ? "max-h-160 overflow-y-auto" : "max-h-52 overflow-hidden"}`}>
        <img src={url} alt={`${variant} engraving`} className="w-full" />
        {!expanded && (
          <button
            className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white to-transparent flex items-end justify-center pb-1.5 text-xs text-brand font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
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
      // draft polls too: after a wizard submit the cache can briefly hold the stale
      // draft snapshot — polling self-corrects instead of stranding the reader.
      return s === "queued" || s === "running" || s === "draft" ? 2000 : false;
    },
  });

  const act = useMutation<StudioJob, Error, "retry" | "publish" | "reopen" | "cancel">({
    mutationFn: (action) => api(`/admin/studio/jobs/${id}/${action}`, { method: "POST" }),
    onSuccess: (res, action) => {
      qc.setQueryData(["studio-job", id], (old: StudioJob | undefined) =>
        old ? { ...old, ...res } : res,
      );
      qc.invalidateQueries({ queryKey: ["studio-job", id] });
      qc.invalidateQueries({ queryKey: ["studio-jobs"] });
      qc.invalidateQueries({ queryKey: ["pieces"] });
      setConfirmPublish(false);
      if (action === "reopen") nav(`/studio/${id}/edit`);
      if (action === "cancel") toast("Build discarded");
      // Publish lands on the piece's registry page — the published state's real home.
      if (action === "publish") {
        toast.success(`Published v${res.publishedVersion} — live in the app catalog`);
        nav(`/pieces?sel=${res.pieceId}`);
      }
    },
  });

  // Live elapsed clock for the queued/running banner — ticks every ~5s while in flight.
  const liveStatus = query.data?.status;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (liveStatus !== "queued" && liveStatus !== "running") return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [liveStatus]);

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
  const previewAudio = (job.previews ?? []).find((p) => p.role === "preview_audio");
  const referenceAudio = (job.previews ?? []).find((p) => p.role === "reference_audio");
  const audioTier = (job.gates?.audio?.metrics as { tier?: number } | undefined)?.tier;

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
            {m.rights && <ToneBadge tone={rightsTone(m.rights)}>{m.rights.replace("_", " ")}</ToneBadge>}
            <ToneBadge tone={jobTone(job.status)}>{statusLabel(job)}</ToneBadge>
          </div>
        }
      />
      <PipelineStepper job={job} />

      {/* ——— action bar by state ——— */}
      {job.status === "ready_for_review" && (
        <Card className="p-4 mb-5 flex flex-row items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">All checks passed — review below, then publish.</p>
            <p className="text-xs text-ink-soft mt-0.5">
              {publishable
                ? "Publishing creates an immutable bundle version and updates the app catalog."
                : `Rights are "${m.rights}" — resolve the copyright status before this can be published.`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="text-ink-faint hover:text-destructive"
              disabled={act.isPending}
              onClick={() => act.mutate("cancel")}
              title="Discards this build (can be reopened later)"
            >
              Discard
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={act.isPending}
              onClick={() => act.mutate("reopen")}
              title="Back to the form with everything prefilled; submit re-verifies"
            >
              Edit details
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={act.isPending}
              onClick={() => act.mutate("retry")}
              title="Runs every gate again from the uploaded files"
            >
              Re-run all checks
            </Button>
            {!confirmPublish ? (
              <Button size="sm" disabled={!publishable} onClick={() => setConfirmPublish(true)}>
                Publish…
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={() => setConfirmPublish(false)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={act.isPending} onClick={() => act.mutate("publish")}>
                  {act.isPending ? "Publishing…" : "Confirm publish"}
                </Button>
              </>
            )}
          </div>
        </Card>
      )}

      {job.status === "failed" && (
        <Card className="p-4 mb-5 gap-0">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-bad">Verification failed{job.stage ? ` at “${ALL_GATES.find((g) => g.key === job.stage)?.label ?? job.stage}”` : ""}.</p>
              {job.error && <p className="text-xs text-ink-soft mt-1 leading-relaxed">{job.error}</p>}
              {job.stage && diagnosisOf(job.gates?.[job.stage]?.metrics).length > 0 ? (
                <div className="mt-2">
                  <Diagnosis items={diagnosisOf(job.gates?.[job.stage]?.metrics)} />
                </div>
              ) : (
                job.stage && job.error && (
                  <p className="text-xs mt-2 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2 leading-relaxed">
                    {failureHint(job.stage, job.error)}
                  </p>
                )
              )}
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <Button size="sm" disabled={act.isPending} onClick={() => act.mutate("reopen")}>
                Edit & fix files
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={act.isPending}
                onClick={() => act.mutate("retry")}
                title="For transient failures — runs again with the same files"
              >
                Retry as-is
              </Button>
            </div>
          </div>
        </Card>
      )}

      {(job.status === "queued" || job.status === "running") && (
        <Card className="p-4 mb-5 flex flex-row items-center gap-3">
          <div className="size-4 rounded-full border-2 border-line border-t-brand animate-spin" />
          <p className="text-sm text-ink-soft">
            Running full verification
            {job.stage ? ` — ${ALL_GATES.find((g) => g.key === job.stage)?.label.toLowerCase() ?? job.stage}` : ""}
            {Number.isFinite(Date.parse(job.updatedAt)) ? (
              <> · <span className="tabular-nums">{formatElapsed(now - Date.parse(job.updatedAt))}</span></>
            ) : null}…
            you can leave this page; the board updates on its own.
          </p>
        </Card>
      )}

      {job.status === "canceled" && (
        <Card className="p-4 mb-5 flex flex-row items-center justify-between">
          <p className="text-sm text-ink-soft">This build was canceled.</p>
          <Button variant="outline" size="sm" onClick={() => act.mutate("reopen")}>
            Reopen as draft
          </Button>
        </Card>
      )}

      {job.status === "published" && (
        <Card className="p-4 mb-5 flex flex-row items-center justify-between">
          <p className="text-sm">
            This build published <span className="font-semibold tabular-nums">v{job.publishedVersion}</span>
            {job.piece?.status === "archived" ? (
              <span className="text-ink-soft"> — the piece has since been archived (not in the app catalog).</span>
            ) : job.piece && job.piece.publishedVersion !== job.publishedVersion ? (
              <span className="text-ink-soft">
                {" "}— the live version is now{" "}
                <span className="font-semibold tabular-nums">v{job.piece.publishedVersion}</span> (from a later build).
              </span>
            ) : (
              <span> — live in the app catalog.</span>
            )}
          </p>
          <Link className="text-sm text-brand font-medium hover:underline" to={`/pieces?sel=${job.pieceId}`}>
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
        <Card className="p-5 gap-0">
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
          <Row label="Rights" value={m.rights ? <ToneBadge tone={rightsTone(m.rights)}>{m.rights.replace("_", " ")}</ToneBadge> : "—"} />
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

        <Card className="p-5 gap-0">
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

      {(previewAudio || referenceAudio) && (
        <Card className="p-4 mb-5 gap-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-3">
            Listen before publishing
          </p>
          <div className="grid grid-cols-2 gap-4">
            {previewAudio && (
              <div>
                <p className="text-xs font-medium mb-1">Synthesized preview (app sound)</p>
                <audio controls preload="none" src={previewAudio.url} className="w-full h-9" />
              </div>
            )}
            {referenceAudio && (
              <div>
                <p className="text-xs font-medium mb-1">
                  Uploaded recording — ships in the app
                  {audioTier === 2 && <span className="text-ok"> · expressive, aligned & verified</span>}
                  {audioTier === 1 && <span className="text-ok"> · notated tempo</span>}
                </p>
                <audio controls preload="none" src={referenceAudio.url} className="w-full h-9" />
              </div>
            )}
          </div>
        </Card>
      )}

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
