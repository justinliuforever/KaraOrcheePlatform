/** Failure-attribution findings computed by the worker when the timeline gate fails —
 * data facts + a concrete fix each, so the uploader never faces a bare rejection. */
export interface DiagnosisFinding {
  code: string;
  message: string;
  evidence?: Record<string, unknown>;
}

export function diagnosisOf(metrics: Record<string, unknown> | undefined): DiagnosisFinding[] {
  const d = metrics?.diagnosis;
  return Array.isArray(d) ? (d as DiagnosisFinding[]).filter((f) => f && f.message) : [];
}

export default function Diagnosis({ items }: { items: DiagnosisFinding[] }) {
  return (
    <div className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2 space-y-1.5">
      <p className="text-[11px] font-semibold text-warn uppercase tracking-wide">
        What the checks detected
      </p>
      {items.map((f, i) => (
        <p key={i} className="text-[11px] leading-relaxed text-ink">
          {items.length > 1 ? `${i + 1}. ` : ""}
          {f.message}
        </p>
      ))}
    </div>
  );
}
