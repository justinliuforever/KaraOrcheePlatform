import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))
from gates import ARTIFACT_LAYOUT, PUBLISH_ROLES, gate_thumbnail
from pipeline.thumbnail import PAPER_RGB, THUMB_H, THUMB_W, compose, render_thumbnail
from tests.test_structure import ATTRS, measure, score


def _dark(px):
    return sum(px) < 90


def test_compose_top_crops_tall_page():
    src = Image.new("RGB", (1200, 5000), (255, 255, 255))
    src.paste(Image.new("RGB", (1200, 60), (0, 0, 0)), (0, 0))
    src.paste(Image.new("RGB", (1200, 60), (255, 0, 0)), (0, 4000))
    out = compose(src)
    assert out.size == (THUMB_W, THUMB_H)
    assert _dark(out.getpixel((300, 10)))                       # top content survives
    reds = [out.getpixel((x, y)) for x in range(0, THUMB_W, 13) for y in range(0, THUMB_H, 13)]
    assert not any(r > 200 and g < 60 for (r, g, b) in reds)    # below-crop content gone


def test_compose_pads_short_page_with_paper():
    src = Image.new("RGB", (1200, 900), (0, 0, 0))
    out = compose(src)
    assert out.size == (THUMB_W, THUMB_H)
    assert _dark(out.getpixel((300, 100)))
    px = out.getpixel((300, THUMB_H - 20))
    assert all(abs(a - b) <= 2 for a, b in zip(px, PAPER_RGB))


def test_compose_exact_aspect_is_pure_resize():
    out = compose(Image.new("RGB", (1200, 1600), (10, 20, 30)))
    assert out.size == (THUMB_W, THUMB_H)
    assert out.getpixel((300, 400)) == (10, 20, 30)


def test_gate_thumbnail_skips_on_failure(tmp_path):
    metrics = gate_thumbnail("nope", tmp_path)              # no SVG present
    assert "skipped" in metrics
    assert not (tmp_path / "thumbnail.webp").exists()


def test_thumbnail_registered_for_staging_and_publish():
    row = next(r for r in ARTIFACT_LAYOUT if r[0] == "thumbnail.webp")
    assert (row[1], row[2], row[3]) == ("thumbnail.webp", "thumbnail", None)
    assert "thumbnail" in PUBLISH_ROLES
    # source-text check (parity.test.ts style): importing main drags azure/psycopg
    main_src = (Path(__file__).parent.parent / "main.py").read_text()
    assert '".webp": "image/webp"' in main_src


def _webkit_ready() -> bool:
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            return Path(pw.webkit.executable_path).exists()
    except Exception:
        return False


def test_e2e_thumbnail_from_built_svg(tmp_path):
    if not _webkit_ready():
        pytest.skip("playwright webkit browser not installed (CI runs browserless)")
    from pipeline.staff import build_staff_assets
    xml = score(measure(1, ATTRS), *[measure(i) for i in range(2, 13)])
    build_staff_assets("t", xml, tmp_path / "score_events.json", tmp_path)
    m = render_thumbnail(tmp_path / "t.phone.svg", tmp_path / "thumbnail.webp")
    img = Image.open(tmp_path / "thumbnail.webp")
    assert img.format == "WEBP" and img.size == (THUMB_W, THUMB_H)
    assert m["bytes"] > 2000
    # not blank: paper corner, real ink somewhere, spread above noise
    # (measured: blank page 0, this bare 12-whole-note score 7.2, real piece 33.9)
    assert m["ink_stddev"] > 4.0
    corner = img.convert("RGB").getpixel((THUMB_W - 3, 3))
    assert all(abs(a - b) <= 6 for a, b in zip(corner, PAPER_RGB))
    px = list(img.convert("L").getdata())
    assert sum(1 for p in px if p < 100) > 200
