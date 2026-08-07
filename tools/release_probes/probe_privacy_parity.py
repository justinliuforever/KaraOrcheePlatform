#!/usr/bin/env python3
"""[C6]: the bundled Settings copy, the checked-in documents, and the numbers the
retention probe asserts all say the same thing — and so does the deployed public page.

    python3 tools/release_probes/probe_privacy_parity.py
    python3 tools/release_probes/probe_privacy_parity.py --public-url https://karaorchee.com/privacy

Paths default to the sibling checkouts and can be overridden by argument or by
NOTES_APP_REPO / NOTES_PRIVACY_DOCS. Exit 0 = every artifact agrees; 1 = a real
disagreement; 2 = something could not be read, so nothing was proved.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import privacy_parity  # noqa: E402

DEFAULT_APP = Path.home() / "Desktop" / "KaraOrcheeAMT"
DEFAULT_DOCS = (Path.home() / "Desktop" / "KaraOrcheeNotes_Feedback1" / "batch_ab" / "documents")
SWIFT_RELATIVE = Path("App") / "Settings" / "PrivacyDataView.swift"

DOCUMENTS = (
    ("retention_policy.md", privacy_parity.render_retention),
    ("privacy_notice.md", privacy_parity.render_notice),
)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--app-repo", default=os.environ.get("NOTES_APP_REPO", str(DEFAULT_APP)))
    p.add_argument("--docs", default=os.environ.get("NOTES_PRIVACY_DOCS", str(DEFAULT_DOCS)))
    p.add_argument("--public-url", default=os.environ.get("NOTES_PRIVACY_URL"))
    args = p.parse_args(argv)

    swift_path = Path(args.app_repo) / SWIFT_RELATIVE
    docs = Path(args.docs)
    try:
        source = swift_path.read_text()
    except OSError as err:
        print(f"UNPROVEN: {err}", file=sys.stderr)
        return 2

    failed = False
    print(f"probe_privacy_parity  app  {swift_path}")
    print(f"                      docs {docs}")
    for name, render in DOCUMENTS:
        try:
            document = (docs / name).read_text()
            rendered = render(source)
        except (OSError, KeyError) as err:
            print(f"UNPROVEN: {name}: {err}", file=sys.stderr)
            return 2
        lines = privacy_parity.diff(document, rendered, name)
        if lines:
            failed = True
            print(f"  DIFF  {name}")
            for line in lines:
                print(f"        {line}")
        else:
            print(f"  ok    {name} ({len(document)} chars)")

    numbers = privacy_parity.number_mismatches((docs / "retention_policy.md").read_text())
    for message in numbers:
        failed = True
        print(f"  DIFF  retention numbers: {message}")
    if not numbers:
        print(f"  ok    retention numbers ({len(privacy_parity.NUMBER_CLAIMS)} claims)")

    # The published page is the artifact a parent actually reads. Until FG-11 names a
    # URL there is nothing to fetch, and "not checked" must never print as a pass.
    if not args.public_url:
        print("  UNPROVEN  public page: no --public-url (FG-11 pending)", file=sys.stderr)
        return 2 if not failed else 1
    try:
        import urllib.request
        with urllib.request.urlopen(args.public_url, timeout=15) as response:
            page = response.read().decode("utf-8")
    except Exception as err:  # noqa: BLE001 - any failure here proves nothing
        print(f"  UNPROVEN  public page: {err}", file=sys.stderr)
        return 2 if not failed else 1
    for name, render in DOCUMENTS:
        body = (docs / name).read_text()
        missing = [line for line in body.split("\n")
                   if line.strip().startswith(("- **", "**")) and line.strip() not in page]
        if missing:
            failed = True
            print(f"  DIFF  public page is missing {len(missing)} line(s) of {name}")
            for line in missing[:5]:
                print(f"        {line[:110]}")
        else:
            print(f"  ok    public page carries {name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
