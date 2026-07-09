# RETIRED 2026-07-08: catalog->SQL direction now REVERTS Library edits (SQL is truth).
# Kept for history only. Do not run.
raise SystemExit('retired — see docs/catalog_roadmap.md')

#!/usr/bin/env python3
"""Backfill/sync catalog.json into the SQL registry (books/pieces/piece_versions).

Idempotent: books/pieces upsert, piece_versions insert-if-absent (immutable).
Interim direction is catalog->SQL; flips to SQL->catalog when the admin publish
endpoint lands. Blob paths are stored container-relative.
"""
import json
import os
import sys

import psycopg
from azure.storage.blob import BlobServiceClient

ACCOUNT = "stkaraoappdev"
CONTAINER = "piece-bundles"
URL_PREFIX = f"https://{ACCOUNT}.blob.core.windows.net/{CONTAINER}/"

BOOKS = {
    "czerny_op599": {
        "title": "Practical Method for Beginners, Op. 599",
        "author": "Carl Czerny",
        "rights": "public_domain",
        "rights_note": "Composer d. 1857; own Verovio engraving.",
    },
}

RIGHTS_NOTE = "PD composition; own Verovio engraving (source MusicXML provenance to confirm)."


def get_connection_string() -> str:
    cs = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if cs:
        return cs.strip()
    import subprocess
    out = subprocess.run(
        ["az", "storage", "account", "show-connection-string",
         "-n", ACCOUNT, "-g", "rg-karaorchee-app-dev", "-o", "tsv"],
        check=True, capture_output=True, text=True,
    )
    return out.stdout.strip()


def relative(url: str) -> str:
    if not url.startswith(URL_PREFIX):
        sys.exit(f"error: url outside expected container: {url[:80]}")
    return url[len(URL_PREFIX):]


def main() -> None:
    db_url = os.environ.get("DATABASE_URL") or sys.exit("error: DATABASE_URL not set")

    service = BlobServiceClient.from_connection_string(get_connection_string())
    raw = service.get_container_client(CONTAINER).get_blob_client("catalog.json").download_blob().readall()
    catalog = json.loads(raw)

    with psycopg.connect(db_url) as conn, conn.cursor() as cur:
        for bid, b in BOOKS.items():
            cur.execute(
                """INSERT INTO books (id, title, author, rights, rights_note)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title,
                       author = EXCLUDED.author, rights = EXCLUDED.rights,
                       rights_note = EXCLUDED.rights_note, updated_at = now()""",
                (bid, b["title"], b["author"], b["rights"], b["rights_note"]),
            )

        for p in catalog["pieces"]:
            tracking = p.get("tracking") or ("validated" if p.get("tier") == "core" else "experimental")
            cur.execute(
                """INSERT INTO pieces (id, title, composer, subtitle, mode, difficulty,
                       tracking, book_id, book_index, rights, rights_note, status, published_version)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'published',%s)
                   ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title,
                       composer = EXCLUDED.composer, subtitle = EXCLUDED.subtitle,
                       mode = EXCLUDED.mode, difficulty = EXCLUDED.difficulty,
                       tracking = EXCLUDED.tracking, book_id = EXCLUDED.book_id,
                       book_index = EXCLUDED.book_index, status = 'published',
                       published_version = EXCLUDED.published_version, updated_at = now()""",
                (p["id"], p["title"], p["composer"], p.get("subtitle", ""), p.get("mode", "solo"),
                 p.get("difficulty"), tracking, p.get("book_id"), p.get("book_index"),
                 "public_domain", RIGHTS_NOTE, p["bundle_version"]),
            )
            files = [
                {k: v for k, v in {
                    "role": f["role"], "variant": f.get("variant"),
                    "path": relative(f["url"]), "bytes": f["bytes"], "sha256": f["sha256"],
                }.items() if v is not None}
                for f in p["files"]
            ]
            cur.execute(
                """INSERT INTO piece_versions (piece_id, version, engine_sha, files)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (piece_id, version) DO NOTHING""",
                (p["id"], p["bundle_version"], p.get("engine_sha"), json.dumps(files)),
            )
        conn.commit()

        cur.execute("SELECT count(*) FROM pieces WHERE status = 'published'")
        n_pieces = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM piece_versions")
        n_versions = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM books")
        n_books = cur.fetchone()[0]
    print(f"backfilled: {n_pieces} published pieces, {n_versions} versions, {n_books} books")


if __name__ == "__main__":
    main()
