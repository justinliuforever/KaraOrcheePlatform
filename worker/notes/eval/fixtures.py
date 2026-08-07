"""Corpus loader. The transcripts are a minor's speech and a teacher's, recorded in
a private home: they live OUTSIDE the repo behind $NOTES_EVAL_CORPUS and are never
committed, mirrored, or printed. Only derived NUMBERS leave this module."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

# The cached ASR stores flat words with a speaker label, not utterances; the
# production pipeline is fed diarized TURNS, so the loader rebuilds them the same
# way the vendor would — one turn per contiguous run of a single speaker.
LESSONS = ["Chateau Ridge Dr 7", "Chateau Ridge Dr 8", "Soft Stuff"]


@dataclass(frozen=True)
class Lesson:
    key: str
    text: str
    utterances: list[dict]
    measure_count: int | None
    piece_desc: str | None


def corpus_root() -> Path | None:
    raw = os.environ.get("NOTES_EVAL_CORPUS")
    if not raw:
        return None
    root = Path(raw).expanduser()
    return root if (root / "results").is_dir() else None


def _turns(words: list[dict]) -> list[dict]:
    out: list[dict] = []
    for w in words:
        speaker = w.get("speaker") or "?"
        text = (w.get("text") or "").strip()
        if not text:
            continue
        if out and out[-1]["speaker"] == speaker:
            out[-1]["text"] += " " + text
        else:
            out.append({"speaker": speaker, "text": text})
    return out


def load(root: Path, keys: list[str] | None = None) -> list[Lesson]:
    lessons = []
    for key in keys or LESSONS:
        path = root / "results" / key / "assemblyai_base.json"
        if not path.is_file():
            continue
        raw = json.loads(path.read_text())
        lessons.append(Lesson(
            key=key,
            text=raw.get("text") or "",
            utterances=_turns(raw.get("words") or []),
            # The corpus lessons are off-catalog: no piece was ever named to the
            # pipeline, which is exactly the cell B5 exists for.
            measure_count=None,
            piece_desc=None,
        ))
    return lessons
