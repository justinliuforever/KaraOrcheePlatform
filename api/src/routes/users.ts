import { Router } from "express";
import { sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { users } from "../db/schema";

export function usersRouter(deps: Deps): Router {
  const router = Router();

  router.post(
    "/v1/users/sync",
    requireAuth(deps.auth),
    wrap(async (req, res) => {
      if (!deps.db) {
        res.status(503).json({ error: "db_not_configured" });
        return;
      }
      const claims = req.user!;
      const email = claims.email ?? null;
      const displayName = claims.name ?? null;

      const [row] = await deps.db.orm
        .insert(users)
        .values({ entraOid: claims.oid, email, displayName })
        .onConflictDoUpdate({
          target: users.entraOid,
          set: { email, displayName, updatedAt: sql`now()` },
        })
        .returning();

      res.status(200).json(row);
    }),
  );

  return router;
}
