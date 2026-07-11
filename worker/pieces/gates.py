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
from pipeline.preview import render_preview
from pipeline.audio_gate import check_reference_audio, AudioGateError


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
    normalize metronome marks (verovio's dotted-unit conversion is wrong)."""
    if meta["n_parts"] <= 1 or solo_used is None:
        return normalize_tempo(xml_path, out_dir)
    reduced = out_dir / "_solo.musicxml"
    reduce_xml_to_part(xml_path, reduced, solo_used)
    return normalize_tempo(reduced, out_dir)


def gate_alignment(xml_path: Path, midi_path: Path | None, out_dir: Path,
                   meta: dict, solo_used: str | None) -> dict:
    multi = meta["n_parts"] > 1 and solo_used is not None
    effective_xml = _effective_paths(xml_path, out_dir, meta, solo_used)

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
    se.write_score_events(payload, out_dir / "score_events.json")

    duration = max((e["onset_sec"] + max(e["durations"]) for e in payload["events"]), default=0.0)
    return {"route": route, "n_events": payload["n_events"],
            "solo_part": solo_used if multi else None,
            "accompaniment": multi and (out_dir / "accompaniment_events.json").exists(),
            "duration_sec": round(duration, 1),
            "initial_tempo_eps": round(payload["initial_tempo_eps"], 4)}


def gate_geometry(piece: str, xml_path: Path, out_dir: Path,
                  meta: dict, solo_used: str | None) -> dict:
    effective_xml = _effective_paths(xml_path, out_dir, meta, solo_used)
    bundle = build_staff_assets(piece, effective_xml, out_dir / "score_events.json", out_dir)
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


def gate_audio(audio_path: Path, out_dir: Path) -> dict:
    try:
        return check_reference_audio(audio_path, out_dir / "score_events.json")
    except AudioGateError as err:
        raise GateError(str(err), err.metrics) from err


def gate_render(piece: str, out_dir: Path) -> dict:
    ok, failures, metrics = run_gate(out_dir, piece)
    if not ok:
        raise GateError("cursor-on-staff verification failed: " + "; ".join(failures[:5]), metrics)
    return metrics


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
    ("preview.m4a", "preview.m4a", "preview_audio", None),
]
PUBLISH_ROLES = {"score_events", "accompaniment_events", "geometry", "svg", "reference_audio"}


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
        ("alignment", lambda: gate_alignment(xml_path, midi_path, out_dir, state["meta"], state["solo"])),
        ("geometry", lambda: gate_geometry(piece, xml_path, out_dir, state["meta"], state["solo"])),
        ("preview", lambda: gate_preview(out_dir, sf2_path, program)),
    ]
    if audio_path is not None:
        # Stage the uploaded audio under the canonical name before checking it.
        shutil.copyfile(audio_path, out_dir / "reference.m4a")
        stages.append(("audio", lambda: gate_audio(audio_path, out_dir)))
    if include_render:
        stages.append(("render", lambda: gate_render(piece, out_dir)))

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
