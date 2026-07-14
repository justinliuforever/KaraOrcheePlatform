# Notation-detail fidelity — deep research digest (2026-07-13)

103-agent adversarially-verified research run (20 claims confirmed 3-0, 5 refuted, 4 open).
Full result: session task wh82ntkha. Trigger: colleague's Sibelius-engraved scores lose
fingerings/expression detail in our rendering (example: La Pastorale, job 39729a7a).

## Confirmed findings (all 3-0 verified, sources in parentheses)

1. **Fingering-as-`<words>` is Sibelius Direct-export behavior, industry-recognized.**
   Sibelius has no semantic fingering element in its direct export; Dorico's own docs state
   they cannot import fingerings from Sibelius MusicXML. (musescore handbook, steinberg docs)

2. **Dolet 8 plugin = the Sibelius workflow that CAN export true fingerings.**
   Open-source (MakeMusicInc/DoletSibelius), frozen at 8.3 (Jan 2023), nominal Sibelius
   Ultimate 2019.5+. v8.0: "Multi-line fingerings are now exported as fingerings rather than
   text". PREREQUISITE: digits must be entered in the Fingering TEXT STYLE
   (StyleId `text.staff.space.fingering`); Technique/Expression digits stay `<words>` even
   via Dolet. Sibelius 26.6 compatibility UNTESTED (open question — needs colleague round-trip).

3. **MuseScore's "Infer text type based on content" importer is the exact prior art for our
   worker-side converter** (importmusicxmlpass2.cpp): regex digits 0–5 incl. "1-2" and newline
   chord stacks; candidates sorted by default-y for stack order; tick rounded to the measure's
   rhythmic gcd; attached to chord notes scanning up to 4 tracks; plain-text fallback.
   **Beat/tick-position matching is the proven primary strategy — NOT default-x proximity.**

4. **Verovio 6.2.1 renders true `<technical><fingering>` well**: maps to note-anchored MEI
   `<fing>` (startid), digits centered on the anchored notehead, ALL chord fingerings imported
   since 6.1.0, placement control @place/@vo/@ho + --fingering-scale functional (empirically
   verified on pip 6.2.1). fingGrp NOT supported → emit one <fingering> per chord note.
   **Injection point = MusicXML layer pre-verovio; no MEI edit needed.**

5. **Metronome tofu boxes = our stitcher strips verovio's @font-face.** verovio 6.2.1 default
   `smuflTextFont=embedded` puts a base64 Leipzig WOFF2 @font-face (~58KB) in a per-page
   `<style>` block, making the SVG self-contained. Our `staff.py` stitcher extracts only
   outer/inner/defs/page-margin → the style block is dropped. ('linked' = @import from
   verovio.org, offline-hostile; 'none' = tofu; "base64" is NOT a valid enum value.)
   No option exists to render text-SMuFL glyphs as paths (v5.3 refactor touched path glyphs
   only). Alternative assets: fonts/Leipzig/Leipzig.woff2 (46,688 B, SIL OFL) + data/Leipzig.css
   at the version-6.2.1 tag. CAVEAT: SVG consumed via `<img>` may ignore data-URI fonts in some
   engines — admin PreviewCard uses `<img>`; iOS StaffHTML inlines SVG in DOM (safe). Verify
   empirically; fall back to inlining in admin if needed.

6. **Mechanism of today's misplacement**: verovio maps bare `<words>` → MEI `<dir>`
   (tstamp/staff-anchored floating text; default-y → @vgrp, not @vo). Historical: <fing>
   didn't exist before 2020 (issue #803).

## Refuted (do NOT cite)
- "Dolet fixes metronome-adjacent text loss" (0-3) — ADANTINO drop remains UNEXPLAINED.
- "verovio flattens articulation placement" (0-3) — no evidence for a broad artic problem.
- Dolet promoting arbitrary text→semantic (0-3) — only Fingering-style digits convert.

## Open questions (need controlled tests, not web research)
1. Which Sibelius text style survives Direct export as tempo text (ADANTINO drop mechanism)?
   → colleague exports a test score with Tempo text vs Expression vs Technique vs plain text.
2. Does Dolet 8.3 install/work under Sibelius 26.6, and are the colleague's fingerings in the
   Fingering text style? → one round-trip on the Burgmüller file settles both.
3. default-x/default-y semantics on Sibelius words — unverified; converter must not rely on them
   beyond stack ordering (default-y).
4. Notation-class taxonomy (articulations/pedal/ottava/hairpins/grace/dynamics-between-staves)
   for Sibelius-direct→verovio — unanswered; needs a purpose-built test score per class.

## Outcome (2026-07-13/14 — all shipped, worker rev 0000019)

The Dolet round-trip test settled the open questions faster than planned:
- **Dolet 8.3 works on Sibelius 26.6** (file: `Sibelius 2026.6` + `Dolet 8.3`); all 70
  fingerings exported as true `<technical><fingering>`; **"ADANTINO." survived** (the
  tempo-word drop is a Direct-export bug that Dolet avoids — open Q1/Q2 closed).
- Guide rule shipped: XML via Dolet plugin menu; MIDI/audio via normal export;
  fingerings must use the Fingering text style.
- **R2 shipped** (`1d2f858`): stitcher carries verovio's two `<style>` blocks
  (scoped CSS + Leipzig @font-face) — metronome tofu fixed, dir text gets its
  intended italics. R1 (digit-words converter) DEPRIORITIZED to defense-in-depth.
- **engraving_norm shipped** (`5bfd397`, `21730f4` — worker `pipeline/engraving_norm.py`,
  colleague round-2/3 feedback): (a) bottom-staff fingerings → placement="below" +
  per-note stack reorder by default-y desc (verovio stacks below-placements in doc
  order staff-outward → editor's visual order); (b) bare "N." words in measure 1
  dropped (edition piece numbers); (c) **re-anchor pass**: Dolet's x-proximity
  matching hung a chord's fingering stack on a lone note in the OTHER VOICE
  (m11: 2/5 for the held F3+C4 double-stop landed on the off-beat D4 eighth; proof:
  fingering default-y values = the chord notes' positions). Shape-detected (lone
  note + ≥2 stacked fings + unique same-staff unfingered chord of matching count
  SOUNDING at that onset — overlap window, not same-onset) and moved to the chord
  principal. Tests 61.
- Residual known gap (accepted for now): the source edition prints chord fingerings
  BESIDE the noteheads; verovio ignores default-x/y on fingering, so we render below
  the staff (modern-edition convention). True beside-notehead needs MEI @vo/@ho
  post-processing — renderer-side work, NOT fixable by any exporter/plugin.

## Phase R design (original proposal, superseded by the outcome above)
- **R1 worker fingering converter** (MusicXML pre-verovio, port of MuseScore heuristic):
  digit-words → per-note `<technical><fingering>`; conservative gate (convert only on confident
  note match; ambiguous stays words = today's rendering); fixture corpus from colleague's real
  uploads in blob; mirror in piano-amt prototype/staff for parity.
- **R2 stitcher font fix**: carry page-1 `<style>` @font-face into stitched SVG (staff.py +
  prototype mirror + test_shim/test_staff_parity refresh); empirical check of admin `<img>`
  rendering, inline fallback if engine ignores data-URI fonts.
- **R3 colleague guide v1**: numeric metronome mark required (120-default rule);
  dotted metronome + Italian prefix fine (Pastorale evidence); fingerings in Fingering text
  style; Dolet round-trip test; tempo-text style A/B test (open Q1/Q2).
- Published pieces re-render on next rebuild → renders change (better); coordinate with
  version/rebuild flow.
