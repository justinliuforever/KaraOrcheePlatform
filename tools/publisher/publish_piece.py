#!/usr/bin/env python3
"""Publish an immutable piece bundle to the dev blob store and update catalog.json.

Bundle layout: piece-bundles/<piece_id>/v<N>/{score_events.json, staff.json,
score.phone.svg, score.ipad.svg, score.ipad_portrait.svg}. Versions are immutable:
re-publishing a piece means a new v<N>. Catalog URLs are full UNSIGNED blob URLs; the
API appends a read SAS at serve time.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

from azure.core import MatchConditions
from azure.core.exceptions import (
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)
from azure.storage.blob import BlobServiceClient, ContentSettings

ACCOUNT = "stkaraoappdev"
RESOURCE_GROUP = "rg-karaorchee-app-dev"
CONTAINER = "piece-bundles"
CATALOG_BLOB = "catalog.json"
BLOB_BASE = f"https://{ACCOUNT}.blob.core.windows.net/{CONTAINER}"

# Display metadata extracted from KaraOrcheeAMT/App/Repertoire/Repertoire.swift.
# czerny_599_41 is a LessonContent-only piece (not in the Pieces catalogue): title/
# composer come from LessonContent/*.lesson.json; subtitle/mode/tier are sensible
# defaults for a solo beginner study.
# tier kept for app-compat (maps to the shipped PieceTier); tracking/difficulty are the
# forward model (tracking = follower reliability, difficulty = 1..5 pedagogy, provisional).
METADATA = {
    "bach_bwv_846": {
        "title": "The Well-Tempered Clavier, Book I",
        "composer": "J. S. Bach",
        "subtitle": "Prelude No. 1 in C major, BWV 846",
        "mode": "solo", "tier": "core", "difficulty": 3,
    },
    "czerny_599_41": {
        "title": "Practical Method for Beginners, Op. 599",
        "composer": "Carl Czerny",
        "subtitle": "No. 41",
        "mode": "solo", "tier": "core", "difficulty": 1,
        "book": {"id": "czerny_op599", "index": 41},
    },
    "scriabin_etude_op8_11": {
        "title": "12 Études, Op. 8",
        "composer": "Alexander Scriabin",
        "subtitle": "No. 11 in B-flat minor",
        "mode": "solo", "tier": "experimental", "difficulty": 5,
    },
    "mozart_k330_mvt1": {
        "title": "Piano Sonata No. 10, K. 330",
        "composer": "W. A. Mozart",
        "subtitle": "I. Allegro moderato",
        "mode": "solo", "tier": "core", "difficulty": 4,
    },
    "rach_op23_4": {
        "title": "10 Preludes, Op. 23",
        "composer": "Sergei Rachmaninoff",
        "subtitle": "No. 4 in D major",
        "mode": "solo", "tier": "core", "difficulty": 5,
    },
    "schubert_sonata_894_mvt2": {
        "title": "Piano Sonata No. 18, D. 894",
        "composer": "Franz Schubert",
        "subtitle": "II. Andante",
        "mode": "solo", "tier": "core", "difficulty": 4,
    },
    "haydn_sonata_48_2": {
        "title": "Keyboard Sonata in C major, Hob. XVI:48",
        "composer": "Joseph Haydn",
        "subtitle": "II. Rondo — Presto",
        "mode": "solo", "tier": "core", "difficulty": 4,
    },
    "chopin_etude_op25_12_ocean": {
        "title": "12 Études, Op. 25",
        "composer": "Frédéric Chopin",
        "subtitle": "No. 12 in C minor, “Ocean”",
        "mode": "solo", "tier": "experimental", "difficulty": 5,
    },
    "liszt_trans_5_feux_follets": {
        "title": "Transcendental Études, S. 139",
        "composer": "Franz Liszt",
        "subtitle": "No. 5, “Feux follets”",
        "mode": "solo", "tier": "experimental", "difficulty": 5,
    },
    "bach_fugue_bwv_846": {
        "title": "The Well-Tempered Clavier, Book I",
        "composer": "J. S. Bach",
        "subtitle": "Fugue No. 1 in C major, BWV 846",
        "mode": "solo", "tier": "experimental", "difficulty": 4,
    },
    "chopin_sonata3_mvt4": {
        "title": "Piano Sonata No. 3, Op. 58",
        "composer": "Frédéric Chopin",
        "subtitle": "IV. Finale — Presto non tanto",
        "mode": "solo", "tier": "experimental", "difficulty": 5,
    },
}

# source basename (relative to --src, {p}=piece_id) -> (bundle blob name, role, variant, content_type, required)
LAYOUT = [
    ("score_events.json", "score_events.json", "score_events", None, "application/json", True),
    ("{p}.staff.json", "staff.json", "geometry", None, "application/json", False),
    ("{p}.phone.svg", "score.phone.svg", "svg", "phone", "image/svg+xml", False),
    ("{p}.ipad.svg", "score.ipad.svg", "svg", "ipad", "image/svg+xml", False),
    ("{p}.ipad_portrait.svg", "score.ipad_portrait.svg", "svg", "ipad_portrait", "image/svg+xml", False),
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_engine_sha(src: str) -> str:
    # MANIFEST.txt sits at the Assets root (src is Assets/scores/<piece>/).
    manifest = os.path.normpath(os.path.join(src, "..", "..", "MANIFEST.txt"))
    try:
        with open(manifest, "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("piano_amt_git="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return "unknown"


def get_connection_string() -> str:
    cs = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if cs:
        return cs.strip()
    out = subprocess.run(
        ["az", "storage", "account", "show-connection-string",
         "-n", ACCOUNT, "-g", RESOURCE_GROUP, "-o", "tsv"],
        check=True, capture_output=True, text=True,
    )
    return out.stdout.strip()


def existing_versions(container, piece: str) -> set:
    versions = set()
    for blob in container.list_blobs(name_starts_with=f"{piece}/v"):
        m = re.match(rf"^{re.escape(piece)}/v(\d+)/", blob.name)
        if m:
            versions.add(int(m.group(1)))
    return versions


def load_files(src: str, piece: str) -> list:
    files = []
    for src_tmpl, blob_name, role, variant, ctype, required in LAYOUT:
        path = os.path.join(src, src_tmpl.format(p=piece))
        if not os.path.exists(path):
            if required:
                sys.exit(f"error: required file missing: {path}")
            continue
        with open(path, "rb") as fh:
            data = fh.read()
        files.append({
            "src_path": path, "blob_name": blob_name, "role": role, "variant": variant,
            "content_type": ctype, "data": data,
            "sha256": sha256_bytes(data), "bytes": len(data),
        })
    return files


def build_entry(piece: str, version: int, engine_sha: str, files: list) -> tuple:
    """Return (catalog_entry, blobs_to_upload). Dedups phone/ipad_portrait when identical."""
    by_variant = {f.get("variant"): f for f in files}
    phone = by_variant.get("phone")
    portrait = by_variant.get("ipad_portrait")
    dedup = bool(phone and portrait and phone["sha256"] == portrait["sha256"])

    upload = [f for f in files if not (dedup and f.get("variant") == "ipad_portrait")]

    prefix = f"{BLOB_BASE}/{piece}/v{version}"
    entries = []
    for f in files:
        blob_name = phone["blob_name"] if (dedup and f.get("variant") == "ipad_portrait") else f["blob_name"]
        e = {"role": f["role"]}
        if f["variant"]:
            e["variant"] = f["variant"]
        e.update({"url": f"{prefix}/{blob_name}", "bytes": f["bytes"], "sha256": f["sha256"]})
        entries.append(e)

    meta = METADATA[piece]
    entry = {
        "id": piece, "title": meta["title"], "composer": meta["composer"],
        "subtitle": meta["subtitle"], "mode": meta["mode"], "tier": meta["tier"],
        "tracking": "validated" if meta["tier"] == "core" else "experimental",
        "difficulty": meta.get("difficulty"),
        "bundle_version": version, "engine_sha": engine_sha, "files": entries,
    }
    if "book" in meta:
        entry["book_id"] = meta["book"]["id"]
        entry["book_index"] = meta["book"]["index"]
    return entry, upload, dedup


def upload_bundle(container, piece: str, version: int, blobs: list) -> None:
    for f in blobs:
        name = f"{piece}/v{version}/{f['blob_name']}"
        container.get_blob_client(name).upload_blob(
            f["data"], overwrite=True,
            content_settings=ContentSettings(content_type=f["content_type"]),
        )


def update_catalog(container, entry: dict) -> None:
    cat_client = container.get_blob_client(CATALOG_BLOB)
    for attempt in range(2):
        try:
            dl = cat_client.download_blob()
            etag = dl.properties.etag
            catalog = json.loads(dl.readall())
        except ResourceNotFoundError:
            etag = None
            catalog = {"catalog_version": 1, "generated_at": now_iso(), "pieces": []}

        catalog["generated_at"] = now_iso()
        pieces = catalog.setdefault("pieces", [])
        for i, p in enumerate(pieces):
            if p.get("id") == entry["id"]:
                pieces[i] = entry
                break
        else:
            pieces.append(entry)
        body = json.dumps(catalog, indent=2, ensure_ascii=False).encode("utf-8")
        settings = ContentSettings(content_type="application/json")
        try:
            if etag is None:
                cat_client.upload_blob(body, overwrite=False, content_settings=settings)
            else:
                cat_client.upload_blob(body, overwrite=True, content_settings=settings,
                                       etag=etag, match_condition=MatchConditions.IfNotModified)
            return
        except (ResourceModifiedError, ResourceExistsError):
            if attempt == 1:
                raise
    raise RuntimeError("catalog update failed after retry")


def main() -> None:
    ap = argparse.ArgumentParser(description="Publish a piece bundle to dev blob storage.")
    ap.add_argument("--piece", required=True)
    ap.add_argument("--src", required=True)
    ap.add_argument("--version", type=int)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    piece = args.piece
    if piece not in METADATA:
        sys.exit(f"error: no display metadata for piece '{piece}' (add it to METADATA)")
    if not os.path.isdir(args.src):
        sys.exit(f"error: --src not a directory: {args.src}")

    engine_sha = read_engine_sha(args.src)
    files = load_files(args.src, piece)

    service = BlobServiceClient.from_connection_string(get_connection_string())
    container = service.get_container_client(CONTAINER)

    present = existing_versions(container, piece)
    if args.version is not None:
        if args.version in present:
            sys.exit(f"error: {piece} v{args.version} already published (bundles are immutable)")
        version = args.version
    else:
        version = (max(present) + 1) if present else 1

    entry, upload, dedup = build_entry(piece, version, engine_sha, files)

    naive_bytes = sum(f["bytes"] for f in files)
    uploaded_bytes = sum(f["bytes"] for f in upload)
    print(f"piece={piece} version=v{version} engine_sha={engine_sha}")
    print(f"  files: {[f['blob_name'] for f in files]}")
    print(f"  dedup(phone==ipad_portrait): {dedup}")
    print(f"  uploaded bytes: {uploaded_bytes}  naive bytes: {naive_bytes}  saved: {naive_bytes - uploaded_bytes}")
    for f in upload:
        print(f"    {f['blob_name']:22} {f['bytes']:>8}  {f['sha256'][:16]}…  {f['content_type']}")

    if args.dry_run:
        print("[dry-run] no upload; catalog entry:")
        print(json.dumps(entry, indent=2, ensure_ascii=False))
        return

    upload_bundle(container, piece, version, upload)
    update_catalog(container, entry)
    print(f"published {piece} v{version} ({len(upload)} blobs) and updated {CATALOG_BLOB}")


if __name__ == "__main__":
    main()
