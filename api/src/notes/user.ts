import type { Request, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { users, auditEvents, type User } from "../db/schema";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      notesUser?: User;
    }
  }
}

// Authorization never trusts token claims or the client role toggle — always checks DB rows.
export function requireUser(deps: Deps): RequestHandler {
  return async (req, res, next) => {
    if (!deps.db) {
      res.status(503).json({ error: "db_not_configured", message: "KaraOrchee is having trouble right now." });
      return;
    }
    const oid = req.user?.oid;
    if (!oid) {
      res.status(401).json({ error: "unauthorized", message: "Sign in again to continue." });
      return;
    }
    try {
      const [row] = await deps.db.orm
        .select()
        .from(users)
        .where(eq(users.entraOid, oid))
        .limit(1);
      if (!row || row.status !== "active") {
        res.status(403).json({ error: "unknown_user", message: "Sign in again to sync your account." });
        return;
      }
      req.notesUser = row;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// End-user counterpart of admin.ts audit(): same table, actor = the Notes user.
export async function userAudit(
  deps: Deps,
  req: Request,
  action: string,
  subject?: { type: string; id: string },
  detail: Record<string, unknown> = {},
): Promise<void> {
  if (!deps.db) return;
  await deps.db.orm.insert(auditEvents).values({
    actorUserId: req.notesUser!.id,
    action,
    subjectType: subject?.type ?? null,
    subjectId: subject?.id ?? null,
    detail: req.reqId ? { ...detail, reqId: req.reqId } : detail,
  });
}
