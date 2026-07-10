"""Compressed MusicXML (.mxl) support: verovio decompresses it natively, but our own
ElementTree passes (xml_meta facts, solo-part surgery) need the raw XML. MuseScore's
DEFAULT export is .mxl, so this is the common path, not an edge case."""
from __future__ import annotations
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


def ensure_xml(path: Path, out_dir: Path) -> Path:
    """Return a plain-XML path for `path`, extracting next to out_dir if compressed."""
    with open(path, "rb") as f:
        if f.read(4) != b"PK\x03\x04":
            return path
    with zipfile.ZipFile(path) as z:
        root_name = None
        try:
            container = ET.fromstring(z.read("META-INF/container.xml"))
            rootfile = container.find(".//rootfile")
            if rootfile is not None:
                root_name = rootfile.get("full-path")
        except KeyError:
            pass
        if not root_name:
            candidates = [n for n in z.namelist()
                          if n.lower().endswith((".xml", ".musicxml")) and not n.startswith("META-INF")]
            if not candidates:
                raise ValueError("compressed MusicXML contains no score XML")
            root_name = candidates[0]
        out = out_dir / (path.stem + ".extracted.musicxml")
        out.write_bytes(z.read(root_name))
        return out
