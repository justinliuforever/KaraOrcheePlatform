import type { RequestHandler } from "express";

// Fixed-window in-memory limiter — adequate for a single-replica beta API.
export function rateLimit(maxPerMinute = 120): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      windows.set(key, { start: now, count: 1 });
      if (windows.size > 10_000) windows.clear();
      next();
      return;
    }
    w.count += 1;
    if (w.count > maxPerMinute) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}
