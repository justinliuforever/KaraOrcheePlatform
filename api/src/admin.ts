import type { Request, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import type { Deps } from "./deps";
import { users, auditEvents, type User } from "./db/schema";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminUser?: User;
    }
  }
}

// Layered behind requireAuth. Fail-closed: no db -> 503; unknown, non-admin,
// or non-active account -> 403. Admin status lives only in Postgres, never in the token.
export function requireAdmin(deps: Deps): RequestHandler {
  return async (req, res, next) => {
    if (!deps.db) {
      res.status(503).json({ error: "db_not_configured" });
      return;
    }
    const oid = req.user?.oid;
    if (!oid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const [row] = await deps.db.orm
        .select()
        .from(users)
        .where(eq(users.entraOid, oid))
        .limit(1);
      if (!row || !row.isAdmin || row.status !== "active") {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      req.adminUser = row;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function audit(
  deps: Deps,
  req: Request,
  action: string,
  subject?: { type: string; id: string },
  detail: Record<string, unknown> = {},
): Promise<void> {
  if (!deps.db) return;
  await deps.db.orm.insert(auditEvents).values({
    actorUserId: req.adminUser!.id,
    action,
    subjectType: subject?.type ?? null,
    subjectId: subject?.id ?? null,
    // reqId joins this business event to its technical logs (Ops timeline).
    detail: req.reqId ? { ...detail, reqId: req.reqId } : detail,
  });
}
