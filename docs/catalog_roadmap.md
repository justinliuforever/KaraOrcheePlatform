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
works       id slug ("mozart_k330") · title · composer string ·
            catalogue ("K. 330") · work_type · parent_work_id      [BUILD-NOW — founder
            2026-07-08: work membership is HUMAN knowledge captured at upload; deferring
            = mass manual backfill after hundreds of uploads. Upload flow lands complete.]
pieces      + work_id, work_index      (movement membership)       [BUILD-NOW, same reason]
            + arrangement_of, arrangement_kind                     [ADDITIVE-LATER]
            + instrumentation                                      [BUILD-NOW w/ studio v3]
            + facts jsonb (auto-extracted key/time/tempo/duration) [BUILD-NOW w/ studio v3]
books       unchanged — pedagogical container, already correct
piece_versions  unchanged — immutable bundles; this IS the FRBR
            manifestation layer collapsed; never add layers below it
```

**Studio v3 (upload lands complete — founder-locked scope)**: wizard = files-first w/ XML
facts card (read-only ground truth) + part detection → solo-part question (multi-part only,
system pre-selects, human confirms; drives display/timeline/audio split) → **preview audio
rendered AT PREFLIGHT** (FluidSynth + the SAME cloud SF2 the app will use + same
score_events — audible in the wizard while filling the form, so the admin can judge whether
to add a produced reference_audio override; multi-part renders after the solo choice) →
piece info (instrument dropdown, prefilled titles, works/books grouping, rights) → submit →
full gates (+ audio gate when reference audio present) → review (listen + look) → publish.

work-membership and book-membership are ORTHOGONAL parallel fields (a movement can be in
K.330 AND in an exam book). Books stay single-FK until the first cross-work exam
compilation lands (pre-agreed trigger → book_memberships join table; catalog.json shape
tolerates the change via the app's tolerant decoding).

## Locked conventions (violations are the only expensive mistakes)

1. **Slug naming**: hand-curated ids follow the grammar work `{composer}_{catalogue}`
   (mozart_k330) · movement `{work}_mvt{n}` · book number `{book}_{n}` · variants suffixed.
   **Studio-derived slugs stay title-derived (composer+title+subtitle)** — adversarial
   review 2026-07-08 killed work-derived slugs (collision-guard deadlock: subtitle no longer
   feeds the slug so the 409 remedy fails; work_index is legitimately non-unique; post-publish
   index fixes would make slugs lie). Mixed styles are permanently fine because of #5.
   slug.ts must preserve digit-bearing tokens through the token caps (Hob. XVI:48 must not
   truncate to XVI) and fold in the work's catalogue tokens when attached.
2. **IDs never rename** — deprecate-and-add only. piece.id is simultaneously the progress
   key, blob prefix, versions FK, and fielded catalog id.
3. **Progress keys on piece.id alone** — containers are pure navigation; a piece in two
   books has ONE progress record.
4. **Composer display strings house-consistent from now** ("Frédéric Chopin", "J. S. Bach").
   When work_id is set, the app's group header renders EXCLUSIVELY from the works[] entry;
   piece.title/composer serve standalone display + search. checks warns on piece-vs-work
   composer mismatch.
5. **Slug structure is never parsed** — no code may derive meaning from an id. IDs are
   opaque keys; all semantics live in columns.
6. **work_index is a musical position, NOT a unique key** — arrangements legitimately share
   (work_id, work_index). UIs group by (work_index, instrumentation, arrangement); aggregate
   progress counts DISTINCT work_index per instrument. Collapse groups by LEAF work;
   parent works are shelf/breadcrumb only.

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
- **Soundfont selection — LOCKED 2026-07-09** (three deep-research passes + rendered
  audition through the production preview path; clips in ~/Desktop/SoundfontAudition):
  - **violin = `MuseScore_General-20260709.sf2` @ program 40** (MIT, in-app attribution;
    215MB whole-bank snapshot in soundfont/; its solo violin = VSCO-2 CE real recordings).
    VSCO-2 CE itself ships SFZ/WAV only — no official SF2 exists; MuseScore_General IS the
    curated SF2 build of it.
  - **guitar = `SpanishClassicalGuitar-20190618.sf2` @ program 0** (FreePats, CC0, 19MB
    dedicated font, 48 per-key zones, real nylon recordings). ⚠️ NOT at GM 24 — program 0;
    the SOUNDFONTS map carries per-instrument program, app must mirror that mapping.
  - **piano: incumbent `SalC5Light2.sf2` has a LICENSE PROBLEM** — HED-Sounds build terms
    forbid "sell or repackage and sell" (personal use only); underlying Salamander samples
    are CC-BY 3.0 but that specific build is not shippable in a paid app. Replacement
    candidate rendered + delivered for founder ear-gate: **YDP-GrandPiano (CC-BY 3.0,
    113MB, 121 samples/5 vel layers vs incumbent 44/7 — big pitch-stretch win, coarser
    soft layers)**. Swap pending founder ear decision — production sound identity.
  - Rejected on license: All-Around Violin (pirated provenance), Aegean (NC), Timbres of
    Heaven (no redistribution), Arachno (written consent), Maestro/Cathan (ND), Splendid
    Grand (Akai provenance), soundfonts4u (login-walled/unclear). GeneralUser GS v2 stays
    the documented gap-filler (free-commercial, GM-tier).
  ⚠️ SF2 ONLY — AVAudioUnitSampler silently fails on SF3 (MuseScore_General default
  download is SF3; our blob is the real 215MB SF2 — byte-verified RIFF/sfbk, zero OggS).
  ⚠️ iOS RAM: sampler resident ≈ file size; >200MB risky on min-spec (jetsam) — for the
  APP bundle, extract the violin preset from the whole-bank blob at app-batch time if
  device tests demand (extraction preserves samples byte-identically, preview==app holds);
  one sampler per instrument on a shared engine; watch fd exhaustion (error -42) and the
  ~128-voice drop cap with piano+solo stacked.
  Blob convention: immutable date-stamped names + sibling `.LICENSE.*` blob (MIT/CC-BY
  attribution text ships with the asset, into the app credits screen later).
- **Beta instruments (founder-locked 2026-07-08): violin + guitar. Voice = CUT** (no lyric
  synthesis exists; revisit post-beta via reference_audio only).
- **Guitar first, violin second (repertoire-driven sequencing)**: classical guitar repertoire
  is almost entirely single-part (self-accompanying, plucked = decaying envelope like piano —
  GM guitar patches suffice, NO sustain problem) → fully covered by step 1. Violin repertoire
  is overwhelmingly solo+piano-accompaniment → realistically needs step 2 (part selection).
  Guitar notes: written an octave above sounding (playback safe — MIDI is sounding pitch;
  validate cursor correspondence once); TAB rendering = future product decision (classical
  pedagogy uses standard notation; Verovio can engrave TAB if ever needed).
- **Per-family synth verdict**: winds = good; guitar/plucked = good; solo strings = acceptable
  ONLY with a real solo patch (GM section-strings fail); **voice = synth impossible**. Verovio
  renders lyrics well (verified on our pinned 6.2.1; check WKWebView fonts for elision glyph).
- **Per-piece `reference_audio` escape hatch — two tiers** (sync = an audio↔score time map;
  synthesis gets it by construction, real audio needs it explicitly):
  - **Tier 1 (beta)**: audio PRODUCED AT the notated score tempo (studio renders from
    MIDI/DAW are exactly this) → linear time map → tap-to-seek, cursor sync, and seek-from-
    measure all work unchanged. A lightweight gate verifies tempo conformity at upload.
  - **Tier 2 (post-beta)**: human performance recordings with rubato → offline audio↔score
    alignment computed AND VERIFIED in the pipeline as a gate artifact (history lesson:
    hand-made alignment.json shipped broken once — never trust, always verify). The only
    path for voice content.
  - **Alignment toolchain (research-locked)**: **Sync Toolbox** (MIT, Müller/AudioLabs;
    chroma CENS + DLNCO onsets + MrMsDTW) — instrument-agnostic, batteries-included; score
    side parsed via partitura. NOT Matchmaker (online+piano-only, less accurate), NOT
    neural/AMT-feature aligners (piano-centric, heavy — v1 over-engineering), NOT raw
    librosa DTW (rebuilds what synctoolbox ships).
  - **Verification gate (both tiers share it)**: primary = **onset-agreement** — map score
    onsets through the alignment into audio time, require ≥90% within 100ms of a detected
    audio onset (75-90% = human review; <75% fail) + no 5s window below 60% (catches
    locally-broken maps). Secondary: DTW path cost (threshold from calibration data, not
    invented), stall/jump slope checks, head/tail coverage. Tier 1 gate = duration-ratio
    (|audio/notated − 1| ≤ 2-3%) + the same onset-agreement under a linear map.
  - **Time-map format**: piecewise-linear breakpoints (per score onset or ~30ms Douglas-
    Peucker), linear interpolation at 60fps, strictly monotonic by construction; Tier 1 =
    the same schema with two breakpoints. Mixed audio (solo+accompaniment) aligns against
    the FULL-score timeline — display stays solo; onset gate counts all parts' onsets.
  - **Effort**: Tier 1 = S (days), Tier 2 = M (1-2 weeks on existing worker+gates infra).
- **Concertos need NO new upload form**: learning-context concertos = piano-reduction
  accompaniment editions (what exams/lessons actually use) = a standard two-part upload
  (step 2 covers it). Real orchestral backing = the mov2 stems model — production-grade
  manual path via stems + reference_audio, not a wizard flow. NEVER "upload full orchestral
  score → synthesize the orchestra" (quality fails; no one does this).
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

## Pre-lock adversarial review — BINDING amendments (2026-07-08, two Fable-5 attack lanes + synthesis)

Verdict: **entity model LOCKED — zero structural redos found across nine future-feature
families and fourteen maintenance attacks.** The recurring lesson: *the schema is ahead of
the catalog — future features die in catalog_build.ts, not Postgres.* Treat the catalog
emit shape as a versioned public API.

**Design decisions locked by the review:**
- `instrumentation` shape = **`{solo: "violin", parts: ["violin","piano"]}`** — one flat
  string cannot serve both profile filtering and part display.
- **Soundfonts are BUNDLED in the app for the 2-instrument beta** (founder 2026-07-08:
  violin ~15-25MB + guitar a few MB keeps the app well under store limits; kills the
  download-manager + offline-hole + catalog-contract complexity by construction). The
  `soundfonts[]` catalog contract {instrument, url, bytes, sha256, version} + download-
  completeness rule stays documented here as the ESCAPE PATH when instrument #4-5 arrives.
  SF2 assets remain immutable versioned blobs in soundfont/ (source of truth for app
  builds); never swapped in place (would invalidate ear-gates).
- **Capability gating NOW**: /v1/catalog + /v1/pieces/:id/download filter server-side to
  piano/null instrumentation; instrument-aware app builds opt in explicitly (?caps= or /v2).
  Proven: the shipped decoder ignores catalog_version entirely — the ONLY lever over fielded
  apps is not sending them rows they'd misrender (piano AMT running on guitar audio).
  The NEW decoder must actually enforce a capability field to gate the next fleet.
- **Reviewed = published invariant**: solo-part choice is metadata that changes artifacts →
  changing it resets gates/artifacts and re-runs preflight (same path as file replacement);
  a part-selection stamp in gate metrics is asserted at submit AND publish; publish copies
  artifacts by ROLE ALLOWLIST (preview audio must never ride into the immutable bundle);
  the chosen part persists on the pieces row so pinned-draft prefill keeps it.
- **reference_audio is bundle-versioned, no in-place replacement EVER** (immutability law +
  updateStalePieces only reacts to bundle_version + stale sha256 would brick fresh
  downloads). Cheap flow: pinned draft reusing previous sources + new audio.
- **Works hygiene**: catalogue normalized (K. 330→k330) for dup-check AND slug; FK RESTRICT
  on work delete with pieces; **works[] emitted ONLY for works referenced by published
  pieces (+parent chain)** — no work archive state exists; piece↔work reassignment guards
  (exists, soft dup warn, rebuild, audit, never re-derive slug); works edits trigger catalog
  rebuild + audit like pieces. Empty works surface as "0 pieces", never auto-GC'd.
- **Dup-check spec at (work, index)**: same instrumentation + no arrangement marker → warn
  probable duplicate; different instrumentation → info "arrangement?"; archived match →
  hint restore. Include archived pieces in the check.
- **One open draft per piece**: POST /drafts?piece=X 409s when a non-terminal job exists.
- **Facts encodings locked**: key = {fifths, mode} (not display strings), tempo_source =
  "xml"|"default" (120bpm-default durations are approximate — flag in filters), tempo_text
  ("Allegro con brio"). Every catalogued piece gets a work row — 1:1 works are normal.
- **works.sort_index scope** = admin-maintained ordering within composer; app uses a
  numeric-aware catalogue comparator as fallback.
- **Arrangement trigger** (pre-agreed like book_memberships): the first same-instrument
  variant upload activates arrangement_of + arrangement_kind (controlled vocab: level:N,
  duet, reduction, excerpt) + catalog emit.
- **Emit-layer additions with studio v3**: tags (namespaced vocab: genre:etude, mood:calm,
  use:competition, use:student — Library gets a tags editor), display jsonb (localization:
  title_zh keys; display jsonb added to works+books), thumbnail_url, first_published_at
  (recently-added), books[] {id,title,author,cover_url,sort_index} (bookshelf needs covers
  IN the catalog), work_type = structural only (genre lives in tags).
- **Catalog wire discipline**: minify (drop pretty-print), gzip at upload
  (content-encoding), app sends If-None-Match. Escape path at ~5k pieces: split files[]
  into per-piece manifests (bundle_version is the cache key) — non-breaking via tolerant
  decode.
- **Era/composer sorting**: era + sort_name + years live on the future composers table
  (the wizard's no-birth/death rule is about DATA ENTRY — the composers table fills years
  from a lookup, not from Crystal). Interim: era: namespaced tag allowed.
- **Featured/popular**: featured = editorial flag/collection (additive); popularity is
  time-varying and must NEVER live in catalog.json (rebuilt only on publish) — sidecar
  popularity.json on a schedule, or defer.
- **Takedown-vs-archive client semantics**: archive = keep downloaded copy playable;
  takedown (rights) = hide + disable playback. App snapshots piece metadata at download.
- **Backfill plan hardening**: czerny gets NO work (method book only); raw-SQL backfill must
  end with an explicit rebuildCatalog invocation; note the works/pieces id namespace
  coexistence (work bach_bwv846 vs piece bach_bwv_846 — namespaced tables, documented);
  **retire tools/publisher/backfill_sql.py** (catalog→SQL direction now reverts Library
  edits — loaded footgun).
- **Preview audio ops**: encode Opus/MP3 (~64kbps; WAV would be ~170MB per 17-min movement),
  add the encoder to the worker image, and BUILD the staging sweeper before preview ships.
- Minor (documented): rebuildCatalog has no concurrency lease (single-admin risk accepted);
  gates jsonb keys are a worker↔SPA API — keep stable, SPA tolerates absence.

## Never build (research-flagged over-engineering)

Generic polymorphic containers table · FRBR manifestation/item layers · per-variation
entities · composer authority graphs (VIAF etc.) · musical facts as indexed columns
(jsonb suffices at low-thousands scale).

## Known pitfalls this design avoids

Movement-in-subtitle-string (→ work_index int) · arrangement metadata duplication (→ shared
on work) · progress forked per container (→ piece.id only) · title string playing four roles
(→ display jsonb keys) · opus stuffed in titles (→ works.catalogue) · slug renames (never).
