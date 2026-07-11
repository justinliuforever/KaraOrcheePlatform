"""Post-failure attribution for the geometry gate.

When the score/MIDI timelines disagree, classify WHY from data shape alone and tell
the uploader in plain facts (never guessing their software). The load-bearing design
rules:
  - pitch-aware alignment, never index pairing (ornament surpluses shift indices);
  - robust fit BEFORE jump detection, jumps on the detrended residue and only when
    the shift PERSISTS (repeats are sustained, graces are transient);
  - tempo is a THREE-way comparison (marked-in-XML / verovio-effective / MIDI-played);
  - every finding must pass a sufficiency check — applying its model must actually
    collapse the same nearest-onset median that failed the gate. A wrong diagnosis is
    worse than none, so anything unproven stays silent and the generic message stands.
"""
from __future__ import annotations
import bisect
import random
import re
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

import pretty_midi

from pipeline.score_events import _mei_pitches, CLUSTER_EPS_SEC
from pipeline.tempo_norm import _metronome_qpm

MEI_NS = "{http://www.music-encoding.org/ns/mei}"
GATE_MS = 12.0          # must match staff.py's staff_eligible threshold
MIN_EVENTS_TEMPO = 24
MIN_EVENTS_WARP = 32
JUMP_BEATS = 0.5
JUMP_PERSIST = 8


# ---------- extraction ----------

def _xml_side(effective_xml: Path) -> dict:
    from pipeline.vrv import make_toolkit  # lazy: keeps the pure-math helpers testable without verovio
    tk = make_toolkit()
    tk.setOptions({"xmlIdChecksum": True, "header": "none", "footer": "none"})
    if not tk.loadFile(str(effective_xml)):
        raise ValueError("verovio could not load the effective MusicXML")
    mei = tk.getMEI()
    pitches = _mei_pitches(mei)
    grace_ids = set()
    root = ET.fromstring(mei)
    for note in root.iter(f"{MEI_NS}note"):
        if note.get("grace") is not None:
            nid = note.get("{http://www.w3.org/XML/1998/namespace}id")
            if nid:
                grace_ids.add(nid)
    measure_n = {}
    for m in root.iter(f"{MEI_NS}measure"):
        mid = m.get("{http://www.w3.org/XML/1998/namespace}id")
        if mid:
            measure_n[mid] = m.get("n") or "?"

    tm = tk.renderToTimemap({"includeMeasures": True, "includeRests": False})
    events, measures = [], []
    pass_count: dict[str, int] = {}
    for e in tm:
        if e.get("measureOn"):
            mid = e["measureOn"]
            base = re.sub(r"-rend\d+$", "", mid)
            pass_count[base] = pass_count.get(base, 0) + 1
            measures.append({"q": e["qstamp"], "n": measure_n.get(base, "?"),
                             "pass": pass_count[base]})
        if e.get("on"):
            ids = list(e["on"])
            ps = frozenset(pitches[i] for i in ids if i in pitches)
            if not ps:
                continue
            events.append({"q": float(e["qstamp"]), "sec": e["tstamp"] / 1000.0,
                           "pitches": ps,
                           "grace": all(i in grace_ids for i in ids)})
    events.sort(key=lambda x: x["q"])
    return {"events": events, "measures": measures,
            "repeats_expanded": any(m["pass"] > 1 for m in measures)}


def _measure_label(measures: list[dict], q: float) -> str:
    label = None
    for m in measures:
        if m["q"] <= q + 1e-6:
            label = m
        else:
            break
    if not label:
        return "the start"
    return f"measure {label['n']}" + (f" (repeat pass {label['pass']})" if label["pass"] > 1 else "")


def _midi_side(midi_path: Path, solo_idx: int | None) -> dict:
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    insts = [i for i in pm.instruments if not i.is_drum]
    if solo_idx is not None and solo_idx < len(insts):
        insts = [insts[solo_idx]]
    notes = sorted(((n.start, n.pitch) for i in insts for n in i.notes), key=lambda x: x[0])
    if not notes:
        raise ValueError("MIDI side has no notes")
    events, bucket, b0 = [], [notes[0]], notes[0][0]
    for n in notes[1:]:
        if n[0] - b0 <= CLUSTER_EPS_SEC:
            bucket.append(n)
        else:
            events.append(bucket); bucket, b0 = [n], n[0]
    events.append(bucket)
    out = []
    for b in events:
        sec = min(x[0] for x in b)
        out.append({"sec": sec, "beat": pm.time_to_tick(sec) / pm.resolution,
                    "pitches": frozenset(x[1] for x in b)})
    times, tempi = pm.get_tempo_changes()
    return {"events": out, "tempo_track": list(zip(times.tolist(), tempi.tolist()))}


def _marked_tempi(original_xml: Path) -> list[float]:
    """Numeric tempi actually present in the uploaded score, in QPM."""
    try:
        root = ET.parse(original_xml).getroot()
    except ET.ParseError:
        return []
    out = []
    for d in root.iter("direction"):
        snd = d.find("sound")
        if snd is not None and snd.get("tempo"):
            try:
                v = float(snd.get("tempo"))
                if v > 0:
                    out.append(v)
                    continue
            except ValueError:
                pass
        met = d.find(".//metronome")
        if met is not None:
            qpm = _metronome_qpm(met)
            if qpm:
                out.append(qpm)
    return out


# ---------- alignment ----------

def _align(xa: list[dict], xb: list[dict]) -> list[tuple[int, int]]:
    """Banded DP alignment on (normalized position, pitch-set) — scale-neutral, so an
    untruthful MIDI tick clock cannot fake structural divergence."""
    na, nb = len(xa), len(xb)
    if na == 0 or nb == 0:
        return []
    qmax = max(e["q"] for e in xa) or 1.0
    bmax = max(e["beat"] for e in xb) or 1.0
    band = max(24, int(0.15 * max(na, nb)))
    GAP = 0.55
    INF = float("inf")
    prev = {0: 0.0}
    back: dict[tuple[int, int], tuple[int, int]] = {}
    cols = [prev]
    for i in range(1, na + 1):
        center = int(i * nb / na)
        lo, hi = max(0, center - band), min(nb, center + band)
        cur: dict[int, float] = {}
        for j in range(lo, hi + 1):
            best, arg = INF, None
            up = cols[i - 1].get(j)
            if up is not None and up + GAP < best:
                best, arg = up + GAP, (i - 1, j)
            left = cur.get(j - 1)
            if left is not None and left + GAP < best:
                best, arg = left + GAP, (i, j - 1)
            diag = cols[i - 1].get(j - 1)
            if diag is not None and j >= 1:
                A, B = xa[i - 1], xb[j - 1]
                inter = len(A["pitches"] & B["pitches"])
                union = len(A["pitches"] | B["pitches"]) or 1
                cost = 0.7 * (1 - inter / union) + 0.3 * min(abs(A["q"] / qmax - B["beat"] / bmax) * 10, 1.0)
                if diag + cost < best:
                    best, arg = diag + cost, (i - 1, j - 1)
            if arg is not None:
                cur[j] = best
                back[(i, j)] = arg
        cols.append(cur)
    j = min(cols[na], key=lambda k: cols[na][k], default=None)
    if j is None:
        return []
    pairs = []
    i = na
    while i > 0 and j > 0:
        pi, pj = back.get((i, j), (i - 1, j - 1))
        if pi == i - 1 and pj == j - 1:
            pairs.append((i - 1, j - 1))
        i, j = pi, pj
    pairs.reverse()
    return pairs


def _theil_sen(xs: list[float], ys: list[float]) -> tuple[float, float]:
    n = len(xs)
    rng = random.Random(7)
    slopes = []
    for _ in range(min(2000, n * (n - 1) // 2 or 1)):
        i, j = rng.randrange(n), rng.randrange(n)
        if xs[i] != xs[j]:
            slopes.append((ys[j] - ys[i]) / (xs[j] - xs[i]))
    slopes.sort()
    s = slopes[len(slopes) // 2] if slopes else 1.0
    resid = sorted(ys[k] - s * xs[k] for k in range(n))
    c = resid[n // 2]
    return s, c


def _nearest_median_ms(ref_secs: list[float], midi_secs: list[float]) -> float:
    """The gate's own metric shape: for each MIDI onset, distance to nearest ref onset."""
    ref = sorted(ref_secs)
    ds = []
    for t in midi_secs:
        k = bisect.bisect_left(ref, t)
        cands = [abs(t - ref[m]) for m in (k - 1, k) if 0 <= m < len(ref)]
        ds.append(min(cands) if cands else 0.0)
    ds.sort()
    return (ds[len(ds) // 2] if ds else 0.0) * 1000.0


# ---------- main ----------

def diagnose(original_xml: Path, effective_xml: Path, midi_path: Path,
             solo_idx: int | None = None) -> list[dict]:
    X = _xml_side(effective_xml)
    M = _midi_side(midi_path, solo_idx)
    xe, me = X["events"], M["events"]
    findings: list[dict] = []

    baseline = _nearest_median_ms([e["sec"] for e in xe], [e["sec"] for e in me])

    # -- note-level counting + identity (notes, not events: humanize splits chords) --
    xml_notes = sum(len(e["pitches"]) for e in xe)
    midi_notes = sum(len(e["pitches"]) for e in me)
    xh = Counter(p for e in xe for p in e["pitches"])
    mh = Counter(p for e in me for p in e["pitches"])
    overlap = sum((xh & mh).values()) / max(sum((xh | mh).values()), 1)
    if overlap < 0.5:
        findings.append({
            "code": "content_mismatch",
            "message": f"The MIDI's note content matches only {overlap:.0%} of the score's — these two files "
                       "do not appear to contain the same music. Re-export BOTH files from the same project.",
            "evidence": {"pitch_overlap": round(overlap, 2), "xml_notes": xml_notes, "midi_notes": midi_notes},
        })
        return findings  # nothing downstream is meaningful

    pairs = _align(xe, me)
    if len(pairs) < 8:
        return findings

    matched_x = [xe[i] for i, _ in pairs]
    matched_m = [me[j] for _, j in pairs]

    # -- structure: robust beat fit, then detrended persistent shifts --
    ng = [(a, b) for a, b in zip(matched_x, matched_m) if not a["grace"]]
    qs = [a["q"] for a, _ in ng]
    bs = [b["beat"] for _, b in ng]
    s, c = _theil_sen(qs, bs)
    detr = [bs[k] - (s * qs[k] + c) for k in range(len(qs))]
    jump_at = None
    for k in range(1, len(detr) - JUMP_PERSIST):
        step = detr[k] - detr[k - 1]
        if abs(step) >= JUMP_BEATS:
            before = sorted(detr[max(0, k - JUMP_PERSIST):k])[max(0, (min(k, JUMP_PERSIST)) // 2)]
            after_win = sorted(detr[k:k + JUMP_PERSIST])
            after = after_win[len(after_win) // 2]
            if abs(after - before) >= JUMP_BEATS:
                jump_at = (qs[k], after - before)
                break
    if jump_at is not None:
        q_at, dbeats = jump_at
        where = _measure_label(X["measures"], q_at)
        has_repeats = _xml_has_repeats(original_xml)
        if has_repeats:
            msg = (f"From {where} the MIDI runs {abs(dbeats):.1f} beats "
                   f"{'behind' if dbeats < 0 else 'ahead of'} the score timeline — the score's repeats/endings "
                   "are being expanded differently on the two sides (neither is 'wrong'; different programs "
                   "unroll repeat structures differently). Write out the repeats in the score and re-export both files.")
        else:
            msg = (f"From {where} the MIDI runs {abs(dbeats):.1f} beats "
                   f"{'behind' if dbeats < 0 else 'ahead of'} the score timeline — the two files diverge "
                   "structurally there (a bar missing or added on one side). Check that bar and re-export both files.")
        findings.append({"code": "structure_divergence",
                         "message": msg,
                         "evidence": {"at_qstamp": round(q_at, 2), "delta_beats": round(dbeats, 2),
                                      "where": where}})

    # -- tempo: three-way comparison with sufficiency --
    marked = _marked_tempi(original_xml)
    # fit in the TIME domain on the pre-jump matched prefix
    prefix = [(a, b) for a, b in zip(matched_x, matched_m)
              if jump_at is None or a["q"] < jump_at[0]]
    if len(prefix) >= MIN_EVENTS_TEMPO:
        ta = [a["sec"] for a, _ in prefix]
        tb = [b["sec"] for _, b in prefix]
        a_fit, b_fit = _theil_sen(ta, tb)
        rescaled = _nearest_median_ms([t * a_fit + b_fit for t in ta], tb)
        if baseline >= GATE_MS and rescaled < GATE_MS and abs(a_fit - 1) > 0.005:
            # effective clock of the XML timeline over the same prefix
            q_span = prefix[-1][0]["q"] - prefix[0][0]["q"]
            t_span = prefix[-1][0]["sec"] - prefix[0][0]["sec"]
            eff_qpm = (q_span / t_span * 60) if t_span > 0 else 120.0
            played = eff_qpm / a_fit
            tt = [b for _, b in M["tempo_track"]]
            if len(tt) == 1 and abs(tt[0] - played) > 3 and abs(tt[0] - 120) < 0.5:
                pass  # flat default track lying about the real pacing — trust the fit
            elif len(tt) == 1:
                played = tt[0]
            if not marked:
                findings.append({
                    "code": "no_numeric_tempo",
                    "message": f"The score has NO numeric tempo mark (text like 'Allegro' does not carry a number), "
                               f"so its timeline uses the {eff_qpm:.0f}bpm default — but the MIDI performs at ≈♩{played:.0f}. "
                               f"Add a metronome mark (♩ = {played:.0f}) to the score and re-export both files.",
                    "evidence": {"midi_qpm": round(played, 1), "xml_assumed_qpm": round(eff_qpm, 1),
                                 "residual_after_rescale_ms": round(rescaled, 1)},
                })
            else:
                findings.append({
                    "code": "tempo_mismatch",
                    "message": f"The score marks ♩ = {marked[0]:.0f} but the MIDI performs at ≈♩{played:.0f} — "
                               "the two files must use the same tempo. Re-export both from the same project "
                               "after checking the playback tempo.",
                    "evidence": {"marked_qpm": round(marked[0], 1), "midi_qpm": round(played, 1),
                                 "residual_after_rescale_ms": round(rescaled, 1)},
                })
        elif baseline >= GATE_MS and rescaled < GATE_MS and abs(b_fit) > 0.05:
            findings.append({
                "code": "lead_in_offset",
                "message": f"The MIDI starts {abs(b_fit)*1000:.0f}ms {'later' if b_fit > 0 else 'earlier'} than the "
                           "score timeline (a count-in or leading silence). Remove the lead-in and re-export.",
                "evidence": {"offset_ms": round(b_fit * 1000, 0)},
            })
        elif baseline >= GATE_MS and rescaled >= GATE_MS and len(prefix) >= MIN_EVENTS_WARP:
            # residue after the best global clock: local timing effects
            resid = [tb[k] - (ta[k] * a_fit + b_fit) for k in range(len(ta))]
            med = sorted(abs(r) for r in resid)[len(resid) // 2] * 1000
            if med >= GATE_MS:
                # smooth (windowed median) component vs raw: warp if the smooth curve carries it
                w = 9
                smooth = [sorted(resid[max(0, k - w):k + w])[len(resid[max(0, k - w):k + w]) // 2]
                          for k in range(len(resid))]
                smooth_med = sorted(abs(r) for r in smooth)[len(smooth) // 2] * 1000
                if smooth_med > 0.6 * med:
                    findings.append({
                        "code": "local_tempo_warping",
                        "message": "The MIDI's pacing bends locally against the score timeline (ritardando/rubato-style "
                                   "tempo changes are performed in the MIDI without numeric marks in the score). "
                                   "Export the MIDI without performance interpretation (straight/deadpan playback), "
                                   "or add the tempo changes to the score as numeric marks.",
                        "evidence": {"residual_after_global_fit_ms": round(med, 1)},
                    })
                else:
                    findings.append({
                        "code": "timing_jitter",
                        "message": "MIDI note timings scatter randomly around the score timeline (humanize/feel "
                                   "randomization is baked into the export). Turn off humanize/swing/feel and re-export the MIDI.",
                        "evidence": {"residual_after_global_fit_ms": round(med, 1)},
                    })

    # -- ornament surplus: unmatched MIDI events clustered at ornament positions --
    matched_j = {j for _, j in pairs}
    extra = [me[j] for j in range(len(me)) if j not in matched_j]
    if extra and midi_notes > xml_notes * 1.05:
        orn_q = _ornament_positions(original_xml)
        if orn_q and X["events"]:
            bmax = max(e["beat"] for e in me) or 1.0
            qmax = max(e["q"] for e in xe) or 1.0
            near = sum(1 for e in extra
                       if any(abs(e["beat"] / bmax * qmax - q) <= 1.0 for q in orn_q))
            if near >= 0.7 * len(extra):
                findings.append({
                    "code": "ornaments_realized",
                    "message": f"The MIDI contains ≈{midi_notes - xml_notes} more notes than the score, clustered at "
                               "ornament signs (trills/mordents played out as many notes). Export the MIDI without "
                               "ornament realization (deadpan playback), or remove the ornament playback before export.",
                    "evidence": {"extra_notes": midi_notes - xml_notes, "clustered_at_ornaments": near},
                })

    return findings[:3]


def _xml_has_repeats(original_xml: Path) -> bool:
    try:
        root = ET.parse(original_xml).getroot()
    except ET.ParseError:
        return False
    if root.find(".//repeat") is not None or root.find(".//ending") is not None:
        return True
    for snd in root.iter("sound"):
        if any(snd.get(k) is not None for k in ("dacapo", "dalsegno", "segno", "coda", "tocoda", "fine")):
            return True
    return False


def _ornament_positions(original_xml: Path) -> list[float]:
    """Approximate qstamps of ornament-bearing notes (cumulative duration walk)."""
    try:
        root = ET.parse(original_xml).getroot()
    except ET.ParseError:
        return []
    out = []
    for part in root.findall("part"):
        divisions = 1.0
        q = 0.0
        for measure in part.findall("measure"):
            d = measure.find(".//divisions")
            if d is not None and (d.text or "").strip():
                divisions = float(d.text)
            for el in measure:
                if el.tag == "note":
                    dur = el.findtext("duration")
                    is_chord = el.find("chord") is not None
                    if el.find(".//ornaments") is not None or el.find(".//trill-mark") is not None:
                        out.append(q)
                    if dur and not is_chord and el.find("grace") is None:
                        q += float(dur) / divisions
                elif el.tag == "backup":
                    dur = el.findtext("duration")
                    if dur:
                        q -= float(dur) / divisions
                elif el.tag == "forward":
                    dur = el.findtext("duration")
                    if dur:
                        q += float(dur) / divisions
        break  # solo part is enough for position estimates
    return out
