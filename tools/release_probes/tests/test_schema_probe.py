import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from schema import (EXPECTED_COLUMNS, check_columns, check_typed_create,  # noqa: E402
                    render)


def _all_columns():
    return {pair for pairs in EXPECTED_COLUMNS.values() for pair in pairs}


def test_a_complete_schema_holds_every_assertion():
    text, ok = render(check_columns(_all_columns()))
    assert ok, text


def test_a_missing_column_fails_and_names_itself():
    live = _all_columns() - {("note_jobs", "piece_mentions")}
    text, ok = render(check_columns(live))
    assert not ok
    assert "FAIL 0025 note_jobs.piece_mentions" in text


def test_an_image_without_0024_fails_even_though_0025_landed():
    live = _all_columns() - {("lesson_sessions", "piece_source")}
    text, ok = render(check_columns(live))
    assert not ok
    assert "FAIL 0024 lesson_sessions.piece_source" in text


def test_an_image_without_0027_fails_even_though_the_rest_landed():
    live = _all_columns() - {("users", "ciam_oid_at_delete")}
    text, ok = render(check_columns(live))
    assert not ok
    assert "FAIL 0027 users.ciam_oid_at_delete" in text


def test_an_image_without_0026_fails_even_though_the_rest_landed():
    live = _all_columns() - {("users", "age_bracket")}
    text, ok = render(check_columns(live))
    assert not ok
    assert "FAIL 0026 users.age_bracket" in text


def test_typed_create_needs_the_row_not_the_status_code():
    _, ok = render(check_typed_create({"piece_source": "typed", "custom_piece_id": "c1"},
                                      {"id": "c1"}))
    assert ok

    text, ok = render(check_typed_create({"piece_source": "typed", "custom_piece_id": None}, None))
    assert not ok
    assert "custom_pieces row exists" in text

    text, ok = render(check_typed_create({"piece_source": None, "custom_piece_id": None}, None))
    assert not ok
    assert "lesson.piece_source" in text
