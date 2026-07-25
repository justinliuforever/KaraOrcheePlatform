import type { RequestHandler } from "express";

// Fixed-window in-memory limiter — adequate for a single-replica beta API.
// 300/min: the studio wizard live-polls a draft alongside board polling; two admin
// tabs behind one NAT must not starve the app's catalog traffic.
// PER REPLICA: the effective ceiling is maxPerMinute × maxReplicas
// (infra/main.bicep), so a replica-count change is a rate change.
export function rateLimit(maxPerMinute = 300): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      windows.set(key, { start: now, count: 1 });
      // Evict only what has expired: clearing the whole map would disable the
      // limiter under exactly the load it exists for.
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
      }
      next();
      return;
    }
    w.count += 1;
    if (w.count > maxPerMinute) {
      res.status(429).json({ error: "rate_limited", message: "Too many requests. Try again in a minute." });
      return;
    }
    next();
  };
}
