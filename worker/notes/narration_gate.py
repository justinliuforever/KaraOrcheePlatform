"""Proves a migration did not invalidate a single narration clip.

Every stored clip is re-planned through narration.py's own functions and its two hashes
recomputed. A mismatch means the app will recompute text_hash, disagree, and fall back to
the device voice while reporting nothing — the one failure in this pipeline that has no
error surface. Run it before and after any migration that touches notes, note_annotations
or their ordering, and require the same answer both times.

A nonzero baseline is normal and is not a defect: a draft edited after its clips were
narrated disagrees until it is sent, and `plan_missing` re-renders any clip whose
content_hash moved. That is why `compare` reports only NEW mismatches — the count alone
would make every edited draft look like a migration failure.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from narration import VOICES, content_hash, load_note, plan_clips


@dataclass(frozen=True)
class Mismatch:
    note_id: str
    voice: str
    clip_id: str
    reason: str


@dataclass
class Report:
    checked: int = 0
    notes: int = 0
    mismatches: list[Mismatch] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.mismatches


def stored_clips(conn, note_id: str, voice: str) -> dict[str, tuple[str, str]]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT clip_id, content_hash, text_hash FROM note_narration_clips
               WHERE note_id = %s::uuid AND voice = %s""",
            (note_id, voice))
        rows = cur.fetchall()
    conn.commit()
    return {r[0]: (r[1], r[2]) for r in rows}


def narrated_pairs(conn) -> list[tuple[str, str]]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT note_id::text, voice FROM note_narration_clips ORDER BY 1, 2")
        rows = cur.fetchall()
    conn.commit()
    return [(r[0], r[1]) for r in rows]


def audit_note(conn, note_id: str, voice: str) -> list[Mismatch]:
    stored = stored_clips(conn, note_id, voice)
    if not stored:
        return []
    voice_id = VOICES.get(voice)
    if voice_id is None:
        return [Mismatch(note_id, voice, "*", f"unknown voice {voice!r}")]
    loaded = load_note(conn, note_id)
    if loaded is None:
        return [Mismatch(note_id, voice, "*", "note is gone or retracted but clips remain")]
    summary, is_self_origin, annotations = loaded
    planned = {c.clip_id: c for c in plan_clips(summary, annotations, is_self_origin)}

    out: list[Mismatch] = []
    for clip_id, (stored_content, stored_text) in sorted(stored.items()):
        clip = planned.get(clip_id)
        if clip is None:
            out.append(Mismatch(note_id, voice, clip_id, "stored clip is no longer planned"))
            continue
        if clip.text_hash != stored_text:
            out.append(Mismatch(note_id, voice, clip_id, "text_hash changed — the app will fall back to the device voice"))
        if content_hash(clip.text, voice_id) != stored_content:
            out.append(Mismatch(note_id, voice, clip_id, "content_hash changed — resend would re-bill the vendor"))
    for clip_id in sorted(set(planned) - set(stored)):
        out.append(Mismatch(note_id, voice, clip_id, "planned clip has no stored row"))
    return out


def audit_all(conn) -> Report:
    report = Report()
    seen_notes = set()
    for note_id, voice in narrated_pairs(conn):
        report.checked += 1
        seen_notes.add(note_id)
        report.mismatches.extend(audit_note(conn, note_id, voice))
    report.notes = len(seen_notes)
    return report


def snapshot(report: Report) -> dict:
    return {
        "checked": report.checked,
        "notes": report.notes,
        "mismatches": sorted([m.note_id, m.voice, m.clip_id, m.reason] for m in report.mismatches),
    }


def compare(before: dict, after: dict) -> list[str]:
    """A clip that vanished is the failure a mismatch count alone cannot see."""
    out: list[str] = []
    if after["checked"] < before["checked"]:
        out.append(
            f"clips disappeared: {before['checked']} checked before, {after['checked']} after")
    if after["notes"] < before["notes"]:
        out.append(f"notes lost narration: {before['notes']} before, {after['notes']} after")
    was = {tuple(m) for m in before["mismatches"]}
    now = {tuple(m) for m in after["mismatches"]}
    for m in sorted(now - was):
        out.append(f"new mismatch: {' | '.join(m)}")
    return out


def _main(argv: list[str]) -> int:
    import json
    import os
    import psycopg

    if len(argv) >= 4 and argv[1] == "compare":
        with open(argv[2]) as f:
            before = json.load(f)
        with open(argv[3]) as f:
            after = json.load(f)
        problems = compare(before, after)
        for p in problems:
            print(p)
        print("SAME" if not problems else f"CHANGED ({len(problems)})")
        return 0 if not problems else 1

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        report = audit_all(conn)
    print(json.dumps(snapshot(report), indent=2, sort_keys=True))
    return 0 if report.clean else 1


if __name__ == "__main__":
    import sys

    sys.exit(_main(sys.argv))
