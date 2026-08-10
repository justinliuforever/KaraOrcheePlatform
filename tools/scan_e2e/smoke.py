#!/usr/bin/env python3
"""Smoke the deployed score-scan routes, aimed at what the stage-gate fixes changed."""
import io, json, sys, uuid, urllib.request, urllib.error
sys.path.insert(0, "/Users/liuqinyuan/Desktop/KaraOrcheePlatform/tools/collection_splitter")
from admin_auth import token
from PIL import Image

BASE = "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io"
TOK = token(interactive_ok=False)
results = []


def call(method, path, body=None, expect=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + TOK,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except Exception:
            return e.code, {"raw": raw[:200].decode("utf8", "replace")}


def put_blob(url, payload):
    req = urllib.request.Request(url, data=payload, method="PUT",
                                 headers={"x-ms-blob-type": "BlockBlob",
                                          "Content-Type": "image/jpeg"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def page_jpeg(seed):
    img = Image.new("RGB", (900, 1200), "white")
    px = img.load()
    for staff in range(6):
        for line in range(5):
            y = 120 + staff * 170 + line * 14 + seed
            for x in range(60, 840):
                px[x, y] = (20, 20, 20)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return buf.getvalue()


def with_exif(jpeg):
    payload = b"Exif\x00\x00" + b"II*\x00\x08\x00\x00\x00\x00\x00"
    seg = b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload
    return jpeg[:2] + seg + jpeg[2:]


def check(name, ok, detail=""):
    results.append((ok, name, detail))
    print(("PASS  " if ok else "FAIL  ") + name + ("   " + detail if detail else ""))


status, me = call("GET", "/v1/me")
check("signed in with a notes role", status == 200 and (me.get("isTeacher") or me.get("isStudent")),
      f"status={status} teacher={me.get('isTeacher')} student={me.get('isStudent')}")
if status != 200:
    print(json.dumps(me)[:400]); sys.exit(1)

# --- happy path, then every idempotency claim the fixes made ---
client_id = str(uuid.uuid4())
status, created = call("POST", "/v1/score-scans",
                       {"title": "E2E smoke", "pageCount": 2, "clientScanId": client_id})
check("create returns 201 with an upload url per page",
      status == 201 and len(created.get("uploadUrls") or []) == 2, f"status={status}")
scan_id = created["scan"]["id"]

status2, dup = call("POST", "/v1/score-scans",
                    {"title": "E2E smoke", "pageCount": 2, "clientScanId": client_id})
check("a duplicate create hands back the same row instead of 500",
      status2 in (200, 201) and dup.get("scan", {}).get("id") == scan_id,
      f"status={status2} id={dup.get('scan', {}).get('id')}")

for entry in created["uploadUrls"]:
    code = put_blob(entry["url"], page_jpeg(entry["page"]))
    check(f"page {entry['page']} uploads", code == 201, f"status={code}")

status, committed = call("POST", f"/v1/score-scans/{scan_id}/commit")
check("commit promotes the scan to ready",
      status == 200 and committed.get("scan", {}).get("status") == "ready",
      f"status={status} state={committed.get('scan', {}).get('status')} err={committed.get('error')}")

status, again = call("POST", f"/v1/score-scans/{scan_id}/commit")
check("a commit whose answer was lost is answered again, not refused",
      status == 200 and again.get("scan", {}).get("status") == "ready",
      f"status={status} err={again.get('error')}")

status, detail = call("GET", f"/v1/score-scans/{scan_id}")
check("detail returns both pages and an empty usage list",
      status == 200 and len(detail.get("pages") or []) == 2 and detail.get("usedBy") == [],
      f"status={status} pages={len(detail.get('pages') or [])} usedBy={detail.get('usedBy')}")

# --- the refusals, and whether they say which page ---
bad_id = str(uuid.uuid4())
status, bad = call("POST", "/v1/score-scans",
                   {"title": "E2E refusal", "pageCount": 2, "clientScanId": bad_id})
bad_scan = bad["scan"]["id"]
put_blob(bad["uploadUrls"][0]["url"], page_jpeg(1))
put_blob(bad["uploadUrls"][1]["url"], b"this is not a jpeg at all")
status, refused = call("POST", f"/v1/score-scans/{bad_scan}/commit")
check("a page that is not an image is refused and the page is named",
      status == 415 and refused.get("n") == 2,
      f"status={status} n={refused.get('n')} reason={refused.get('reason')} msg={refused.get('message')}")

exif_id = str(uuid.uuid4())
status, ex = call("POST", "/v1/score-scans",
                  {"title": "E2E exif", "pageCount": 1, "clientScanId": exif_id})
exif_scan = ex["scan"]["id"]
put_blob(ex["uploadUrls"][0]["url"], with_exif(page_jpeg(1)))
status, exr = call("POST", f"/v1/score-scans/{exif_scan}/commit")
check("a page carrying EXIF is refused",
      status == 415 and exr.get("reason") in ("exif", "metadata"),
      f"status={status} reason={exr.get('reason')}")

# --- cleanup, which is itself the delete path ---
for sid in (scan_id, bad_scan, exif_scan):
    status, _ = call("DELETE", f"/v1/score-scans/{sid}")
    check(f"delete {sid[:8]} succeeds", status in (200, 204), f"status={status}")

status, _ = call("GET", f"/v1/score-scans/{scan_id}")
check("a deleted scan is gone", status in (404, 410), f"status={status}")

failed = [r for r in results if not r[0]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
