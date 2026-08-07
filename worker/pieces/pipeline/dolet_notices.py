"""Dolet's own failure log, read back out of the export.

Dolet 8.3 has exactly one reporting channel: LogError() (Dolet8.plg:16528) writes every
complaint in place as `<?DoletSibelius …?>`. Nothing else in any of the four .plg files
emits a processing instruction, and there is no trace() output.

Two constraints this module exists to satisfy, both of which silently defeat the obvious
implementation:
  * ElementTree drops processing instructions, so this cannot live inside xml_meta's tree.
  * The engraver's exports are UTF-16 (Dolet8.plg:81 hard-codes encoding='UTF-16'), so the
    text has to be decoded from a BOM sniff, not read as UTF-8.
"""
from __future__ import annotations
import re
from pathlib import Path

_PI = re.compile(r"<\?DoletSibelius\s+(.*?)\?>", re.S)
_MEASURE = re.compile(r"""<measure\b[^>]*?\bnumber=["']([^"']*)["'](?:[^>]*?\btext=["']([^"']*)["'])?""")

# Dolet reuses the error channel to carry Sibelius layout settings an importer cannot
# derive (Dolet8.plg:16183 "Output the cutoff percentage here as a processing instruction").
# They are the only notices shaped Identifier=Value; matching the shape rather than the four
# known keys keeps a future Dolet's new setting out of the wizard card without a code change.
_LAYOUT_DATA = re.compile(r"^[A-Za-z][A-Za-z0-9]*=")

# A notice blocks only when a musician reading the printed page would play wrong notes.
# Everything else is a visible or audible loss the notes survive, and warns.
_BLOCK_PREFIXES = (
    "Unrecognized line style line.staff.octava.",   # Dolet8.plg:8592 — the 8va/8vb bug
    "Unrecognized octave line style ",              # Dolet8.plg:3121
    "Octava line not exported",                     # Dolet8.plg:3125
    "Unexported transposition",                     # Dolet8.plg:3576
)

_CODES = (
    # (message prefix, code)  — first match wins, longest prefixes first
    ("Unrecognized line style line.staff.octava.", "dolet_octave_line_dropped"),
    ("Unrecognized octave line style ",            "dolet_octave_line_dropped"),
    ("Octava line not exported",                   "dolet_octave_line_dropped"),
    ("Unexported transposition",                   "dolet_transposition_dropped"),
    ("Unrecognized line style ",                   "dolet_line_dropped"),
    ("Unrecognized music text written as words",   "dolet_music_font_as_text"),
    ("Unknown symbol index ",                      "dolet_symbol_unmapped"),
    ("Unknown user-defined ",                      "dolet_symbol_unmapped"),
    ("Unrecognized symbol item index ",            "dolet_symbol_unmapped"),
    ("Unexported custom articulation ",            "dolet_articulation_dropped"),
    ("Unexported slide start",                     "dolet_slide_dropped"),
    ("Unexported box",                             "dolet_box_dropped"),
    ("Unexported graphic",                         "dolet_graphic_dropped"),
    ("Unexported guitar scale diagram",            "dolet_diagram_dropped"),
    ("Unexported stemlet",                         "dolet_stemlet_dropped"),
    ("Unexported parentheses",                     "dolet_parentheses_dropped"),
    ("Unexported credit in style ",                "dolet_credit_dropped"),
    ("Unexported format code ",                    "dolet_format_code_dropped"),
    ("Untranslated wildcard ",                     "dolet_wildcard_untranslated"),
    ("Glissando not exported",                     "dolet_level_exhausted"),
    ("Slur not exported",                          "dolet_level_exhausted"),
    ("Trill not exported",                         "dolet_level_exhausted"),
    ("Unrecognized pedal line style ",             "dolet_pedal_unrecognized"),
    ("Unrecognized system text style ",            "dolet_text_style_unrecognized"),
    ("Unknown clef style ",                        "dolet_clef_substituted"),
    ("Unknown sound id ",                          "dolet_sound_id_unknown"),
    ("Bend exported as slur",                      "dolet_bend_as_slur"),
    ("Chord symbol saved as text",                 "dolet_chord_as_text"),
    ("Frame missing; chord symbol saved as text",  "dolet_chord_as_text"),
    ("Tied already present",                       "dolet_lv_dropped"),
    ("No place for user-defined or conflicting lyric", "dolet_lyric_dropped"),
    ("Tuplet(s) in following note are confusing",  "dolet_tuplet_suspect"),
    ("Extending tuplet to compensate",             "dolet_tuplet_extended"),
    ("Two NoteRests in same voice",                "dolet_voice_collision"),
    ("Large within-voice backup",                  "dolet_voice_collision"),
    ("Unrecognized c format string ",              "dolet_format_code_dropped"),
)


def _read_any(path: Path) -> str:
    b = path.read_bytes()
    for bom, enc in ((b"\xff\xfe\x00\x00", "utf-32-le"), (b"\x00\x00\xfe\xff", "utf-32-be"),
                     (b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be"),
                     (b"\xef\xbb\xbf", "utf-8-sig")):
        if b.startswith(bom):
            return b.decode(enc)
    return b.decode("utf-8", errors="replace")


def _classify(msg: str) -> tuple[str, str]:
    for prefix, code in _CODES:
        if msg.startswith(prefix):
            sev = "block" if msg.startswith(_BLOCK_PREFIXES) else "warn"
            return code, sev
    return "dolet_notice", "warn"


def dolet_notices(xml_path: Path, max_measures: int = 8) -> list[dict]:
    """Every actionable thing Dolet told us it could not export, grouped by kind.

    Returns [{code, severity, count, measures, detail}], severity 'block' or 'warn'.
    Layout-data notices are dropped; unrecognised messages warn rather than disappear.
    """
    raw = _read_any(Path(xml_path))
    # A file holding several pieces restarts bar numbering, so `number` is unique but the
    # engraver reads `text`. Report his number, and disambiguate with the index when they
    # differ — otherwise every Invention's bar 1 collapses into one useless "bar 1".
    bars = []
    for m in _MEASURE.finditer(raw):
        index, printed = m.group(1), m.group(2)
        label = index if not printed or printed == index else f"{printed} (#{index})"
        bars.append((m.start(), label))

    grouped: dict[tuple[str, str], dict] = {}
    for hit in _PI.finditer(raw):
        msg = " ".join(hit.group(1).split())
        if _LAYOUT_DATA.match(msg):
            continue
        code, sev = _classify(msg)
        # A message we have never seen keeps its whole text, or the card would show
        # an unnamed complaint — the one case the gate exists to survive.
        detail = msg
        for prefix, c in _CODES:
            if c == code and msg.startswith(prefix):
                detail = msg[len(prefix):].strip()
                break
        key = (code, detail)
        g = grouped.setdefault(key, {"code": code, "severity": sev, "count": 0,
                                     "measures": [], "detail": detail})
        g["count"] += 1
        bar = "front matter"
        for pos, num in bars:
            if pos > hit.start():
                break
            bar = num
        if bar not in g["measures"]:
            g["measures"].append(bar)

    out = sorted(grouped.values(), key=lambda g: (g["severity"] != "block", -g["count"]))
    for g in out:
        g["measures_total"] = len(g["measures"])
        g["measures"] = g["measures"][:max_measures]
    return out
