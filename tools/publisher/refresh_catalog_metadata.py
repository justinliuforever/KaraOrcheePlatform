#!/usr/bin/env python3
"""Refresh catalog.json display metadata from METADATA without touching files/versions.

Metadata edits don't bump bundle versions (bundles stay immutable); this is the CLI
ancestor of the admin panel's edit-metadata-without-rebuild operation.
"""
import json

from azure.core import MatchConditions
from azure.storage.blob import ContentSettings, BlobServiceClient

from publish_piece import CATALOG_BLOB, CONTAINER, METADATA, get_connection_string, now_iso


def main() -> None:
    service = BlobServiceClient.from_connection_string(get_connection_string())
    client = service.get_container_client(CONTAINER).get_blob_client(CATALOG_BLOB)
    dl = client.download_blob()
    etag = dl.properties.etag
    catalog = json.loads(dl.readall())

    changed = []
    for entry in catalog.get("pieces", []):
        meta = METADATA.get(entry["id"])
        if not meta:
            continue
        fresh = {
            "title": meta["title"], "composer": meta["composer"],
            "subtitle": meta["subtitle"], "mode": meta["mode"], "tier": meta["tier"],
            "tracking": "validated" if meta["tier"] == "core" else "experimental",
            "difficulty": meta.get("difficulty"),
        }
        if "book" in meta:
            fresh["book_id"] = meta["book"]["id"]
            fresh["book_index"] = meta["book"]["index"]
        if any(entry.get(k) != v for k, v in fresh.items()):
            entry.update(fresh)
            changed.append(entry["id"])

    if not changed:
        print("catalog metadata already current")
        return
    catalog["generated_at"] = now_iso()
    body = json.dumps(catalog, indent=2, ensure_ascii=False).encode("utf-8")
    client.upload_blob(body, overwrite=True, etag=etag,
                       match_condition=MatchConditions.IfNotModified,
                       content_settings=ContentSettings(content_type="application/json"))
    print(f"refreshed metadata for: {', '.join(changed)}")


if __name__ == "__main__":
    main()
