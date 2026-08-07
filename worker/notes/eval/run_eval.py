#!/usr/bin/env python3
"""The standing prompt eval. Two planes, one gate.

  Plane P (--plane prompt)  re-runs the LLM over FROZEN transcripts. Costs money;
                            prints the estimate and refuses without --spend.
  Plane R (--plane replay)  re-derives every number from a stored run. $0, no
                            network, bit-deterministic.

  python3 run_eval.py --plane prompt --arm baseline  --spend
  python3 run_eval.py --plane prompt --arm candidate --spend
  python3 run_eval.py --plane replay --gate

Runs land in runs/<arm>/ as {lesson}.json — raw model text stays there and is
gitignored: it is derived from a minor's speech.

The gate is the only thing that may let a prompt change ship: candidate metrics
on EXISTING fields must not be worse than baseline on any lesson.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import fixtures  # noqa: E402
from metrics import (LessonMetrics, compare_samples, measure,  # noqa: E402
                     regressions)
from pipeline import build_turns  # noqa: E402
from prompt import build_system, build_user  # noqa: E402

# claude-sonnet-5 list price. Printed before any spend, never after.
IN_PER_TOK = 3 / 1_000_000
OUT_PER_TOK = 15 / 1_000_000

RUN_TAG = ""


def runs_dir(arm: str) -> Path:
    return HERE / "runs" / (f"{arm}_{RUN_TAG}" if RUN_TAG else arm)


def run_prompt_plane(arm: str, lessons: list[fixtures.Lesson]) -> list[LessonMetrics]:
    from llm import call_claude  # imported late: replay must not need requests

    out_dir = runs_dir(arm)
    out_dir.mkdir(parents=True, exist_ok=True)
    metrics: list[LessonMetrics] = []
    for lesson in lessons:
        # Both arms render from the shipped builder, so the baseline IS the deployed
        # prompt: an arm assembled by editing text could differ from it by a stray
        # comma and quietly flatter the candidate.
        system = build_system(lesson.measure_count, piece_mentions=(arm == "candidate"))
        user = build_user(build_turns(lesson.utterances), lesson.piece_desc)
        result = call_claude(system, user)
        cost = result.in_tok * IN_PER_TOK + result.out_tok * OUT_PER_TOK
        (out_dir / f"{lesson.key}.json").write_text(json.dumps({
            "key": lesson.key,
            "arm": arm,
            "model": result.model,
            "in_tok": result.in_tok,
            "out_tok": result.out_tok,
            "cost_usd": round(cost, 6),
            "secs": result.secs,
            "text": result.text,
        }, indent=1))
        m = measure(lesson.key, result.text, lesson.text, lesson.measure_count)
        metrics.append(m)
        print(f"  {lesson.key}: kept {m.kept}/{m.proposed} fidelity {m.quote_fidelity} "
              f"grounded {m.grounded} mentions {m.mentions_verbatim}/{m.mentions_proposed} "
              f"${cost:.4f}")
    return metrics


def replay(arm: str, lessons: list[fixtures.Lesson]) -> list[LessonMetrics]:
    by_key = {lesson.key: lesson for lesson in lessons}
    metrics: list[LessonMetrics] = []
    for path in sorted(runs_dir(arm).glob("*.json")):
        stored = json.loads(path.read_text())
        lesson = by_key.get(stored["key"])
        if lesson is None:
            continue
        metrics.append(measure(stored["key"], stored["text"], lesson.text, lesson.measure_count))
    return metrics


def render(arm: str, metrics: list[LessonMetrics]) -> str:
    lines = [f"[{arm}]"]
    for m in metrics:
        lines.append(
            f"  {m.key:28s} json_ok={m.json_ok} gate={m.gate_failed} "
            f"kept={m.kept}/{m.proposed} fidelity={m.quote_fidelity} grounded={m.grounded} "
            f"summary={m.summary_chars}c plan_steps={m.plan_steps} "
            f"mentions={m.mentions_verbatim}/{m.mentions_proposed}")
    return "\n".join(lines)


def pooled(args, lessons: list[fixtures.Lesson]) -> int:
    """Replay every sample of both arms and judge with a tolerance read off the
    baseline's own spread."""
    global RUN_TAG
    tags = [t.strip() for t in args.samples.split(",")]
    runs: dict[str, list[list[LessonMetrics]]] = {"baseline": [], "candidate": []}
    for tag in tags:
        RUN_TAG = tag
        for arm in ("baseline", "candidate"):
            got = replay(arm, lessons)
            if got:
                runs[arm].append(got)
                print(render(f"{arm} [{tag or 'r1'}]", got))
    if not runs["baseline"] or not runs["candidate"]:
        print("need at least one stored run per arm.")
        return 2
    print(f"\npooled over {len(runs['baseline'])} baseline and {len(runs['candidate'])} candidate samples")
    verdicts = compare_samples(runs["baseline"], runs["candidate"])
    for v in verdicts:
        print(v)
    regressed = [v for v in verdicts if v.regressed]
    unresolved = [v for v in verdicts if not v.regressed and not v.resolvable]
    if regressed:
        print(f"\nREGRESSION on {len(regressed)} measure(s) beyond the baseline's own spread — "
              "the prompt change may not ship.")
        return 1
    if unresolved:
        print(f"\nUNRESOLVED: {len(unresolved)} of {len(verdicts)} measures have a baseline spread "
              "wider than half their own mean. No regression was found, and none could have been: "
              "this corpus and sample count cannot resolve the question. NOT a pass.")
        return 1
    print("\nzero regression on existing fields, resolvable at this sample count")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--plane", choices=["prompt", "replay"], default="replay")
    p.add_argument("--arm", choices=["baseline", "candidate", "both"], default="both")
    p.add_argument("--spend", action="store_true", help="required for --plane prompt")
    p.add_argument("--gate", action="store_true", help="exit 1 on any regression")
    p.add_argument("--json", action="store_true")
    # A second sample of the SAME arm. The model runs at its production temperature,
    # so one run per arm cannot tell a prompt effect from run-to-run variance.
    p.add_argument("--tag", default="")
    # Comma-separated tags to pool, e.g. --samples ,r2,r3 (the empty tag is the first run).
    p.add_argument("--samples", default="")
    args = p.parse_args(argv)
    global RUN_TAG
    RUN_TAG = args.tag

    root = fixtures.corpus_root()
    if root is None:
        print("NOTES_EVAL_CORPUS is unset or has no results/ — nothing was measured.")
        return 2
    lessons = fixtures.load(root)
    if not lessons:
        print(f"no lessons found under {root}/results — nothing was measured.")
        return 2

    if args.samples:
        return pooled(args, lessons)

    arms = ["baseline", "candidate"] if args.arm == "both" else [args.arm]
    results: dict[str, list[LessonMetrics]] = {}
    for arm in arms:
        if args.plane == "prompt":
            if not args.spend:
                est = len(lessons) * 0.16
                print(f"Plane P re-runs the LLM on {len(lessons)} lessons per arm "
                      f"(~${est:.2f}/arm at list price). Re-run with --spend.")
                return 2
            if not os.environ.get("ANTHROPIC_API_KEY"):
                print("ANTHROPIC_API_KEY is unset — nothing was measured.")
                return 2
            print(f"[{arm}] running…")
            results[arm] = run_prompt_plane(arm, lessons)
        else:
            results[arm] = replay(arm, lessons)
            if not results[arm]:
                print(f"no stored run for '{arm}' — run --plane prompt first.")
                return 2

    for arm in arms:
        print(render(arm, results[arm]))
    if args.json:
        print(json.dumps({arm: [m.as_dict() for m in ms] for arm, ms in results.items()}, indent=1))

    if args.gate:
        if len(arms) != 2:
            print("--gate needs both arms.")
            return 2
        found = regressions(results["baseline"], results["candidate"])
        if found:
            print("\nREGRESSION — the prompt change may not ship:")
            for r in found:
                print(f"  {r}")
            return 1
        print("\nzero regression on existing fields: kept, quote_fidelity, grounded, "
              "gate_failed, json_ok all held on every lesson")
    return 0


if __name__ == "__main__":
    sys.exit(main())
