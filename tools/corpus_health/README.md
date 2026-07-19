# corpus_health

Audits every published piece in the live catalog against the structural invariants the
app's FOLLOW/playback modes depend on. Read-only: it downloads bundle assets through
the API's signed URLs and writes reports locally — it never mutates anything.

## Invocation

```
python3 tools/corpus_health/corpus_checker.py --api-base https://<api-host> [--workdir ./corpus_health_run] [--assets-dir <dir>] [--refresh]
```

- `--api-base` (required): API origin. The catalog is fetched with
  `caps=instruments,repeats` so non-piano and repeat pieces are included in the audit.
- `--workdir` (default `./corpus_health_run`): download cache and report output.
  Bundle files are cached; pass `--refresh` to re-download after a re-publish.
- `--assets-dir` (optional): a directory of vendored app asset sets
  (`<id>/<id>.staff.json` + `<id>/<id>.phone.svg` ...) to cross-check against the
  cloud bundles for generation skew. Skipped when omitted.

Outputs in the workdir:

- `corpus_audit.tsv` — one row per piece, every invariant's verdict and evidence.
- `summary.json` — flagged pieces grouped by failure class, plus the clean list and
  any pieces skipped for missing bundle files.
- `perpiece/<pid>.json` — raw per-piece evidence.

## Invariants

- **I1 endpoint** — the last event release must not overrun the timeline end:
  `last onset+duration <= expanded end` (repeat pieces) or `written end` (linear)
  `+ 0.05s`. An overrun means score_events and the staff timeline disagree about how
  long the piece is (split timeline). Also detects `identity_truncated` (a linear
  piece whose last onset sits at/past the final written barline — the identity
  timeline lost its final measure) and zero-length final measures.
- **I2 anchor coverage** — every unique onset must have a cursor anchor within
  **250ms** (ornament tolerance: grace-note clusters legitimately sit up to ~250ms
  from the beat anchor; the earlier 60ms rule false-positived on ornamented pieces),
  coverage `>= 0.995`, and the max nearest-anchor distance `<= 0.5s`. Failures are
  anchor holes: the cursor freezes mid-passage.
- **I3 start agreement** — first anchor vs first onset (intercept `<= 0.10s`) and a
  measure-based Theil-Sen drift fit over the first 30s (slope `<= 0.02`). A non-unit
  slope means score_events and the staff timeline were built at different tempos —
  the from-t=0 start-lag class.
- **I4 geometry pairing** — the phone `staff.json` page viewbox must match the phone
  SVG's own `viewBox`. A mismatch means cursor coordinates are expressed in a
  different coordinate system than the score being drawn.
- **I5 audio_map** — breakpoints must be monotone in both axes. (The former
  endpoint-ratio checks are superseded by the worker's G8 publish gate, which asserts
  the endpoint at build time.)
- **I6 residuals** — the stored `timeline_residual_ms_p90` from staff.json must be
  `<= 1000ms`; larger means the engraved timeline and the MIDI timeline drifted.
- **I7 bijection** — consistency of the flags that gate app behavior:
  `follow_ready` pieces must be `staff_eligible`; an expanded (repeat) timeline must
  carry a playback block; the final expanded measures must contain onsets.

Vendored cross-check (`--assets-dir` only): compares each vendored staff/svg pair to
the current cloud bundle of the same catalog piece (viewbox, first-anchor position,
file sha256) and flags **generation skew** — pairs that are internally consistent but
belong to a different render generation, which draws the cursor a full system off if
a client mixes vendored geometry with cloud SVG.
