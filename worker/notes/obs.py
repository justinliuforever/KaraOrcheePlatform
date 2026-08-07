"""One JSON line per worker event -> ContainerAppConsoleLogs_CL.

Severity is decided HERE and shipped as `level`; the Ops page reads that field rather
than keeping its own copy of this vocabulary.
"""
from __future__ import annotations

import json

# A job, or a whole lane, did not do what it was asked to do.
ERROR_EVENTS = {
    "asr_fail",
    "asr_vendor_delete_failed",
    "asset_delete_failed",
    "gate_fail",
    "llm_invalid",
    "narration_failed",
    "narration_lane_down",
    "worker_crash",
}
# Recovered, or an outcome an operator should see without it counting as a fault.
WARN_EVENTS = {
    "drop",
    "llm_repair",
    "model_output_unwritten",
    "narration_clip_failed",
    "narration_deadline",
    "narration_over_budget",
    "narration_unconfigured",
    "ready_push_failed",
}


def level_for(event: str) -> str:
    if event in ERROR_EVENTS:
        return "error"
    if event in WARN_EVENTS:
        return "warn"
    return "info"


def jlog(**fields) -> None:
    print(json.dumps({"kind": "notes-worker", "level": level_for(str(fields.get("event", ""))),
                      **fields}), flush=True)
