"""[C6] parity, as pure functions.

Three artifacts have to agree, and each is authored in a different language: the
checked-in source document, the copy compiled into the iOS Settings screen, and the
numbers the probes assert against Azure. Two of the three were compared before; a
number could still drift in the third and every check stayed green.
"""
from __future__ import annotations

import difflib
import re

import retention

# document phrase -> the constant that must produce the number inside it. Anchored on
# the phrase, not the digits, so a reworded row fails loudly instead of silently
# ceasing to be checked.
NUMBER_CLAIMS = {
    "deleted files are recoverable by our operators for up to {n} days":
        retention.operator_recovery_days(),
    "database backups are kept {n} days": retention.PG_BACKUP_RETENTION_DAYS,
    "overwritten note files up to {n} days": retention.DELETED_VERSION_RETENTION_DAYS,
    "deleted {n} days after processing": retention.TRANSCRIPT_RETENTION_DAYS,
    "deleted on the same {n}-day clock": retention.TRANSCRIPT_RETENTION_DAYS,
}


def unescape_swift(text: str) -> str:
    text = re.sub(r"\\u\{([0-9A-Fa-f]+)\}", lambda m: chr(int(m.group(1), 16)), text)
    return text.replace('\\"', '"').replace("\\\\", "\\")


def swift_literal(source: str, name: str) -> str:
    match = re.search(r'static let %s = "((?:[^"\\]|\\.)*)"' % name, source)
    if match is None:
        raise KeyError(f"no compiled-in literal named {name}")
    return unescape_swift(match.group(1))


def swift_entries(source: str, block: str) -> list[tuple[str, str]]:
    match = re.search(r"static let %s: \[Entry\] = \[(.*?)\n    \]" % block, source, re.S)
    if match is None:
        raise KeyError(f"no compiled-in entry block named {block}")
    body = match.group(1)
    out = [
        (unescape_swift(m.group(1)), unescape_swift(m.group(2)))
        for m in re.finditer(
            r'Entry\(lead: "((?:[^"\\]|\\.)*)",\s*\n?\s*rest: "((?:[^"\\]|\\.)*)"(?:, atomic: true)?\)',
            body, re.S)
    ]
    if "deletionSection," in body:
        section = re.search(
            r'static let deletionSection = Entry\(\s*lead: "((?:[^"\\]|\\.)*)",'
            r'\s*\n?\s*rest: "((?:[^"\\]|\\.)*)"\)', source, re.S)
        if section is None:
            raise KeyError("deletionSection referenced but not defined")
        disclosure = swift_literal(source, "signInDisclosure")
        lead = unescape_swift(section.group(1))
        rest = unescape_swift(section.group(2)).replace("\\(signInDisclosure)", disclosure)
        lines = body.split("\n")
        idx = next(i for i, line in enumerate(lines) if "deletionSection," in line)
        before = len(re.findall(r"Entry\(lead:", "\n".join(lines[:idx])))
        out.insert(before, (lead, rest))
    return out


def render_retention(source: str) -> str:
    rows = swift_entries(source, "retentionRows")
    return "# %s\n\n" % swift_literal(source, "retentionTitle") + \
        "\n".join("- **%s**%s" % row for row in rows) + "\n"


def render_notice(source: str) -> str:
    sections = swift_entries(source, "noticeSections")
    head = "# %s\n\n%s\n\n" % (swift_literal(source, "noticeTitle"),
                               swift_literal(source, "noticeIntro"))
    return head + "\n\n".join("**%s**%s" % s for s in sections) + "\n"


def diff(document: str, rendered: str, name: str) -> list[str]:
    if document == rendered:
        return []
    return list(difflib.unified_diff(document.split("\n"), rendered.split("\n"),
                                     f"{name} (document)", f"{name} (app)", lineterm=""))


def number_mismatches(document: str) -> list[str]:
    """Every number the document prints, checked against the constant the probe
    asserts against Azure. A row whose phrase is gone is a mismatch too — the check
    must not fall silent because someone reworded the sentence it guards."""
    out: list[str] = []
    for phrase, expected in NUMBER_CLAIMS.items():
        pattern = re.escape(phrase).replace(r"\{n\}", r"(\d+)")
        found = re.search(pattern, document)
        if found is None:
            out.append(f'no row reads "{phrase.format(n="<n>")}" — the check guards nothing')
        elif int(found.group(1)) != expected:
            out.append(f'"{phrase.format(n=found.group(1))}" but the probe asserts {expected}')
    return out
