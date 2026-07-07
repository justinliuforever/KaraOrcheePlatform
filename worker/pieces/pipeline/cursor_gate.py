"""Real-render cursor-on-staff gate — vendored from piano-amt prototype/staff/verify_cursor.py
with paths parameterized. Loads the built SVG into headless WebKit (the engine iOS WKWebView
uses), drives the production shim, and asserts the cursor's vertical span sits inside its
system box. The SHIM below is byte-identical to the Swift app's — keep in sync.
"""
from __future__ import annotations
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

PHONE_W = 390
VIEW_H = 760
SAMPLES = 8

SHIM = """
function setCursor(x, y, h) {
  var c = document.getElementById('cursor'); if (!c) return;
  c.setAttribute('visibility', 'visible');
  var ls = c.getElementsByTagName('line');
  for (var i = 0; i < ls.length; i++) {
    ls[i].setAttribute('x1', x); ls[i].setAttribute('x2', x);
    ls[i].setAttribute('y1', y); ls[i].setAttribute('y2', y + h);
  }
}
var _anim = null;
var _rm = false;   // Reduce Motion mirror: page-turn becomes an instant scrollTo
function setRM(v){_rm=v;if(v&&_anim){var y=_anim.y1;_anim=null;window.scrollTo(0,y);}}
function _ease(t){return t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;}
function _tick(now){if(!_anim)return;var p=Math.min(1,(now-_anim.t0)/_anim.dur);window.scrollTo(0,_anim.y0+(_anim.y1-_anim.y0)*_ease(p));if(p<1){requestAnimationFrame(_tick);}else{_anim=null;}}
function requestTurn(y1){var y0=window.pageYOffset,vh=window.innerHeight||1,d=Math.abs(y1-y0);if(d<1)return;if(_rm){_anim=null;window.scrollTo(0,y1);return;}if(_anim&&Math.abs(_anim.y1-y1)<1)return;var dur=(y1<y0&&d>=vh)?120:Math.max(150,Math.min(450,d/vh*350));_anim={y0:y0,y1:y1,t0:performance.now(),dur:dur};requestAnimationFrame(_tick);}
function scrollToSystem(idx) {
  var e = document.querySelector('[data-system-index="' + idx + '"]'); if (!e) return;
  var r = e.getBoundingClientRect();
  requestTurn(Math.max(0, window.pageYOffset + r.top - 14));   // smooth ~330ms ease-in-out glide (Step A)
}
// Phase 2 — BROWSE tap-to-jump (the StaffGestureResolver JS half; byte-identical to the Swift app shim).
function setCursorColor(c) {
  var g = document.getElementById('cursor'); if (!g) return;
  var ls = g.getElementsByTagName('line');
  for (var i = 0; i < ls.length; i++) { ls[i].setAttribute('stroke', c); }
  if (!g.__lv) { g.__lv = 1; requestAnimationFrame(function(){ g.classList.add('live'); }); }
}
function _measureAt(x, y) {
  var e = document.elementFromPoint(x, y);
  while (e) { if (e.getAttribute && e.getAttribute('data-measure-index')) return parseInt(e.getAttribute('data-measure-index'), 10); e = e.parentNode; }
  return -1;
}
function _isTap(moved, dt) { return moved <= 10 && dt <= 400; }
var _ts = null;
function _onStart(e) { var t = e.touches ? e.touches[0] : e; _ts = { x: t.clientX, y: t.clientY, t: performance.now() }; }
function _onEnd(e) {
  if (!_ts) return;
  var t = (e.changedTouches && e.changedTouches[0]) || e;
  var dx = t.clientX - _ts.x, dy = t.clientY - _ts.y, moved = Math.sqrt(dx * dx + dy * dy), dt = performance.now() - _ts.t;
  _ts = null;
  if (!_isTap(moved, dt)) return;
  var idx = _measureAt(t.clientX, t.clientY);
  window.__lastTap = idx;
  if (idx > 0 && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tap) {
    window.webkit.messageHandlers.tap.postMessage(idx);
  }
}
document.addEventListener('touchstart', _onStart, { passive: true });
document.addEventListener('touchend', _onEnd, { passive: true });
"""


def html_for(svg: str) -> str:
    return ("<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<style>html,body{margin:0;padding:0;background:#FBFAF6}svg{display:block;width:100%;height:auto}"
            "#cursor{pointer-events:none}"
            "#cursor.live line{transition:stroke .25s ease-in-out}</style>"
            f"<script>{SHIM}</script></head><body>{svg}</body></html>")


def pick(lst: list, k: int) -> list:
    if len(lst) <= k:
        return lst
    return [lst[int(round(i * (len(lst) - 1) / (k - 1)))] for i in range(k)]


def sample_indices(n: int, k: int) -> list:
    if n <= k:
        return list(range(n))
    return [int(round(i * (n - 1) / (k - 1))) for i in range(k)]


def verify_tap(page, pid: str, variant: str, v: dict) -> list:
    fails = []
    gate = page.evaluate("() => ({tap: _isTap(5,100), drag: _isTap(30,100), held: _isTap(5,500)})")
    if not (gate["tap"] and not gate["drag"] and not gate["held"]):
        fails.append((pid, variant, "FAIL", f"tap movement/dwell gate wrong: {gate}"))
    cand = [m for m in v["measures"] if m.get("system_index") is not None and m.get("bbox")]
    hit = 0
    samples = pick(cand, 6)
    for gm in samples:
        mi = gm["measure_index"]; sysi = int(gm["system_index"])
        page.evaluate("(s) => scrollToSystem(s)", sysi)
        page.wait_for_timeout(560)
        got = page.evaluate(
            "(mi) => { var m=document.querySelector('[data-measure-index=\"'+mi+'\"]'); if(!m) return -2;"
            " var hr=m.querySelector('.measure-hit')||m; var r=hr.getBoundingClientRect();"
            " var cy=r.top+r.height/2; if(cy<0||cy>window.innerHeight) return -3;"
            " return _measureAt(r.left+r.width/2, cy); }", mi)
        if got == mi:
            hit += 1
        else:
            fails.append((pid, variant, "FAIL", f"tap on measure {mi} band resolved to {got}"))
    return fails or [(pid, variant, "ok", f"tap-gate ok · {hit}/{len(samples)} measure bands resolve to their index")]


def verify_piece(page, assets_dir: Path, pid: str, variant: str) -> list:
    bundle = json.loads((assets_dir / f"{pid}.staff.json").read_text())
    if bundle.get("staff_eligible") is not True:
        p50 = bundle.get("timeline_residual_ms_p50")
        return [(pid, variant, "FAIL", f"not staff-eligible (timeline p50={p50}ms >= 12 gate)")]
    if variant not in bundle.get("variants", {}):
        return [(pid, variant, "FAIL", f"variant '{variant}' not in bundle")]
    v = bundle["variants"][variant]
    svg = (assets_dir / f"{pid}.{variant}.svg").read_text()
    bands = {sg["system_index"]: sg["bbox"] for sg in v["systems"]}
    anchors = v["cursor_anchors"]
    page.set_viewport_size({"width": PHONE_W, "height": VIEW_H})
    page.set_content(html_for(svg))
    page.wait_for_timeout(60)
    fails = []
    for idx in sample_indices(len(anchors), SAMPLES):
        sec, x, y, sysi = anchors[idx]
        sysi = int(sysi)
        bb = bands.get(sysi)
        if not bb:
            fails.append((pid, variant, "FAIL", f"anchor {idx}: no band for system {sysi}")); continue
        page.evaluate("([x,by,bh,s]) => { setCursor(x, by, bh); scrollToSystem(s); }", [x, bb[1], bb[3], sysi])
        page.wait_for_timeout(560)
        r = page.evaluate(
            "(s) => { const sys=document.querySelector('[data-system-index=\"'+s+'\"]'); const cur=document.getElementById('cursor');"
            " const a=sys.getBoundingClientRect(), b=cur.getBoundingClientRect();"
            " return {sysTop:a.top, sysBot:a.bottom, curTop:b.top, curBot:b.bottom, curH:b.height,"
            " vis:cur.getAttribute('visibility'), sw:cur.querySelector('.cursor-core').getAttribute('stroke-width'), vh:window.innerHeight}; }",
            sysi)
        if not (-5 <= r["sysTop"] <= r["vh"]):
            fails.append((pid, variant, "FAIL", f"anchor {idx} sec={sec:.1f}: system {sysi} not in viewport (top={r['sysTop']:.0f})")); continue
        tol = 6
        if not (r["curTop"] >= r["sysTop"] - tol and r["curBot"] <= r["sysBot"] + tol):
            fails.append((pid, variant, "FAIL",
                          f"anchor {idx} sec={sec:.1f}: cursor [{r['curTop']:.0f}..{r['curBot']:.0f}] outside system "
                          f"[{r['sysTop']:.0f}..{r['sysBot']:.0f}] (BUG-A: floating off the staff)")); continue
        if r["curH"] < 4 or r["vis"] != "visible" or float(r["sw"] or 0) <= 0:
            fails.append((pid, variant, "FAIL", f"anchor {idx}: cursor not drawn (h={r['curH']:.1f} vis={r['vis']} sw={r['sw']})")); continue
    # Reduce-Motion branch: the turn must land at the exact target offset within 60ms.
    last_sys = int(anchors[-1][3])
    page.evaluate("() => { window.scrollTo(0, 0); setRM(true); }")
    want = page.evaluate(
        "(s) => { var e = document.querySelector('[data-system-index=\"'+s+'\"]'); if (!e) return -9999;"
        " var maxY = Math.max(0, document.body.scrollHeight - window.innerHeight);"
        " return Math.min(maxY, Math.max(0, e.getBoundingClientRect().top - 14)); }", last_sys)
    page.evaluate("(s) => scrollToSystem(s)", last_sys)
    page.wait_for_timeout(60)
    got = page.evaluate("() => window.pageYOffset")
    page.evaluate("() => setRM(false)")
    if want == -9999 or abs(got - want) > 2:
        fails.append((pid, variant, "FAIL", f"RM turn not instant: offset {got:.0f} vs target {want:.0f}"))
    staff_res = fails or [(pid, variant, "ok", f"{min(len(anchors), SAMPLES)} samples on staff · rm-turn instant")]
    return staff_res + verify_tap(page, pid, variant, v)


def run_gate(assets_dir: Path, piece: str) -> tuple[bool, list[str], dict]:
    """Run the full render gate for one piece. Returns (passed, failures, metrics)."""
    results = []
    with sync_playwright() as pw:
        browser = pw.webkit.launch()
        page = browser.new_page()
        for variant in ("phone", "ipad_portrait"):
            results += verify_piece(page, assets_dir, piece, variant)
        browser.close()
    failures = [f"[{variant}] {msg}" for (_, variant, status, msg) in results if status == "FAIL"]
    checks = sum(1 for r in results if r[2] == "ok")
    return (len(failures) == 0, failures, {"checks_passed": checks, "violations": len(failures)})
