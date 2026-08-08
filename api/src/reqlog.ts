import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

// Never log PII here — no email/display name, no bodies, no query strings, no client IPs (COPPA/GDPR).
export function requestLog() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const reqId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    req.reqId = reqId;
    res.setHeader("x-request-id", reqId);
    res.on("finish", () => {
      if (req.path === "/healthz") return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(JSON.stringify({
        kind: "http",
        reqId,
        method: req.method,
        // route template when Express matched one (no per-piece cardinality), bare path otherwise
        route: req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        oid: req.user?.oid ?? null,
        admin: req.adminUser?.id ?? null,
        ua: req.headers["user-agent"]?.slice(0, 80) ?? null,
      }));
    });
    next();
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      reqId?: string;
    }
  }
}
