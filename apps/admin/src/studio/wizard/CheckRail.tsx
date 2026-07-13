import { useState } from "react";
import type { StudioJob } from "../../api";
import { AUDIO_GATE, PREFLIGHT_GATES, RENDER_GATE, failureHint } from "../gateInfo";
import Diagnosis, { diagnosisOf } from "../Diagnosis";

/** Live check rail: GitHub-Actions-style step list fed by the polled job row. */
export default function CheckRail({ job }: { job: StudioJob }) {
  const [open, setOpen] = useState<string | null>(null);
  // The audio card only exists when a recording was actually uploaded.
  const gatesShown = job.sources?.some((s) => s.kind === "audio")
    ? [...PREFLIGHT_GATES, AUDIO_GATE]
    : PREFLIGHT_GATES;
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Automated checks
      </p>
      {gatesShown.map((g) => {
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
        const m = entry?.metrics ?? {};
        return (
          <div key={g.key} className="rounded-xl border border-line bg-card px-3.5 py-3">
            <button
              className="w-full flex items-start justify-between gap-2 text-left"
              onClick={() => setOpen(open === g.key ? null : g.key)}
            >
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  {icon} {g.label}
                </p>
                <p className="text-[11px] text-ink-faint mt-0.5">{g.blurb}</p>
              </div>
              <span className="text-ink-faint text-xs mt-0.5">{open === g.key ? "−" : "?"}</span>
            </button>
            {g.key === "audio" && entry?.status === "pass" && (
              <p className="text-[11px] text-ok mt-1.5">
                {(m.tier as number) === 2
                  ? `expressive performance — aligned & verified (${Math.round((((m.map_note_evidence ?? m.map_onset_agreement) as number) ?? 0) * 100)}% of notes confirmed)`
                  : "matches the notated tempo"}
              </p>
            )}
            {g.key === "structure" && entry?.status === "pass" && (
              <p className="text-[11px] text-ink-soft mt-1.5 tabular-nums">
                {(m.kind as string) === "repeats"
                  ? `plays repeats — ${String(m.written_measures)} written / ${String(m.played_measures)} played measures (verified)`
                  : "no repeats — plays straight through"}
              </p>
            )}
            {g.key === "audio" && entry?.status === "running" && (
              <p className="text-[11px] text-ink-faint mt-1.5">
                Expressive verification transcribes the recording note-by-note — allow roughly
                twice the recording's length. Leaving this page won't stop it.
              </p>
            )}
            {g.key === "sanity" && entry?.status === "pass" && (
              <p className="text-[11px] text-ink-soft mt-1.5 tabular-nums">
                {String(m.measures)} measures · {String(m.xml_onsets)} score notes ·{" "}
                {String(m.midi_notes)} MIDI notes · {String(m.midi_duration_sec)}s
              </p>
            )}
            {g.key === "geometry" && entry?.status === "pass" && (
              <p className="text-[11px] text-ink-soft mt-1.5 tabular-nums">
                {String(m.systems)} systems · timeline offset {String(m.residual_p50_ms)}ms (median)
              </p>
            )}
            {open === g.key && (
              <ul className="mt-2 space-y-1">
                {g.explain.map((line, i) => (
                  <li key={i} className="text-[11px] text-ink-soft leading-relaxed">
                    · {line}
                  </li>
                ))}
              </ul>
            )}
            {entry?.status === "fail" && (
              <div className="mt-2 space-y-1.5">
                <p className="text-[11px] text-bad leading-relaxed">{entry.error}</p>
                {diagnosisOf(entry.metrics).length > 0 ? (
                  <Diagnosis items={diagnosisOf(entry.metrics)} />
                ) : (
                  <p className="text-[11px] text-ink leading-relaxed rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2">
                    {failureHint(g.key, entry.error ?? "")}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="rounded-xl border border-dashed border-line px-3.5 py-3">
        <p className="text-sm font-medium text-ink-faint">{RENDER_GATE.label}</p>
        <p className="text-[11px] text-ink-faint mt-0.5">Runs after you submit (~20s).</p>
      </div>
    </div>
  );
}
