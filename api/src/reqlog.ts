import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

// Structured request logging → stdout → ContainerAppConsoleLogs_CL. One JSON line per
// completed request. Privacy rules (COPPA/GDPR posture): identity is the opaque CIAM
// oid only (never email/display name), no request bodies, no query strings (tokens can
// ride in them), no client IPs (ingress logs hold those if forensics ever need them).
// NOTE: ACA only columnizes JSON stdout when the environment has
// --logs-dynamic-json-columns true (off by default since Oct 2023).
export function requestLog() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const reqId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    req.reqId = reqId;
    res.setHeader("x-request-id", reqId);
    res.on("finish", () => {
      if (req.path === "/healthz") return; // probe noise
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
