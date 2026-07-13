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
    key: "structure",
    label: "Repeat structure",
    blurb: "Reads repeat marks, verifies the playback order",
    explain: [
      "Repeat barlines, 1st/2nd endings and multi-time repeats are read from the score and expanded into the exact playing order.",
      "The engraving engine's expansion is cross-checked measure-by-measure against an independent expansion of the same marks — any disagreement rejects the build rather than risking a wrong playback order.",
      "D.C./D.S./Coda navigation isn't supported yet: write the form out in playing order and re-export.",
      "Pieces without repeats pass straight through.",
    ],
  },
  {
    key: "alignment",
    label: "Extracting the timeline",
    blurb: "Builds the note timeline the app follows",
    explain: [
      "Every note onset in the MIDI becomes a follow event — this is the timeline the score-following engine listens against.",
      "Notes within 30ms are grouped into one chord event, matching how the shipped pieces were built.",
      "When the score has repeats, the MIDI must play them out (repeats taken): it is matched note-by-note against both the written-through and the repeat-expanded reading, and must fit the expanded one.",
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
    "An expressive performance (rubato, ritardando) is aligned automatically against the score and the alignment itself is verified — every note needs onset evidence OF ITS OWN PITCH at the expected time (tier 2).",
    "The recording's structure must match the score exactly: same number of repeats, nothing added or cut — on repeat pieces every repeat pass is checked for its share of time.",
    "Expressive verification transcribes the recording note-by-note; expect it to run for roughly TWICE the recording's length. A 10-minute recording can take ~20 minutes — the check keeps running if you leave the page.",
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
  if (gateKey === "structure") {
    if (e.includes("d.c.") || e.includes("d.s.") || e.includes("coda") || e.includes("segno") || e.includes("not supported yet")) {
      return "This score uses D.C./D.S./Coda navigation, which isn't supported yet. In your notation software, write the form out in playing order (copy the repeated section to where it plays), remove the navigation marks, and re-export both files.";
    }
    if (e.includes("nested") || e.includes("overlap")) {
      return "Nested or overlapping repeats can't be expanded safely. Simplify the repeat structure (or write the passage out) and re-export.";
    }
    if (e.includes("expansion mismatch")) {
      return "The engraving engine expanded the repeats differently than the marks say — this protects you from a wrong playback order. Flag it to engineering with this piece's files.";
    }
    return "The repeat marks couldn't be read safely. Check the barlines and ending brackets in your notation software, then re-export.";
  }
  if (gateKey === "alignment") {
    if (e.includes("straight through") || e.includes("repeats taken")) {
      return "The score plays repeats but this MIDI doesn't. Re-export the MIDI with repeat playback ON (the export follows playback), or use your software's Unroll/Expand-repeats before exporting BOTH files.";
    }
  }
  if (gateKey === "audio") {
    if (e.includes("skipped or cut") || e.includes("proportional time")) {
      return "The named repeat pass is missing or cut short in the recording. This score plays its repeats — record the full structure (all repeats taken) and re-upload.";
    }
    if (e.includes("structure") || e.includes("repeats")) {
      return "The recording and the score disagree structurally — most often a repeat played a different number of times, or extra/missing material. Make the recording follow the written score exactly and re-upload.";
    }
    if (e.includes("pedal") || e.includes("drier")) {
      return "The recording is verified as this piece — the notes just can't be confirmed precisely enough (usually heavy pedal, distant mic, or reverb). A drier, closer recording of the same performance will usually pass.";
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
