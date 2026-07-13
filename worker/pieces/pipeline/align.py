"""Pitch-aware event alignment, shared by diagnose (post-failure attribution) and the
structure-aware gates (PASS-path verdicts). Extracted verbatim from diagnose._align —
behavior is load-bearing there; changes need both consumers' tests.
"""
from __future__ import annotations


def align_events(xa: list[dict], xb: list[dict]) -> list[tuple[int, int]]:
    """Banded DP alignment on (normalized position, pitch-set) — scale-neutral, so an
    untruthful MIDI tick clock cannot fake structural divergence.
    xa: [{"q": float, "pitches": frozenset}], xb: [{"beat": float, "pitches": frozenset}]."""
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


def structure_match_score(xml_events: list[dict], midi_events: list[dict]) -> float:
    """How well the MIDI's event stream realizes this XML timeline's STRUCTURE:
    fraction of the larger stream aligned with exactly-equal pitch sets. Robust to
    ornament surpluses (gaps) and tempo (scale-neutral positions)."""
    pairs = align_events(xml_events, midi_events)
    if not pairs:
        return 0.0
    exact = sum(1 for i, j in pairs
                if xml_events[i]["pitches"] == midi_events[j]["pitches"])
    return exact / max(len(xml_events), len(midi_events))
