"""Rebuild-diff harness: re-run the preflight pipeline on every PUBLISHED piece's
archived sources and compare score_events.json + staff.json byte-for-byte against
the published blobs. The linear corpus must be sha256-identical through any pipeline
change; repeat-bearing pieces are expected diffs (schema 2) and report their verdicts.

Manual ops tool (needs blob access via `az` CLI): python tools/rebuild_regression.py
"""
from __future__ import annotations
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from gates import GateError, run_all  # noqa: E402

ACCOUNT = "stkaraoappdev"
PIECES = [
    "bach_bwv_846", "bach_fugue_bwv_846", "chopin_etude_op25_12_ocean",
    "chopin_sonata3_mvt4", "czerny_599_41", "haydn_sonata_48_2",
    "liszt_trans_5_feux_follets", "mozart_k330_mvt1", "rach_op23_4",
    "schubert_sonata_894_mvt2", "scriabin_etude_op8_11",
]


def az_download(container: str, blob: str, dest: Path) -> bool:
    r = subprocess.run(
        ["az", "storage", "blob", "download", "--account-name", ACCOUNT,
         "--auth-mode", "key", "-c", container, "-n", blob, "-f", str(dest),
         "--no-progress", "-o", "none"],
        capture_output=True)
    return r.returncode == 0 and dest.exists()


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="rebuild-regression-"))
    print(f"workdir {work}")
    identical, expected_diff, failures = [], [], []
    for pid in PIECES:
        pdir = work / pid
        pdir.mkdir()
        xml = pdir / "score.musicxml"
        if not az_download("piece-sources", f"{pid}/score.musicxml", xml):
            failures.append((pid, "source xml missing"))
            continue
        midi = pdir / "reference.mid"
        has_midi = az_download("piece-sources", f"{pid}/reference.mid", midi)

        out = pdir / "out"
        out.mkdir()
        gate_log: list[tuple[str, str]] = []
        try:
            run_all("regression", pid, xml, midi if has_midi else None, out,
                    on_gate=lambda st, ok, m, e: gate_log.append((st, ok)),
                    include_render=False)
        except GateError as err:
            failures.append((pid, f"gate {gate_log[-1][0] if gate_log else '?'}: {str(err)[:140]}"))
            continue

        staff_new = out / f"{pid}.staff.json"
        schema = json.loads(staff_new.read_text()).get("schema")
        diffs = []
        for new, blob in [(out / "score_events.json", f"{pid}/v1/score_events.json"),
                          (staff_new, f"{pid}/v1/staff.json")]:
            old = pdir / (blob.split("/")[-1] + ".published")
            if not az_download("piece-bundles", blob, old):
                diffs.append(f"{blob.split('/')[-1]}: published blob missing")
                continue
            if sha(new) != sha(old):
                diffs.append(f"{blob.split('/')[-1]}: {sha(new)} != {sha(old)}")
        if not diffs:
            identical.append(pid)
            print(f"  {pid}: BYTE-IDENTICAL")
        elif schema == 2:
            expected_diff.append((pid, diffs))
            print(f"  {pid}: schema-2 rebuild (repeat piece) — expected diff: {diffs}")
        else:
            failures.append((pid, "; ".join(diffs)))
            print(f"  {pid}: UNEXPECTED DIFF {diffs}")

    print(f"\nidentical {len(identical)} | expected-diff {len(expected_diff)} | failures {len(failures)}")
    for pid, why in failures:
        print(f"  FAIL {pid}: {why}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
