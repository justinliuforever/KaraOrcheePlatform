"""Pure assertions for probe_schema / probe_lesson_typed. No DB, no Azure — the CLI
hands these the rows it read, so the rules stay testable without either.

The 0023 rule: a migration is proved by the columns that exist in the database the
DEPLOYED image is talking to, never by the runner's exit code. 0023 was executed
inside an image that did not contain it, exited 0, did nothing, and the roster 500ed
for days."""
from __future__ import annotations

from dataclasses import dataclass

# (table, column) added by each reserved migration. A probe that does not name the
# migration cannot tell "this deploy shipped it" from "someone added it by hand".
EXPECTED_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "0024": [("lesson_sessions", "piece_source")],
    "0025": [
        ("custom_pieces", "id"),
        ("custom_pieces", "teacher_id"),
        ("custom_pieces", "display_label"),
        ("custom_pieces", "normalized_label"),
        ("custom_pieces", "linked_piece_id"),
        ("custom_pieces", "linked_at"),
        ("custom_pieces", "dismissed_piece_ids"),
        ("lesson_sessions", "custom_piece_id"),
        ("notes", "custom_piece_id"),
        ("notes", "piece_suggestion_dismissed"),
        ("note_jobs", "piece_mentions"),
    ],
    "0026": [("users", "age_bracket"), ("users", "age_attested_at")],
    "0027": [("users", "ciam_oid_at_delete"), ("users", "ciam_deleted_at")],
}

EXPECTED_CONSTRAINTS = {"0024": ["ck_lesson_piece_source"]}
EXPECTED_INDEXES = {
    "0025": ["uq_custom_pieces_teacher_label"],
    "0027": ["ix_users_ciam_oid_at_delete"],
}


@dataclass
class Assertion:
    label: str
    expected: object
    actual: object

    @property
    def held(self) -> bool:
        return self.expected == self.actual

    def __str__(self) -> str:
        mark = "ok  " if self.held else "FAIL"
        return f"{mark} {self.label}: expected {self.expected!r}, read {self.actual!r}"


def check_columns(live: set[tuple[str, str]], migrations: list[str] | None = None) -> list[Assertion]:
    out = []
    for mig in migrations or sorted(EXPECTED_COLUMNS):
        for table, column in EXPECTED_COLUMNS[mig]:
            out.append(Assertion(f"{mig} {table}.{column}", True, (table, column) in live))
    return out


def check_named(live: set[str], expected: dict[str, list[str]], kind: str) -> list[Assertion]:
    out = []
    for mig, names in expected.items():
        for name in names:
            out.append(Assertion(f"{mig} {kind} {name}", True, name in live))
    return out


def check_typed_create(lesson: dict | None, custom_piece: dict | None) -> list[Assertion]:
    """probe_lesson_typed: one live POST /v1/lessons with pieceSource:"typed" must
    leave BOTH a lesson row carrying the source and a custom_pieces row it points at.
    A 201 alone proves only that the route answered."""
    return [
        Assertion("lesson row exists", True, lesson is not None),
        Assertion("lesson.piece_source", "typed", (lesson or {}).get("piece_source")),
        Assertion("custom_pieces row exists", True, custom_piece is not None),
        Assertion(
            "lesson.custom_piece_id points at it",
            True,
            bool(lesson and custom_piece and lesson.get("custom_piece_id") == custom_piece.get("id")),
        ),
    ]


def render(assertions: list[Assertion]) -> tuple[str, bool]:
    lines = [str(a) for a in assertions]
    return "\n".join(lines), all(a.held for a in assertions)
