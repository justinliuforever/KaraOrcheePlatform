"""Catalog art — thumbnail (600x800 top crop) + row icon (300x400 tight crop of the
opening: system 0's band x roughly the first two measures, from staff.json geometry),
both cut from ONE headless-WebKit screenshot of the phone-variant score SVG. WebKit is
the one rasterizer here that honors the SVG's data-URI @font-face blocks (SMuFL
beat-unit glyphs, text fonts) — lightweight SVG rasterizers drop them — and it is
already in the worker image. Enhancement only: callers must treat any failure as skip,
never a gate. Playwright sync API -> full lane / main thread only.
"""
from __future__ import annotations
import base64
import io
import json
import os
from pathlib import Path

THUMB_W, THUMB_H = 600, 800
ICON_W, ICON_H = 300, 400
RENDER_SCALE = 2                 # supersample, then LANCZOS down to target
PAPER = "#FBFAF6"                # bundle paper — pads scores shorter than the crop
PAPER_RGB = (0xFB, 0xFA, 0xF6)
WEBP_QUALITY = 80

ICON_PAD_FRAC = 0.15             # of system height, both axes
ICON_FALLBACK_WIDTH_FRAC = 0.5   # no usable geometry: top-left band of the page

# House text font, embedded: the SVG's stack ("Baskerville, Palatino, ...") is a
# macOS stack absent on Linux workers; an @font-face claiming the family name
# "Baskerville" wins over any local font, so container renders match Mac renders.
# Libre Baskerville is OFL — license vendored beside the file.
TEXT_FONT_FILE = Path(__file__).parent / "fonts" / "LibreBaskerville-Regular.ttf"
_font_css: str | None = None


def font_face_css() -> str:
    global _font_css
    if _font_css is None:
        b64 = base64.b64encode(TEXT_FONT_FILE.read_bytes()).decode()
        _font_css = ("@font-face{font-family:Baskerville;"
                     f"src:url(data:font/ttf;base64,{b64}) format('truetype')}}")
    return _font_css


def html_for(svg: str) -> str:
    return ("<!doctype html><html><head>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<style>{font_face_css()}"
            f"html,body{{margin:0;padding:0;background:{PAPER}}}"
            "svg{display:block;width:100%;height:auto}</style></head>"
            f"<body>{svg}</body></html>")


def compose(img):
    """Top-anchored 3:4 normalization: crop when taller, paper-pad when shorter,
    then exact target size. Pure math — unit-testable without a browser."""
    from PIL import Image
    target_h = round(img.width * THUMB_H / THUMB_W)
    if img.height >= target_h:
        img = img.crop((0, 0, img.width, target_h))
    else:
        canvas = Image.new("RGB", (img.width, target_h), PAPER_RGB)
        canvas.paste(img, (0, 0))
        img = canvas
    return img.resize((THUMB_W, THUMB_H), Image.LANCZOS)


def icon_crop_rect(staff: dict | None, img_w: int) -> tuple[tuple[float, float, float, float], str]:
    """Pixel-space (x0, y0, x1, y1) for the row icon: a 3:4 window over the opening
    of system 0. Missing/unusable staff.json -> top-left page band."""
    try:
        ph = staff["variants"]["phone"]
        sx, sy, sw, sh = ph["systems"][0]["bbox"]
        scale = img_w / ph["page"]["viewbox_w"]
        # 3:4 BY CONSTRUCTION: height = system band + padding, width = height * 3/4,
        # anchored at the system's left edge — the opening FILLS the canvas. A
        # measure-width crop letterboxes into a thin strip at row size.
        pad = ICON_PAD_FRAC * sh
        band_h = sh + 2 * pad
        w = min(band_h * ICON_W / ICON_H, sw + 2 * pad)
        return ((sx - pad) * scale, (sy - pad) * scale,
                (sx - pad + w) * scale, (sy + sh + pad) * scale), "system0"
    except Exception:
        w = img_w * ICON_FALLBACK_WIDTH_FRAC
        return (0.0, 0.0, w, w * ICON_H / ICON_W), "fallback"


def compose_icon(img, rect):
    """Crop rect (clamped to the page; degenerate rects fall back to a top band),
    center on a paper 3:4 canvas, then exact target size. Pure math."""
    from PIL import Image
    x0, y0, x1, y1 = (int(round(v)) for v in rect)
    x0, y0 = max(x0, 0), max(y0, 0)
    x1, y1 = min(x1, img.width), min(y1, img.height)
    if x1 <= x0 or y1 <= y0:
        x0, y0, x1, y1 = 0, 0, img.width, min(img.height, round(img.width * ICON_H / ICON_W))
    crop = img.crop((x0, y0, x1, y1))
    cw, ch = crop.size
    canvas_w = max(cw, round(ch * ICON_W / ICON_H))
    canvas_h = max(ch, round(canvas_w * ICON_H / ICON_W))
    canvas = Image.new("RGB", (canvas_w, canvas_h), PAPER_RGB)
    canvas.paste(crop, ((canvas_w - cw) // 2, (canvas_h - ch) // 2))
    return canvas.resize((ICON_W, ICON_H), Image.LANCZOS)


def rasterize_top(svg: str) -> bytes:
    """Viewport-sized WebKit screenshot of the score's top at RENDER_SCALE."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.webkit.launch()
        try:
            page = browser.new_page(
                viewport={"width": THUMB_W * RENDER_SCALE, "height": THUMB_H * RENDER_SCALE})
            page.set_content(html_for(svg))
            # embedded fonts must finish decoding or glyphs screenshot as tofu;
            # BOUNDED wait — an unresolvable fonts promise must not wedge the lane
            page.wait_for_function(
                "document.fonts ? document.fonts.status !== 'loading' : true", timeout=5000)
            page.wait_for_timeout(50)
            return page.screenshot(type="png")
        finally:
            browser.close()


def _save_webp(img, out_path: Path) -> dict:
    # Atomic: a failed encode must never leave a truncated file where stage_artifacts
    # selects on existence.
    part = out_path.with_suffix(".part")
    img.save(part, "WEBP", quality=WEBP_QUALITY, method=6)
    os.replace(part, out_path)
    return {"width": img.width, "height": img.height, "bytes": out_path.stat().st_size}


def _finish_thumbnail(img, out_path: Path) -> dict:
    from PIL import ImageStat
    out = compose(img)
    metrics = _save_webp(out, out_path)
    metrics["ink_stddev"] = round(ImageStat.Stat(out.convert("L")).stddev[0], 1)
    return metrics


def render_thumbnail(svg_path: Path, out_path: Path) -> dict:
    from PIL import Image
    img = Image.open(io.BytesIO(rasterize_top(svg_path.read_text()))).convert("RGB")
    return _finish_thumbnail(img, out_path)


def render_catalog_art(svg_path: Path, staff_path: Path, thumb_path: Path, icon_path: Path) -> dict:
    """Thumbnail + row icon from ONE screenshot pass. A row-icon failure never voids
    the thumbnail; the caller treats any failure as skip."""
    from PIL import Image
    img = Image.open(io.BytesIO(rasterize_top(svg_path.read_text()))).convert("RGB")
    metrics = _finish_thumbnail(img, thumb_path)
    try:
        staff = json.loads(staff_path.read_text()) if staff_path.exists() else None
        rect, source = icon_crop_rect(staff, img.width)
        icon_metrics = _save_webp(compose_icon(img, rect), icon_path)
        icon_metrics["source"] = source
        metrics["row_icon"] = icon_metrics
    except Exception as err:
        metrics["row_icon"] = {"skipped": f"row icon failed: {str(err)[:120]}"}
    return metrics
