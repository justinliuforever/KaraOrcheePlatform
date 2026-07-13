import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline.note_evidence import (
    TERMINAL_EXEMPT_SEC, evidence_rates, note_hits, score_notes_from_events,
)
from pipeline.audio_map import _evidence_failure_message


def test_score_notes_expand_chords_to_notes():
    events = [
        {"onset_sec": 0.0, "pitches": [60, 64, 67]},
        {"onset_sec": 1.0, "pitches": [62]},
    ]
    notes = score_notes_from_events(events)
    assert notes == [(0.0, 60), (0.0, 64), (0.0, 67), (1.0, 62)]


def test_note_hits_require_matching_pitch():
    notes = [(0.0, 60), (1.0, 62), (2.0, 64)]
    mapped = np.array([0.0, 1.0, 2.0])
    by_pitch = {60: np.array([0.02]), 62: np.array([5.0]), 65: np.array([2.0])}
    hits = note_hits(notes, mapped, by_pitch, tol_sec=0.100)
    # 60: onset of its pitch nearby -> hit; 62: right pitch wrong time -> miss;
    # 64: an onset exists at the right time but of pitch 65 -> miss (the blind spot fix)
    assert hits.tolist() == [True, False, False]


def test_note_hits_tolerance_boundary():
    notes = [(0.0, 60), (1.0, 60)]
    by_pitch = {60: np.array([0.099, 1.101])}
    hits = note_hits(notes, np.array([0.0, 1.0]), by_pitch, tol_sec=0.100)
    assert hits.tolist() == [True, False]


def test_evidence_rates_catch_nonterminal_break():
    # 40s of notes at 4/s; one mid-piece 5s window fully missed
    sec = np.arange(0, 40, 0.25)
    hits = np.ones(len(sec), dtype=bool)
    hits[(sec >= 15) & (sec < 20)] = False
    rate, worst = evidence_rates(hits, sec)
    assert rate > 0.85
    assert worst == 0.0


def test_evidence_rates_terminal_window_exempt_from_kill_but_counted():
    # all perfect except the terminal region (map-endpoint artifact class)
    sec = np.arange(0, 40, 0.25)
    hits = np.ones(len(sec), dtype=bool)
    hits[sec >= 40 - TERMINAL_EXEMPT_SEC] = False
    rate, worst = evidence_rates(hits, sec)
    assert worst == 1.0            # kill-switch must not fire on the tail
    assert rate < 0.90             # but the misses still count toward the overall bar


def test_failure_message_blames_structure_only_with_duration_evidence():
    structural = _evidence_failure_message(0.60, 0.20, 0.85, ratio=1.62)
    assert "structure" in structural and "repeats" in structural
    quality = _evidence_failure_message(0.76, 0.54, 0.83, ratio=1.02)
    assert "structure" not in quality
    assert "pedal" in quality and "verified as this piece" in quality
    no_ratio = _evidence_failure_message(0.76, 0.54, 0.83, ratio=None)
    assert "structure" not in no_ratio


def test_span_duration_check_flags_crammed_pass():
    import numpy as np
    from pipeline.audio_map import _span_duration_check
    playback = {
        "counts": {"expanded_duration_sec": 20.0},
        "spans": [
            {"span_index": 0, "pass": 1, "written_start": 1, "written_end": 5,
             "expanded_sec_start": 0.0, "expanded_sec_end": 10.0},
            {"span_index": 1, "pass": 2, "written_start": 1, "written_end": 5,
             "expanded_sec_start": 10.0, "expanded_sec_end": 20.0},
        ],
    }
    # map crams the second span: 10s of score -> 1s of audio
    ms = np.array([0.0, 10.0, 20.0])
    ma = np.array([0.0, 10.0, 11.0])
    ratio, span = _span_duration_check(playback, ms, ma)
    assert span["pass"] == 2 and ratio < 0.4

    # healthy map: proportional throughout
    ratio, _ = _span_duration_check(playback, ms, np.array([0.0, 10.0, 20.0]))
    assert ratio > 0.95
