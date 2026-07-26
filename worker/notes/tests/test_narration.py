"""Narration stage: text parity with the app's read-aloud script, the content-hash
cache that keeps unchanged text free, the character ceiling, and the fail-closed paths.

Every synthesizer here is a fake. conftest blocks outbound sockets and the real client
refuses to construct under pytest, so no test can spend a character of the account.
"""
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import narration  # noqa: E402
from narration import Clip  # noqa: E402

GOLDEN = json.loads((Path(__file__).resolve().parents[1] / "narration_parity.json").read_text())

NOTE = "note-1"
JESSICA = narration.VOICES["jessica"]
GEORGE = narration.VOICES["george"]


# ── fakes ────────────────────────────────────────────────────────────────────────

class FakeSynth:
    """Records what it was asked to say. `fail_on` matches on the clip text. Meters at a
    rate deliberately far from 1:1 — a fake that billed one credit per character would
    let a credits-are-characters regression pass every assertion in this file."""

    RATE = 0.55

    def __init__(self, fail_on=(), meterless=False):
        self.calls = []
        self.fail_on = set(fail_on)
        self.meterless = meterless

    def synth(self, text, voice_id):
        self.calls.append((voice_id, text))
        if text in self.fail_on:
            raise RuntimeError("vendor 500")
        audio = b"mp3:" + hashlib.sha256(text.encode()).digest()[:8]
        return narration.Synthesized(audio, None if self.meterless else self.billed(text))

    @classmethod
    def billed(cls, text):
        return round(len(text) * cls.RATE)

    @property
    def chars(self):
        return sum(len(t) for _, t in self.calls)

    @property
    def credits(self):
        return sum(self.billed(t) for _, t in self.calls if t not in self.fail_on)


class Settings:
    def __init__(self, content_type=None):
        self.content_type = content_type


class FakeBlobClient:
    def __init__(self, container, path):
        self.container = container
        self.path = path

    def upload_blob(self, data, overwrite=False, content_settings=None, metadata=None):
        self.container.blobs[self.path] = data
        self.container.settings[self.path] = content_settings
        self.container.metadata[self.path] = metadata


class FakeContainer:
    def __init__(self):
        self.blobs = {}
        self.settings = {}
        self.metadata = {}

    def get_blob_client(self, path):
        return FakeBlobClient(self, path)


class FakeBlob:
    def __init__(self):
        self.container = FakeContainer()
        self.containers = []

    def get_container_client(self, name):
        self.containers.append(name)
        return self.container


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
        self.db.executed.append(text)
        if "FROM platform_config" in text:
            self._rows = [(self.db.config,)] if self.db.config is not None else []
        elif "FROM notes WHERE id" in text:
            self._rows = [self.db.note] if self.db.note else []
        elif "FROM note_annotations" in text:
            self._rows = [(a["id"], a["instruction"], a["quote"], a["location"])
                          for a in self.db.annotations]
        elif "FROM note_narration_clips" in text:
            note_id, voice = params
            self._rows = [(k[2], v["content_hash"]) for k, v in self.db.clips.items()
                          if k[0] == note_id and k[1] == voice]
        elif "INSERT INTO note_narration_clips" in text:
            (note_id, annotation_id, voice, clip_id, kind, path,
             chash, thash, chars, credits, size, model) = params
            self.db.clips[(note_id, voice, clip_id)] = {
                "annotation_id": annotation_id, "kind": kind, "blob_path": path,
                "content_hash": chash, "text_hash": thash, "chars": chars,
                "credits": credits, "bytes": size, "model": model}
            self._rows = []
        else:
            raise AssertionError(f"unexpected sql: {text}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class FakeDB:
    def __init__(self, config=None, note=None, annotations=(), clips=None):
        self.config = config
        self.note = note
        self.annotations = list(annotations)
        self.clips = clips or {}
        self.executed = []
        self.commits = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1


def annotation(aid, instruction="Even tone in the left hand",
               quote="keep the left hand even", location=None):
    return {"id": aid, "instruction": instruction, "quote": quote,
            "location": location if location is not None else {"grounded": False}}


def db(summary="We worked on the left hand", origin="teacher", status="sent",
       annotations=None, config=None, clips=None):
    anns = annotations if annotations is not None else [annotation("a1"), annotation("a2")]
    return FakeDB(config=config,
                  note=({"lessonSummary": summary}, origin, status),
                  annotations=anns, clips=clips)


@pytest.fixture
def blob(monkeypatch):
    import azure.storage.blob as azblob
    monkeypatch.setattr(azblob, "ContentSettings", Settings, raising=False)
    return FakeBlob()


# ── text parity with NoteReadAloudScript.swift ───────────────────────────────────

@pytest.mark.parametrize("case", GOLDEN["overview"], ids=lambda c: c["case"])
def test_overview_matches_the_app_script(case):
    assert narration.overview_lines(case["summary"], case["stepCount"]) == case["lines"]


@pytest.mark.parametrize("case", GOLDEN["step"], ids=lambda c: c["case"])
def test_step_matches_the_app_script(case):
    lines = narration.step_lines(case["annotation"], case["number"], case["isSelfOrigin"])
    assert lines == case["lines"]


@pytest.mark.parametrize("case", GOLDEN["overview"] + GOLDEN["step"], ids=lambda c: c["case"])
def test_canonical_join_matches_the_golden(case):
    assert narration.canonical(case["lines"]) == case["canonical"]


@pytest.mark.parametrize("case", GOLDEN["overview"] + GOLDEN["step"], ids=lambda c: c["case"])
def test_text_hash_matches_the_golden(case):
    """The cross-repo alarm. The app recomputes this from its own read-aloud script and
    plays nothing it cannot reproduce, so a hash that moves here without moving there
    ends premium narration silently — no error, no log, just the device voice forever."""
    assert narration.text_hash(case["lines"]) == case["textHash"]


@pytest.mark.parametrize("case", GOLDEN["spoken"], ids=lambda c: c["in"])
def test_glyphs_become_words_exactly_as_the_app_does(case):
    assert narration.spoken(case["in"]) == case["out"]


def test_the_response_sample_carries_hashes_this_worker_would_produce():
    """The sample the app decodes byte-for-byte and the API asserts its shape against is
    not free-standing: its clips are this worker's output for the golden's first cases."""
    clips = GOLDEN["wire"]["response"]["clips"]
    assert clips[0]["textHash"] == narration.text_hash(GOLDEN["overview"][0]["lines"])
    assert clips[1]["textHash"] == narration.text_hash(GOLDEN["step"][0]["lines"])
    assert [c["clipId"] for c in clips][0] == GOLDEN["wire"]["overviewClipId"]
    assert list(narration.VOICES) == GOLDEN["wire"]["voices"]


def test_the_blob_path_is_the_one_the_api_signs():
    note = GOLDEN["wire"]["response"]["noteId"]
    clip = GOLDEN["wire"]["response"]["clips"][1]
    assert narration.blob_path(note, "jessica", clip["clipId"]) in clip["url"]


def test_the_engraving_index_is_never_spoken():
    """The shipped Liszt prints 92 where the index is 93; only the printed number is
    stored, so the clip must read the number the student sees."""
    lines = narration.step_lines(
        annotation("a1", location={"grounded": True, "measureStart": 92, "measureEnd": 94}),
        1, False)
    assert "Bars 92 to 94." in lines


def test_a_step_number_is_its_page_position_not_its_annotation_id():
    clips = narration.plan_clips("S", [annotation("zz"), annotation("aa")], False)
    assert [c.clip_id for c in clips] == ["overview", "zz", "aa"]
    assert clips[1].text.startswith("Step 1.")
    assert clips[2].text.startswith("Step 2.")


def test_a_self_note_is_never_attributed_to_a_teacher():
    clips = narration.plan_clips("S", [annotation("a1")], True)
    assert all("teacher" not in c.text.lower() for c in clips)


def test_a_step_with_nothing_to_say_gets_no_clip():
    clips = narration.plan_clips("S", [annotation("a1", instruction="  ", quote=None)], False)
    assert [c.clip_id for c in clips] == ["overview"]


def test_a_bare_note_produces_no_clips_at_all():
    assert narration.plan_clips(None, [], False) == []


# ── hashing and the cache ────────────────────────────────────────────────────────

def test_content_hash_is_stable_for_the_same_text_and_voice():
    assert narration.content_hash("Step 1.", JESSICA) == narration.content_hash("Step 1.", JESSICA)


def test_content_hash_separates_voice_text_settings_and_format(monkeypatch):
    base = narration.content_hash("Step 1.", JESSICA)
    assert narration.content_hash("Step 1.", GEORGE) != base
    assert narration.content_hash("Step 2.", JESSICA) != base
    monkeypatch.setattr(narration, "OUTPUT_FORMAT", "mp3_44100_128")
    assert narration.content_hash("Step 1.", JESSICA) != base, \
        "a clip at another bitrate is another artifact"
    monkeypatch.setattr(narration, "SETTINGS", {**narration.SETTINGS, "speed": 1.0})
    assert narration.content_hash("Step 1.", JESSICA) != base


def test_the_vendor_bytes_are_stored_unmodified():
    """One lossy encode, not two: the vendor returns the bitrate we asked for and the
    worker uploads exactly those bytes, so there is no transcoder to install or to drift."""
    assert narration.OUTPUT_FORMAT == "mp3_44100_64"
    assert narration.CLIP_EXT == ".mp3"
    assert not hasattr(narration, "to_m4a")


def test_text_hash_ignores_the_voice_so_the_app_can_check_parity():
    assert narration.text_hash(["Step 1."]) == narration.text_hash(["Step 1."])
    assert narration.content_hash("Step 1.", JESSICA) != narration.text_hash(["Step 1."])


def test_text_hash_is_full_lowercase_hex_sha256_of_the_newline_join():
    """Stored whole, never truncated: the app compares the FULL digest, and a 16-char
    prefix can never equal it — every clip would read as stale and nothing would say so."""
    lines = ["Step 1.", "Bars 92 to 94."]
    h = narration.text_hash(lines)
    assert h == hashlib.sha256("\n".join(lines).encode()).hexdigest()
    assert len(h) == 64 and h == h.lower()
    assert all(c in "0123456789abcdef" for c in h)


def test_text_hash_is_taken_over_the_spoken_form_not_the_raw_text():
    assert narration.text_hash(["Play D → F♯."]) == narration.text_hash([narration.spoken("Play D → F♯.")])
    assert narration.text_hash(["a", "", "b"]) == narration.text_hash(["a", "b"])


def test_text_hash_separates_the_lines_so_a_rejoin_cannot_collide():
    assert narration.text_hash(["Step 1.", "Bar 12."]) != narration.text_hash(["Step 1. Bar 12."])


def test_unchanged_text_is_never_resynthesized(blob):
    conn = db()
    first = FakeSynth()
    narration.narrate(conn, blob, NOTE, ["jessica", "george"], synth=first)
    assert len(first.calls) == 6

    second = FakeSynth()
    result = narration.narrate(conn, blob, NOTE, ["jessica", "george"], synth=second)
    assert second.calls == []
    assert result == {"status": "cached", "clips": 3, "chars": 0, "credits": 0}


def test_only_the_changed_clip_is_paid_for_again(blob):
    conn = db()
    narration.narrate(conn, blob, NOTE, ["jessica"], synth=FakeSynth())
    conn.annotations[1]["instruction"] = "Lighter wrist on the return"

    again = FakeSynth()
    result = narration.narrate(conn, blob, NOTE, ["jessica"], synth=again)
    assert [t for _, t in again.calls] == [
        narration.canonical(narration.step_lines(conn.annotations[1], 2, False))]
    assert result["made"] == 1


def test_a_new_voice_reuses_nothing_and_costs_its_own_clips(blob):
    conn = db()
    narration.narrate(conn, blob, NOTE, ["jessica"], synth=FakeSynth())
    george = FakeSynth()
    narration.narrate(conn, blob, NOTE, ["george"], synth=george)
    assert len(george.calls) == 3
    assert all(v == GEORGE for v, _ in george.calls)


def test_clips_land_on_the_contract_path_with_an_audio_content_type(blob):
    conn = db(annotations=[annotation("a1")])
    narration.narrate(conn, blob, NOTE, ["jessica"], synth=FakeSynth())
    assert blob.containers == ["notes-assets"]
    assert sorted(blob.container.blobs) == [
        f"narration/{NOTE}/jessica/a1.mp3", f"narration/{NOTE}/jessica/overview.mp3"]
    assert blob.container.settings[f"narration/{NOTE}/jessica/a1.mp3"].content_type == "audio/mpeg"


def test_the_manifest_row_links_the_clip_to_its_annotation(blob):
    conn = db(annotations=[annotation("a1")])
    narration.narrate(conn, blob, NOTE, ["jessica"], synth=FakeSynth())
    step = conn.clips[(NOTE, "jessica", "a1")]
    overview = conn.clips[(NOTE, "jessica", "overview")]
    assert step["annotation_id"] == "a1" and step["kind"] == "step"
    assert overview["annotation_id"] is None and overview["kind"] == "overview"
    assert step["model"] == narration.MODEL
    assert step["text_hash"] == narration.text_hash(
        narration.step_lines(conn.annotations[0], 1, False))
    assert len(step["text_hash"]) == 64


def test_the_blob_carries_the_same_hashes_as_its_manifest_row(blob):
    conn = db(annotations=[annotation("a1")])
    narration.narrate(conn, blob, NOTE, ["jessica"], synth=FakeSynth())
    row = conn.clips[(NOTE, "jessica", "a1")]
    meta = blob.container.metadata[f"narration/{NOTE}/jessica/a1.mp3"]
    assert meta["texthash"] == row["text_hash"]
    assert meta["contenthash"] == row["content_hash"]
    assert meta["clipid"] == "a1" and meta["voice"] == "jessica"


# ── the character ceiling ────────────────────────────────────────────────────────

def test_a_runaway_note_spends_nothing_at_all(blob):
    conn = db(annotations=[annotation("a1", instruction="x" * 20000)])
    synth = FakeSynth()
    result = narration.narrate(conn, blob, NOTE, ["jessica"], synth=synth, max_chars=8000)
    assert synth.calls == []
    assert blob.container.blobs == {}
    assert conn.clips == {}
    assert result["status"] == "over_budget"


def test_the_ceiling_counts_every_voice_in_the_run(blob):
    conn = db()
    one = narration.plan_clips("We worked on the left hand", conn.annotations, False)
    script = sum(c.chars for c in one)

    both = FakeSynth()
    assert narration.narrate(conn, blob, NOTE, ["jessica", "george"],
                             synth=both, max_chars=script + 1)["status"] == "over_budget"
    assert both.calls == []

    solo = FakeSynth()
    assert narration.narrate(conn, blob, NOTE, ["jessica"],
                             synth=solo, max_chars=script + 1)["status"] == "ok"
    assert solo.chars == script


def test_cached_clips_do_not_count_against_the_ceiling(blob):
    conn = db()
    clips = narration.plan_clips("We worked on the left hand", conn.annotations, False)
    script = sum(c.chars for c in clips)
    narration.narrate(conn, blob, NOTE, ["jessica"], synth=FakeSynth(), max_chars=script)

    conn.annotations.append(annotation("a3", instruction="New one"))
    grown = FakeSynth()
    result = narration.narrate(conn, blob, NOTE, ["jessica"], synth=grown, max_chars=script)
    assert result["status"] == "ok"
    assert grown.chars <= script


def test_the_ceiling_is_read_from_config_not_hardcoded(blob, monkeypatch):
    conn = db(config={"enabled": True, "voices": ["jessica"], "maxCharsPerNote": 1})
    monkeypatch.setattr(narration, "build_synthesizer", lambda: FakeSynth())
    assert narration.narration_stage(conn, blob, NOTE)["status"] == "over_budget"


def test_the_ceiling_gates_on_characters_sent_not_on_credits(blob):
    conn = db()
    clips = narration.plan_clips("We worked on the left hand", conn.annotations, False)
    script = sum(c.chars for c in clips)
    would_bill = sum(FakeSynth.billed(c.text) for c in clips)
    assert would_bill < script  # otherwise this test proves nothing

    synth = FakeSynth()
    result = narration.narrate(conn, blob, NOTE, ["jessica"], synth=synth,
                               max_chars=script - 1)
    assert result["status"] == "over_budget"
    assert result["chars"] == script
    assert synth.calls == []


# ── what the vendor actually bills ───────────────────────────────────────────────

@pytest.mark.parametrize("value,expected", [
    ("239", 239), (239, 239), ("238.6", 239), ("0", 0),
    (None, None), ("", None), ("not-a-number", None),
])
def test_the_cost_header_is_read_or_left_unknown(value, expected):
    headers = {} if value is None else {narration.COST_HEADER: value}
    assert narration.vendor_credits(headers) == expected


def test_a_missing_header_object_is_unknown_not_zero():
    assert narration.vendor_credits(None) is None


def test_the_ledger_records_what_the_vendor_billed_not_what_we_sent(blob):
    conn = db()
    synth = FakeSynth()
    result = narration.narrate(conn, blob, NOTE, ["jessica", "george"], synth=synth)

    assert result["credits"] == synth.credits
    assert result["unmetered"] == 0
    assert result["chars"] == synth.chars
    assert result["credits"] != result["chars"]

    billed = {t: FakeSynth.billed(t) for _, t in synth.calls}
    for row in conn.clips.values():
        assert row["credits"] in billed.values()
        assert row["credits"] != row["chars"]
    assert sum(r["credits"] for r in conn.clips.values()) == synth.credits


def test_an_unreadable_meter_is_unknown_rather_than_a_made_up_charge(blob):
    conn = db()
    synth = FakeSynth(meterless=True)
    result = narration.narrate(conn, blob, NOTE, ["jessica"], synth=synth)

    assert result["made"] == 3 and result["unmetered"] == 3
    assert result["credits"] == 0
    assert all(row["credits"] is None for row in conn.clips.values())


# ── fail closed ──────────────────────────────────────────────────────────────────

def test_one_failing_clip_does_not_stop_the_others(blob):
    conn = db()
    doomed = narration.canonical(narration.step_lines(conn.annotations[0], 1, False))
    synth = FakeSynth(fail_on=[doomed])
    result = narration.narrate(conn, blob, NOTE, ["jessica"], synth=synth)
    assert result == {"status": "partial", "clips": 3, "made": 2, "failed": 1,
                      "chars": result["chars"], "credits": synth.credits,
                      "unmetered": 0}
    assert (NOTE, "jessica", "a1") not in conn.clips
    assert (NOTE, "jessica", "a2") in conn.clips


def test_a_clip_that_failed_is_retried_on_the_next_run(blob):
    conn = db()
    doomed = narration.canonical(narration.step_lines(conn.annotations[0], 1, False))
    narration.narrate(conn, blob, NOTE, ["jessica"], synth=FakeSynth(fail_on=[doomed]))
    retry = FakeSynth()
    narration.narrate(conn, blob, NOTE, ["jessica"], synth=retry)
    assert [t for _, t in retry.calls] == [doomed]


def test_the_stage_swallows_everything_so_the_note_still_ships(blob, monkeypatch):
    conn = db(config={"enabled": True})
    monkeypatch.setattr(narration, "narrate",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("vendor down")))
    assert narration.narration_stage(conn, blob, NOTE) is None


def test_a_missing_key_disables_the_stage_instead_of_crashing(blob, monkeypatch):
    monkeypatch.delenv(narration.KEY_ENV, raising=False)
    assert narration.build_synthesizer() is None
    conn = db()
    assert narration.narrate(conn, blob, NOTE, ["jessica"])["status"] == "unconfigured"


def test_a_retracted_note_is_never_narrated(blob):
    conn = db(status="retracted")
    synth = FakeSynth()
    assert narration.narrate(conn, blob, NOTE, ["jessica"], synth=synth)["status"] == "not_narratable"
    assert synth.calls == []


def test_a_missing_note_is_not_an_error(blob):
    conn = FakeDB(note=None)
    assert narration.narrate(conn, blob, NOTE, ["jessica"],
                             synth=FakeSynth())["status"] == "not_narratable"


def test_the_deadline_stops_a_slow_run_without_losing_what_it_paid_for(blob, monkeypatch):
    conn = db()
    clock = iter([0, 0, 999])  # stop_at, first clip, then past the deadline
    monkeypatch.setattr(narration.time, "time", lambda: next(clock))
    synth = FakeSynth()
    result = narration.narrate(conn, blob, NOTE, ["jessica"], synth=synth, deadline_sec=10)
    assert result["made"] == 1
    assert len(conn.clips) == 1


def test_an_unknown_voice_is_never_synthesized(blob):
    conn = db()
    synth = FakeSynth()
    assert narration.narrate(conn, blob, NOTE, ["morgan"], synth=synth)["status"] == "no_voices"
    assert synth.calls == []


# ── the config switch ────────────────────────────────────────────────────────────

def test_no_config_row_means_the_stage_is_off(blob):
    conn = db(config=None)
    assert narration.narration_stage(conn, blob, NOTE) is None
    assert not any("note_narration_clips" in s for s in conn.executed)


def test_enabled_defaults_to_eager_with_both_voices():
    cfg = narration.parse_config({"enabled": True})
    assert cfg.enabled and cfg.mode == "eager"
    assert cfg.voices == ("jessica", "george")
    assert cfg.max_chars == narration.DEFAULT_MAX_CHARS


def test_on_demand_mode_narrates_nothing_eagerly(blob, monkeypatch):
    conn = db(config={"enabled": True, "mode": "on_demand"})
    monkeypatch.setattr(narration, "build_synthesizer", lambda: FakeSynth())
    assert narration.narration_stage(conn, blob, NOTE) == {"status": "on_demand"}
    assert conn.clips == {}


def test_on_demand_narrates_exactly_the_voices_asked_for(blob, monkeypatch):
    conn = db(config={"enabled": True, "mode": "on_demand"}, annotations=[annotation("a1")])
    synth = FakeSynth()
    monkeypatch.setattr(narration, "build_synthesizer", lambda: synth)
    narration.narrate_on_demand(conn, blob, NOTE, ["george"])
    assert {v for v, _ in synth.calls} == {GEORGE}
    assert set(conn.clips) == {(NOTE, "george", "overview"), (NOTE, "george", "a1")}


def test_on_demand_after_an_eager_run_re_pays_for_nothing(blob, monkeypatch):
    conn = db(config={"enabled": True}, annotations=[annotation("a1")])
    eager = FakeSynth()
    monkeypatch.setattr(narration, "build_synthesizer", lambda: eager)
    narration.narration_stage(conn, blob, NOTE)

    resend = FakeSynth()
    monkeypatch.setattr(narration, "build_synthesizer", lambda: resend)
    result = narration.narrate_on_demand(conn, blob, NOTE, ["jessica", "george"])
    assert resend.calls == []
    assert result["status"] == "cached"


def test_on_demand_is_still_gated_by_the_switch(blob, monkeypatch):
    conn = db(config=None)
    monkeypatch.setattr(narration, "build_synthesizer", lambda: FakeSynth())
    assert narration.narrate_on_demand(conn, blob, NOTE, "george") is None


def test_config_is_off_unless_enabled_is_literally_true():
    for value in (None, {}, {"enabled": False}, {"enabled": "yes"}, "on", 1, []):
        assert narration.parse_config(value).enabled is False, value


def test_an_unknown_voice_name_is_dropped_never_guessed():
    assert narration.parse_config({"enabled": True, "voices": ["morgan"]}).enabled is False
    cfg = narration.parse_config({"enabled": True, "voices": ["george", "morgan"]})
    assert cfg.voices == ("george",)


def test_a_nonsense_ceiling_falls_back_to_the_default():
    for bad in (0, -1, "lots", None):
        assert narration.parse_config(
            {"enabled": True, "maxCharsPerNote": bad}).max_chars == narration.DEFAULT_MAX_CHARS


def test_config_is_read_from_platform_config():
    conn = FakeDB(config={"enabled": True, "mode": "on_demand"})
    assert narration.load_config(conn).mode == "on_demand"
    assert any("FROM platform_config" in s for s in conn.executed)


# ── retry policy ─────────────────────────────────────────────────────────────────

class Resp:
    def __init__(self, status, content=b"mp3"):
        self.status_code = status
        self.content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise narration.requests.HTTPError(f"status {self.status_code}")


def test_a_transient_failure_is_retried():
    responses = iter([Resp(503), Resp(429), Resp(200, b"audio")])
    got = narration.post_with_retry(lambda: next(responses), sleep=lambda *_: None)
    assert got.content == b"audio"


def test_a_client_error_is_not_retried():
    calls = {"n": 0}

    def send():
        calls["n"] += 1
        return Resp(401)

    with pytest.raises(narration.requests.HTTPError):
        narration.post_with_retry(send, sleep=lambda *_: None)
    assert calls["n"] == 1


def test_retries_give_up_rather_than_hammer():
    calls = {"n": 0}

    def send():
        calls["n"] += 1
        return Resp(500)

    with pytest.raises(RuntimeError):
        narration.post_with_retry(send, attempts=3, sleep=lambda *_: None)
    assert calls["n"] == 3


def test_only_unbilled_statuses_are_transient():
    assert narration.transient(429) and narration.transient(500) and narration.transient(503)
    assert not narration.transient(200)
    assert not any(narration.transient(s) for s in (400, 401, 403, 404, 422))


# ── nothing here can reach the vendor ────────────────────────────────────────────

def test_the_real_synthesizer_refuses_to_exist_under_pytest():
    with pytest.raises(RuntimeError, match="not reachable from a test"):
        narration.ElevenLabsSynthesizer("would-be-key")


def test_build_synthesizer_refuses_even_when_a_key_is_present(monkeypatch):
    monkeypatch.setenv(narration.KEY_ENV, "would-be-key")
    with pytest.raises(RuntimeError, match="not reachable from a test"):
        narration.build_synthesizer()


def test_outbound_http_is_blocked_for_every_test():
    with pytest.raises(Exception, match="blocked"):
        narration.requests.post("https://api.elevenlabs.io/v1/text-to-speech/x")


def test_a_full_eager_run_stays_inside_the_fake(blob, monkeypatch):
    conn = db(config={"enabled": True})
    synth = FakeSynth()
    monkeypatch.setattr(narration, "build_synthesizer", lambda: synth)
    result = narration.narration_stage(conn, blob, NOTE)
    assert result["status"] == "ok" and result["made"] == 6
    assert len(conn.clips) == 6
    assert result["chars"] == synth.chars


def test_clip_is_hashable_and_carries_its_own_length():
    clip = Clip("overview", None, "overview", ("Step 1.",))
    assert clip.chars == 7
    assert clip.text == "Step 1."
    assert clip.text_hash == narration.text_hash(["Step 1."])
    assert {clip}


# ── pipeline wiring: narration is downstream of delivery ─────────────────────────

import main  # noqa: E402

JOB_ROW = ("job-9", "queued", 0, "lesson-1", "teacher-7", "student-4", "piece-1",
           "Etude No. 3", "audio/x.m4a", 300, "teacher", "Etude", "Czerny", None)


class JobCursor:
    def __init__(self, conn):
        self.conn = conn
        self.rowcount = 1

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        text = " ".join(sql.split())
        self.conn.executed.append((text, params))
        self.conn.pending = None
        for fragment, row in self.conn.rows.items():
            if fragment in text:
                self.conn.pending = row
                break

    def fetchone(self):
        return self.conn.pending

    def fetchall(self):
        return []


class JobConn:
    def __init__(self):
        self.rows = {
            "FROM note_jobs j": JOB_ROW,
            "SELECT status FROM lesson_sessions": ("submitted",),
            "FOR UPDATE OF l": ("submitted", "teacher-7", "student-4", "piece-1",
                                "Etude No. 3", "teacher", 3, None),
            "INSERT INTO notes": ("note-9",),
        }
        self.executed = []
        self.pending = None

    def cursor(self):
        return JobCursor(self)

    def commit(self):
        pass


def _job_updates(conn):
    return [(s, p) for s, p in conn.executed if s.startswith("UPDATE note_jobs")]


def _cols(sql):
    return [seg.split(" = ")[0].strip()
            for seg in sql.split(" SET ")[1].split(" WHERE ")[0].split(",")]


def _metrics_of(sql, params):
    cols = _cols(sql)
    return json.loads(params[cols.index("metrics")]) if "metrics" in cols else None


@pytest.fixture
def delivered(monkeypatch):
    monkeypatch.setattr(main, "env", lambda n: "test-key")
    monkeypatch.setattr(main, "audio_read_url", lambda cs, p: "https://audio?sas")
    monkeypatch.setattr(main, "run_asr", lambda url, key: {
        "text": "plenty of lesson talk", "utterances": [],
        "language_code": "en", "audio_duration": 300})
    monkeypatch.setattr(main, "check_transcript", lambda text, utt: {"transcript_words": 100})
    monkeypatch.setattr(main, "ContentSettings", lambda **k: None)
    monkeypatch.setattr(main, "generate", lambda s, u: type(
        "R", (), {"text": "x", "model": "m", "in_tok": 1, "out_tok": 2})())
    monkeypatch.setattr(main, "extract_json", lambda t: {"lesson_summary": "s"})
    monkeypatch.setattr(main, "normalize_note", lambda obj, text, mc: (
        {"lessonSummary": "s"},
        [{"category": "technique", "instruction": "i", "quote": "q",
          "location": {"grounded": False}}],
        []))
    return JobConn()


def test_narration_runs_only_after_the_job_is_ready_for_review(delivered, blob, monkeypatch):
    at_call = {}

    def stage(conn, _blob, note_id, req_id=None):
        at_call["note"] = note_id
        at_call["updates"] = list(_job_updates(delivered))
        return None

    monkeypatch.setattr(main, "narration_stage", stage)
    main.process(delivered, blob, "cs", "job-9")

    sql, params = at_call["updates"][-1]
    assert at_call["note"] == "note-9"
    assert params[_cols(sql).index("status")] == "ready_for_review"
    assert _job_updates(delivered) == at_call["updates"]


def test_a_narration_result_is_recorded_in_job_metrics(delivered, blob, monkeypatch):
    monkeypatch.setattr(main, "narration_stage",
                        lambda *a, **k: {"status": "ok", "made": 4, "chars": 1200})
    main.process(delivered, blob, "cs", "job-9")

    final_sql, final_params = _job_updates(delivered)[-1]
    assert _metrics_of(final_sql, final_params)["narration"] == {
        "status": "ok", "made": 4, "chars": 1200}


def test_narration_collapsing_still_leaves_the_note_delivered(delivered, blob, monkeypatch):
    monkeypatch.setattr(main, "narration_stage", lambda *a, **k: None)
    main.process(delivered, blob, "cs", "job-9")

    sql, params = _job_updates(delivered)[-1]
    assert params[_cols(sql).index("status")] == "ready_for_review"
    assert "narration" not in _metrics_of(sql, params)


def test_the_narration_lane_is_its_own_queue():
    """A synthesis run is minutes long; on notes-jobs it would sit in front of an ASR
    job and hold its lock. The golden names the queue for the API side too."""
    assert main.NARRATION_QUEUE == GOLDEN["wire"]["queue"]
    assert main.NARRATION_QUEUE != main.QUEUE


def test_the_api_message_shape_is_understood():
    message = GOLDEN["wire"]["message"]
    assert narration.targets_from_message(message) == (message["noteId"], message["voices"])


@pytest.mark.parametrize("body", [
    {"noteId": "note-9"},
    {"noteId": "note-9", "voice": "george"},
    {"noteId": "note-9", "voices": []},
    {"noteId": "note-9", "voices": "george"},
    {"voices": ["george"]},
    {},
])
def test_a_body_that_is_not_the_one_shape_is_refused_rather_than_guessed(body):
    """A guessed voice list is a paid vendor run nobody asked for; raising here abandons
    the message, and the DLQ alert says the contract broke."""
    with pytest.raises(ValueError):
        narration.targets_from_message(body)
