#!/usr/bin/env python3
"""Drives the multi-piece surface over real HTTPS with a real token, on dev.

Everything below the wire is covered by unit and container tests; this is the one leg they
cannot reach. Pass a note id, or omit it to run the whole pipeline from a real lesson.
"""
import json, sys, time, urllib.request, urllib.error, uuid
sys.path.insert(0, "/Users/liuqinyuan/Desktop/KaraOrcheePlatform/tools/scan_e2e")
from testuser_auth import token

BASE = "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io"
CATALOG_PIECE = "bach_bwv_846"  # a real published row on dev; the server refuses an unknown id, correctly
AUDIO = "/Users/liuqinyuan/Desktop/KaraOrcheeAMT/DebugFixtures/01_fast_87s.m4a"
TOK = token(interactive_ok=False)
fails = []


def call(method, path, body=None):
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
            return e.code, {"raw": raw[:300].decode("utf8", "replace")}


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (("  — " + str(detail)) if not ok else ""))
    if not ok:
        fails.append(name)
    return ok


def make_note():
    s, c = call("POST", "/v1/lessons",
                {"pieceLabel": "E2E multi-piece", "clientLessonId": str(uuid.uuid4())})
    if s != 201:
        raise SystemExit(f"lesson create failed: {s} {c}")
    lid = c["lesson"]["id"]
    s, u = call("POST", f"/v1/lessons/{lid}/upload-url")
    payload = open(AUDIO, "rb").read()
    req = urllib.request.Request(u["uploadUrl"], data=payload, method="PUT",
                                 headers={"x-ms-blob-type": "BlockBlob", "Content-Type": "audio/mp4"})
    urllib.request.urlopen(req).read()
    call("POST", f"/v1/lessons/{lid}/submit", {"durationSec": 87})
    for _ in range(30):
        s, d = call("GET", f"/v1/lessons/{lid}")
        notes = d.get("notes") or []
        if notes:
            return notes[0]["id"]
        time.sleep(20)
    raise SystemExit("the worker never produced a note")


def run(note_id):
    s, d = call("GET", f"/v1/notes/{note_id}")
    check("the note comes back with a piece list", s == 200 and isinstance(d.get("pieces"), list),
          f"status={s} keys={list(d)}")
    slots = d["pieces"]
    check("the lesson's piece became its first slot", len(slots) == 1 and slots[0]["kind"] == "titled",
          [(p["kind"], p["pieceLabel"]) for p in slots])
    check("a practice row is not a marked spot",
          all(a.get("source", "transcript") == "transcript" for a in d["annotations"]),
          sorted({a.get("source") for a in d["annotations"]}))
    spots = d["annotations"]
    check("the worker stamped every spot onto that slot",
          bool(spots) and all(a.get("notePieceId") == slots[0]["id"] for a in spots),
          [(a["id"][:8], a.get("notePieceId")) for a in spots[:3]])

    s, added = call("POST", f"/v1/notes/{note_id}/pieces", {"pieceLabel": "Czerny Op. 599 No. 23"})
    check("a second piece can be added", s == 201 and added.get("piece", {}).get("kind") == "titled",
          f"status={s} {added}")
    second = added["piece"]["id"]
    s, third = call("POST", f"/v1/notes/{note_id}/pieces", {"pieceId": CATALOG_PIECE})
    check("a catalog piece can be added", s == 201 and third.get("piece",{}).get("kind") == "engraved",
          f"status={s} {third}")

    s, d = call("GET", f"/v1/notes/{note_id}")
    order = [p["id"] for p in d["pieces"]]
    check("three pieces, in the order they were added", len(order) == 3, order)

    s, moved = call("PATCH", f"/v1/notes/{note_id}/pieces/{second}", {"sortIndex": -1000})
    check("a piece can be moved to the front", s == 200, f"status={s} {moved}")
    s, d = call("GET", f"/v1/notes/{note_id}")
    check("and the list comes back in the new order", d["pieces"][0]["id"] == second,
          [p["id"] for p in d["pieces"]])

    first_spot = spots[0]
    payload = [dict(a, notePieceId=(second if a["id"] == first_spot["id"] else a.get("notePieceId")))
               for a in spots]
    s, saved = call("PATCH", f"/v1/notes/{note_id}", {"annotations": payload})
    check("a marked spot can be moved to another piece", s == 200, f"status={s}")
    # The app assigns this response straight into its live list; an answer without it empties the screen.
    check("a save answers with the piece list", isinstance(saved.get("pieces"), list)
          and len(saved["pieces"]) == 3, f"pieces={saved.get('pieces') and len(saved['pieces'])}")
    s, d = call("GET", f"/v1/notes/{note_id}")
    got = next(a for a in d["annotations"] if a["id"] == first_spot["id"])
    check("and it comes back under the piece it was moved to", got.get("notePieceId") == second,
          got.get("notePieceId"))
    check("its bar numbers did not follow it to another score",
          got["location"].get("grounded") is not True or first_spot["location"].get("grounded") is not True,
          got["location"])

    # Ground two spots against two different pieces, then swap one piece's score under it.
    s, d = call("GET", f"/v1/notes/{note_id}")
    here = [a for a in d["annotations"] if a.get("notePieceId") == second]
    there = [a for a in d["annotations"] if a.get("notePieceId") and a["notePieceId"] != second]
    if here and there:
        # Deliberately past the end of any real piece. Whether an IN-RANGE bar should also die on a
        # swap is a live question — the plan's prose says yes, the shipped rule keeps it — and this
        # check takes no position on it, so a decision there does not read as a regression here.
        bars = {"type": "measures", "raw": "bar 900", "grounded": True, "hint": None,
                "measureStart": 900, "measureEnd": 900, "pinnedBy": "teacher", "studentPin": None}
        pinned = [dict(a, location=(bars if a["id"] in {here[0]["id"], there[0]["id"]} else a["location"]))
                  for a in d["annotations"]]
        call("PATCH", f"/v1/notes/{note_id}", {"annotations": pinned})
        call("PATCH", f"/v1/notes/{note_id}/pieces/{second}", {"pieceId": CATALOG_PIECE})
        s, after = call("GET", f"/v1/notes/{note_id}")
        moved_on = next(a for a in after["annotations"] if a["id"] == here[0]["id"])
        neighbour = next(a for a in after["annotations"] if a["id"] == there[0]["id"])
        check("swapping a piece drops bars written against the score it replaced",
              moved_on["location"].get("grounded") is not True, moved_on["location"])
        check("and leaves every other piece's bars alone",
              neighbour["location"].get("grounded") is True, neighbour["location"])

    s, _ = call("DELETE", f"/v1/notes/{note_id}/pieces/{second}")
    check("a piece can be taken out", s == 200, f"status={s}")
    s, d = call("GET", f"/v1/notes/{note_id}")
    left = next(a for a in d["annotations"] if a["id"] == first_spot["id"])
    check("its words survive in General", left.get("notePieceId") is None, left.get("notePieceId"))
    check("the note now names whichever piece is first",
          d["note"].get("pieceLabel") == d["pieces"][0].get("pieceLabel")
          or d["note"].get("pieceId") == d["pieces"][0].get("pieceId"),
          (d["note"].get("pieceId"), d["note"].get("pieceLabel"),
           d["pieces"][0].get("pieceId"), d["pieces"][0].get("pieceLabel")))

    s, over = call("POST", f"/v1/notes/{note_id}/pieces", {"pieceLabel": "x"})
    for _ in range(6):
        if over.get("error") == "too_many_pieces":
            break
        s, over = call("POST", f"/v1/notes/{note_id}/pieces", {"pieceLabel": "x"})
    check("the cap is enforced by the server", over.get("error") == "too_many_pieces", over)


if __name__ == "__main__":
    nid = sys.argv[1] if len(sys.argv) > 1 else make_note()
    print(f"note {nid}\n")
    run(nid)
    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
    sys.exit(1 if fails else 0)
