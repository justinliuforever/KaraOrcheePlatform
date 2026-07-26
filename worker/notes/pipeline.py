"""Pure transform + gate logic for the notes pipeline (no I/O — unit-tested).

Gate discipline mirrors the pieces worker: fail with actionable hints, never
ship garbage. The structural killer is the quote-verbatim gate — an annotation
whose quote is not in the transcript is unverifiable and is dropped, which makes
invented instructions impossible by construction.
"""
from __future__ import annotations

import json
import re

MIN_TRANSCRIPT_WORDS = 50
MIN_ANNOTATIONS = 2

CATEGORIES = {"technique", "musicality", "reading", "rhythm", "fingering",
              "pedaling", "practice_strategy", "posture", "other"}
LOCATION_TYPES = {"absolute", "compound", "relative", "deixis", "none"}


class GateFail(Exception):
    """`code` is the machine-readable cause written to note_jobs.failure_code. The
    app renders copy and the retry cap keys off it — hints are prose and cannot
    carry it (hints[0] is shown to the user verbatim)."""

    def __init__(self, message: str, hints: list[str] | None = None, code: str = "unknown",
                 evidence: dict | None = None):
        super().__init__(message)
        self.hints = hints or []
        self.code = code
        # What the gate saw. `drops` holds verbatim instruction/quote text, so this
        # belongs in the model-output artifact and never in the note_jobs row.
        self.evidence = evidence or {}
        # Stamped by the worker before the failure row is written.
        self.metrics: dict | None = None
        self.artifact: str | None = None


def build_turns(utterances: list[dict]) -> str:
    """Diarized turn lines. The prototype fed flat text and muddied who-said-what;
    turn labels let the prompt ignore student self-talk."""
    lines = []
    for u in utterances:
        speaker = u.get("speaker") or "?"
        text = (u.get("text") or "").strip()
        if text:
            lines.append(f"Speaker {speaker}: {text}")
    return "\n".join(lines)


def check_transcript(text: str, utterances: list[dict]) -> dict:
    words = len(text.split())
    if words < MIN_TRANSCRIPT_WORDS:
        raise GateFail(
            "Very little speech was detected in this recording.",
            ["The lesson may have been mostly playing, or the phone was too far from the teacher.",
             "Next time, keep the phone within a few feet of where you talk."],
            code="no_speech",
            evidence={"transcript_words": words, "min_transcript_words": MIN_TRANSCRIPT_WORDS})
    speakers = {u.get("speaker") for u in utterances if u.get("speaker")}
    return {"transcript_words": words, "speakers": len(speakers)}


def extract_json(text: str) -> dict:
    m = re.search(r"```json\s*(.*?)```", text, re.S)
    raw = m.group(1) if m else text
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as err:
        raise ValueError(f"output is not valid JSON: {err}") from err
    if not isinstance(obj, dict):
        raise ValueError("output JSON is not an object")
    return obj


def _norm(s: str) -> str:
    # Punctuation becomes a space (not deleted): ASR says "F sharp", an LLM may
    # quote "F-sharp" — both must normalize to the same token stream.
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def quote_in_transcript(quote: str, transcript: str) -> bool:
    q = _norm(quote)
    return bool(q) and q in _norm(transcript)


def drop_reasons(drops: list[dict]) -> dict:
    out: dict = {}
    for d in drops:
        reason = str(d.get("reason", "unknown"))
        out[reason] = out.get(reason, 0) + 1
    return out


DROP_TEXT_CHARS = 600  # the model can emit an arbitrarily long instruction


def _drop(index: int, reason: str, **fields) -> dict:
    return {"index": index, "reason": reason,
            **{k: (v[:DROP_TEXT_CHARS] if isinstance(v, str) else v) for k, v in fields.items()}}


def normalize_note(obj: dict, transcript: str, measure_count: int | None):
    """LLM object -> (content, annotation rows, warnings, drops). Raises ValueError on
    shape problems (caller retries once with the validator message).

    `warnings` is the operator-readable summary kept on the job row; `drops` names the
    rejected annotation and the gate that rejected it, for the artifact."""
    summary = obj.get("lesson_summary")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("lesson_summary missing or empty")
    raw_annotations = obj.get("annotations")
    if not isinstance(raw_annotations, list):
        raise ValueError("annotations missing or not a list")
    plan_in = obj.get("practice_plan")
    if not isinstance(plan_in, list):
        raise ValueError("practice_plan missing or not a list")

    plan = []
    for step in plan_in:
        if not isinstance(step, dict):
            continue
        steps = [s for s in step.get("steps", []) if isinstance(s, str) and s.strip()]
        focus = step.get("focus")
        if isinstance(focus, str) and focus.strip():
            plan.append({"focus": focus.strip(), "steps": steps,
                         "target": step.get("target") if isinstance(step.get("target"), str) else ""})

    annotations = []
    warnings: list[str] = []
    drops: list[dict] = []
    for i, a in enumerate(raw_annotations):
        if not isinstance(a, dict):
            drops.append(_drop(i, "not_an_object"))
            continue
        instruction = a.get("instruction")
        if not isinstance(instruction, str) or not instruction.strip():
            drops.append(_drop(i, "empty_instruction", quote=a.get("quote")
                               if isinstance(a.get("quote"), str) else None))
            continue
        quote = a.get("quote") if isinstance(a.get("quote"), str) else ""
        if not quote_in_transcript(quote, transcript):
            warnings.append(f"dropped_unverifiable_quote: {instruction[:60]}")
            drops.append(_drop(i, "unverifiable_quote", instruction=instruction, quote=quote,
                               category=a.get("category") if isinstance(a.get("category"), str) else None))
            continue
        category = a.get("category") if a.get("category") in CATEGORIES else "other"
        loc_in = a.get("location") if isinstance(a.get("location"), dict) else {}
        ltype = loc_in.get("type") if loc_in.get("type") in LOCATION_TYPES else "none"
        location: dict = {
            "type": ltype,
            "raw": loc_in.get("raw") if isinstance(loc_in.get("raw"), str) else None,
            "grounded": False,
            "hint": loc_in.get("grounding_hint") if isinstance(loc_in.get("grounding_hint"), str) else None,
        }
        if ltype == "absolute":
            start = loc_in.get("measure_start")
            end = loc_in.get("measure_end") or start
            valid = (isinstance(start, int) and isinstance(end, int) and 1 <= start <= end)
            in_range = valid and (measure_count is None or end <= measure_count)
            if valid and in_range:
                # V1 auto-anchoring: absolute measure numbers only; everything
                # else stays honestly unplaced until teacher tap-to-pin.
                location.update({"grounded": True, "measureStart": start,
                                 "measureEnd": end, "pinnedBy": "auto"})
            elif valid:
                warnings.append(f"measure_out_of_range: {start}-{end} > {measure_count}")
        annotations.append({
            "instruction": instruction.strip(),
            "quote": quote.strip(),
            "category": category,
            "location": location,
            "confidence": a.get("confidence") if a.get("confidence") in {"high", "medium", "low"} else "medium",
        })

    if len(annotations) < MIN_ANNOTATIONS:
        # Never tell the user to listen back: the local audio is deleted at submit
        # and the client cannot read the blob. Naming the piece is the one thing
        # they CAN do — it changes the prompt, so the retry is not a re-run.
        raise GateFail(
            "Too little teaching talk was detected to build a useful note.",
            ["The recording may be mostly playing, or the teacher's voice may be unclear.",
             "Naming the piece gives the note writer something to anchor to — add it, then try once more."],
            code="thin_note",
            evidence={"annotations_in": len(raw_annotations), "kept": len(annotations),
                      "min_annotations": MIN_ANNOTATIONS, "drops": drops})

    content = {"lessonSummary": summary.strip(), "practicePlan": plan}
    return content, annotations, warnings, drops
