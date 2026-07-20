import { Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import {
  devices,
  entitlements,
  invites,
  lessonSessions,
  noteAnnotations,
  noteJobs,
  notes,
  teacherStudentLinks,
  users,
} from "../db/schema";
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

  // Apple 5.1.1(v): in-app account deletion. Full erase, not deactivation. The row
  // survives as a PII-scrubbed tombstone so notes ALREADY DELIVERED to the other
  // party keep their FK integrity (a student's received notes are their record; a
  // teacher's sent notes stay with their students). Everything private to the
  // deleting user is destroyed here; the raw lesson audio blob is purged now, not
  // left to the 90-day lifecycle. NOTE: CIAM (Auth-tenant) identity deletion via
  // Graph is a follow-up (needs the app registration's User.ReadWrite.All) — until
  // then the scrubbed row + released entra_oid prevents re-link, and the client
  // signs out; document this gap.
  router.delete(
    "/v1/me",
    requireAuth(deps.auth),
    requireUser(deps),
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const me = req.notesUser!;

      // Collect this user's own lesson audio to purge from blob after the tx commits.
      const myLessons = await db
        .select({ id: lessonSessions.id, audioPath: lessonSessions.audioPath })
        .from(lessonSessions)
        .where(eq(lessonSessions.teacherId, me.id));
      const audioPaths = myLessons.map((l) => l.audioPath).filter((p): p is string => !!p);

      await db.transaction(async (tx) => {
        // End every relationship on both sides.
        await tx
          .update(teacherStudentLinks)
          .set({ status: "removed", removedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(
            sql`(${teacherStudentLinks.teacherId} = ${me.id} OR ${teacherStudentLinks.studentId} = ${me.id})`,
            eq(teacherStudentLinks.status, "active"),
          ));
        await tx.update(invites).set({ revokedAt: sql`now()` })
          .where(and(eq(invites.teacherId, me.id), isNull(invites.revokedAt)));

        // As STUDENT: the received-note copies are the student's data — delete them.
        const received = await tx.select({ id: notes.id }).from(notes).where(eq(notes.studentId, me.id));
        const receivedIds = received.map((n) => n.id);
        if (receivedIds.length) {
          await tx.delete(noteAnnotations).where(inArray(noteAnnotations.noteId, receivedIds));
          await tx.delete(notes).where(inArray(notes.id, receivedIds));
        }

        // As TEACHER: destroy DRAFT notes (never delivered); SENT notes stay with
        // their students, attribution collapsing to this tombstone row.
        const drafts = await tx
          .select({ id: notes.id })
          .from(notes)
          .where(and(eq(notes.teacherId, me.id), eq(notes.status, "draft")));
        const draftIds = drafts.map((n) => n.id);
        if (draftIds.length) {
          await tx.delete(noteAnnotations).where(inArray(noteAnnotations.noteId, draftIds));
          await tx.delete(notes).where(inArray(notes.id, draftIds));
        }
        // Lessons + their jobs are the teacher's private capture — remove entirely.
        const lessonIds = myLessons.map((l) => l.id);
        if (lessonIds.length) {
          await tx.delete(noteJobs).where(inArray(noteJobs.lessonSessionId, lessonIds));
          await tx.delete(lessonSessions).where(inArray(lessonSessions.id, lessonIds));
        }

        await tx.delete(devices).where(eq(devices.userId, me.id));
        await tx.delete(entitlements).where(eq(entitlements.userId, me.id));

        // Scrub PII, release the entra_oid, mark deleted.
        await tx
          .update(users)
          .set({
            status: "deleted",
            email: null,
            displayName: null,
            entraOid: null,
            trialStartedAt: null,
            notesConsentAt: null,
            deletedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(users.id, me.id));
      });

      await userAudit(deps, req, "account.delete", { type: "user", id: me.id });
      if (deps.lessons) {
        for (const path of audioPaths) {
          try {
            await deps.lessons.deleteAudio(path);
          } catch (err) {
            console.error("account.delete: audio purge failed", path, err);
          }
        }
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
