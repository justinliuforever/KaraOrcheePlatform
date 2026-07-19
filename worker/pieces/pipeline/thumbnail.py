"""First-page piece thumbnail — 600x800 (3:4) top crop of the phone-variant score
SVG (title block + first systems), rasterized in the same headless WebKit the render
gate uses. WebKit is the one rasterizer here that honors the SVG's data-URI @font-face
blocks (SMuFL beat-unit glyphs, text fonts) — lightweight SVG rasterizers drop them —
and it is already in the worker image. Enhancement only: callers must treat any
failure as skip, never a gate. Playwright sync API -> full lane / main thread only.
"""
from __future__ import annotations
import io
from pathlib import Path

THUMB_W, THUMB_H = 600, 800
RENDER_SCALE = 2                 # supersample, then LANCZOS down to target
PAPER = "#FBFAF6"                # bundle paper — pads scores shorter than the crop
PAPER_RGB = (0xFB, 0xFA, 0xF6)
WEBP_QUALITY = 80


def html_for(svg: str) -> str:
    return ("<!doctype html><html><head>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<style>html,body{{margin:0;padding:0;background:{PAPER}}}"
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


def rasterize_top(svg: str) -> bytes:
    """Viewport-sized WebKit screenshot of the score's top at RENDER_SCALE."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.webkit.launch()
        try:
            page = browser.new_page(
                viewport={"width": THUMB_W * RENDER_SCALE, "height": THUMB_H * RENDER_SCALE})
            page.set_content(html_for(svg))
            # embedded fonts must finish decoding or glyphs screenshot as tofu
            page.evaluate("() => document.fonts ? document.fonts.ready : true")
            page.wait_for_timeout(50)
            return page.screenshot(type="png")
        finally:
            browser.close()


def render_thumbnail(svg_path: Path, out_path: Path) -> dict:
    from PIL import Image, ImageStat
    img = compose(Image.open(io.BytesIO(rasterize_top(svg_path.read_text()))).convert("RGB"))
    img.save(out_path, "WEBP", quality=WEBP_QUALITY, method=6)
    stddev = ImageStat.Stat(img.convert("L")).stddev[0]
    return {"width": THUMB_W, "height": THUMB_H, "bytes": out_path.stat().st_size,
            "ink_stddev": round(stddev, 1)}
