import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { notes, users } from "../db/schema";
import { notesAccess } from "../notes/entitlement";

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

      const upserted = await deps.db.orm
        .insert(users)
        .values({ entraOid: claims.oid, email, displayName })
        .onConflictDoUpdate({
          target: users.entraOid,
          set: { email, displayName, updatedAt: sql`now()` },
        })
        .returning();
      const row = upserted[0]!;

      // Role capabilities grow-only from the app (registration role step + beta
      // Settings toggle); admin role-patch remains the only way to revoke.
      const body = req.body ?? {};
      const patch: Record<string, unknown> = {};
      if (body.role === "teacher" && !row.isTeacher) patch.isTeacher = true;
      if (body.role === "student" && !row.isStudent) {
        patch.isStudent = true;
        if (!row.trialStartedAt) patch.trialStartedAt = sql`now()`;
      }
      if (body.notesConsent === true && !row.notesConsentAt) patch.notesConsentAt = sql`now()`;
      let user = row;
      if (Object.keys(patch).length) {
        const updated = await deps.db.orm
          .update(users)
          .set({ ...patch, updatedAt: sql`now()` })
          .where(eq(users.id, row.id))
          .returning();
        user = updated[0]!;
      }

      const access = await notesAccess(deps, user);
      const [unread] = await deps.db.orm
        .select({ count: sql<number>`count(*)::int` })
        .from(notes)
        .where(and(eq(notes.studentId, user.id), eq(notes.status, "sent"), isNull(notes.readAt)));

      res.status(200).json({ ...user, access, unreadNotes: unread?.count ?? 0 });
    }),
  );

  return router;
}
