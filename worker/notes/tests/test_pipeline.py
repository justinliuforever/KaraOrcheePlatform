import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline import (GateFail, build_turns, check_transcript, extract_json,
                      normalize_note, quote_in_transcript)

TRANSCRIPT = ("Let's look at bar three. The left hand D to F sharp leap needs to be "
              "prepared in advance. Circle those two bars where the change happens. "
              "Play it slowly five times with a relaxed wrist. " * 3)


def make_obj(**over):
    obj = {
        "lesson_summary": "Great work today. Focus on the bar three leap this week.",
        "annotations": [
            {"instruction": "Prepare the left-hand D to F sharp leap in advance.",
             "quote": "The left hand D to F sharp leap needs to be prepared in advance",
             "category": "technique",
             "location": {"raw": "bar three", "type": "absolute", "measure_start": 3,
                          "measure_end": 3, "needs_grounding": False, "grounding_hint": ""},
             "confidence": "high"},
            {"instruction": "Circle the two bars where the change happens.",
             "quote": "Circle those two bars where the change happens",
             "category": "practice_strategy",
             "location": {"raw": "those two bars", "type": "deixis", "measure_start": None,
                          "measure_end": None, "needs_grounding": True,
                          "grounding_hint": "the spot discussed after bar 3"},
             "confidence": "medium"},
        ],
        "practice_plan": [
            {"focus": "Bar 3 leap", "steps": ["Slow, 5 clean reps", "Relaxed wrist"],
             "target": "Clean leap at tempo", "est_minutes": 10},
        ],
    }
    obj.update(over)
    return obj


def test_build_turns_labels_speakers():
    turns = build_turns([{"speaker": "A", "text": "Play bar three."},
                         {"speaker": "B", "text": "Okay."},
                         {"speaker": "A", "text": ""}])
    assert turns == "Speaker A: Play bar three.\nSpeaker B: Okay."


def test_check_transcript_rejects_near_silence():
    with pytest.raises(GateFail):
        check_transcript("too short", [])


def test_check_transcript_metrics():
    m = check_transcript(TRANSCRIPT, [{"speaker": "A"}, {"speaker": "B"}])
    assert m["speakers"] == 2
    assert m["transcript_words"] > 50


def test_extract_json_fenced_and_bare():
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('{"a": 1}') == {"a": 1}
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_quote_matching_normalizes_punctuation_and_case():
    assert quote_in_transcript("the left hand D to F-sharp leap", TRANSCRIPT)
    assert not quote_in_transcript("use a metronome every day", TRANSCRIPT)


def test_normalize_grounds_absolute_and_flags_deixis():
    content, annotations, warnings, drops = normalize_note(make_obj(), TRANSCRIPT, 32)
    assert content["lessonSummary"].startswith("Great work")
    assert len(annotations) == 2
    absolute, deixis = annotations
    assert absolute["location"]["grounded"] is True
    assert absolute["location"]["measureStart"] == 3
    assert absolute["location"]["pinnedBy"] == "auto"
    assert deixis["location"]["grounded"] is False
    assert deixis["location"]["type"] == "deixis"
    assert warnings == []


def test_normalize_strips_est_minutes():
    content, _, _, _ = normalize_note(make_obj(), TRANSCRIPT, 32)
    assert "est_minutes" not in content["practicePlan"][0]
    assert content["practicePlan"][0]["steps"] == ["Slow, 5 clean reps", "Relaxed wrist"]


def test_measure_beyond_piece_demotes_not_fails():
    obj = make_obj()
    obj["annotations"][0]["location"].update({"measure_start": 40, "measure_end": 40})
    _, annotations, warnings, _ = normalize_note(obj, TRANSCRIPT, 32)
    assert annotations[0]["location"]["grounded"] is False
    assert any("measure_out_of_range" in w for w in warnings)


def test_no_measure_count_grounds_any_positive_measure():
    obj = make_obj()
    obj["annotations"][0]["location"].update({"measure_start": 40, "measure_end": 41})
    _, annotations, _, _ = normalize_note(obj, TRANSCRIPT, None)
    assert annotations[0]["location"]["grounded"] is True
    assert annotations[0]["location"]["measureEnd"] == 41


def test_invented_quote_dropped_structurally():
    obj = make_obj()
    obj["annotations"][0]["quote"] = "practice with a metronome daily"
    with pytest.raises(GateFail):
        normalize_note(obj, TRANSCRIPT, 32)


def test_annotation_floor_message_is_actionable():
    obj = make_obj(annotations=[])
    with pytest.raises(GateFail) as exc:
        normalize_note(obj, TRANSCRIPT, 32)
    assert exc.value.hints


def test_shape_errors_raise_valueerror_for_repair_pass():
    with pytest.raises(ValueError):
        normalize_note({"annotations": []}, TRANSCRIPT, 32)
    with pytest.raises(ValueError):
        normalize_note(make_obj(practice_plan="nope"), TRANSCRIPT, 32)


def test_unknown_category_and_type_fall_back():
    obj = make_obj()
    obj["annotations"][1]["category"] = "wizardry"
    obj["annotations"][1]["location"]["type"] = "telepathic"
    _, annotations, _, _ = normalize_note(obj, TRANSCRIPT, 32)
    assert annotations[1]["category"] == "other"
    assert annotations[1]["location"]["type"] == "none"
