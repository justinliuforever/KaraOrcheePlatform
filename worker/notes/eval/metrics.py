"""Metrics + the zero-regression gate. Pure: every function takes an already-parsed
LLM object and a transcript, so the numbers are re-derivable from a stored run
without spending a cent (Plane R)."""
from __future__ import annotations

import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline import (GateFail, extract_json, normalize_note,  # noqa: E402
                      normalize_piece_mentions, quote_in_transcript)


@dataclass
class LessonMetrics:
    """Existing output fields only, plus the new field kept strictly beside them."""
    key: str
    json_ok: bool = False
    gate_failed: str | None = None
    proposed: int = 0
    kept: int = 0
    quote_fidelity: float = 0.0
    grounded: int = 0
    summary_chars: int = 0
    plan_steps: int = 0
    # New field. Never part of the regression gate — a change here must not be able
    # to excuse a loss above.
    mentions_proposed: int = 0
    mentions_verbatim: int = 0
    mentions: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def measure(key: str, raw_text: str, transcript: str,
            measure_count: int | None = None) -> LessonMetrics:
    m = LessonMetrics(key=key)
    try:
        obj = extract_json(raw_text)
    except ValueError:
        return m
    m.json_ok = True
    raw_annotations = obj.get("annotations")
    m.proposed = len(raw_annotations) if isinstance(raw_annotations, list) else 0
    raw_mentions = obj.get("piece_mentions")
    m.mentions_proposed = len(raw_mentions) if isinstance(raw_mentions, list) else 0
    m.mentions = normalize_piece_mentions(obj, transcript)
    m.mentions_verbatim = len(m.mentions)
    try:
        content, annotations, _warnings, _drops = normalize_note(obj, transcript, measure_count)
    except GateFail as fail:
        m.gate_failed = fail.code
        return m
    except ValueError:
        m.json_ok = False
        return m
    m.kept = len(annotations)
    m.quote_fidelity = round(m.kept / m.proposed, 4) if m.proposed else 0.0
    m.grounded = sum(1 for a in annotations if a["location"].get("grounded"))
    m.summary_chars = len(content["lessonSummary"])
    m.plan_steps = sum(len(p["steps"]) for p in content["practicePlan"])
    return m


def verbatim_rate(mentions: list[str], transcript: str) -> float:
    if not mentions:
        return 1.0
    return sum(1 for q in mentions if quote_in_transcript(q, transcript)) / len(mentions)


# ── the gate ────────────────────────────────────────────────────────────────────
# "Zero regression on existing fields" made falsifiable: per lesson, the candidate
# may not lose a kept annotation, may not lose quote fidelity, may not lose a
# grounded anchor, may not newly fail a gate, and may not stop producing JSON.
# Nothing about piece_mentions can make this pass.

REGRESSION_FIELDS = ("json_ok", "gate_failed", "kept", "quote_fidelity", "grounded")


@dataclass
class Regression:
    key: str
    field: str
    baseline: object
    candidate: object

    def __str__(self) -> str:
        return f"{self.key}: {self.field} {self.baseline!r} -> {self.candidate!r}"


def regressions(baseline: list[LessonMetrics], candidate: list[LessonMetrics]) -> list[Regression]:
    by_key = {m.key: m for m in candidate}
    out: list[Regression] = []
    for base in baseline:
        cand = by_key.get(base.key)
        if cand is None:
            out.append(Regression(base.key, "missing", True, False))
            continue
        if base.json_ok and not cand.json_ok:
            out.append(Regression(base.key, "json_ok", True, False))
        if base.gate_failed is None and cand.gate_failed is not None:
            out.append(Regression(base.key, "gate_failed", None, cand.gate_failed))
        if cand.kept < base.kept:
            out.append(Regression(base.key, "kept", base.kept, cand.kept))
        if cand.quote_fidelity < base.quote_fidelity:
            out.append(Regression(base.key, "quote_fidelity", base.quote_fidelity, cand.quote_fidelity))
        if cand.grounded < base.grounded:
            out.append(Regression(base.key, "grounded", base.grounded, cand.grounded))
    return out


# ── the multi-sample gate ───────────────────────────────────────────────────────
# The model runs at its production temperature, so ONE sample per arm cannot tell a
# prompt effect from run-to-run variance — measured, not assumed: on this corpus the
# same arm's quote_fidelity moved by up to 0.25 and `kept` by up to 7 annotations
# between two runs of the IDENTICAL prompt. The tolerance is therefore read off the
# baseline's own spread rather than declared in advance.

NUMERIC_FIELDS = ("kept", "quote_fidelity", "grounded")


@dataclass
class FieldVerdict:
    key: str
    field: str
    baseline_mean: float
    baseline_spread: float
    candidate_mean: float

    @property
    def regressed(self) -> bool:
        return self.candidate_mean < self.baseline_mean - self.baseline_spread

    @property
    def resolvable(self) -> bool:
        """False when the baseline's own swing is as large as the quantity measured —
        the run says nothing either way, and must not be read as a pass. A baseline of
        zero has nothing to lose and is always resolvable."""
        if self.baseline_mean == 0:
            return True
        return self.baseline_spread < 0.5 * self.baseline_mean

    def __str__(self) -> str:
        mark = "REGRESSED" if self.regressed else ("ok" if self.resolvable else "UNRESOLVED")
        return (f"  {mark:10s} {self.key:28s} {self.field:14s} "
                f"baseline {self.baseline_mean:.3f} ±{self.baseline_spread:.3f}  "
                f"candidate {self.candidate_mean:.3f}")


@dataclass
class BooleanVerdict:
    """A mean is the wrong operator for "it produced JSON" and "it passed the gate":
    averaging hides the one sample that broke. One broken candidate run against an
    unbroken baseline is a regression however many good runs surround it."""
    key: str
    field: str
    detail: str

    regressed: bool = True
    resolvable: bool = True

    def __str__(self) -> str:
        return f"  {'REGRESSED':10s} {self.key:28s} {self.field:14s} {self.detail}"


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _boolean_verdicts(key: str, base_runs: list[LessonMetrics],
                      cand_runs: list[LessonMetrics]) -> list[BooleanVerdict]:
    out: list[BooleanVerdict] = []
    if all(m.json_ok for m in base_runs) and not all(m.json_ok for m in cand_runs):
        broke = sum(1 for m in cand_runs if not m.json_ok)
        out.append(BooleanVerdict(
            key, "json_ok",
            f"baseline parsed {len(base_runs)}/{len(base_runs)}, "
            f"candidate failed {broke}/{len(cand_runs)}"))
    if all(m.gate_failed is None for m in base_runs):
        failed = [m.gate_failed for m in cand_runs if m.gate_failed is not None]
        if failed:
            out.append(BooleanVerdict(
                key, "gate_failed",
                f"baseline never failed, candidate failed {len(failed)}/{len(cand_runs)}: {failed[0]}"))
    return out


def compare_samples(baseline: list[list[LessonMetrics]],
                    candidate: list[list[LessonMetrics]]) -> list[FieldVerdict | BooleanVerdict]:
    keys = [m.key for m in baseline[0]] if baseline else []
    out: list[FieldVerdict | BooleanVerdict] = []
    for key in keys:
        base_runs = [next((m for m in run if m.key == key), None) for run in baseline]
        cand_runs = [next((m for m in run if m.key == key), None) for run in candidate]
        base_runs = [m for m in base_runs if m]
        cand_runs = [m for m in cand_runs if m]
        if not base_runs or not cand_runs:
            continue
        out.extend(_boolean_verdicts(key, base_runs, cand_runs))
        for field in NUMERIC_FIELDS:
            base_values = [float(getattr(m, field)) for m in base_runs]
            cand_values = [float(getattr(m, field)) for m in cand_runs]
            out.append(FieldVerdict(
                key=key,
                field=field,
                baseline_mean=_mean(base_values),
                baseline_spread=max(base_values) - min(base_values),
                candidate_mean=_mean(cand_values),
            ))
    return out
