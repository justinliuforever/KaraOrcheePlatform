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

## Multi-instrument (beta direction agreed; specifics pending research)

Scope: sheet display + reference playback + Notes for non-piano; **Live/following stays
piano-only** (AMT is piano-trained; expected, gated in UI by instrumentation).

- **Playback stays on-device synthesis from score_events** — preserves tiny bundles,
  construction-aligned audio/cursor, arbitrary tempo/measure start, fully automated pipeline.
- **Instrument soundfonts are cloud-delivered per instrument** (soundfont/ container +
  existing download infra; fetched on first download of a piece needing them). Piano SF2
  stays bundled.
- **Per-piece `reference_audio` escape hatch**: files model gains an optional audio role —
  app plays real (professionally produced) audio when present, synthesizes otherwise.
  Default = cheap & automatic; override = quality where it matters. Zero schema change.
- `instrumentation` column + wizard dropdown become BUILD-NOW the moment multi-instrument
  beta is greenlit (feature consumes the field).
- Keyboard UI hidden for non-piano pieces.

## Never build (research-flagged over-engineering)

Generic polymorphic containers table · FRBR manifestation/item layers · per-variation
entities · composer authority graphs (VIAF etc.) · musical facts as indexed columns
(jsonb suffices at low-thousands scale).

## Known pitfalls this design avoids

Movement-in-subtitle-string (→ work_index int) · arrangement metadata duplication (→ shared
on work) · progress forked per container (→ piece.id only) · title string playing four roles
(→ display jsonb keys) · opus stuffed in titles (→ works.catalogue) · slug renames (never).
