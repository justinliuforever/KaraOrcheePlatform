import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, X } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import {
  ApiError,
  getNoteJob,
  getNoteTranscript,
  requeueNoteJob,
  type NoteJobDetail,
  type NoteTranscript,
} from "../api";
import { ErrorNote, PanelSection, Spinner } from "../components/ui";
import StatusTag from "../components/StatusTag";
import SlideOver from "../components/SlideOver";
import { Button } from "@/components/ui-kit/button";
import { Label } from "@/components/ui-kit/label";
import { Textarea } from "@/components/ui-kit/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-kit/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui-kit/alert-dialog";

function copyText(v: string) {
  void navigator.clipboard.writeText(v).then(() => toast("Copied"));
}

function person(p: { email: string | null; displayName: string | null } | null): string {
  if (!p) return "—";
  return p.email ?? p.displayName ?? "—";
}

// transcript_missing / notes_assets_not_configured carry no server detail, so ApiError.message
// is the bare code slug — map them here (reason_required / transcript_not_ready ship a message).
function transcriptErrorMessage(e: Error): string {
  if (e instanceof ApiError && e.code === "transcript_missing")
    return "No transcript found for this job — it may have failed before transcription.";
  if (e instanceof ApiError && e.code === "notes_assets_not_configured")
    return "Transcript storage isn't configured on this environment.";
  return e.message;
}

export default function NoteJobPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery<NoteJobDetail, Error>({
    queryKey: ["note-job", id],
    queryFn: () => getNoteJob(id),
  });

  const [confirmRequeue, setConfirmRequeue] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  // Break-glass transcript is held in local state only (never react-query cache):
  // it leaves memory when the panel unmounts. { reason } is the accountability record.
  const [transcript, setTranscript] = useState<{ reason: string; body: NoteTranscript } | null>(null);

  const requeue = useMutation<unknown, Error>({
    mutationFn: () => requeueNoteJob(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["note-jobs"] });
      qc.invalidateQueries({ queryKey: ["note-job", id] });
      toast.success("Job re-queued");
      setConfirmRequeue(false);
    },
    onError: (e) => {
      // A 409 (e.g. not_failed) means our cached status is stale — refresh so the panel
      // reflects the job's real current status instead of keeping Requeue enabled.
      qc.invalidateQueries({ queryKey: ["note-jobs"] });
      qc.invalidateQueries({ queryKey: ["note-job", id] });
      setConfirmRequeue(false);
      const msg =
        e instanceof ApiError && e.code === "not_failed"
          ? "Only a failed job can be re-queued."
          : e instanceof ApiError && e.code === "queue_unavailable"
            ? "Processing is briefly unavailable — try again in a moment."
            : e.message;
      toast.error(msg);
    },
  });

  const fetchTranscript = useMutation<{ reason: string; body: NoteTranscript }, Error>({
    mutationFn: async () => {
      const r = reason.trim();
      const res = await getNoteTranscript(id, r);
      return { reason: r, body: res.transcript };
    },
    onSuccess: (t) => {
      setTranscript(t);
      setReasonOpen(false);
      setReason("");
    },
  });

  const job = detail.data?.job;
  const lesson = detail.data?.lesson;
  const notes = detail.data?.notes ?? [];
  const metrics = job?.metrics ?? {};
  const metricRows = Object.entries(metrics).filter(([k]) => k !== "reqId");

  return (
    <SlideOver
      width="min(56vw, 780px)"
      onClose={onClose}
      header={
        <div className="flex items-center gap-2.5">
          <p className="text-sm font-semibold">Note job</p>
          <span className="rounded border border-line bg-paper px-1.5 py-px font-mono text-[11px] text-ink-soft" title={id}>
            {id.slice(0, 8)}
          </span>
          <Button variant="ghost" size="icon-xs" className="size-5" aria-label="Copy job id" onClick={() => copyText(id)}>
            <Copy />
          </Button>
          {job && <StatusTag value={job.status} family="lifecycle" label={job.status.replaceAll("_", " ")} />}
          <span className="ml-auto" />
          <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
      }
    >
      {detail.isPending && <Spinner />}
      {detail.isError && <ErrorNote message={detail.error.message} />}

      {job && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={job.status !== "failed"} onClick={() => setConfirmRequeue(true)}>
              Requeue
            </Button>
            {/* SECURITY: transcript is verbatim lesson content; the backend audits transcript.view.
                Gated on admin for now — a narrower TranscriptViewer role is a founder decision. */}
            <Button
              variant="outline"
              size="sm"
              disabled={!job.transcriptPath}
              title={job.transcriptPath ? undefined : "No transcript produced yet"}
              onClick={() => setReasonOpen(true)}
            >
              View transcript
            </Button>
            {job.status !== "failed" && (
              <span className="text-xs text-ink-faint">Requeue is available on failed jobs only.</span>
            )}
          </div>

          {job.error && (
            <div className="mb-3">
              <ErrorNote message={job.error} />
            </div>
          )}

          <PanelSection title="Lesson" defaultOpen>
            <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <span className="text-xs text-ink-faint pt-0.5">Teacher</span>
              <span>{person(lesson?.teacher ?? null)}</span>
              <span className="text-xs text-ink-faint pt-0.5">Student</span>
              <span>{person(lesson?.student ?? null)}</span>
              <span className="text-xs text-ink-faint pt-0.5">Piece</span>
              <span>{lesson?.pieceLabel ?? lesson?.pieceId ?? "—"}</span>
              <span className="text-xs text-ink-faint pt-0.5">Duration</span>
              <span className="tabular-nums">{lesson?.durationSec != null ? `${lesson.durationSec}s` : "—"}</span>
              <span className="text-xs text-ink-faint pt-0.5">Language</span>
              <span>{lesson?.language ?? "—"}</span>
              <span className="text-xs text-ink-faint pt-0.5">Stage</span>
              <span>{job.stage ?? "—"}</span>
              <span className="text-xs text-ink-faint pt-0.5">Attempts</span>
              <span className="tabular-nums">{job.attempts}</span>
              <span className="text-xs text-ink-faint pt-0.5">Created</span>
              <span className="tabular-nums">{new Date(job.createdAt).toLocaleString()}</span>
            </div>
          </PanelSection>

          {job.failureHints.length > 0 && (
            <PanelSection title="Failure hints" defaultOpen badge={`${job.failureHints.length}`}>
              <ul className="space-y-1.5">
                {job.failureHints.map((h, i) => (
                  <li key={i} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-warn">
                    {h}
                  </li>
                ))}
              </ul>
            </PanelSection>
          )}

          <PanelSection title="Metrics" defaultOpen badge={`${metricRows.length} fields`}>
            {metricRows.length === 0 ? (
              <p className="text-xs text-ink-faint">No metrics recorded.</p>
            ) : (
              <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5">
                {metricRows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <span className="py-0.5 text-xs text-ink-faint">{k}</span>
                    <span className="py-0.5 text-xs tabular-nums break-all">
                      {typeof v === "object" ? JSON.stringify(v) : String(v)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </PanelSection>

          <PanelSection title="Produced notes" badge={`${notes.length}`}>
            {notes.length === 0 ? (
              <p className="text-xs text-ink-faint">No notes produced yet.</p>
            ) : (
              notes.map((n) => (
                <div key={n.id} className="flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0">
                  <span className="font-mono text-xs text-ink-soft">{n.id.slice(0, 8)}</span>
                  <StatusTag value={n.status === "sent" ? "published" : "draft"} family="lifecycle" label={n.status} />
                  <span className="ml-auto text-[11px] text-ink-faint">
                    {n.studentId ? `→ ${n.studentId.slice(0, 8)}` : "unassigned"}
                  </span>
                </div>
              ))
            )}
          </PanelSection>

          {lesson && (
            <PanelSection title="Links">
              <p className="text-xs text-ink-soft">
                Lesson session <span className="font-mono">{lesson.id.slice(0, 8)}</span>
                {detail.data?.job.metrics.reqId && (
                  <>
                    {" · "}
                    <Link className="text-brand hover:underline" to={`/ops?reqId=${detail.data.job.metrics.reqId}&tl=1`}>
                      request trace
                    </Link>
                  </>
                )}
              </p>
            </PanelSection>
          )}
        </>
      )}

      <AlertDialog open={confirmRequeue} onOpenChange={(o) => !o && setConfirmRequeue(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-queue this note job?</AlertDialogTitle>
            <AlertDialogDescription>
              The job goes back to the front of the processing queue (attempts increments). Use this
              after fixing a transient failure.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={requeue.isPending} onClick={() => requeue.mutate()}>
              {requeue.isPending ? "Re-queuing…" : "Requeue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={reasonOpen}
        onOpenChange={(o) => {
          setReasonOpen(o);
          if (!o) setReason("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>View transcript — break-glass</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-warn">
              Transcripts are verbatim lesson content. This access is audited. State a reason.
            </div>
            <div>
              <Label className="mb-1.5">Reason (at least 10 characters)</Label>
              <Textarea
                placeholder="e.g. Investigating grounding failure reported in support ticket 512"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-ink-faint tabular-nums">{reason.trim().length}/10</p>
            </div>
            {fetchTranscript.isError && <ErrorNote message={transcriptErrorMessage(fetchTranscript.error)} />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={reason.trim().length < 10 || fetchTranscript.isPending}
              onClick={() => fetchTranscript.mutate()}
            >
              {fetchTranscript.isPending ? "Opening…" : "Open transcript"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {transcript && <TranscriptViewer data={transcript} onClose={() => setTranscript(null)} />}
    </SlideOver>
  );
}

function TranscriptViewer({
  data,
  onClose,
}: {
  data: { reason: string; body: NoteTranscript };
  onClose: () => void;
}) {
  const { reason, body } = data;
  return (
    <SlideOver
      width="min(48vw, 640px)"
      onClose={onClose}
      header={
        <div className="flex items-center gap-2.5">
          <p className="text-sm font-semibold">Transcript</p>
          <span className="ml-auto" />
          <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
      }
    >
      <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-warn">
        Break-glass access — this view is audited. Reason: {reason}
      </div>
      <div className="max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-card p-4">
        {Array.isArray(body.utterances) && body.utterances.length > 0 ? (
          <div className="space-y-2.5">
            {body.utterances.map((u, i) => (
              <div key={i} className="text-sm">
                {u.speaker && <span className="mr-2 font-medium text-ink-soft">{u.speaker}</span>}
                <span className="whitespace-pre-wrap break-words">{u.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm">{body.text || "(empty transcript)"}</p>
        )}
      </div>
    </SlideOver>
  );
}
