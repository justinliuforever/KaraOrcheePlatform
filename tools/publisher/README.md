# Piece-bundle publisher

Publishes an app piece bundle (score events, staff geometry, per-device SVGs) to the
dev blob store `stkaraoappdev` / container `piece-bundles`, then updates `catalog.json`
which the platform API serves at `GET /v1/catalog`.

## Usage

```bash
# from tools/publisher/
.venv/bin/python publish_piece.py --piece bach_bwv_846 \
  --src /Users/liuqinyuan/Desktop/KaraOrcheeAMT/Assets/scores/bach_bwv_846 [--version N] [--dry-run]
```

- `--src` is an assembled app-bundle dir: `<piece>.phone.svg`, `<piece>.ipad.svg`,
  `<piece>.ipad_portrait.svg`, `<piece>.staff.json`, `score_events.json`.
- `--version` defaults to the next integer after the highest published version for the
  piece. Passing an explicit `--version` that already exists is a hard error.
- `--dry-run` prints the plan + catalog entry without uploading.
- Auth: reads `AZURE_STORAGE_CONNECTION_STRING`, else fetches it via
  `az storage account show-connection-string` (never echoed).
- Display metadata (title/composer/subtitle/mode/tier) lives in the `METADATA` dict,
  extracted from `KaraOrcheeAMT/App/Repertoire/Repertoire.swift` (czerny_599_41
  title/composer come from `LessonContent/*.lesson.json`). Add an entry there for a new
  piece. `engine_sha` is read from `Assets/MANIFEST.txt` (`piano_amt_git`).

Setup once: `python3 -m venv .venv && .venv/bin/pip install azure-storage-blob`.

## Bundle layout (immutable)

```
piece-bundles/<piece_id>/v<N>/
  score_events.json   (required)   staff.json
  score.phone.svg     score.ipad.svg     score.ipad_portrait.svg
```

Each `v<N>` is **immutable** — re-publishing a piece writes a new version, never
overwrites an existing one. Files upload first; only after all land is `catalog.json`
updated (so the catalog never references missing blobs).

**SVG dedup:** if `phone.svg` and `ipad_portrait.svg` are byte-identical (the common
case), the portrait blob is not uploaded; its catalog entry points at `score.phone.svg`.
The variant entry is always present — dedup happens in the catalog, not by omission.

## Catalog schema (`catalog.json`)

```json
{
  "catalog_version": 1,
  "generated_at": "2026-07-05T21:43:41Z",
  "pieces": [
    {
      "id": "bach_bwv_846", "title": "...", "composer": "...", "subtitle": "...",
      "mode": "solo", "tier": "core", "bundle_version": 1, "engine_sha": "f662e61",
      "files": [
        {"role": "score_events", "url": "https://.../v1/score_events.json", "bytes": 0, "sha256": "..."},
        {"role": "geometry",     "url": "https://.../v1/staff.json", "bytes": 0, "sha256": "..."},
        {"role": "svg", "variant": "phone",         "url": ".../score.phone.svg", "bytes": 0, "sha256": "..."},
        {"role": "svg", "variant": "ipad",          "url": ".../score.ipad.svg", "bytes": 0, "sha256": "..."},
        {"role": "svg", "variant": "ipad_portrait", "url": ".../score.phone.svg", "bytes": 0, "sha256": "..."}
      ]
    }
  ]
}
```

`files[].url` are **full unsigned blob URLs**. The API rewrites every `files[].url` /
`stems[].url` with a short-lived read SAS at serve time, so URLs must stay unsigned in
the catalog. The catalog is updated with an ETag `If-Match` (optimistic concurrency);
a concurrent write triggers one re-download-and-retry.
