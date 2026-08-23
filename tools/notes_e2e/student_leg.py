#!/usr/bin/env python3
"""Drives a multi-piece note all the way to a REAL second account, on dev.

The other end of multipiece.py: that one stops at the teacher's draft, so nothing until now proved a
student is handed the piece list, or that each piece carries the version its bars were written
against. Both accounts are real CIAM users and the audio really goes through the worker.

Needs two cached credentials:
  tools/scan_e2e/testuser_auth.py                       -> the teacher
  KARAORCHEE_TESTUSER=student tools/scan_e2e/testuser_auth.py student
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error, uuid

AUTH_DIR = "/Users/liuqinyuan/Desktop/KaraOrcheePlatform/tools/scan_e2e"
BASE = "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io"
CATALOG_PIECE = "bach_bwv_846"
AUDIO = "/Users/liuqinyuan/Desktop/KaraOrcheeAMT/DebugFixtures/01_fast_87s.m4a"
fails = []


def token_for(account: str) -> str:
    env = dict(os.environ)
    env["KARAORCHEE_TESTUSER"] = account
    out = subprocess.run(
        [sys.executable, "-c",
         "import sys;sys.path.insert(0,'.');from testuser_auth import token;print(token(interactive_ok=False))"],
        capture_output=True, text=True, env=env, cwd=AUTH_DIR)
    if out.returncode:
        raise SystemExit(f"no cached credential for {account or 'teacher'}: {out.stderr.strip()}")
    return out.stdout.strip()


TEACHER = token_for("")
STUDENT = token_for("student")


def call(tok, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + tok,
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


def student_id():
    s, roster = call(TEACHER, "GET", "/v1/me/students")
    items = roster.get("items") or []
    if not items:
        raise SystemExit("the teacher has no students — pair the two accounts first")
    return items[0]["studentId"]


def make_note():
    s, c = call(TEACHER, "POST", "/v1/lessons",
                {"pieceLabel": "E2E student leg", "clientLessonId": str(uuid.uuid4())})
    if s != 201:
        raise SystemExit(f"lesson create failed: {s} {c}")
    lid = c["lesson"]["id"]
    s, u = call(TEACHER, "POST", f"/v1/lessons/{lid}/upload-url")
    payload = open(AUDIO, "rb").read()
    req = urllib.request.Request(u["uploadUrl"], data=payload, method="PUT",
                                 headers={"x-ms-blob-type": "BlockBlob", "Content-Type": "audio/mp4"})
    urllib.request.urlopen(req).read()
    call(TEACHER, "POST", f"/v1/lessons/{lid}/submit", {"durationSec": 87})
    for _ in range(30):
        s, d = call(TEACHER, "GET", f"/v1/lessons/{lid}")
        notes = d.get("notes") or []
        if notes:
            return notes[0]["id"]
        time.sleep(20)
    raise SystemExit("the worker never produced a note")


def run(note_id, sid):
    s, added = call(TEACHER, "POST", f"/v1/notes/{note_id}/pieces", {"pieceId": CATALOG_PIECE})
    check("the teacher can add an engraved piece", s == 201, f"status={s} {added}")
    engraved = added.get("piece", {}).get("id")

    s, d = call(TEACHER, "GET", f"/v1/notes/{note_id}")
    slots = d["pieces"]
    spots = d["annotations"]
    check("the draft now holds two pieces", len(slots) == 2, [(p["kind"]) for p in slots])

    payload = [dict(a, notePieceId=(engraved if a["id"] == spots[0]["id"] else a.get("notePieceId")))
               for a in spots]
    s, _ = call(TEACHER, "PATCH", f"/v1/notes/{note_id}", {"annotations": payload})
    check("a spot can be moved onto the engraved piece", s == 200, f"status={s}")

    s, d = call(TEACHER, "GET", f"/v1/notes/{note_id}")
    content = d["note"]["content"] or {}
    if not (content.get("practicePlan") or []):
        content["practicePlan"] = [
            {"focus": "Hands separately", "steps": ["RH alone"], "target": "even"},
            {"focus": "Pedal on its own", "steps": [], "target": ""},
        ]
        s, _ = call(TEACHER, "PATCH", f"/v1/notes/{note_id}", {"content": content})
        check("a plan can be written where the model produced none", s == 200, f"status={s}")
    s, moved = call(TEACHER, "PATCH", f"/v1/notes/{note_id}",
                    {"planItems": [{"idx": 0, "notePieceId": engraved}]})
    check("a plan entry can be filed under a piece",
          s == 200 and (moved.get("planItems") or [{}])[0].get("notePieceId") == engraved,
          f"status={s} planItems={moved.get('planItems')}")

    s, sent = call(TEACHER, "POST", f"/v1/notes/{note_id}/send", {"studentId": sid})
    check("the note sends to a real student", s == 200, f"status={s} {sent}")

    # THE POINT OF THIS TOOL: everything below is the student's own token.
    s, inbox = call(STUDENT, "GET", "/v1/me/notes")
    ids = [n["id"] for n in inbox.get("items", [])]
    check("the note reaches the student's inbox", note_id in ids, ids[:3])

    s, sd = call(STUDENT, "GET", f"/v1/me/notes/{note_id}")
    check("the student's note carries the piece list", s == 200 and isinstance(sd.get("pieces"), list),
          f"status={s} keys={list(sd)}")
    sslots = sd.get("pieces") or []
    check("the student sees both pieces", len(sslots) == 2, [p.get("kind") for p in sslots])

    # The bug this tool was written for: an unversioned slot tells the app there is nothing to check,
    # so a republished piece resolves the teacher's bars against a different engraving in silence.
    versioned = [p for p in sslots if p.get("pieceId")]
    check("every engraved piece the student receives carries its own version",
          bool(versioned) and all(isinstance(p.get("pieceVersion"), int) for p in versioned),
          [(p.get("pieceId"), p.get("pieceVersion")) for p in sslots])

    sspots = sd.get("annotations") or []
    check("the student's spots say which piece they belong to",
          bool(sspots) and all("notePieceId" in a for a in sspots),
          [(a["id"][:8], a.get("notePieceId")) for a in sspots[:3]])
    check("the moved spot arrives under the engraved piece",
          any(a.get("notePieceId") == engraved for a in sspots),
          [a.get("notePieceId") for a in sspots[:3]])

    s, r = call(STUDENT, "POST", f"/v1/me/notes/{note_id}/read")
    check("the student can mark it read", s in (200, 204), f"status={s} {r}")

    splan = (sd.get("note") or {}).get("content", {}).get("practicePlan") or []
    spi = sd.get("planItems")
    check("the plan reaches the student one assignment per entry",
          isinstance(spi, list) and len(spi) == len(splan) and len(splan) >= 2,
          f"plan={len(splan)} planItems={spi}")
    check("and the filed entry arrives under its piece",
          bool(spi) and spi[0].get("notePieceId") == engraved, spi and spi[0])


if __name__ == "__main__":
    sid = student_id()
    nid = sys.argv[1] if len(sys.argv) > 1 else make_note()
    print(f"note {nid} -> student {sid}\n")
    run(nid, sid)
    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
