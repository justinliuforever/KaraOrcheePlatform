import os

# Ported from the validated prototype (piano-ai-notes/notes/prompt.py) with
# production hardening: diarized-turn input, no est_minutes (teachers ruled the
# field misleading), and an explicit measure-count bound fed per lesson.

SPEC = """You convert the diarized transcript of a REAL 1:1 music lesson into STRUCTURED, student-facing practice notes anchored to score locations. The student reads these at home and practices from them.

OUTPUT exactly ONE fenced ```json block with the structured object below. No prose outside the fence.

STRUCTURED OBJECT:
{
  "lesson_summary": string,                                          // 2-3 sentences, student-facing, warm but concrete
  "annotations": [{
    "instruction": string,        // imperative, student-facing, what to DO at home
    "quote": string,              // short VERBATIM transcript evidence (copy the exact words)
    "category": "technique"|"musicality"|"reading"|"rhythm"|"fingering"|"pedaling"|"practice_strategy"|"posture"|"other",
    "location": {
      "raw": string|null,         // the reference AS SAID: "the fourth bar", "second line third bar", "that section", or null if none
      "type": "absolute"|"compound"|"relative"|"deixis"|"none",
      "measure_start": number|null,    // only for a clean absolute bar/measure number
      "measure_end": number|null,      // end of an absolute range; equals measure_start for one bar
      "needs_grounding": boolean,      // true unless it is already a concrete resolvable measure
      "grounding_hint": string         // how to resolve it later (e.g. "line 2, measure 3 of the score", "relative to the previously-discussed spot")
    },
    "confidence": "high"|"medium"|"low"
  }],
  "practice_plan": [{"focus": string, "steps": [string], "target": string}]
}

REFERENCE TAXONOMY (classify EVERY location mention):
- absolute: explicit number -> "bar 4", "measure 3", "first 4 bars"
- compound: layout+position -> "second line, third bar", "third note is A"
- relative: needs a moving cursor -> "the next bar", "go back one measure", "from here"
- deixis: pure pointing -> "that section", "this D", "right there"

RULES:
- Faithful ONLY. Every instruction must be traceable to the transcript; the quote must be the teacher's EXACT words, copied verbatim. Do NOT invent pedagogy the teacher did not give.
- The transcript is diarized into speaker turns. Instructions come from the TEACHER; do not turn the student's own words into instructions.
- Detect ALL location references; most real references are relative/deixis, NOT absolute numbers -> set needs_grounding=true for those. That flag is a feature, not a failure.
- The score has {measure_count} measures. Never emit a measure number outside 1..{measure_count}; if the teacher's number seems to exceed it, keep the raw text and set needs_grounding=true instead.
- The practice plan = deliberate practice derived from THIS lesson's actual problems (isolate the hard spot -> slow -> N clean reps -> chunk -> connect). Quality over minutes; do NOT estimate minutes.
- Extrapolate NOTHING beyond what the teacher actually said. No generic advice (e.g. "use a metronome") unless it is in the transcript.
- Be lean: merge related points, no bloat — a page a student scans in under a minute."""

SPEC_NO_COUNT = SPEC.replace(
    "The score has {measure_count} measures. Never emit a measure number outside 1..{measure_count}; if the teacher's number seems to exceed it, keep the raw text and set needs_grounding=true instead.",
    "If the teacher says an explicit measure number, record it exactly as spoken.",
)

USER_TEMPLATE = (
    "This is the diarized ASR transcript of a real music lesson on {piece_desc}. "
    "The teacher speaks; the student mostly plays. Produce the notes for THIS lesson.\n\n"
    "TRANSCRIPT:\n{transcript}"
)

_SCHEMA_TAIL = '  "practice_plan": [{"focus": string, "steps": [string], "target": string}]\n}'
_RULE_TAIL = "- Be lean:"

PIECE_MENTIONS_SCHEMA = (
    '  "piece_mentions": [string]      // quote VERBATIM every phrase where the teacher '
    "names the piece or composer being played; at most 3; [] if none"
)
PIECE_MENTIONS_RULE = (
    "- piece_mentions is evidence, not inference: copy the teacher's exact words naming the "
    'piece or composer ("the Sonatina in C major", "that Burgmuller"). Never write a title the '
    "teacher did not say, and leave the list empty rather than guess."
)


def piece_mentions_enabled() -> bool:
    return os.environ.get("NOTES_PIECE_MENTIONS", "").strip().lower() in {"1", "true", "yes", "on"}


def with_piece_mentions(spec: str) -> str:
    return spec.replace(
        _SCHEMA_TAIL,
        _SCHEMA_TAIL.replace("}]\n}", "}],\n" + PIECE_MENTIONS_SCHEMA + "\n}"),
    ).replace(_RULE_TAIL, PIECE_MENTIONS_RULE + "\n" + _RULE_TAIL)


# W6 Step 1 gates this field on a zero-regression eval the corpus has not cleared, so
# the shipped prompt is the one the corpus was measured against. Flipping the env var
# is the whole change once it clears.
PIECE_SUMMARIES_SCHEMA = (
    '  "piece_summaries": [{"piece": string, "summary": string}]      // one entry per listed piece '
    "the teacher clearly discussed; copy the piece name EXACTLY from the list; 1-2 sentences each"
)


def piece_summaries_rule(names: list[str]) -> str:
    listed = "; ".join(f'"{n}"' for n in names)
    return (
        f"- This lesson covered several pieces: {listed}. Attribute a summary only where the "
        "transcript clearly ties the words to that piece; leave a piece OUT rather than guess. "
        "lesson_summary stays the whole lesson's."
    )


def with_piece_summaries(spec: str, names: list[str]) -> str:
    """Injected only for a multi-piece lesson — the single-piece prompt stays byte-identical."""
    return spec.replace(
        _SCHEMA_TAIL,
        _SCHEMA_TAIL.replace("}]\n}", "}],\n" + PIECE_SUMMARIES_SCHEMA + "\n}"),
    ).replace(_RULE_TAIL, piece_summaries_rule(names) + "\n" + _RULE_TAIL)


def build_system(measure_count: int | None, *, piece_mentions: bool | None = None,
                 piece_names: list[str] | None = None) -> str:
    base = (
        SPEC.replace("{measure_count}", str(measure_count))
        if measure_count and measure_count > 0
        else SPEC_NO_COUNT
    )
    enabled = piece_mentions_enabled() if piece_mentions is None else piece_mentions
    out = with_piece_mentions(base) if enabled else base
    if piece_names and len(piece_names) > 1:
        out = with_piece_summaries(out, piece_names)
    return out


def build_user(transcript_turns: str, piece_desc: str | None) -> str:
    return USER_TEMPLATE.format(
        piece_desc=piece_desc or "a piece not in our catalog",
        transcript=transcript_turns,
    )
