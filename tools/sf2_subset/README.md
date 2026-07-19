# sf2_subset — SoundFont single-preset extractor

Extracts one preset from a SoundFont 2 file into a standalone `.sf2`, copying the
full preset chain (preset zones → instrument → instrument zones → samples,
including stereo-linked partners) **byte-for-byte**. All generators and modulators
are carried unchanged — only instrument/sample indices are rewritten and sample
offsets rebased — so the extracted preset sounds identical to the source.
Optionally remaps the preset's bank/program number in the output (for samplers
that hardcode program 0).

Stdlib only (Python 3.9+). No dependencies.

## Usage

```
python3 extract_violin.py SOURCE.sf2 BANK PROGRAM OUTPUT.sf2 \
    [--remap-to-program N] [--remap-to-bank N]
```

The KaraOrchee violin build (FluidR3 bank 0 prog 40 → standalone, exposed at prog 0
because the app's sampler hardcodes program 0):

```
python3 extract_violin.py FluidR3_GM.sf2 0 40 FluidR3_Violin-20260719.sf2 --remap-to-program 0
```

Source `FluidR3_GM-20260709.sf2` + license live in the Azure blob container
`soundfont` (storage account behind `ca-app-api-dev`'s `storagecs` secret).
The FluidR3 MIT license file must ship beside any derived artifact.

## What it preserves

- Every pgen/pmod and igen/imod record of the preset chain, in order
  (global zones — first zone without instrument/sampleID generator — included).
- Sample PCM copied verbatim from `sdta.smpl`; loop points rebased to the new
  offsets with identical start-relative structure; spec-mandated 46 zero sample
  points appended after each sample.
- Stereo pairs: `shdr` sampleLink partners are collected transitively and link
  indices rewritten (a dangling source link would degrade that sample to mono
  rather than emit an invalid index).
- `phdr` library/genre/morphology, preset and instrument names; INFO chunk
  carried over with an `INAM`/`ICMT` marking provenance.
- Terminal EOP/EOI/EOS + terminal bag/gen/mod records appended per spec;
  RIFF chunk sizes word-aligned.

Not supported: `sm24` (24-bit) sample chunks, ROM samples (neither occurs in
FluidR3; the tool fails loudly instead of writing a wrong file).

## Verification results — FluidR3_Violin-20260719.sf2 (2026-07-18)

Source: `FluidR3_GM-20260709.sf2`, 148,345,256 bytes, sha256 prefix `2ae766ab5c5deb6f`.
Output: **3,051,862 bytes (2.9 MB)** — 1 preset ("Violin", bank 0 prog 0, 10 zones),
1 instrument (29 zones incl. global), 28 samples (14 stereo pairs).

| Check | Method | Result |
|---|---|---|
| Structural | sf2utils 1.0 (audioop-lts on py3.14), log capture at DEBUG | **PASS** — opens with 0 warnings; preset/instrument/sample counts + terminals as expected |
| Generator-level diff | dump of full source prog-40 chain vs subset prog-0 chain, indices abstracted to chain position, PCM compared by sha256 | **IDENTICAL** — 252 chain lines 1:1 (184 generator records, 0 explicit modulators — FluidR3 uses spec-default modulators — 28 samples: same PCM hash, loop points, rate, pitch, correction, link topology) |
| Audible equivalence | fluidsynth 2.x renders of the same 33-note C3–C6 scale+arpeggio MIDI (source@prog40 vs subset@prog0), 44.1 kHz stereo 16-bit | **BYTE-IDENTICAL** — 1,863,424 samples, max abs diff 0, RMS diff 0.0 |

Only fluidsynth message: "No preset found on channel 9 [bank=128 prog=0]" when
loading the subset — expected (single-preset file has no drum bank; the test MIDI
plays nothing on channel 9).

Verification scripts (`check_structural.py`, `gen_diff.py`, `make_midi.py`,
`compare_wav.py`) were run from the session scratchpad; they are throwaway but
the method above is enough to reproduce them.
