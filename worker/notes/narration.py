"""Premium narration (ElevenLabs) for a note: one clip per annotation plus an overview.

The spoken text is a line-for-line mirror of the app's NoteReadAloudScript.swift
(KaraOrcheeAMT/App/Notes/Player/) — if the two diverge the ears and the screen tell
the student different things. `narration_parity.json` is the shared golden all three
sides assert against, and every clip carries a text_hash the app re-computes before
playing: a hash the app does not reproduce EXACTLY is a permanent, silent fallback to
the device voice, so its definition is pinned by golden on the worker, the API and the
app rather than described in prose.

Voice config (model + seed + settings) is frozen so a character sounds identical across
batches, and content_hash over [text, voice_id, MODEL, SEED, SETTINGS] is what makes an
unchanged clip free on a re-run. Nothing here may synthesize without first passing the
per-note ceiling.

`chars` and `credits` are not the same quantity and never convert into each other here.
`chars` is what this worker sends — the only cost knowable BEFORE a request, so it is
what the ceiling gates on. `credits` is what the vendor's meter charges, taken from its
per-request character-cost header; its rate is not 1:1 and is not published anywhere the
worker can read. Account drain is SUM(credits) — a sum of chars is not a charge.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass

import requests

from obs import jlog

VOICES = {
    "jessica": "cgSgspJ2msm6clMCkdW9",
    "george": "JBFqnCBsd6RMkjVDRZzb",
}
MODEL = "eleven_multilingual_v2"
SEED = 42
SETTINGS = {"stability": 0.5, "similarity_boost": 0.75, "style": 0.0,
            "speed": 0.9, "use_speaker_boost": True}
API_BASE = "https://api.elevenlabs.io/v1/text-to-speech"
COST_HEADER = "character-cost"
# Stored exactly as the vendor returns it: one lossy encode, not two. Speech energy is
# essentially all under 8 kHz, so a music bitrate buys nothing a second encoder could
# only degrade. Part of content_hash — a clip at another bitrate is another artifact.
OUTPUT_FORMAT = "mp3_44100_64"
CLIP_EXT = ".mp3"

ASSETS_CONTAINER = "notes-assets"
CONFIG_KEY = "notes_narration"
KEY_ENV = "ELEVENLABS_API_KEY"

# Bounds the characters ONE run may send the vendor, summed over every voice — not the
# length of the script, and NOT credits: it buys a different, larger number of them.
# Sized off the longest real note on dev (17 annotations, ~3.6k chars of script) read in
# both voices, with headroom.
DEFAULT_MAX_CHARS = 12000
DEFAULT_VOICES = ["jessica", "george"]
DEFAULT_MODE = "eager"
# Narration runs after the note is already delivered; this only stops a slow vendor
# from holding the queue message for the rest of the lock.
DEADLINE_SEC = 240


# ── the spoken script — mirrors NoteReadAloudScript.swift ─────────────────────────

# ReadAloudService.spoken: glyphs the synthesizer drops or mangles.
GLYPHS = {"♯": " sharp", "♭": " flat", "→": " to ",
          "—": ", ", "×": " times "}
TERMINATORS = (".", "!", "?", "…")


def spoken(s: str) -> str:
    for glyph, word in GLYPHS.items():
        s = s.replace(glyph, word)
    return s


def clean(s) -> str | None:
    if not isinstance(s, str):
        return None
    t = s.strip()
    return t or None


def stopped(s: str) -> str:
    return s if s.endswith(TERMINATORS) else s + "."


def bars_spoken(start: int, end: int) -> str:
    """NoteBarsText.spoken — PRINTED bar numbers, the ones on the student's page."""
    lo, hi = min(start, end), max(start, end)
    return f"Bars {lo} to {hi}." if hi > lo else f"Bar {lo}."


def printed_range(location) -> tuple[int, int] | None:
    """NoteLessonAdapter.printedRange. Teacher grounding wins, then the student's pin."""
    loc = location if isinstance(location, dict) else {}
    if loc.get("grounded") is True and isinstance(loc.get("measureStart"), int):
        start = loc["measureStart"]
        end = loc["measureEnd"] if isinstance(loc.get("measureEnd"), int) else start
        return (start, end)
    pin = loc.get("studentPin")
    if isinstance(pin, dict) and isinstance(pin.get("measureStart"), int) \
            and isinstance(pin.get("measureEnd"), int):
        return (pin["measureStart"], pin["measureEnd"])
    return None


def spoken_range(location) -> tuple[int, int] | None:
    """NoteStep.authoredBars. The bars the NOTE carries — a pin the STUDENT adds is local, and the clip
    is one pre-rendered file for every device: a script that changes when a student pins orphans the clip
    and the device voice reads that step for the rest of the note's life."""
    loc = location if isinstance(location, dict) else {}
    if loc.get("grounded") is True and isinstance(loc.get("measureStart"), int):
        start = loc["measureStart"]
        end = loc["measureEnd"] if isinstance(loc.get("measureEnd"), int) else start
        return (start, end)
    return None


def attributed(quote: str, is_self_origin: bool) -> str:
    return f"From your lesson: {quote}" if is_self_origin else f"Your teacher said: {quote}"


def overview_lines(summary, step_count: int) -> list[str]:
    lines = []
    s = clean(summary)
    if s:
        lines.append(stopped(s))
    if step_count > 0:
        lines.append(f"{step_count} thing{'' if step_count == 1 else 's'} to work on.")
    return lines


def step_lines(annotation: dict, number: int, is_self_origin: bool) -> list[str]:
    lines = []
    bars = spoken_range(annotation.get("location"))
    if bars:
        lines.append(bars_spoken(*bars))
    else:
        phrase = clean((annotation.get("location") or {}).get("raw"))
        if phrase:
            lines.append(stopped(phrase))
    instruction = clean(annotation.get("instruction"))
    if instruction:
        lines.append(stopped(instruction))
    quote = clean(annotation.get("quote"))
    if quote:
        lines.append(stopped(attributed(quote, is_self_origin)))
    return [f"Step {number}."] + lines if lines else []


def spoken_lines(lines: list[str]) -> list[str]:
    """ReadAloudService.canonical — the exact strings a voice utters, in order."""
    return [x for x in (spoken(line) for line in lines) if x]


def canonical(lines: list[str]) -> str:
    """One clip's text. ReadAloudService queues the lines as separate utterances; a
    single audio file has to speak them as one."""
    return " ".join(spoken_lines(lines))


# ── clips ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Clip:
    clip_id: str
    annotation_id: str | None
    kind: str
    lines: tuple[str, ...]

    @property
    def text(self) -> str:
        return canonical(list(self.lines))

    @property
    def text_hash(self) -> str:
        return text_hash(list(self.lines))

    @property
    def chars(self) -> int:
        return len(self.text)


def plan_clips(summary, annotations: list[dict], is_self_origin: bool) -> list[Clip]:
    """Annotations must already be in server idx order — the spoken step number is the
    student's page position, and reordering renumbers every clip."""
    clips = []
    overview = overview_lines(summary, len(annotations))
    if canonical(overview):
        clips.append(Clip("overview", None, "overview", tuple(overview)))
    for i, a in enumerate(annotations):
        lines = step_lines(a, i + 1, is_self_origin)
        if canonical(lines):
            clips.append(Clip(str(a["id"]), str(a["id"]), "step", tuple(lines)))
    return clips


def content_hash(text: str, voice_id: str) -> str:
    blob = json.dumps([text, voice_id, MODEL, SEED, SETTINGS, OUTPUT_FORMAT], sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def text_hash(lines: list[str]) -> str:
    """NoteNarration.textHash — full lowercase-hex sha256 of the spoken lines joined by
    a single newline. Voice-independent: the app recomputes it over the script it would
    speak and falls back to the device voice when it disagrees, so a truncated digest,
    a different join or a pre-substitution hash all read as "every clip is stale" and
    report nothing. narration_parity.json pins the value on all three sides."""
    return hashlib.sha256("\n".join(spoken_lines(lines)).encode()).hexdigest()


def blob_path(note_id: str, voice: str, clip_id: str) -> str:
    return f"narration/{note_id}/{voice}/{clip_id}{CLIP_EXT}"


# ── config (platform_config, same mechanism as monetization_live_at) ──────────────

@dataclass(frozen=True)
class NarrationConfig:
    enabled: bool
    mode: str
    voices: tuple[str, ...]
    max_chars: int


OFF = NarrationConfig(False, DEFAULT_MODE, tuple(DEFAULT_VOICES), DEFAULT_MAX_CHARS)


def parse_config(value) -> NarrationConfig:
    """No row / anything unrecognized = OFF. An unknown voice name is dropped rather
    than guessed: there is no safe default voice id."""
    if value is True:
        value = {"enabled": True}
    if not isinstance(value, dict) or value.get("enabled") is not True:
        return OFF
    mode = value.get("mode") if value.get("mode") in ("eager", "on_demand") else DEFAULT_MODE
    raw = value.get("voices")
    names = raw if isinstance(raw, list) else DEFAULT_VOICES
    voices = tuple(v for v in DEFAULT_VOICES if v in names)
    limit = value.get("maxCharsPerNote")
    max_chars = limit if isinstance(limit, int) and limit > 0 else DEFAULT_MAX_CHARS
    if not voices:
        return OFF
    return NarrationConfig(True, mode, voices, max_chars)


def load_config(conn) -> NarrationConfig:
    with conn.cursor() as cur:
        cur.execute("SELECT value FROM platform_config WHERE key = %s", (CONFIG_KEY,))
        row = cur.fetchone()
    conn.commit()
    return parse_config(row[0] if row else None)


# ── synthesis ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Synthesized:
    audio: bytes
    credits: int | None  # vendor-metered cost; None when the header is missing


class Synthesizer:
    def synth(self, text: str, voice_id: str) -> Synthesized:
        raise NotImplementedError


def _refuse_under_test() -> None:
    # Every call here is billed to the founder's account; a test that reaches it is a bug.
    if "PYTEST_CURRENT_TEST" in os.environ or "NARRATION_NO_SPEND" in os.environ:
        raise RuntimeError("real synthesis is not reachable from a test run")


def transient(status: int) -> bool:
    """Worth another attempt only where nothing was produced and nothing was billed.
    Every other 4xx is a config error, and repeating it just delays the fail-closed path."""
    return status == 429 or status >= 500


def post_with_retry(send, attempts: int = 3, sleep=time.sleep):
    """Returns the whole response, not just its body: the billed cost is a header."""
    for i in range(attempts):
        last = i == attempts - 1
        try:
            r = send()
        except requests.RequestException:
            if last:
                raise
            sleep(min(2 ** i, 15))
            continue
        if not transient(r.status_code):
            r.raise_for_status()
            return r
        if last:
            raise RuntimeError(f"elevenlabs transient {r.status_code}")
        sleep(min(2 ** i, 15))


def vendor_credits(headers) -> int | None:
    """What the vendor says this request cost. Unreadable or absent = unknown, never a
    guess: a fabricated number here would read as a real charge in the ledger."""
    try:
        raw = (headers or {}).get(COST_HEADER)
    except Exception:
        return None
    if raw is None:
        return None
    try:
        return round(float(raw))
    except (TypeError, ValueError):
        return None


class ElevenLabsSynthesizer(Synthesizer):
    def __init__(self, api_key: str, attempts: int = 3):
        _refuse_under_test()
        self._key = api_key
        self._attempts = attempts

    def synth(self, text: str, voice_id: str) -> Synthesized:
        _refuse_under_test()
        r = post_with_retry(
            lambda: requests.post(
                f"{API_BASE}/{voice_id}?output_format={OUTPUT_FORMAT}",
                headers={"xi-api-key": self._key, "Content-Type": "application/json"},
                json={"text": text, "model_id": MODEL, "seed": SEED,
                      "voice_settings": SETTINGS},
                timeout=180),
            self._attempts)
        return Synthesized(r.content, vendor_credits(r.headers))


def build_synthesizer() -> Synthesizer | None:
    """Missing key = narration off, never a worker that refuses to start: the notes
    pipeline must run whether or not this stage is configured."""
    key = os.environ.get(KEY_ENV)
    if not key:
        return None
    return ElevenLabsSynthesizer(key)


# ── the run ───────────────────────────────────────────────────────────────────────

def load_note(conn, note_id: str):
    """Returns (summary, is_self_origin, annotations) or None when there is nothing
    narratable — no such note, or one already retracted.

    Only source='transcript' rows are spoken. A plan row entering this list would
    renumber every step and change the count the overview clip states, which
    invalidates every stored text_hash and drops the reader to the device voice
    with nothing reported."""
    with conn.cursor() as cur:
        # ::uuid throughout — the on-demand trigger carries noteId as a JSON string.
        cur.execute("SELECT content, origin, status FROM notes WHERE id = %s::uuid", (note_id,))
        row = cur.fetchone()
        if row is None or row[2] == "retracted":
            conn.commit()
            return None
        content, origin, _ = row
        if isinstance(content, str):
            content = json.loads(content)
        cur.execute(
            """SELECT id, instruction, quote, location FROM note_annotations
               WHERE note_id = %s::uuid AND source = 'transcript' ORDER BY idx""", (note_id,))
        annotations = [{"id": r[0], "instruction": r[1], "quote": r[2],
                        "location": json.loads(r[3]) if isinstance(r[3], str) else r[3]}
                       for r in cur.fetchall()]
    conn.commit()
    summary = (content or {}).get("lessonSummary")
    return summary, origin == "self", annotations


def existing_hashes(conn, note_id: str, voice: str) -> dict[str, str]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT clip_id, content_hash FROM note_narration_clips
               WHERE note_id = %s::uuid AND voice = %s""",
            (note_id, voice))
        rows = cur.fetchall()
    conn.commit()
    return {r[0]: r[1] for r in rows}


def record_clip(conn, note_id: str, voice: str, clip: Clip, path: str,
                chash: str, size: int, credits: int | None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO note_narration_clips
                   (note_id, annotation_id, voice, clip_id, kind, blob_path,
                    content_hash, text_hash, chars, credits, bytes, model)
               VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (note_id, voice, clip_id) DO UPDATE SET
                   annotation_id = EXCLUDED.annotation_id,
                   kind = EXCLUDED.kind,
                   blob_path = EXCLUDED.blob_path,
                   content_hash = EXCLUDED.content_hash,
                   text_hash = EXCLUDED.text_hash,
                   chars = EXCLUDED.chars,
                   credits = EXCLUDED.credits,
                   bytes = EXCLUDED.bytes,
                   model = EXCLUDED.model,
                   updated_at = now()""",
            (note_id, clip.annotation_id, voice, clip.clip_id, clip.kind, path,
             chash, clip.text_hash, clip.chars, credits, size, MODEL))
    conn.commit()


def pending(conn, note_id: str, clips: list[Clip], voices) -> list[tuple[str, Clip, str]]:
    """(voice, clip, content_hash) for everything not already synthesized at this exact
    text + voice config. A cached clip costs nothing and is never re-sent."""
    out = []
    for voice in voices:
        voice_id = VOICES[voice]
        have = existing_hashes(conn, note_id, voice)
        for clip in clips:
            chash = content_hash(clip.text, voice_id)
            if have.get(clip.clip_id) != chash:
                out.append((voice, clip, chash))
    return out


def narrate(conn, blob, note_id: str, voices, synth: Synthesizer | None = None,
            max_chars: int = DEFAULT_MAX_CHARS, deadline_sec: int = DEADLINE_SEC) -> dict:
    """Synthesize a named subset of (note, voice). Returns a result dict for metrics; a
    vendor failure is per-clip and leaves the rest of the run — and the note — intact."""
    voices = [v for v in voices if v in VOICES]
    if not voices:
        return {"status": "no_voices"}
    loaded = load_note(conn, note_id)
    if loaded is None:
        return {"status": "not_narratable"}
    summary, is_self_origin, annotations = loaded
    clips = plan_clips(summary, annotations, is_self_origin)
    if not clips:
        return {"status": "nothing_to_say"}

    todo = pending(conn, note_id, clips, voices)
    if not todo:
        return {"status": "cached", "clips": len(clips), "chars": 0, "credits": 0}
    spend = sum(clip.chars for _, clip, _ in todo)
    if spend > max_chars:
        # Hard stop BEFORE the first request: a partial run on a runaway note would
        # still have paid for the runaway part.
        jlog(event="narration_over_budget", note=str(note_id), chars=spend, ceiling=max_chars)
        return {"status": "over_budget", "chars": spend, "ceiling": max_chars}

    synth = synth or build_synthesizer()
    if synth is None:
        jlog(event="narration_unconfigured", note=str(note_id))
        return {"status": "unconfigured"}

    container = blob.get_container_client(ASSETS_CONTAINER)
    made = failed = spent = billed = unmetered = 0
    stop_at = time.time() + deadline_sec
    for voice, clip, chash in todo:
        if time.time() >= stop_at:
            jlog(event="narration_deadline", note=str(note_id), made=made)
            break
        try:
            out = synth.synth(clip.text, VOICES[voice])
            path = blob_path(note_id, voice, clip.clip_id)
            container.get_blob_client(path).upload_blob(
                out.audio, overwrite=True,
                content_settings=_audio_content_settings(),
                # Mirrors the manifest row so a blob-listing read path can hand the
                # client a text hash without a second query.
                metadata={"texthash": clip.text_hash, "contenthash": chash,
                          "clipid": clip.clip_id, "voice": voice})
            record_clip(conn, note_id, voice, clip, path, chash, len(out.audio),
                        out.credits)
            made += 1
            spent += clip.chars
            if out.credits is None:
                unmetered += 1
            else:
                billed += out.credits
        except Exception as err:
            failed += 1
            jlog(event="narration_clip_failed", note=str(note_id), voice=voice,
                 clip=clip.clip_id, error=str(err)[:200])
    # credits is only a floor while unmetered > 0: those clips were billed unreadably.
    return {"status": "ok" if not failed else "partial", "clips": len(clips),
            "made": made, "failed": failed, "chars": spent,
            "credits": billed, "unmetered": unmetered}


def _audio_content_settings():
    # Resolved at call time so this module imports without the azure SDK installed.
    from azure.storage.blob import ContentSettings
    return ContentSettings(content_type="audio/mpeg")


def narration_stage(conn, blob, note_id: str, req_id: str | None = None) -> dict | None:
    """The pipeline seam. Returns None when narration did not run. Never raises: the
    note is already delivered and the app falls back to system speech."""
    try:
        cfg = load_config(conn)
        if not cfg.enabled:
            return None
        if cfg.mode != "eager":
            return {"status": "on_demand"}
        result = narrate(conn, blob, note_id, cfg.voices, max_chars=cfg.max_chars)
        jlog(event="narration", note=str(note_id), reqId=req_id, **result)
        return result
    except Exception as err:
        jlog(event="narration_failed", note=str(note_id), reqId=req_id, error=str(err)[:200])
        return None


def targets_from_message(body: dict) -> tuple[str, list[str]]:
    """The ONE notes-narration message shape: {noteId, voices[], reqId} — sent by
    api/src/routes/notes.ts and pinned in narration_parity.json. Anything else raises
    rather than guessing a voice list: a body this worker cannot read is a contract
    break, and dead-lettering it rings the DLQ alert instead of billing the account
    for something nobody asked for."""
    note_id = body.get("noteId")
    voices = body.get("voices")
    if not isinstance(note_id, str) or not note_id:
        raise ValueError("narration message has no noteId")
    if not isinstance(voices, list) or not voices or not all(isinstance(v, str) for v in voices):
        raise ValueError("narration message has no voices[]")
    return note_id, voices


def narrate_on_demand(conn, blob, note_id: str, voices,
                      req_id: str | None = None) -> dict | None:
    """A named subset of (note, voice), triggered after the fact — the API enqueues one
    of these when a note is sent. Same config gate, same ceiling as the eager stage."""
    try:
        cfg = load_config(conn)
        if not cfg.enabled:
            return None
        names = [voices] if isinstance(voices, str) else list(voices or [])
        result = narrate(conn, blob, note_id, names, max_chars=cfg.max_chars)
        jlog(event="narration", note=str(note_id), voices=names, reqId=req_id, **result)
        return result
    except Exception as err:
        jlog(event="narration_failed", note=str(note_id), reqId=req_id, error=str(err)[:200])
        return None
