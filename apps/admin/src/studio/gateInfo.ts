import type { StudioJob } from "../api";

// Operator-facing copy for the pipeline gates. Internal keys (sanity/alignment/
// geometry/render) never surface to the editor — human labels + remediation hints do.
export interface GateInfo {
  key: string;
  label: string;
  blurb: string;
  explain: string[];
}

export const PREFLIGHT_GATES: GateInfo[] = [
  {
    key: "sanity",
    label: "Reading the files",
    blurb: "Both files open and contain music",
    explain: [
      "The MusicXML is loaded by the engraving engine — a file that fails here is corrupted or not really MusicXML.",
      "The score must contain at least one measure and one note (an empty template is rejected).",
      "The MIDI is parsed and its note count and duration are measured.",
    ],
  },
  {
    key: "alignment",
    label: "Extracting the timeline",
    blurb: "Builds the note timeline the app follows",
    explain: [
      "Every note onset in the MIDI becomes a follow event — this is the timeline the score-following engine listens against.",
      "Notes within 30ms are grouped into one chord event, matching how the shipped pieces were built.",
    ],
  },
  {
    key: "geometry",
    label: "Engraving & matching",
    blurb: "Draws the sheet music, checks MIDI matches the score",
    explain: [
      "The engraving engine renders the score for phone and iPad and computes where the play cursor sits for every note.",
      "The MIDI timeline and the engraved score timeline are compared note-by-note: the median offset must stay under 12ms.",
      "If this fails, the MIDI almost certainly wasn't exported from the same project as the MusicXML — or has performance timing baked in.",
    ],
  },
];

export const AUDIO_GATE: GateInfo = {
  key: "audio",
  label: "Reference audio verification",
  blurb: "Confirms the recording follows the score",
  explain: [
    "Tap-to-seek, cursor sync, and start-anywhere all assume the audio matches the score timeline — an unverified recording would silently break them.",
    "A recording at the notated tempo passes directly (tier 1).",
    "An expressive performance (rubato, ritardando) is aligned automatically against the score and the alignment itself is verified — onsets AND pitch content (tier 2).",
    "The recording's structure must match the score exactly: same number of repeats, nothing added or cut.",
  ],
};

export const RENDER_GATE: GateInfo = {
  key: "render",
  label: "On-screen verification",
  blurb: "Verifies the cursor lands on the staff in a real renderer",
  explain: [
    "The built score is loaded into the same browser engine an iPhone uses, and the play cursor is driven exactly like the app drives it.",
    "At sampled positions the cursor must sit on the staff — not float above or below it.",
    "This is the slow gate (~20s); it runs after you submit, and again before any re-publish.",
  ],
};

export const ALL_GATES = [...PREFLIGHT_GATES, AUDIO_GATE, RENDER_GATE];

// Actionable remediation, matched on the worker's failure text.
export function failureHint(gateKey: string, error: string): string {
  const e = error.toLowerCase();
  if (gateKey === "sanity") {
    if (e.includes("musicxml")) {
      return "Re-export the score from your notation software: File → Export → MusicXML (.musicxml or .mxl). If it keeps failing, the file may be damaged — open it in the notation app first to confirm it loads.";
    }
    if (e.includes("midi")) {
      return "Re-export the MIDI from the same project as a standard .mid file. If your software offers MIDI format options, pick type 0 or 1.";
    }
    if (e.includes("empty")) {
      return "The score has no notes — you may have exported an empty template or the wrong file.";
    }
  }
  if (gateKey === "alignment" || gateKey === "geometry") {
    if (e.includes("residual") || e.includes("disagree") || e.includes("timeline")) {
      return "Export the MIDI from the SAME project as the MusicXML, and turn OFF any “humanize”, “swing”, or performance-playback options — the MIDI must follow the notated tempo exactly. A recorded human performance will not pass.";
    }
    if (e.includes("pitch")) {
      return "Some notes couldn't be read from the score. Re-export the MusicXML, or upload a reference MIDI exported from the same project.";
    }
  }
  if (gateKey === "audio") {
    if (e.includes("structure") || e.includes("repeats")) {
      return "The recording and the score disagree structurally — most often a repeat played a different number of times, or extra/missing material. Make the recording follow the written score exactly (write out repeats in the score if needed) and re-upload.";
    }
    if (e.includes("does not appear to be this piece") || e.includes("pitch content")) {
      return "This looks like the wrong audio file for this piece — double-check which recording you attached.";
    }
    if (e.includes("decoded")) {
      return "The audio file couldn't be read — re-export it as .m4a, .mp3, or .wav.";
    }
    return "The recording drifts too far from the score timeline. Either re-render it at the notated tempo, or make sure the performance follows the score's structure exactly.";
  }
  if (gateKey === "render") {
    return "This is usually a pipeline problem, not your files. Re-run the checks; if it fails again, flag it to engineering.";
  }
  return "Check the details above, fix the export, and replace the files to re-run the checks.";
}

export function jobTone(status: StudioJob["status"]) {
  switch (status) {
    case "published":
      return "ok" as const;
    case "ready_for_review":
      return "brand" as const;
    case "failed":
      return "bad" as const;
    case "draft":
      return "muted" as const;
    case "queued":
    case "running":
      return "warn" as const;
    default:
      return "muted" as const;
  }
}

export function statusLabel(job: Pick<StudioJob, "status" | "checkStatus">): string {
  if (job.status === "draft") {
    switch (job.checkStatus) {
      case "pending":
      case "running":
        return "draft · checking";
      case "fail":
        return "draft · fix files";
      default:
        return "draft";
    }
  }
  return job.status.replaceAll("_", " ");
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const KEY_NAMES_MAJOR = ["C", "G", "D", "A", "E", "B", "F♯", "C♯"];
const KEY_NAMES_FLAT_MAJOR = ["C", "F", "B♭", "E♭", "A♭", "D♭", "G♭", "C♭"];

export function keyLabel(key: { fifths: number; mode?: string } | null | undefined): string {
  if (!key) return "—";
  const f = key.fifths;
  const name = f >= 0 ? KEY_NAMES_MAJOR[f] ?? `${f}♯` : KEY_NAMES_FLAT_MAJOR[-f] ?? `${-f}♭`;
  return `${name} ${key.mode === "minor" ? "minor" : "major"} (${f >= 0 ? `${f}♯` : `${-f}♭`})`;
}
