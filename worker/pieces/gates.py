"""The studio gates. Each returns (metrics_dict) or raises GateError with a
human-readable reason. Artifacts land in a job-local directory; the caller uploads.

v3: sanity extracts XML facts + detects parts; multi-part scores are reduced to the
chosen solo part before alignment/geometry (accompaniment becomes a second event
stream); preview audio renders with the app's SF2; optional reference audio is
verified against the notated timeline (Tier-1 linear-map gate).
"""
from __future__ import annotations
import shutil
import time
import traceback
from pathlib import Path
import pretty_midi

from pipeline import score_events as se
from pipeline import xml_meta
from pipeline.vrv import make_toolkit
from pipeline.staff import build_staff_assets
from pipeline.cursor_gate import run_gate
from pipeline.parts import reduce_xml_to_part, split_midi_notes
from pipeline.tempo_norm import normalize_tempo
from pipeline.engraving_norm import normalize_engraving
from pipeline.preview import render_preview
from pipeline.thumbnail import render_thumbnail
from pipeline.audio_gate import AudioGateError
from pipeline.audio_map import build_time_map
from pipeline.align import structure_match_score
from pipeline.structure import (
    StructureError, build_playback_map, classify_structure,
    expected_playback_sequence, timemap_measure_sequence,
)


class GateError(Exception):
    def __init__(self, reason: str, metrics: dict | None = None):
        super().__init__(reason)
        self.metrics = metrics or {}


def gate_sanity(xml_path: Path, midi_path: Path | None, solo_part: str | None) -> dict:
    tk = make_toolkit()
    tk.setOptions({"header": "none", "footer": "none"})
    if not tk.loadFile(str(xml_path)):
        raise GateError("MusicXML failed to load (not a valid MusicXML/MXL file?)")
    tm = tk.renderToTimemap({"includeMeasures": True, "includeRests": False})
    n_measures = sum(1 for e in tm if e.get("measureOn"))
    n_onsets = sum(1 for e in tm if e.get("on"))
    if n_measures < 1 or n_onsets < 1:
        raise GateError(f"score is empty (measures={n_measures}, onsets={n_onsets})")

    meta = xml_meta.extract(xml_path)
    part_ids = [p["id"] for p in meta["parts"]]
    if solo_part and solo_part not in part_ids:
        raise GateError(f"selected solo part {solo_part!r} is not in this file (parts: {part_ids})", {"xml_meta": meta})
    # Auto-select the first part; the wizard shows the choice for human confirmation.
    solo_used = solo_part or (part_ids[0] if part_ids else None)

    metrics = {
        "measures": n_measures,
        "xml_onsets": n_onsets,
        "xml_bytes": xml_path.stat().st_size,
        "xml_meta": meta,
        "solo_part": solo_used,
        "solo_part_auto": solo_part is None and meta["n_parts"] > 1,
    }
    if midi_path is not None:
        try:
            pm = pretty_midi.PrettyMIDI(str(midi_path))
        except Exception as err:
            raise GateError(f"MIDI failed to parse: {err}") from err
        n_notes = sum(len(i.notes) for i in pm.instruments if not i.is_drum)
        if n_notes < 1:
            raise GateError("MIDI contains no notes")
        metrics["midi_notes"] = n_notes
        metrics["midi_duration_sec"] = round(pm.get_end_time(), 1)
    return metrics


def _effective_paths(xml_path: Path, out_dir: Path, meta: dict, solo_used: str | None) -> Path:
    """Reduce a multi-part score to the solo part (single-part passes through), then
    normalize metronome marks (verovio's dotted-unit conversion is wrong) and
    engraving placement (bottom-staff fingerings, edition piece numbers)."""
    if meta["n_parts"] <= 1 or solo_used is None:
        return normalize_engraving(normalize_tempo(xml_path, out_dir), out_dir)
    reduced = out_dir / "_solo.musicxml"
    reduce_xml_to_part(xml_path, reduced, solo_used)
    return normalize_engraving(normalize_tempo(reduced, out_dir), out_dir)


def _timeline_events(xml_path: Path, expanded: bool) -> list[dict]:
    """XML-timeline events [{'q', 'pitches'}] for structure scoring, from the same
    engine the pipeline builds with. expanded=False forces the written (linear) order."""
    import re as _re
    from pipeline.score_events import _mei_pitches
    tk = make_toolkit()
    opts = {"xmlIdChecksum": True, "header": "none", "footer": "none"}
    if not expanded:
        opts["expandNever"] = True
    tk.setOptions(opts)
    if not tk.loadFile(str(xml_path)):
        raise GateError("verovio could not load the effective MusicXML")
    pitches = _mei_pitches(tk.getMEI())
    rend = _re.compile(r"-rend\d+$")
    events = []
    for e in tk.renderToTimemap({"includeMeasures": False, "includeRests": False}):
        if e.get("on"):
            ps = frozenset(p for p in (pitches.get(rend.sub("", i)) for i in e["on"]) if p is not None)
            if ps:
                events.append({"q": float(e.get("qstamp", 0.0)), "pitches": ps})
    return events


def gate_structure(xml_path: Path, out_dir: Path, meta: dict, solo_used: str | None,
                   state: dict) -> dict:
    """4th preflight lane, between sanity and alignment: classify the repeat marks,
    verify the engine's expansion EXACTLY matches our independent expander, and build
    the canonical playback map. Linear pieces pass through untouched."""
    effective_xml = _effective_paths(xml_path, out_dir, meta, solo_used)
    try:
        st = classify_structure(effective_xml)
        if xml_path != effective_xml:
            st_orig = classify_structure(xml_path)
            if (st_orig.kind, expected_playback_sequence(st_orig) if st_orig.has_repeats else None) != \
               (st.kind, expected_playback_sequence(st) if st.has_repeats else None):
                raise StructureError(
                    "solo reduction changed the repeat structure — the parts encode "
                    "different structures; re-export with consistent barlines")
    except StructureError as err:
        where = f" (measure {err.measure})" if getattr(err, "measure", None) else ""
        raise GateError(f"repeat structure: {err}{where}") from err

    state["structure"] = st
    metrics: dict = {"kind": st.kind, "written_measures": st.n_measures}
    if not st.has_repeats:
        state["playback"] = None
        return metrics

    expected = expected_playback_sequence(st)
    tk = make_toolkit()
    tk.setOptions({"xmlIdChecksum": True, "header": "none", "footer": "none"})
    tk.loadFile(str(effective_xml))
    import re as _re
    written_ids = _re.findall(r'<measure[^>]*xml:id="([^"]+)"', tk.getMEI())
    played_ids = timemap_measure_sequence(tk)
    try:
        verify_expansion_ok = True
        from pipeline.structure import verify_expansion
        verify_expansion(played_ids, written_ids, expected)
    except StructureError as err:
        raise GateError(f"repeat structure: {err}") from err

    # per-played-measure boundaries from the expanded timemap
    tm = tk.renderToTimemap({"includeMeasures": True, "includeRests": False})
    marks = [(e["tstamp"] / 1000.0, float(e.get("qstamp", 0.0)))
             for e in tm if e.get("measureOn")]
    end_t = max((e["tstamp"] / 1000.0 for e in tm), default=0.0)
    end_q = max((float(e.get("qstamp", 0.0)) for e in tm), default=0.0)
    secs = [(marks[k][0], marks[k + 1][0] if k + 1 < len(marks) else end_t) for k in range(len(marks))]
    qs = [(marks[k][1], marks[k + 1][1] if k + 1 < len(marks) else end_q) for k in range(len(marks))]
    pm = build_playback_map(st, expected, secs, qs)
    pm["counts"]["expansion_source"] = "verovio-inferred"
    state["playback"] = pm
    metrics.update({
        "played_measures": pm["counts"]["played_measures"],
        "max_passes": pm["counts"]["max_passes"],
        "n_spans": len(pm["spans"]),
        "expanded_duration_sec": pm["counts"]["expanded_duration_sec"],
        "expansion_source": "verovio-inferred",
        "expansion_verified": verify_expansion_ok,
    })
    return metrics


def _events_playback_block(events: list[dict], playback: dict) -> dict:
    """Span event-index ranges + twin groups for the follower (design 1b). Twin key =
    (written measure, local offset quantized 50ms, pitch tuple); conservative: events
    that fit no span or sit within the divergence guard of a span end get NO twins."""
    GUARD_SEC = 0.25
    spans = playback["spans"]
    out_spans, twin_key = [], {}
    si = 0
    for k, e in enumerate(events):
        t = float(e["onset_sec"])
        while si + 1 < len(spans) and t >= spans[si + 1]["expanded_sec_start"] - 0.050:
            si += 1
        sp = spans[si]
        if not out_spans or out_spans[-1]["span_index"] != sp["span_index"]:
            out_spans.append({"span_index": sp["span_index"], "pass": sp["pass"],
                              "written_start": sp["written_start"], "written_end": sp["written_end"],
                              "jump_in": sp["jump_in"], "first_event_idx": k, "last_event_idx": k})
        else:
            out_spans[-1]["last_event_idx"] = k
        cands = [o for o in playback["occurrences"]
                 if o["span_index"] == sp["span_index"]
                 and o["expanded_sec_start"] - 0.050 <= t < o["expanded_sec_end"] + 0.050]
        # boundary events belong to the measure they START (start-biased pick)
        occ = max(cands, key=lambda o: o["expanded_sec_start"], default=None)
        if occ is None or t > occ["expanded_sec_end"] - GUARD_SEC:
            continue
        local = round((t - occ["expanded_sec_start"]) / 0.050) * 0.050
        twin_key.setdefault((occ["measure_index"], round(local, 3), tuple(e["pitches"])), []).append(k)
    twin_groups = [v for v in twin_key.values() if len(v) >= 2]
    return {"spans": out_spans, "twin_groups": twin_groups}


# Anchored on real pairs (2026-07-13). Winner-take-all with a floor: a fixed margin
# is WRONG because the gap between the two readings scales with the repeat fraction —
# haydn 48/2 repeats only 12% of the piece, so its correct expanded MIDI scores
# 0.96 vs linear 0.87 (gap 0.09), while short pieces gap 0.4-0.6. Observed: correct
# reading 0.92-0.98 everywhere; wrong reading capped by content coverage; a truly
# foreign pair scores under the floor on both. Tie-guard 0.02 << smallest real gap 0.06.
STRUCTURE_WIN_FLOOR = 0.80
STRUCTURE_TIE_GUARD = 0.02


def gate_alignment(xml_path: Path, midi_path: Path | None, out_dir: Path,
                   meta: dict, solo_used: str | None, state: dict | None = None) -> dict:
    multi = meta["n_parts"] > 1 and solo_used is not None
    effective_xml = _effective_paths(xml_path, out_dir, meta, solo_used)

    structure = (state or {}).get("structure")
    struct_metrics: dict = {}
    if midi_path is not None and structure is not None and structure.has_repeats:
        # Which structure does the MIDI realize? Pitch-DP against BOTH timelines.
        from pipeline.diagnose import _midi_side
        solo_idx = ([p["id"] for p in meta["parts"]].index(solo_used)
                    if multi else None)
        midi_events = _midi_side(midi_path, solo_idx)["events"]
        exp_events = _timeline_events(effective_xml, expanded=True)
        lin_events = _timeline_events(effective_xml, expanded=False)
        s_exp = structure_match_score(exp_events, midi_events)
        s_lin = structure_match_score(lin_events, midi_events)
        struct_metrics = {"structure_match_expanded": round(s_exp, 3),
                          "structure_match_linear": round(s_lin, 3)}
        best = max(s_exp, s_lin)
        decided = best >= STRUCTURE_WIN_FLOOR and abs(s_exp - s_lin) > STRUCTURE_TIE_GUARD
        if decided and s_exp > s_lin:
            struct_metrics["structure_match"] = "expanded"
        elif decided and s_lin > s_exp:
            pb = (state or {}).get("playback") or {}
            counts = pb.get("counts", {})
            raise GateError(
                f"the MIDI plays the score straight through ({len(midi_events)} events, "
                f"~{len(lin_events)} expected linear) but the score's repeats expand to "
                f"{counts.get('played_measures', '?')} played measures "
                f"({len(exp_events)} events expected) — export the MIDI with repeats "
                "taken (play repeats ON), or write the repeats out in both files",
                struct_metrics)
        else:
            raise GateError(
                f"the MIDI matches neither the written-through nor the repeat-expanded "
                f"reading of this score (match {s_lin:.0%} linear / {s_exp:.0%} expanded) — "
                "the files likely come from different edits; re-export both from the same "
                "project", struct_metrics)

    if midi_path is not None:
        if multi:
            solo_idx = [p["id"] for p in meta["parts"]].index(solo_used)
            solo_notes, accomp_notes = split_midi_notes(midi_path, solo_idx)
            payload = se.events_from_notes(solo_notes)
            if accomp_notes:
                se.write_score_events(se.events_from_notes(accomp_notes),
                                      out_dir / "accompaniment_events.json")
        else:
            payload = se.from_midi(midi_path)
        route = "midi"
    else:
        payload = se.from_xml_timemap(effective_xml)
        route = "xml_timemap"
    playback = (state or {}).get("playback")
    if playback is not None:
        payload["playback"] = _events_playback_block(payload["events"], playback)
    se.write_score_events(payload, out_dir / "score_events.json")

    duration = max((e["onset_sec"] + max(e["durations"]) for e in payload["events"]), default=0.0)
    return {"route": route, "n_events": payload["n_events"],
            "solo_part": solo_used if multi else None,
            "accompaniment": multi and (out_dir / "accompaniment_events.json").exists(),
            "duration_sec": round(duration, 1),
            "initial_tempo_eps": round(payload["initial_tempo_eps"], 4),
            **struct_metrics}


def gate_geometry(piece: str, xml_path: Path, out_dir: Path,
                  meta: dict, solo_used: str | None, state: dict | None = None) -> dict:
    effective_xml = _effective_paths(xml_path, out_dir, meta, solo_used)
    bundle = build_staff_assets(piece, effective_xml, out_dir / "score_events.json", out_dir,
                                playback=(state or {}).get("playback"))
    ph = bundle["variants"]["phone"]
    metrics = {
        "engine_sha": f"verovio-{bundle['verovio_version']}",
        "measures": len(bundle["identity"]["measures"]),
        "systems": ph["n_systems"],
        "anchors": len(ph["cursor_anchors"]),
        "residual_p50_ms": bundle["timeline_residual_ms_p50"],
        "residual_p90_ms": bundle["timeline_residual_ms_p90"],
        "anchors_out_of_band": bundle["anchors_out_of_band"],
        "staff_eligible": bundle["staff_eligible"],
    }
    if not bundle["staff_eligible"]:
        raise GateError(
            f"score/MIDI timelines disagree: median residual {bundle['timeline_residual_ms_p50']}ms >= 12ms "
            "(the MIDI likely doesn't correspond to this MusicXML, or has expressive timing)",
            metrics)
    if metrics["anchors"] < 1:
        raise GateError("no cursor anchors produced", metrics)
    return metrics


def gate_preview(out_dir: Path, sf2_path: Path | None, program: int) -> dict:
    if sf2_path is None or not sf2_path.exists():
        return {"skipped": "soundfont unavailable"}
    try:
        metrics = render_preview(out_dir / "score_events.json", sf2_path,
                                 out_dir / "preview.m4a", program)
        metrics["soundfont"] = sf2_path.name
        return metrics
    except Exception as err:
        # Preview is a review aid, never a build blocker.
        return {"skipped": f"render failed: {str(err)[:120]}"}


def gate_audio(audio_path: Path, out_dir: Path, sf2_path: Path | None, program: int,
               state: dict | None = None) -> dict:
    try:
        return build_time_map(audio_path, out_dir / "score_events.json", out_dir,
                              sf2_path, program, playback=(state or {}).get("playback"))
    except AudioGateError as err:
        raise GateError(str(err), err.metrics) from err


def gate_render(piece: str, out_dir: Path) -> dict:
    ok, failures, metrics = run_gate(out_dir, piece)
    if not ok:
        raise GateError("cursor-on-staff verification failed: " + "; ".join(failures[:5]), metrics)
    return metrics


def gate_thumbnail(piece: str, out_dir: Path) -> dict:
    # Catalog art is an enhancement, never a build blocker (mirrors gate_preview).
    try:
        return render_thumbnail(out_dir / f"{piece}.phone.svg", out_dir / "thumbnail.webp")
    except Exception as err:
        traceback.print_exc()
        return {"skipped": f"thumbnail failed: {str(err)[:120]}"}


# Staged blob name -> (role, variant). PUBLISH_ROLES is the bundle allowlist —
# preview audio is a review aid and must never enter the immutable bundle.
ARTIFACT_LAYOUT = [
    ("score_events.json", "score_events.json", "score_events", None),
    ("accompaniment_events.json", "accompaniment_events.json", "accompaniment_events", None),
    ("{p}.staff.json", "staff.json", "geometry", None),
    ("{p}.phone.svg", "score.phone.svg", "svg", "phone"),
    ("{p}.ipad.svg", "score.ipad.svg", "svg", "ipad"),
    ("{p}.ipad_portrait.svg", "score.ipad_portrait.svg", "svg", "ipad_portrait"),
    ("reference.m4a", "reference.m4a", "reference_audio", None),
    ("audio_map.json", "audio_map.json", "audio_map", None),
    ("preview.m4a", "preview.m4a", "preview_audio", None),
    ("thumbnail.webp", "thumbnail.webp", "thumbnail", None),
]
PUBLISH_ROLES = {"score_events", "accompaniment_events", "geometry", "svg", "reference_audio", "audio_map", "thumbnail"}


def run_all(job_id: str, piece: str, xml_path: Path, midi_path: Path | None, out_dir: Path,
            on_gate, include_render: bool = True, solo_part: str | None = None,
            audio_path: Path | None = None, sf2_path: Path | None = None,
            program: int = 0) -> list[Path]:
    """Run gates in order, reporting each via on_gate(stage, status, metrics, error).
    include_render=False is the wizard preflight lane (everything except the slow
    headless-WebKit gate — preview and audio checks DO run there so the admin hears
    and sees verdicts while filling the form)."""
    state: dict = {}

    def sanity():
        m = gate_sanity(xml_path, midi_path, solo_part)
        state["meta"] = m["xml_meta"]
        state["solo"] = m["solo_part"]
        return m

    stages = [
        ("sanity", sanity),
        ("structure", lambda: gate_structure(xml_path, out_dir, state["meta"], state["solo"], state)),
        ("alignment", lambda: gate_alignment(xml_path, midi_path, out_dir, state["meta"], state["solo"], state)),
        ("geometry", lambda: gate_geometry(piece, xml_path, out_dir, state["meta"], state["solo"], state)),
        ("preview", lambda: gate_preview(out_dir, sf2_path, program)),
    ]
    if audio_path is not None:
        # Stage the uploaded audio under the canonical name before checking it.
        shutil.copyfile(audio_path, out_dir / "reference.m4a")
        stages.append(("audio", lambda: gate_audio(audio_path, out_dir, sf2_path, program, state)))
    if include_render:
        stages.append(("render", lambda: gate_render(piece, out_dir)))
        # rides the render lane: preflight must never touch playwright
        stages.append(("thumbnail", lambda: gate_thumbnail(piece, out_dir)))

    for stage, fn in stages:
        t0 = time.monotonic()
        on_gate(stage, "running", {}, None)
        try:
            metrics = fn()
        except GateError as err:
            metrics = dict(err.metrics)
            metrics["duration_ms"] = int((time.monotonic() - t0) * 1000)
            # Post-failure attribution: classify WHY the timelines disagree so the
            # uploader gets data facts instead of a generic rejection. Best-effort —
            # a diagnosis crash must never change the verdict.
            if stage == "geometry" and midi_path is not None and state.get("meta"):
                try:
                    from pipeline.diagnose import diagnose
                    eff = _effective_paths(xml_path, out_dir, state["meta"], state["solo"])
                    multi = state["meta"]["n_parts"] > 1 and state["solo"] is not None
                    sidx = ([p["id"] for p in state["meta"]["parts"]].index(state["solo"])
                            if multi else None)
                    d = diagnose(xml_path, eff, midi_path, sidx)
                    if d:
                        metrics["diagnosis"] = d
                except Exception:
                    traceback.print_exc()
            on_gate(stage, "fail", metrics, str(err))
            raise
        except Exception as err:
            # Unexpected crashes must still CLOSE the gate entry — otherwise the UI
            # shows a spinner forever on a failed job — and surface as a normal
            # gate failure instead of an opaque worker_crash.
            on_gate(stage, "fail", {"duration_ms": int((time.monotonic() - t0) * 1000)},
                    f"unexpected error: {str(err)[:160]}")
            raise GateError(f"{stage} crashed: {str(err)[:160]}") from err
        metrics["duration_ms"] = int((time.monotonic() - t0) * 1000)
        on_gate(stage, "pass", metrics, None)

    files = []
    for local_tmpl, _, _, _ in ARTIFACT_LAYOUT:
        p = out_dir / local_tmpl.format(p=piece)
        if p.exists():
            files.append(p)
    return files
