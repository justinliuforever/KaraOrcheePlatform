"""The four studio gates. Each returns (metrics_dict) or raises GateError with a
human-readable reason. Artifacts land in a job-local directory; the caller uploads."""
from __future__ import annotations
import json
import time
from pathlib import Path
import pretty_midi
import verovio

from pipeline import score_events as se
from pipeline.staff import build_staff_assets
from pipeline.cursor_gate import run_gate


class GateError(Exception):
    def __init__(self, reason: str, metrics: dict | None = None):
        super().__init__(reason)
        self.metrics = metrics or {}


def gate_sanity(xml_path: Path, midi_path: Path | None) -> dict:
    tk = verovio.toolkit()
    tk.setOptions({"header": "none", "footer": "none"})
    if not tk.loadFile(str(xml_path)):
        raise GateError("MusicXML failed to load (not a valid MusicXML/MXL file?)")
    tm = tk.renderToTimemap({"includeMeasures": True, "includeRests": False})
    n_measures = sum(1 for e in tm if e.get("measureOn"))
    n_onsets = sum(1 for e in tm if e.get("on"))
    if n_measures < 1 or n_onsets < 1:
        raise GateError(f"score is empty (measures={n_measures}, onsets={n_onsets})")
    metrics = {"measures": n_measures, "xml_onsets": n_onsets, "xml_bytes": xml_path.stat().st_size}
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


def gate_alignment(xml_path: Path, midi_path: Path | None, out_dir: Path) -> dict:
    """Produce score_events.json and, on the MIDI route, verify the performance
    timeline matches the notated score (median nearest-onset residual < 12ms —
    the same one-timeline law the staff gate enforces)."""
    if midi_path is not None:
        payload = se.from_midi(midi_path)
        route = "midi"
    else:
        payload = se.from_xml_timemap(xml_path)
        route = "xml_timemap"
    se.write_score_events(payload, out_dir / "score_events.json")
    return {"route": route, "n_events": payload["n_events"],
            "initial_tempo_eps": round(payload["initial_tempo_eps"], 4)}


def gate_geometry(piece: str, xml_path: Path, out_dir: Path) -> dict:
    bundle = build_staff_assets(piece, xml_path, out_dir / "score_events.json", out_dir)
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


def gate_render(piece: str, out_dir: Path) -> dict:
    ok, failures, metrics = run_gate(out_dir, piece)
    if not ok:
        raise GateError("cursor-on-staff verification failed: " + "; ".join(failures[:5]), metrics)
    return metrics


# Staged blob name -> (role, variant) matching the publisher layout the app decodes.
ARTIFACT_LAYOUT = [
    ("score_events.json", "score_events.json", "score_events", None),
    ("{p}.staff.json", "staff.json", "geometry", None),
    ("{p}.phone.svg", "score.phone.svg", "svg", "phone"),
    ("{p}.ipad.svg", "score.ipad.svg", "svg", "ipad"),
    ("{p}.ipad_portrait.svg", "score.ipad_portrait.svg", "svg", "ipad_portrait"),
]


def run_all(job_id: str, piece: str, xml_path: Path, midi_path: Path | None, out_dir: Path,
            on_gate, include_render: bool = True) -> list[Path]:
    """Run gates in order, reporting each via on_gate(stage, status, metrics, error).
    Returns the artifact files (local paths) on success. include_render=False is the
    wizard preflight lane — everything except the slow headless-WebKit gate."""
    stages = [
        ("sanity", lambda: gate_sanity(xml_path, midi_path)),
        ("alignment", lambda: gate_alignment(xml_path, midi_path, out_dir)),
        ("geometry", lambda: gate_geometry(piece, xml_path, out_dir)),
    ]
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
            on_gate(stage, "fail", metrics, str(err))
            raise
        metrics["duration_ms"] = int((time.monotonic() - t0) * 1000)
        on_gate(stage, "pass", metrics, None)

    files = []
    for local_tmpl, _, _, _ in ARTIFACT_LAYOUT:
        p = out_dir / local_tmpl.format(p=piece)
        if p.exists():
            files.append(p)
    return files
