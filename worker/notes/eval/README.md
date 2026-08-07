# notes/eval — the standing prompt eval

The gate a prompt change has to clear before it ships. Nothing here is a unit test:
these are measurements on real lessons, and the numbers are the deliverable.

## The corpus never enters this repo

Three real lessons: a minor's speech, a teacher's speech, and a street address in the
folder names. They live outside the repo behind `$NOTES_EVAL_CORPUS`, and `runs/` (raw
model output derived from them) is gitignored. Only derived NUMBERS leave this
directory. Do not "optimize" this later by checking the transcripts in.

```bash
export NOTES_EVAL_CORPUS=~/Desktop/piano-ai-notes
export ANTHROPIC_API_KEY=...
```

## The two planes

```bash
# Plane P — re-runs the LLM over FROZEN transcripts. No ASR spend; ~$0.10/lesson/arm.
python3 notes/eval/run_eval.py --plane prompt --arm both --spend
python3 notes/eval/run_eval.py --plane prompt --arm both --spend --tag r2   # another sample

# Plane R — re-derives every number from the stored runs. $0, no network.
python3 notes/eval/run_eval.py --plane replay --arm both --gate

# The gate that actually decides: pooled over samples.
python3 notes/eval/run_eval.py --plane replay --samples ,r2,r3
```

`baseline` is today's prompt (the same file with the one new line removed), `candidate`
is the prompt under test, so the comparison isolates exactly the change.

## Why the single-sample gate is not the gate

The model runs at its production temperature. Measured on this corpus, two runs of the
IDENTICAL prompt moved one lesson's `quote_fidelity` by 0.25 and its `kept` count by 7.
A one-sample-per-arm comparison therefore reports prompt effects that are noise, in
either direction.

The pooled gate reads its tolerance off the baseline's own spread: a measure counts as
regressed only when the candidate's mean falls below `baseline_mean − baseline_spread`.
A measure whose baseline spread exceeds half its own mean is printed **UNRESOLVED** and
the run exits non-zero — "no regression found" and "no regression findable" are not the
same sentence, and only the first is a pass.

## What it does NOT measure

Nothing requiring fresh ASR (vendor comparison is a one-off study, not a per-change
metric), and nothing derived from the speaker label — on this corpus that label
separates acoustics, not people.
