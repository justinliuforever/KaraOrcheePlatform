"""score_events.json generation — the app-followable score the tracker consumes.

Two routes:
  MIDI route (primary): reference MIDI parsed with pretty_midi, notes clustered into
    events with a 30ms onset bucket — vendored from piano-amt score_parser.parse_score
    (format matches the shipped .a3corpus byte-for-byte).
  XML-timemap route (no MIDI, czerny-style): deadpan render of the notated score via
    the Verovio timemap at the score's tempo; pitches resolved from the frozen MEI.
    Constant velocity 80 — no performance dynamics by construction.
"""
from __future__ import annotations
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
import pretty_midi

from pipeline.vrv import make_toolkit

CLUSTER_EPS_SEC = 0.030
MEI_NS = "{http://www.music-encoding.org/ns/mei}"
PNAME_BASE = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
ACCID_OFFSET = {"s": 1, "f": -1, "n": 0, "ss": 2, "x": 2, "ff": -2, "": 0, None: 0}


def _payload(events: list[dict]) -> dict:
    last = max((e["onset_sec"] for e in events), default=1.0)
    return {
        "n_events": len(events),
        "events": events,
        "initial_tempo_eps": max(2.0, len(events) / max(last, 1.0)),
    }


def events_from_notes(notes: list[tuple[float, float, int, int]]) -> dict:
    """Cluster (start, dur, pitch, velocity) tuples into score events (30ms buckets)."""
    if not notes:
        raise ValueError("no notes")
    notes = sorted(notes, key=lambda x: x[0])
    events: list[dict] = []
    bucket: list[tuple[float, float, int, int]] = [notes[0]]
    bucket_start = notes[0][0]

    def flush(idx: int, b: list) -> dict:
        b = sorted(b, key=lambda x: x[2])
        return {"idx": idx, "onset_sec": float(min(x[0] for x in b)),
                "pitches": [int(x[2]) for x in b],
                "durations": [float(x[1]) for x in b],
                "velocities": [int(x[3]) for x in b]}

    for n in notes[1:]:
        if n[0] - bucket_start <= CLUSTER_EPS_SEC:
            bucket.append(n)
        else:
            events.append(flush(len(events), bucket))
            bucket = [n]
            bucket_start = n[0]
    events.append(flush(len(events), bucket))
    return _payload(events)


def from_midi(midi_path: Path) -> dict:
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    notes: list[tuple[float, float, int, int]] = []
    for inst in pm.instruments:
        if inst.is_drum:
            continue
        for n in inst.notes:
            notes.append((n.start, n.end - n.start, n.pitch, n.velocity))
    if not notes:
        raise ValueError("MIDI contains no notes")
    return events_from_notes(notes)


def _mei_pitches(mei: str) -> dict[str, int]:
    """xml:id -> MIDI pitch for every <note> in the frozen MEI. Written accid wins over
    accid.ges; a child <accid> element wins over attributes."""
    root = ET.fromstring(mei)
    out: dict[str, int] = {}
    for note in root.iter(f"{MEI_NS}note"):
        nid = note.get("{http://www.w3.org/XML/1998/namespace}id")
        pname = note.get("pname")
        oct_ = note.get("oct")
        if not nid or not pname or oct_ is None:
            continue
        accid = note.get("accid") or note.get("accid.ges")
        child = note.find(f"{MEI_NS}accid")
        if child is not None:
            accid = child.get("accid") or child.get("accid.ges") or accid
        base = PNAME_BASE.get(pname.lower())
        if base is None:
            continue
        out[nid] = 12 * (int(oct_) + 1) + base + ACCID_OFFSET.get(accid, 0)
    return out


def from_xml_timemap(xml_path: Path) -> dict:
    tk = make_toolkit()
    tk.setOptions({"xmlIdChecksum": True, "header": "none", "footer": "none"})
    if not tk.loadFile(str(xml_path)):
        raise ValueError("verovio could not load the MusicXML")
    mei = tk.getMEI()
    pitches = _mei_pitches(mei)
    tm = tk.renderToTimemap({"includeMeasures": False, "includeRests": False})

    rend = re.compile(r"-rend\d+$")
    on_sec: dict[str, float] = {}
    off_sec: dict[str, float] = {}
    onsets: list[tuple[float, list[str]]] = []
    for e in tm:
        t = e.get("tstamp", 0) / 1000.0
        if e.get("on"):
            # expansion copies (-rendN) resolve to their written note's pitch, but
            # keep the SUFFIXED id for on/off pairing — each pass has its own off.
            onsets.append((t, list(e["on"])))
            for nid in e["on"]:
                on_sec[nid] = t
        if e.get("off"):
            for nid in e["off"]:
                off_sec[nid] = t

    events: list[dict] = []
    unresolved = 0
    for t, ids in onsets:
        rows = []
        for nid in ids:
            p = pitches.get(rend.sub("", nid))
            if p is None:
                unresolved += 1
                continue
            dur = max(off_sec.get(nid, t) - t, 0.0)
            rows.append((p, dur))
        if not rows:
            continue
        rows.sort(key=lambda x: x[0])
        events.append({"idx": len(events), "onset_sec": round(t, 4),
                       "pitches": [r[0] for r in rows],
                       "durations": [round(r[1], 4) for r in rows],
                       "velocities": [80] * len(rows)})
    if not events:
        raise ValueError("XML-timemap route produced no events")
    if unresolved > 0.02 * sum(len(ids) for _, ids in onsets):
        raise ValueError(
            f"XML-timemap route could not resolve pitches for {unresolved} notes; upload a reference MIDI instead")
    return _payload(events)


def write_score_events(payload: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload))
