import type { StudioJob } from "../api";

// The pipeline, drawn: Upload → Verify → Review → Live. Failure/cancel are
// off-ramps rendered on the step where the job stopped, not stages of their own.
const STEPS = [
  { key: "upload", label: "Upload" },
  { key: "verify", label: "Verify" },
  { key: "review", label: "Review" },
  { key: "live", label: "Live" },
] as const;

function positionOf(job: Pick<StudioJob, "status">): number {
  switch (job.status) {
    case "draft":
      return 0;
    case "queued":
    case "running":
    case "failed":
      return 1;
    case "ready_for_review":
      return 2;
    case "published":
      return 3;
    default:
      return 1; // canceled: show where it likely stopped
  }
}

export function PipelineStepper({ job }: { job: Pick<StudioJob, "status"> }) {
  const pos = positionOf(job);
  const failed = job.status === "failed";
  const canceled = job.status === "canceled";
  const running = job.status === "queued" || job.status === "running";

  return (
    <div className={`flex items-center gap-0 mb-5 ${canceled ? "opacity-50" : ""}`}>
      {STEPS.map((s, i) => {
        const done = i < pos || (i === pos && job.status === "published");
        const current = i === pos && !done;
        const isFailHere = failed && i === pos;
        const circle = done ? (
          <span className="size-6 rounded-full bg-ok text-white grid place-items-center text-[11px]">✓</span>
        ) : isFailHere ? (
          <span className="size-6 rounded-full bg-bad text-white grid place-items-center text-[11px]">✗</span>
        ) : current && running ? (
          <span className="size-6 rounded-full border-2 border-brand grid place-items-center">
            <span className="size-3 rounded-full border-2 border-line border-t-brand animate-spin" />
          </span>
        ) : current ? (
          <span className="size-6 rounded-full bg-brand text-white grid place-items-center text-[11px]">{i + 1}</span>
        ) : (
          <span className="size-6 rounded-full border border-line text-ink-faint grid place-items-center text-[11px]">
            {i + 1}
          </span>
        );
        return (
          <div key={s.key} className="flex items-center">
            <div className="flex items-center gap-2">
              {circle}
              <span
                className={`text-xs font-medium ${
                  isFailHere ? "text-bad" : done || current ? "text-ink" : "text-ink-faint"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`w-10 h-px mx-3 ${i < pos ? "bg-ok" : "bg-line"}`} />
            )}
          </div>
        );
      })}
      {canceled && <span className="ml-4 text-xs text-ink-faint">(canceled)</span>}
    </div>
  );
}
