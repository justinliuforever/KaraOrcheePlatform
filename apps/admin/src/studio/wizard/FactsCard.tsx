import type { XmlMeta } from "../../api";
import { keyLabel } from "../gateInfo";

/** Read-only facts card: the MusicXML is ground truth — to change these, fix the file. */
export default function FactsCard({ meta }: { meta: XmlMeta }) {
  return (
    <div className="rounded-xl border border-line bg-card px-3.5 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">
        From the file <span className="normal-case font-normal">(read-only — re-export to change)</span>
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex justify-between"><dt className="text-ink-faint">Key</dt><dd>{keyLabel(meta.key)}</dd></div>
        <div className="flex justify-between"><dt className="text-ink-faint">Time</dt><dd>{meta.time ?? "—"}</dd></div>
        <div className="flex justify-between"><dt className="text-ink-faint">Measures</dt><dd className="tabular-nums">{meta.measures}</dd></div>
        <div className="flex justify-between">
          <dt className="text-ink-faint">Tempo</dt>
          <dd>{meta.tempo_bpm ? `♩=${meta.tempo_bpm}` : <span className="text-warn">not marked (120 assumed)</span>}{meta.tempo_text ? ` ${meta.tempo_text}` : ""}</dd>
        </div>
        <div className="flex justify-between col-span-2">
          <dt className="text-ink-faint">Parts</dt>
          <dd>{meta.parts.map((p, i) => p.name ?? `Part ${i + 1}`).join(" + ") || "—"}</dd>
        </div>
      </dl>
    </div>
  );
}
