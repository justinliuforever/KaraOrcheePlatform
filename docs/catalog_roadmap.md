# Catalog Roadmap — entity model, conventions, multi-instrument

Status: decisions locked 2026-07-08 (founder + research); implementation slices by feature.
This is the north star for every additive migration — build against this picture, never improvise.

## The three structural axes

Every content form reduces to one of three axes:

1. **Grouping/containment** — what does this piece belong to?
   Movements of a work, suites, song cycles, opus sets, WTC prelude+fugue pairs → `works`.
   Method-book numbers, exam compilations → `books`.
2. **Arrangement/variant** — which playable realization of the same content?
   Simplified levels, duet, reduction, excerpt → `arrangement_of` pointer + kind string.
3. **Internal sections** — parts practiced only as part of the whole (theme & variations,
   sections of one movement) → stay INSIDE the piece (jsonb/geometry). Never entities.

**The decision rule (basis of everything):** a `piece` is the smallest unit we sell practice
progress against. Separately practiced/assigned → own piece row + permanent slug. Practiced
only as part of a whole → internal section. (Sonata movement = piece; variation = section;
prelude and fugue = two pieces.)

## Target schema (north star; tables land when a feature consumes them)

```
composers   id slug ("chopin") · name · sort_name · era            [ADDITIVE-LATER]
works       id slug ("mozart_k330") · title · composer_id ·
            catalogue ("K. 330") · work_type · parent_work_id      [ADDITIVE-LATER]
pieces      + work_id, work_index      (movement membership)       [ADDITIVE-LATER]
            + arrangement_of, arrangement_kind                     [ADDITIVE-LATER]
            + instrumentation                                      [BUILD at multi-instrument beta]
            + facts jsonb (auto-extracted key/time/tempo/duration) [with XML extraction]
books       unchanged — pedagogical container, already correct
piece_versions  unchanged — immutable bundles; this IS the FRBR
            manifestation layer collapsed; never add layers below it
```

work-membership and book-membership are ORTHOGONAL parallel fields (a movement can be in
K.330 AND in an exam book). Books stay single-FK until the first cross-work exam
compilation lands (pre-agreed trigger → book_memberships join table; catalog.json shape
tolerates the change via the app's tolerant decoding).

## Locked conventions (violations are the only expensive mistakes)

1. **Slug grammar**: work `{composer}_{catalogue}` (mozart_k330) · movement `{work}_mvt{n}` ·
   book number `{book}_{n}` · arrangement variants get a suffix (`_l2`, `_duet`) — the
   canonical piece keeps the clean slug forever.
2. **IDs never rename** — deprecate-and-add only. piece.id is simultaneously the progress
   key, blob prefix, versions FK, and fielded catalog id.
3. **Progress keys on piece.id alone** — containers are pure navigation; a piece in two
   books has ONE progress record.
4. **Composer display strings house-consistent from now** ("Frédéric Chopin", "J. S. Bach")
   — makes the eventual composers-table backfill a clean group-by.

## Wizard metadata (locked)

- **MusicXML = ground truth for musical facts**: key/time signatures, parts/instrumentation,
  measure count (100% reliable in our 12-file audit), tempo (75% present — strong default,
  flag when absent). Extracted at upload in gate 1, displayed READ-ONLY; to change them,
  fix the file and re-upload.
- **Titles/composer = human-curated**: file values prefill WHEN present (17-25% today, may
  improve), blank otherwise, always editable. Empirical: 0/12 file titles display-ready
  (wrong language, watermarks, mojibake, missing).
- **Catalogue No.** (Op./BWV/K./Hob./D.) — admin-entered optional field.
- No birth/death years.

## Multi-instrument (beta direction agreed; research-backed specifics)

Scope: sheet display + reference playback + Notes for non-piano; **Live/following stays
piano-only** (AMT is piano-trained; expected, gated in UI by instrumentation).

- **Playback stays on-device synthesis from score_events** — preserves tiny bundles,
  construction-aligned audio/cursor, arbitrary tempo/measure start, fully automated pipeline.
  Every serious classical competitor (Tomplay, Metronaut) ships RECORDED human audio — synth
  is our deliberate architectural trade (cursor-lock + variable speed + automation); run the
  founder ear-gate per instrument before committing catalog content.
- **Instrument soundfonts are cloud-delivered per instrument** (soundfont/ container +
  existing download infra). Piano SF2 stays bundled.
- **Soundfont selection (license-verified)**: primary = **VSCO-2 Community Edition (CC0)** —
  real sampled SOLO violin + solo winds; extract per-instrument SF2 via Polyphone (~10-30MB
  each). Fallback/gap-filler = **GeneralUser GS v2.0.3** (permissive since 2024-10; <30MB
  full GM — covers cello/viola, which VSCO-2 CE lacks as solo patches). FluidR3 (MIT) ok.
  ⚠️ SF2 ONLY — AVAudioUnitSampler silently fails on SF3 (MuseScore_General "36MB" is SF3;
  real SF2 is 208MB). ⚠️ iOS: one sampler per instrument on a shared engine; watch fd
  exhaustion (error -42) and the ~128-voice drop cap with piano+solo stacked.
- **Per-family synth verdict**: winds = good; solo strings = acceptable ONLY with a real
  solo patch (GM section-strings fail); **voice = synth impossible** (no lyric singing —
  cut from instrument beta or ship display-only with piano-reduction playback). Verovio
  renders lyrics well (verified on our pinned 6.2.1; check WKWebView fonts for elision glyph).
- **Per-piece `reference_audio` escape hatch**: files model gains an optional audio role —
  app plays real (professionally produced) audio when present, synthesizes otherwise.
  Default = cheap & automatic; override = quality where it matters; the ONLY path for voice.
- **Display convention (Music-Minus-One, industry-standard)**: solo part alone on screen;
  audio toggles full-mix ↔ accompaniment-only; "show piano part" = secondary option.
- **Catalog axis**: instrument = profile-level default filter (not a hard wall); same title
  on multiple instruments = separate arrangement-variant pieces sharing a work id — exactly
  our arrangement model, zero new concepts.
- `instrumentation` column + wizard dropdown become BUILD-NOW the moment multi-instrument
  beta is greenlit. Keyboard UI hidden for non-piano. Transposing instruments (clarinet/horn):
  playback safe by construction (MIDI = sounding pitch); validate cursor correspondence on
  the first such piece.
- **Effort map (codebase audit + empirical spike)**: single-part pieces = ZERO pipeline
  changes + small app edits (synth program param, catalog field, keyboard/follow gating) +
  soundfont asset (M). **Solo-vs-accompaniment part selection = M, not L** (spike-verified):
  Verovio has NO native part filter, but MusicXML pre-surgery works — remove the
  accompaniment score-part + part block (~20 lines stdlib xml.etree, zero new deps), feed
  reduced XML to the unchanged pipeline; verified on synthetic violin+piano AND the real
  2-part czerny file (measures preserved, valid engraving+timemap). **Timing-neutral:
  residual 0.000ms** — the <12ms gate re-runs unchanged. MIDI instrument separation is a
  one-line pretty_midi filter; the accompaniment event stream ("show solo, play both") is
  a free by-product of the same file. What keeps it M: solo-part identification UX (real
  files have unnamed parts — let the Studio uploader pick the solo part), part-group
  cleanup for orchestral scores, and wiring the second event stream into app playback.
  ⚠️ Verovio defaults to 120 BPM when XML carries no tempo (none of our library files do) —
  MIDI and XML tempi must agree for the gate; today they do by construction.

## Never build (research-flagged over-engineering)

Generic polymorphic containers table · FRBR manifestation/item layers · per-variation
entities · composer authority graphs (VIAF etc.) · musical facts as indexed columns
(jsonb suffices at low-thousands scale).

## Known pitfalls this design avoids

Movement-in-subtitle-string (→ work_index int) · arrangement metadata duplication (→ shared
on work) · progress forked per container (→ piece.id only) · title string playing four roles
(→ display jsonb keys) · opus stuffed in titles (→ works.catalogue) · slug renames (never).
