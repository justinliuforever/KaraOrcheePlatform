import { useEffect, useRef, useState } from "react";
import type { OpsHistogramBucket } from "../api";

const H = 96;
const MIN_DRAG_PX = 5;

function fmtTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs <= 24 * 3_600_000) {
    return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString([], { month: "short", day: "2-digit", hour12: false, hour: "2-digit", minute: "2-digit" });
}

/** Stacked severity bars over time. Drag = brush an absolute from/to window;
 * a plain click on empty canvas resets to the previous relative range. */
export default function Histogram({
  buckets,
  binMinutes,
  onBrush,
  onReset,
}: {
  buckets: OpsHistogramBucket[];
  binMinutes: number;
  onBrush: (fromIso: string, toIso: string) => void;
  onReset: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ startX: number; curX: number } | null>(null);
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const n = buckets.length;
  const t0 = n > 0 ? Date.parse(buckets[0].t) : 0;
  const t1 = n > 0 ? Date.parse(buckets[n - 1].t) + binMinutes * 60_000 : 0;
  const span = t1 - t0;
  const max = Math.max(1, ...buckets.map((b) => b.error + b.warn + b.info));
  const barW = n > 0 ? width / n : 0;

  const xToBucket = (x: number) => Math.min(n - 1, Math.max(0, Math.floor((x / width) * n)));
  const xToTime = (x: number) => t0 + (Math.min(width, Math.max(0, x)) / width) * span;

  const localX = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return e.clientX - rect.left;
  };

  if (n === 0) {
    return (
      <div className="mb-4 grid h-24 place-items-center rounded-xl border border-line bg-card text-xs text-ink-faint">
        No events in this range
      </div>
    );
  }

  // Bar height in px for a count, leaving 2px headroom so max bars don't clip.
  const hFor = (count: number) => (count / max) * (H - 2);

  return (
    <div
      ref={wrapRef}
      className="relative mb-4 select-none overflow-hidden rounded-xl border border-line bg-card"
      style={{ height: H }}
      onPointerDown={(e) => {
        wrapRef.current?.setPointerCapture(e.pointerId);
        const x = localX(e);
        setDrag({ startX: x, curX: x });
      }}
      onPointerMove={(e) => {
        const x = localX(e);
        if (drag) setDrag({ ...drag, curX: x });
        if (x >= 0 && x <= width) setHover({ i: xToBucket(x), x });
        else setHover(null);
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const cur = drag;
        setDrag(null);
        if (Math.abs(cur.curX - cur.startX) < MIN_DRAG_PX) {
          // Click. Empty area (above the bar, or an empty bucket) resets the range.
          const b = buckets[xToBucket(cur.startX)];
          const total = b.error + b.warn + b.info;
          const rect = wrapRef.current!.getBoundingClientRect();
          const y = e.clientY - rect.top;
          if (total === 0 || y < H - hFor(total)) onReset();
          return;
        }
        const lo = Math.min(cur.startX, cur.curX);
        const hi = Math.max(cur.startX, cur.curX);
        onBrush(new Date(xToTime(lo)).toISOString(), new Date(xToTime(hi)).toISOString());
      }}
      onPointerLeave={() => setHover(null)}
    >
      {width > 0 && (
        <svg width={width} height={H} className="block">
          {buckets.map((b, i) => {
            const x = i * barW;
            const w = Math.max(1, barW - (barW > 3 ? 1 : 0));
            const hInfo = hFor(b.info);
            const hWarn = hFor(b.warn);
            const hErr = hFor(b.error);
            let y = H;
            const rects = [];
            if (b.info > 0) {
              y -= hInfo;
              rects.push(<rect key="i" x={x} y={y} width={w} height={hInfo} className="fill-gray-300" />);
            }
            if (b.warn > 0) {
              y -= hWarn;
              rects.push(<rect key="w" x={x} y={y} width={w} height={hWarn} className="fill-amber-400" />);
            }
            if (b.error > 0) {
              y -= hErr;
              rects.push(<rect key="e" x={x} y={y} width={w} height={hErr} className="fill-bad" />);
            }
            return <g key={b.t}>{rects}</g>;
          })}
          {hover && !drag && (
            <rect x={hover.i * barW} y={0} width={Math.max(1, barW)} height={H} className="fill-ink/5" />
          )}
          {drag && Math.abs(drag.curX - drag.startX) >= MIN_DRAG_PX && (
            <rect
              x={Math.min(drag.startX, drag.curX)}
              y={0}
              width={Math.abs(drag.curX - drag.startX)}
              height={H}
              className="fill-brand/15 stroke-brand"
            />
          )}
        </svg>
      )}
      <span className="pointer-events-none absolute left-1.5 top-1 text-[10px] text-ink-faint tabular-nums">
        max {max}
      </span>
      <span className="pointer-events-none absolute bottom-1 left-1.5 text-[10px] text-ink-faint tabular-nums">
        {fmtTick(t0, span)}
      </span>
      <span className="pointer-events-none absolute bottom-1 right-1.5 text-[10px] text-ink-faint tabular-nums">
        {fmtTick(t1, span)}
      </span>
      {hover && !drag && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line bg-card px-2.5 py-1.5 text-[11px] shadow-md"
          style={hover.x < width / 2 ? { left: hover.x + 12 } : { right: width - hover.x + 12 }}
        >
          <p className="font-medium tabular-nums">
            {fmtTick(t0 + hover.i * (span / n), span)} – {fmtTick(t0 + (hover.i + 1) * (span / n), span)}
          </p>
          <p className="tabular-nums">
            <span className="text-bad">{buckets[hover.i].error} error</span>
            <span className="text-ink-faint"> · </span>
            <span className="text-warn">{buckets[hover.i].warn} warn</span>
            <span className="text-ink-faint"> · </span>
            <span className="text-ink-soft">{buckets[hover.i].info} info</span>
          </p>
        </div>
      )}
    </div>
  );
}
