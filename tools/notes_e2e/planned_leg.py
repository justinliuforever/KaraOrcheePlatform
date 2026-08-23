#!/usr/bin/env python3
"""The pieces-first path: a lesson CREATED with its list, through the real worker, to a real student.

What multipiece.py cannot see: it builds its list in review. This one plants the list before any
audio exists and asserts the worker minted every slot, parked the transcript in General, and bounded
grounding by the shortest planned piece's engraving.
"""
import json, sys, time, urllib.request, uuid

sys.path.insert(0, "/Users/liuqinyuan/Desktop/KaraOrcheePlatform/tools/notes_e2e")
from student_leg import AUDIO, BASE, CATALOG_PIECE, TEACHER, STUDENT, call, check, fails, student_id


def planned_note():
    s, c = call(TEACHER, "POST", "/v1/lessons", {
        "clientLessonId": str(uuid.uuid4()),
        "pieces": [
            {"pieceId": CATALOG_PIECE},
            {"pieceLabel": "Czerny from memory", "pieceSource": "typed"},
        ],
    })
    if s != 201:
        raise SystemExit(f"planned create failed: {s} {c}")
    lesson = c["lesson"]
    check("the lesson's own columns are the first planned piece", lesson.get("pieceId") == CATALOG_PIECE,
          lesson.get("pieceId"))
    lid = lesson["id"]
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
    s, d = call(TEACHER, "GET", f"/v1/notes/{note_id}")
    slots = d.get("pieces") or []
    check("the worker minted one slot per planned piece", len(slots) == 2,
          [(p.get("kind"), p.get("pieceLabel")) for p in slots])
    check("in the order they were planned",
          len(slots) == 2 and slots[0].get("pieceId") == CATALOG_PIECE
          and slots[1].get("pieceLabel") == "Czerny from memory",
          [(p.get("pieceId"), p.get("pieceLabel")) for p in slots])

    spots = d.get("annotations") or []
    check("every marked spot starts in General",
          bool(spots) and all(a.get("notePieceId") is None for a in spots),
          [(a["id"][:8], a.get("notePieceId")) for a in spots[:3]])
    check("nothing grounded itself past the shortest planned piece",
          all(not a["location"].get("grounded")
              or (a["location"].get("measureEnd") or a["location"].get("measureStart") or 0) <= 35
              for a in spots),
          [(a["location"].get("raw"), a["location"].get("grounded")) for a in spots[:4]])

    first = slots[0]["id"]
    payload = [dict(a, notePieceId=(first if a["id"] == spots[0]["id"] else a.get("notePieceId")))
               for a in spots]
    s, _ = call(TEACHER, "PATCH", f"/v1/notes/{note_id}", {"annotations": payload})
    check("the teacher can file a General spot under a planned piece", s == 200, f"status={s}")

    s, sent = call(TEACHER, "POST", f"/v1/notes/{note_id}/send", {"studentId": sid})
    check("the planned note sends", s == 200, f"status={s} {sent}")

    s, sd = call(STUDENT, "GET", f"/v1/me/notes/{note_id}")
    sslots = sd.get("pieces") or []
    check("the student receives both planned pieces", len(sslots) == 2,
          [p.get("kind") for p in sslots])
    check("and the engraved one carries its version",
          any(p.get("pieceId") == CATALOG_PIECE and isinstance(p.get("pieceVersion"), int)
              for p in sslots),
          [(p.get("pieceId"), p.get("pieceVersion")) for p in sslots])


if __name__ == "__main__":
    sid = student_id()
    nid = sys.argv[1] if len(sys.argv) > 1 else planned_note()
    print(f"note {nid} -> student {sid}\n")
    run(nid, sid)
    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
