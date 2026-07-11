import type { XmlMeta } from "../../api";

/** Solo-part question — only for multi-part scores. Changing re-runs the checks. */
export default function PartPicker({
  meta,
  soloPart,
  onPick,
}: {
  meta: XmlMeta;
  soloPart: string | null;
  onPick: (id: string) => void;
}) {
  if (meta.n_parts <= 1) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-3">
      <p className="text-xs font-semibold mb-1.5">
        {meta.n_parts} parts detected — which one is the SOLO part?
      </p>
      <p className="text-[11px] text-ink-soft mb-2 leading-relaxed">
        Students see and follow the solo part; the other part becomes the play-along
        accompaniment. Changing this re-runs the checks (~10s).
      </p>
      <div className="flex gap-2 flex-wrap">
        {meta.parts.map((p, i) => (
          <label
            key={p.id}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium cursor-pointer ${
              soloPart === p.id ? "border-brand bg-brand-soft text-brand" : "border-line bg-card"
            }`}
          >
            <input
              type="radio"
              name="solopart"
              className="sr-only"
              checked={soloPart === p.id}
              onChange={() => onPick(p.id)}
            />
            {p.name ?? `Part ${i + 1}`}
          </label>
        ))}
      </div>
    </div>
  );
}
