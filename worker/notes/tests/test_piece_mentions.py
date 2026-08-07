import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline import MAX_PIECE_MENTIONS, normalize_piece_mentions  # noqa: E402
from prompt import (  # noqa: E402
    PIECE_MENTIONS_RULE,
    PIECE_MENTIONS_SCHEMA,
    build_system,
    piece_mentions_enabled,
    with_piece_mentions,
)

TRANSCRIPT = (
    "Speaker A: okay so let's start with the Sonatina in C major, from the top. "
    "Speaker B: (plays) "
    "Speaker A: good, now that Burgmuller etude we did last week, the Arabesque."
)


def test_verbatim_mentions_survive():
    obj = {"piece_mentions": ["the Sonatina in C major", "the Arabesque"]}
    assert normalize_piece_mentions(obj, TRANSCRIPT) == ["the Sonatina in C major", "the Arabesque"]


def test_a_fabricated_quote_is_dropped_never_repaired():
    obj = {"piece_mentions": ["Clementi Sonatina Op. 36 No. 1", "the Sonatina in C major"]}
    assert normalize_piece_mentions(obj, TRANSCRIPT) == ["the Sonatina in C major"]


def test_punctuation_and_case_do_not_count_as_fabrication():
    obj = {"piece_mentions": ["The Sonatina, in C major"]}
    assert normalize_piece_mentions(obj, TRANSCRIPT) == ["The Sonatina, in C major"]


def test_missing_or_malformed_field_is_silence_not_failure():
    assert normalize_piece_mentions({}, TRANSCRIPT) == []
    assert normalize_piece_mentions({"piece_mentions": "the Sonatina"}, TRANSCRIPT) == []
    assert normalize_piece_mentions({"piece_mentions": [None, 7, ""]}, TRANSCRIPT) == []


def test_at_most_three_and_no_duplicates():
    obj = {"piece_mentions": ["the Arabesque", "The Arabesque!", "the Sonatina in C major",
                              "from the top", "let's start"]}
    kept = normalize_piece_mentions(obj, TRANSCRIPT)
    assert len(kept) <= MAX_PIECE_MENTIONS
    assert kept[0] == "the Arabesque"
    assert "The Arabesque!" not in kept


def test_the_shipped_prompt_does_not_ask_for_the_field(monkeypatch):
    monkeypatch.delenv("NOTES_PIECE_MENTIONS", raising=False)
    assert not piece_mentions_enabled()
    for count in (32, None):
        assert "piece_mentions" not in build_system(count)


def test_the_field_appears_only_when_the_gate_is_opened(monkeypatch):
    monkeypatch.setenv("NOTES_PIECE_MENTIONS", "true")
    spec = build_system(32)
    assert "piece_mentions" in spec
    assert "at most 3" in spec
    assert "VERBATIM" in spec


def test_opening_the_gate_adds_only_the_field_and_its_rule():
    for count in (32, None):
        base = build_system(count, piece_mentions=False)
        opened = build_system(count, piece_mentions=True)
        assert opened == with_piece_mentions(base)
        lines = opened.splitlines()
        assert PIECE_MENTIONS_SCHEMA in lines
        assert PIECE_MENTIONS_RULE in lines
        stripped = "\n".join(
            ln for ln in lines if ln not in (PIECE_MENTIONS_SCHEMA, PIECE_MENTIONS_RULE)
        )
        assert stripped.replace('"target": string}],', '"target": string}]') == base
