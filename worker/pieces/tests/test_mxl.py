import sys, tempfile, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline.mxl import ensure_xml

XML = b'<?xml version="1.0"?><score-partwise version="3.1"><part-list/><part id="P1"/></score-partwise>'


def test_plain_xml_passthrough():
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "a.musicxml"
    src.write_bytes(XML)
    assert ensure_xml(src, tmp) == src


def test_musescore_style_container():
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "a.mxl"
    with zipfile.ZipFile(src, "w") as z:
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>')
        z.writestr("score.xml", XML)
    out = ensure_xml(src, tmp)
    assert out != src
    ET.parse(out)


def test_bare_zip_fallback():
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "a.mxl"
    with zipfile.ZipFile(src, "w") as z:
        z.writestr("whatever.musicxml", XML)
    ET.parse(ensure_xml(src, tmp))


def test_zip_without_score_raises():
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "a.mxl"
    with zipfile.ZipFile(src, "w") as z:
        z.writestr("readme.txt", "no score here")
    with pytest.raises(ValueError):
        ensure_xml(src, tmp)
