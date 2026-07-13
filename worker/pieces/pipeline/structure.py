"""Repeat-structure layer: classify the written score's repeat marks, compute OUR OWN
expected playback sequence, and verify verovio's expansion against it exactly.

The playback map is the single source of structure truth downstream (staff identity,
score_events playback block, gates, admin facts). Verovio's inference is powerful but
vendor-documented as limited — so every expansion it produces must EXACTLY equal the
sequence our independent expander derives from the marks, or the build rejects with
measure-level facts. A wrong bundle must be impossible; a rejected upload is fine.

Supported set v1 (everything else = explicit reject, Phase 2 widens):
  - repeat barline pairs, incl. the implicit start-of-piece forward repeat
  - times 2..4 on backward repeats
  - voltas: each ending's number list contiguous, and the union of the lists
    exactly partitions 1..times (admits "1,2"+"3" at times=3)
  - non-nested, standard left/right barline locations
"""
from __future__ import annotations
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path


class StructureError(Exception):
    def __init__(self, reason: str, measure: str | None = None):
        super().__init__(reason)
        self.measure = measure


# D.C./D.S. family: unconditional reject in v1 when jump WORDS or machine-readable
# sound attrs are present. Bare "fine"/"coda" words reject only alongside a jump
# (written-out "Coda" section headings are common and harmless).
_JUMP_WORD = re.compile(r"\b(d\.?\s?c\.?|d\.?\s?s\.?|da\s+capo|dal\s+segno|al\s+coda|to\s+coda|al\s+fine)\b", re.I)
_BARE_WORD = re.compile(r"\b(fine|coda|segno)\b", re.I)
_JUMP_SOUND_ATTRS = ("dacapo", "dalsegno", "tocoda", "fine", "segno", "coda")


@dataclass
class Ending:
    start: int                 # written measure index (1-based), inclusive
    stop: int                  # inclusive
    numbers: list[int]


@dataclass
class RepeatBlock:
    start: int                 # first repeated measure
    end: int                   # measure carrying the backward repeat (volta-1 end when voltas)
    times: int = 2
    endings: list[Ending] = field(default_factory=list)


@dataclass
class Structure:
    kind: str                  # "linear" | "repeats"
    n_measures: int
    blocks: list[RepeatBlock] = field(default_factory=list)

    @property
    def has_repeats(self) -> bool:
        return self.kind == "repeats"


def classify_structure(xml_path: Path) -> Structure:
    """Parse repeat marks from the (effective) MusicXML. Raises StructureError for
    anything outside the supported set — with the offending measure number."""
    root = ET.parse(xml_path).getroot()
    parts = root.findall("part")
    if not parts:
        raise StructureError("no <part> in score")

    per_part = [_part_marks(p) for p in parts]
    for other in per_part[1:]:
        if other != per_part[0]:
            raise StructureError(
                "parts disagree on repeat barlines — the score's parts encode different "
                "structures; re-export with consistent barlines")
    marks = per_part[0]
    n_measures = len(parts[0].findall("measure"))

    _reject_jumps(parts[0])

    # An unpaired forward repeat is decorative: every mainstream player (and the
    # engraving engine) plays through it, so a score with forwards but no backward
    # is linear. The 3-way expansion verify stays the backstop if an engine ever
    # disagrees.
    if not marks["backward"] and not marks["endings"]:
        return Structure(kind="linear", n_measures=n_measures)

    blocks = _pair_blocks(marks, n_measures)
    return Structure(kind="repeats", n_measures=n_measures, blocks=blocks)


def _part_marks(part) -> dict:
    forward, backward, endings = [], [], []
    open_endings: dict[str, dict] = {}
    for i, m in enumerate(part.findall("measure"), start=1):
        num = m.get("number") or str(i)
        for bl in m.findall("barline"):
            rep = bl.find("repeat")
            if rep is not None:
                d = rep.get("direction")
                if d == "forward":
                    forward.append(i)
                elif d == "backward":
                    t = rep.get("times")
                    if t is not None and not t.isdigit():
                        raise StructureError(f"non-numeric repeat times {t!r}", num)
                    backward.append((i, int(t) if t else 2))
                else:
                    raise StructureError(f"unknown repeat direction {d!r}", num)
            end = bl.find("ending")
            if end is not None:
                etype = end.get("type")
                nums_raw = (end.get("number") or "").strip()
                if etype == "start":
                    if not re.fullmatch(r"\d+(\s*,\s*\d+)*", nums_raw):
                        raise StructureError(
                            f"ending number {nums_raw!r} is not a plain list of pass numbers", num)
                    open_endings[nums_raw] = {"start": i, "numbers": [int(x) for x in re.split(r"\s*,\s*", nums_raw)]}
                elif etype in ("stop", "discontinue"):
                    key = nums_raw if nums_raw in open_endings else (next(iter(open_endings), None))
                    if key is None:
                        raise StructureError("ending stop without a matching start", num)
                    e = open_endings.pop(key)
                    endings.append(Ending(start=e["start"], stop=i, numbers=e["numbers"]))
    if open_endings:
        raise StructureError("ending started but never closed")
    return {"forward": forward, "backward": backward, "endings": endings}


def _reject_jumps(part) -> None:
    doc_words: list[tuple[str, str]] = []
    has_jump = False
    for i, m in enumerate(part.findall("measure"), start=1):
        num = m.get("number") or str(i)
        for snd in m.iter("sound"):
            for attr in _JUMP_SOUND_ATTRS:
                if snd.get(attr) is not None:
                    raise StructureError(
                        f"D.C./D.S./Coda navigation (<sound {attr}>) is not supported yet — "
                        "write the form out in playing order and re-export", num)
        for w in m.iter("words"):
            text = (w.text or "").strip()
            if not text:
                continue
            if _JUMP_WORD.search(text):
                raise StructureError(
                    f"D.C./D.S./Coda navigation ({text!r}) is not supported yet — "
                    "write the form out in playing order and re-export", num)
            if _BARE_WORD.search(text):
                doc_words.append((num, text))
        for tag in ("segno", "coda"):
            if m.find(f".//{tag}") is not None:
                has_jump = True
                bad = num
    if has_jump:
        raise StructureError(
            "segno/coda symbols present — D.C./D.S. navigation is not supported yet; "
            "write the form out in playing order and re-export", bad)
    # bare fine/coda words alone: allowed (written-out sections use them as headings)
    _ = doc_words


def _pair_blocks(marks: dict, n_measures: int) -> list[RepeatBlock]:
    forwards: list[int] = sorted(marks["forward"])
    backwards: list[tuple[int, int]] = sorted(marks["backward"])
    endings: list[Ending] = sorted(marks["endings"], key=lambda e: e.start)
    if not backwards:
        raise StructureError("forward repeat without any backward repeat")

    blocks: list[RepeatBlock] = []
    fw_iter = list(forwards)
    prev_block_end = 0
    for b_at, times in backwards:
        if not (2 <= times <= 4):
            raise StructureError(f"repeat times={times} outside supported 2..4", str(b_at))
        # forward partner: the last forward mark at or before the backward, after the
        # previous block; none = implicit start of piece (or start after previous block)
        cands = [f for f in fw_iter if prev_block_end < f <= b_at]
        start = max(cands) if cands else (prev_block_end + 1 if blocks else 1)
        if len(cands) > 1:
            raise StructureError(
                f"nested repeats (forward marks at {cands}) are not supported yet", str(b_at))
        block = RepeatBlock(start=start, end=b_at, times=times)
        block.endings = [e for e in endings if start <= e.start]
        block.endings = [e for e in block.endings if e.start <= b_at + 1 or e.start == b_at + 1]
        blocks.append(block)
        prev_block_end = b_at
        if cands:
            fw_iter.remove(cands[0])
    # Forwards left after the last backward are unpaired == decorative (see above);
    # they change nothing about the playing order and are deliberately ignored.

    # attach voltas: volta-1 must END at the backward repeat; later voltas follow it
    for block in blocks:
        block.endings = _attach_endings(block, endings)
    _check_no_overlap(blocks)
    return blocks


def _attach_endings(block: RepeatBlock, endings: list[Ending]) -> list[Ending]:
    mine = [e for e in endings if e.stop == block.end or
            (e.start > block.end and _belongs_after(e, block, endings))]
    if not mine:
        return []
    first = [e for e in mine if e.stop == block.end]
    if not first:
        raise StructureError(
            "volta structure: no ending closes at the backward repeat", str(block.end))
    covered: set[int] = set()
    for e in mine:
        nums = sorted(e.numbers)
        if nums != list(range(nums[0], nums[-1] + 1)):
            raise StructureError(
                f"non-contiguous ending list {e.numbers} is not supported yet", str(e.start))
        if covered & set(nums):
            raise StructureError(f"overlapping ending numbers {e.numbers}", str(e.start))
        covered |= set(nums)
    if covered != set(range(1, block.times + 1)):
        raise StructureError(
            f"ending numbers {sorted(covered)} do not exactly cover passes 1..{block.times}",
            str(block.end))
    return sorted(mine, key=lambda e: min(e.numbers))


def _belongs_after(e: Ending, block: RepeatBlock, endings: list[Ending]) -> bool:
    # the volta chain directly following this block's backward repeat
    chain_end = block.end
    for cand in sorted(endings, key=lambda x: x.start):
        if cand.start == chain_end + 1:
            if cand is e:
                return True
            chain_end = cand.stop
    return False


def _check_no_overlap(blocks: list[RepeatBlock]) -> None:
    prev_end = 0
    for b in sorted(blocks, key=lambda x: x.start):
        volta_end = max([e.stop for e in b.endings], default=b.end)
        if b.start <= prev_end:
            raise StructureError(
                f"repeat blocks overlap around measure {b.start} — nested/overlapping "
                "repeats are not supported yet", str(b.start))
        prev_end = volta_end


def expected_playback_sequence(st: Structure) -> list[int]:
    """Written measure indices (1-based) in playing order — our independent expander."""
    if not st.has_repeats:
        return list(range(1, st.n_measures + 1))
    seq: list[int] = []
    pos = 1
    for block in sorted(st.blocks, key=lambda b: b.start):
        seq.extend(range(pos, block.start))
        volta_end = max([e.stop for e in block.endings], default=block.end)
        if block.endings:
            first_volta_start = min(e.start for e in block.endings)
            body = list(range(block.start, first_volta_start))
            for p in range(1, block.times + 1):
                seq.extend(body)
                volta = next(e for e in block.endings if p in e.numbers)
                seq.extend(range(volta.start, volta.stop + 1))
        else:
            body = list(range(block.start, block.end + 1))
            for _ in range(block.times):
                seq.extend(body)
        pos = volta_end + 1
    seq.extend(range(pos, st.n_measures + 1))
    return seq


_REND = re.compile(r"-rend\d+$")


def timemap_measure_sequence(tk) -> list[str]:
    """Measure xml:ids in PLAYED order from an already-loaded toolkit, expansion
    copies collapsed back to their written ids (-rendN suffix)."""
    tm = tk.renderToTimemap({"includeMeasures": True, "includeRests": False})
    seq = []
    for e in tm:
        mon = e.get("measureOn")
        if mon:
            seq.append(_REND.sub("", mon))
    return seq


def verify_expansion(played_ids: list[str], written_ids: list[str], expected: list[int]) -> None:
    """played_ids: timemap measure ids (rend-stripped). written_ids: MEI document order.
    Both must realize exactly the expected written-index sequence."""
    idx = {mid: i + 1 for i, mid in enumerate(written_ids)}
    got = [idx.get(mid, -1) for mid in played_ids]
    if got != expected:
        k = next((i for i, (a, b) in enumerate(zip(got, expected)) if a != b),
                 min(len(got), len(expected)))
        raise StructureError(
            f"expansion mismatch at playback step {k + 1}: engine plays written measure "
            f"{got[k] if k < len(got) else '(end)'} where the marks say "
            f"{expected[k] if k < len(expected) else '(end)'} "
            f"(engine {len(got)} played measures, marks {len(expected)}) — "
            "the repeat structure could not be expanded safely")


def build_playback_map(st: Structure, expected: list[int],
                       measure_secs: list[tuple[float, float]],
                       measure_qs: list[tuple[float, float]]) -> dict:
    """The canonical playback block (design 1a). measure_secs/qs: per PLAYED measure
    (from the expanded timemap), aligned 1:1 with `expected`."""
    assert len(measure_secs) == len(expected)
    pass_count: dict[int, int] = {}
    occurrences = []
    for k, wm in enumerate(expected):
        pass_count[wm] = pass_count.get(wm, 0) + 1
        occurrences.append({
            "measure_index": wm, "pass": pass_count[wm], "span_index": None,
            "expanded_sec_start": round(measure_secs[k][0], 4),
            "expanded_sec_end": round(measure_secs[k][1], 4),
            "expanded_q_start": round(measure_qs[k][0], 4),
            "expanded_q_end": round(measure_qs[k][1], 4),
        })
    spans = []
    cur = None
    for occ in occurrences:
        if (cur is not None and occ["measure_index"] == cur["written_end"] + 1
                and occ["pass"] == cur["pass"]):
            cur["written_end"] = occ["measure_index"]
            cur["expanded_sec_end"] = occ["expanded_sec_end"]
            cur["expanded_q_end"] = occ["expanded_q_end"]
        else:
            if cur is not None:
                spans.append(cur)
            jump = "none"
            if cur is not None:
                jump = "backward" if occ["measure_index"] <= cur["written_end"] else "forward"
                if occ["measure_index"] == cur["written_end"] + 1:
                    jump = "none"
            cur = {"span_index": len(spans), "pass": occ["pass"],
                   "written_start": occ["measure_index"], "written_end": occ["measure_index"],
                   "expanded_sec_start": occ["expanded_sec_start"], "expanded_sec_end": occ["expanded_sec_end"],
                   "expanded_q_start": occ["expanded_q_start"], "expanded_q_end": occ["expanded_q_end"],
                   "jump_in": jump}
        occ["span_index"] = cur["span_index"]
    if cur is not None:
        spans.append(cur)
    endings = [{"numbers": e.numbers, "written_start": e.start, "written_end": e.stop}
               for b in st.blocks for e in b.endings]
    return {
        "spans": spans,
        "occurrences": occurrences,
        "endings": endings,
        "counts": {
            "written_measures": st.n_measures,
            "played_measures": len(expected),
            "max_passes": max(pass_count.values(), default=1),
            "expanded_duration_sec": round(measure_secs[-1][1], 4) if measure_secs else 0.0,
        },
    }
