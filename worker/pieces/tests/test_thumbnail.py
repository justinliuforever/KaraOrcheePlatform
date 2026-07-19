import base64
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))
from gates import ARTIFACT_LAYOUT, PUBLISH_ROLES, gate_thumbnail
from pipeline.thumbnail import (
    ICON_FALLBACK_WIDTH_FRAC, ICON_H, ICON_W, PAPER_RGB,
    TEXT_FONT_FILE, THUMB_H, THUMB_W, compose, compose_icon, font_face_css,
    html_for, icon_crop_rect, render_catalog_art, render_thumbnail,
)
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


def _staff(measures, sysbbox=(500.0, 1000.0, 29000.0, 2000.0), vbw=30000):
    return {"variants": {"phone": {
        "page": {"viewbox_w": vbw},
        "systems": [{"system_index": 0, "bbox": list(sysbbox)}],
        "measures": measures}}}


def test_icon_rect_is_3_4_window_at_system_left():
    staff = _staff([{"bbox": [500.0, 1000.0, 6000.0, 2000.0]},
                    {"bbox": [6500.0, 1000.0, 6000.0, 2000.0]}])
    rect, source = icon_crop_rect(staff, 1200)
    assert source == "system0"
    scale, pad = 1200 / 30000, 0.15 * 2000
    x0, y0, x1, y1 = rect
    band_h = 2000 + 2 * pad
    assert x0 == pytest.approx((500 - pad) * scale)
    assert y0 == pytest.approx((1000 - pad) * scale)
    # width = band height * 3/4: the window ITSELF is 3:4, so the crop fills the
    # canvas — no letterboxed thin strip.
    assert x1 == pytest.approx((500 - pad + band_h * ICON_W / ICON_H) * scale)
    assert y1 == pytest.approx((1000 + 2000 + pad) * scale)
    assert (x1 - x0) / (y1 - y0) == pytest.approx(ICON_W / ICON_H)


def test_icon_rect_width_clamped_to_narrow_system():
    # A tall band on a NARROW system: width must clamp to the system, not spill.
    staff = _staff([{"bbox": [500.0, 1000.0, 900.0, 2000.0]}],
                   sysbbox=(500.0, 1000.0, 1000.0, 2000.0))
    rect, source = icon_crop_rect(staff, 1200)
    assert source == "system0"
    scale, pad = 1200 / 30000, 0.15 * 2000
    assert rect[2] == pytest.approx((500 - pad + 1000 + 2 * pad) * scale)


def test_icon_rect_measure_bboxes_not_required():
    rect, source = icon_crop_rect(_staff([{"bbox": None}, {}]), 1200)
    assert source == "system0"
    assert rect[2] > rect[0]


def test_icon_rect_fallback_without_geometry():
    for staff in (None, {}, {"variants": {}}, {"variants": {"phone": {"systems": []}}}):
        rect, source = icon_crop_rect(staff, 1200)
        assert source == "fallback"
        w = 1200 * ICON_FALLBACK_WIDTH_FRAC
        assert rect == (0.0, 0.0, w, w * ICON_H / ICON_W)


def test_compose_icon_pads_wide_crop_to_3_4():
    src = Image.new("RGB", (1200, 1600), (0, 0, 0))
    out = compose_icon(src, (0, 0, 400, 100))
    assert out.size == (ICON_W, ICON_H)
    assert _dark(out.getpixel((ICON_W // 2, ICON_H // 2)))          # content centered
    top = out.getpixel((ICON_W // 2, 4))
    assert all(abs(a - b) <= 2 for a, b in zip(top, PAPER_RGB))     # paper above


def test_compose_icon_clamps_and_survives_bad_rects():
    src = Image.new("RGB", (1200, 1600), (40, 40, 40))
    assert compose_icon(src, (1000, 1500, 5000, 5000)).size == (ICON_W, ICON_H)
    assert compose_icon(src, (2000, 2000, 3000, 3000)).size == (ICON_W, ICON_H)


def test_gate_thumbnail_skips_on_failure(tmp_path):
    metrics = gate_thumbnail("nope", tmp_path)              # no SVG present
    assert "skipped" in metrics
    assert not (tmp_path / "thumbnail.webp").exists()
    assert not (tmp_path / "row_icon.webp").exists()


def test_catalog_art_registered_for_staging_and_publish():
    row = next(r for r in ARTIFACT_LAYOUT if r[0] == "thumbnail.webp")
    assert (row[1], row[2], row[3]) == ("thumbnail.webp", "thumbnail", None)
    row = next(r for r in ARTIFACT_LAYOUT if r[0] == "row_icon.webp")
    assert (row[1], row[2], row[3]) == ("row_icon.webp", "row_icon", None)
    assert "thumbnail" in PUBLISH_ROLES and "row_icon" in PUBLISH_ROLES
    # source-text check (parity.test.ts style): importing main drags azure/psycopg
    main_src = (Path(__file__).parent.parent / "main.py").read_text()
    assert '".webp": "image/webp"' in main_src


def test_house_font_vendored_with_license():
    assert TEXT_FONT_FILE.exists() and TEXT_FONT_FILE.stat().st_size > 50_000
    assert TEXT_FONT_FILE.read_bytes()[:4] == b"\x00\x01\x00\x00"   # TrueType sfnt magic
    ofl = (TEXT_FONT_FILE.parent / "OFL.txt").read_text()
    assert "SIL OPEN FONT LICENSE" in ofl and "Libre Baskerville" in ofl


def test_html_embeds_baskerville_font_face():
    html = html_for("<svg></svg>")
    assert "@font-face" in html and "font-family:Baskerville" in html
    head = base64.b64encode(TEXT_FONT_FILE.read_bytes()[:60]).decode()
    assert f"data:font/ttf;base64,{head}" in html
    assert html.index("@font-face") < html.index("<body>")
    assert font_face_css() in html


def _webkit_ready() -> bool:
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            return Path(pw.webkit.executable_path).exists()
    except Exception:
        return False


def test_e2e_catalog_art_from_built_svg(tmp_path):
    if not _webkit_ready():
        pytest.skip("playwright webkit browser not installed (CI runs browserless)")
    from pipeline.staff import build_staff_assets
    xml = score(measure(1, ATTRS), *[measure(i) for i in range(2, 13)])
    build_staff_assets("t", xml, tmp_path / "score_events.json", tmp_path)
    m = render_catalog_art(tmp_path / "t.phone.svg", tmp_path / "t.staff.json",
                           tmp_path / "thumbnail.webp", tmp_path / "row_icon.webp")
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
    # row icon: from system-0 geometry, right size, carries ink
    assert m["row_icon"]["source"] == "system0"
    icon = Image.open(tmp_path / "row_icon.webp")
    assert icon.format == "WEBP" and icon.size == (ICON_W, ICON_H)
    ipx = list(icon.convert("L").getdata())
    assert sum(1 for p in ipx if p < 100) > 100
    # thumbnail path alone still works (legacy single-artifact entry point)
    m2 = render_thumbnail(tmp_path / "t.phone.svg", tmp_path / "thumb2.webp")
    assert m2["bytes"] > 2000
