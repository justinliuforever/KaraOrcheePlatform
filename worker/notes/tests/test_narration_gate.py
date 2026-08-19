import json

from narration import VOICES, content_hash, plan_clips
from narration_gate import audit_all, audit_note, compare, snapshot


class FakeCursor:
    def __init__(self, db):
        self.db = db
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        text = " ".join(sql.split())
        if "DISTINCT note_id" in text:
            self._rows = sorted({(n, v) for (n, v, _c) in self.db.clips})
        elif "FROM note_narration_clips" in text:
            note_id, voice = params
            self._rows = [(c, row["content_hash"], row["text_hash"])
                          for (n, v, c), row in self.db.clips.items()
                          if n == note_id and v == voice]
        elif "FROM notes WHERE id" in text:
            self._rows = [(json.dumps(self.db.content), self.db.origin, self.db.status)]
        elif "FROM note_annotations" in text:
            rows = self.db.annotations
            if "source = 'transcript'" in text:
                rows = [a for a in rows if a.get("source", "transcript") == "transcript"]
            self._rows = [(a["id"], a["instruction"], a["quote"], json.dumps(a["location"]))
                          for a in rows]
        else:
            raise AssertionError(f"unexpected sql: {text}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class FakeDB:
    def __init__(self, content, annotations, origin="teacher", status="sent"):
        self.content = content
        self.annotations = list(annotations)
        self.origin = origin
        self.status = status
        self.clips = {}

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        pass

    def record_current(self, note_id, voice):
        voice_id = VOICES[voice]
        for clip in plan_clips(self.content.get("lessonSummary"), self.annotations,
                               self.origin == "self"):
            self.clips[(note_id, voice, clip.clip_id)] = {
                "content_hash": content_hash(clip.text, voice_id),
                "text_hash": clip.text_hash,
            }


NOTE = "11111111-1111-1111-1111-111111111111"

def annotation(aid, instruction, quote="keep it even", location=None):
    return {"id": aid, "instruction": instruction, "quote": quote,
            "location": location if location is not None else {"grounded": False}}


def seeded():
    db = FakeDB(
        content={"lessonSummary": "We worked on the left hand",
                 "practicePlan": [{"focus": "Evenness", "steps": ["Slowly"], "target": "Clean"}]},
        annotations=[
            annotation("aaaaaaaa-0000-0000-0000-000000000001", "Even tone in the left hand"),
            annotation("aaaaaaaa-0000-0000-0000-000000000002", "Softer entrance"),
            annotation("aaaaaaaa-0000-0000-0000-000000000003", "Watch the rests"),
        ],
    )
    db.record_current(NOTE, "jessica")
    db.record_current(NOTE, "george")
    return db


def test_an_untouched_corpus_reports_clean():
    report = audit_all(seeded())
    assert report.clean, report.mismatches
    assert report.notes == 1
    assert report.checked == 2


def test_reordering_the_steps_is_caught_in_both_voices():
    db = seeded()
    db.annotations = [db.annotations[2], db.annotations[0], db.annotations[1]]

    report = audit_all(db)

    assert not report.clean
    voices = {m.voice for m in report.mismatches}
    assert voices == {"jessica", "george"}
    assert any("text_hash changed" in m.reason for m in report.mismatches)


def test_editing_the_summary_is_caught_on_the_overview_clip():
    db = seeded()
    db.content = {**db.content, "lessonSummary": "A different summary entirely"}

    mismatches = audit_note(db, NOTE, "jessica")

    assert [m.clip_id for m in mismatches if "text_hash changed" in m.reason] == ["overview"]


def test_a_removed_annotation_leaves_its_clip_orphaned():
    db = seeded()
    dropped = db.annotations.pop()["id"]

    mismatches = audit_note(db, NOTE, "jessica")

    assert any(m.clip_id == dropped and "no longer planned" in m.reason for m in mismatches)


def test_a_retracted_note_with_surviving_clips_is_reported():
    db = seeded()
    db.status = "retracted"

    mismatches = audit_note(db, NOTE, "jessica")

    assert [m.reason for m in mismatches] == ["note is gone or retracted but clips remain"]


def test_compare_sees_clips_that_vanished_even_with_no_mismatches():
    before = {"checked": 79, "notes": 40, "mismatches": []}
    after = {"checked": 0, "notes": 0, "mismatches": []}

    problems = compare(before, after)

    assert any("clips disappeared" in p for p in problems)
    assert any("notes lost narration" in p for p in problems)


def test_compare_is_silent_when_nothing_moved():
    snap = {"checked": 12, "notes": 6,
            "mismatches": [["n", "jessica", "overview", "note is gone or retracted but clips remain"]]}

    assert compare(snap, dict(snap)) == []


def test_compare_reports_only_the_newly_broken():
    stable = ["n1", "jessica", "overview", "note is gone or retracted but clips remain"]
    fresh = ["n2", "george", "aaa", "text_hash changed — the app will fall back to the device voice"]
    before = {"checked": 4, "notes": 2, "mismatches": [stable]}
    after = {"checked": 4, "notes": 2, "mismatches": [stable, fresh]}

    problems = compare(before, after)

    assert len(problems) == 1
    assert "n2 | george | aaa" in problems[0]


def test_snapshot_round_trips_through_compare():
    db = seeded()
    before = snapshot(audit_all(db))
    db.annotations = [db.annotations[1], db.annotations[0], db.annotations[2]]
    after = snapshot(audit_all(db))

    problems = compare(before, after)

    assert before["checked"] == after["checked"] == 2
    assert problems and all("new mismatch" in p for p in problems)


def test_a_plan_row_is_never_spoken_and_moves_no_hash():
    db = seeded()
    before = snapshot(audit_all(db))

    # What the worker will start writing: a practice-plan step living beside the
    # transcript rows in the same table.
    db.annotations.insert(1, {**annotation("bbbbbbbb-0000-0000-0000-000000000001", "Hands separate at 60"),
                              "source": "plan"})

    report = audit_all(db)

    assert report.clean, report.mismatches
    assert snapshot(report) == before, "a plan row must not renumber or re-hash a single clip"


def test_the_gate_would_still_catch_a_transcript_row_arriving():
    db = seeded()
    before = snapshot(audit_all(db))
    db.annotations.insert(1, annotation("cccccccc-0000-0000-0000-000000000001", "A real new instruction"))

    problems = compare(before, snapshot(audit_all(db)))

    assert problems, "the filter must not blind the gate to a real change"
