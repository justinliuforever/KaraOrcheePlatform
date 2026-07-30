#!/usr/bin/env python3
"""Create the collection books with their covers, and fit covers to books that
already exist. Idempotent: an existing book is matched by title and only its cover
is replaced. Prints the server-derived book ids the uploader needs.

Usage: books_and_covers.py <dropbox_lib_dir> [--dry-run]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import requests

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from admin_auth import token  # noqa: E402
from library_plan import BOOKS, EXISTING_BOOK_COVERS, RIGHTS_NOTE  # noqa: E402

API = "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io"


def main():
    lib = Path(sys.argv[1])
    dry = "--dry-run" in sys.argv
    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {token(interactive_ok=False)}"

    raw = s.get(f"{API}/admin/books", timeout=60).json()
    rows = raw if isinstance(raw, list) else raw.get("items", raw.get("books", []))
    existing = {b["title"]: b for b in rows if isinstance(b, dict)}
    print(f"registry has {len(existing)} books: {sorted(existing)}\n")

    resolved = {}
    for key, spec in BOOKS.items():
        cover = lib / spec["cover"]
        if not cover.exists():
            print(f"!! {key}: cover missing {cover}")
            continue
        found = existing.get(spec["title"])
        if found:
            print(f"= {key}: exists as {found['id']} — replacing cover only")
            resolved[key] = found["id"]
            if not dry:
                with open(cover, "rb") as fh:
                    r = s.put(f"{API}/admin/books/{found['id']}/cover",
                              files={"cover": (cover.name, fh, "image/jpeg")}, timeout=180)
                print(f"   cover: {r.status_code} {r.text[:120] if r.status_code >= 300 else 'ok'}")
            continue
        if dry:
            print(f"+ {key}: would create {spec['title']!r} with {spec['cover']}")
            continue
        with open(cover, "rb") as fh:
            r = s.post(f"{API}/admin/books",
                       data={"title": spec["title"], "author": spec["author"],
                             "publisher": spec["publisher"], "edition": spec["edition"],
                             "rights": "public_domain", "rightsNote": RIGHTS_NOTE},
                       files={"cover": (cover.name, fh, "image/jpeg")}, timeout=180)
        if r.status_code in (200, 201):
            bid = r.json().get("id")
            resolved[key] = bid
            print(f"+ {key}: created {bid}")
        else:
            print(f"!! {key}: create failed {r.status_code} {r.text[:200]}")

    for book_id, cover_rel in EXISTING_BOOK_COVERS.items():
        cover = lib / cover_rel
        if not cover.exists():
            print(f"!! {book_id}: cover missing {cover}")
            continue
        if dry:
            print(f"~ {book_id}: would replace cover with {cover_rel}")
            continue
        with open(cover, "rb") as fh:
            r = s.put(f"{API}/admin/books/{book_id}/cover",
                      files={"cover": (cover.name, fh, "image/jpeg")}, timeout=180)
        print(f"~ {book_id}: cover {r.status_code} "
              f"{r.text[:140] if r.status_code >= 300 else 'replaced'}")

    if resolved and not dry:
        out = HERE / "book_ids.json"
        out.write_text(json.dumps(resolved, indent=1))
        print(f"\nbook ids -> {out}: {resolved}")


if __name__ == "__main__":
    main()
