import { Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import {
  auditEvents,
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
import { narrationPrefix } from "../notes/narration";

// Where a role grant came from. Anything else (including a client that sends
// nothing) records as a sign-up, which is what the audit trail assumed before the
// field existed.
const ROLE_GRANT_ORIGINS = ["signup", "setup"] as const;
type RoleGrantOrigin = (typeof ROLE_GRANT_ORIGINS)[number];

// Which recording notice an acceptance is for. Matches NotesConsent.Kind on the app.
const CONSENT_KINDS = ["teacher", "solo"] as const;
type ConsentKind = (typeof CONSENT_KINDS)[number];

function roleGrantOrigin(via: unknown): RoleGrantOrigin {
  return ROLE_GRANT_ORIGINS.includes(via as RoleGrantOrigin) ? (via as RoleGrantOrigin) : "signup";
}

export function usersRouter(deps: Deps): Router {
  const router = Router();

  router.post(
    "/v1/users/sync",
    requireAuth(deps.auth),
    wrap(async (req, res) => {
      if (!deps.db) {
        res.status(503).json({ error: "db_not_configured", message: "KaraOrchee is having trouble right now." });
        return;
      }
      const claims = req.user!;
      const email = claims.email ?? null;
      const displayName = claims.name ?? null;

      // An omitted claim says nothing about the profile — never read it as "clear it".
      const upserted = await deps.db.orm
        .insert(users)
        .values({ entraOid: claims.oid, email, displayName })
        .onConflictDoUpdate({
          target: users.entraOid,
          set: {
            ...(email === null ? {} : { email }),
            ...(displayName === null ? {} : { displayName }),
            updatedAt: sql`now()`,
          },
        })
        .returning();
      const row = upserted[0]!;

      // Role capabilities are grow-only AND first-only: the app may name a role for
      // an account that has NONE (sign-up, or the setup screen repairing a role-less
      // row) and never afterwards. isTeacher is permanent, admin-only to revoke, and
      // short-circuits entitlements to teacher_free — a client that can add it to an
      // existing account is a self-service paywall bypass. A stale role on a
      // returning user is a silent no-op, never an error: sync is an idempotent
      // upsert the app calls on every launch, and the response carries the truth.
      const body = req.body ?? {};
      const patch: Record<string, unknown> = {};
      const roleless = !row.isTeacher && !row.isStudent;
      const grantedRole = roleless && (body.role === "teacher" || body.role === "student")
        ? (body.role as "teacher" | "student")
        : null;
      if (grantedRole === "teacher") patch.isTeacher = true;
      if (grantedRole === "student") {
        patch.isStudent = true;
        if (!row.trialStartedAt) patch.trialStartedAt = sql`now()`;
      }
      // Each recording notice is its own promise and its own timestamp: accepting the
      // solo notice must never satisfy the teacher gate, which is the one carrying the
      // responsibility-to-inform language. consentKind NAMES the notice; an acceptance
      // that does not name one (the pre-split shape, or an unrecognized kind) stamps
      // only the legacy column and satisfies NEITHER gate — re-asking is the sole
      // fail-closed answer to "which notice was this?". Each stamp is write-once.
      const accepted = body.notesConsent === true;
      const consentKind = CONSENT_KINDS.includes(body.consentKind as ConsentKind)
        ? (body.consentKind as ConsentKind)
        : null;
      if (accepted && !row.notesConsentAt) patch.notesConsentAt = sql`now()`;
      if (accepted && consentKind === "solo" && !row.soloConsentAt) patch.soloConsentAt = sql`now()`;
      if (accepted && consentKind === "teacher" && !row.teacherConsentAt) patch.teacherConsentAt = sql`now()`;
      // Optional studio/school from teacher sign-up. Write-once: sign-up sets it,
      // nothing overwrites it (admin-only surface in beta — "Not shown publicly").
      if (typeof body.organization === "string" && body.organization.trim() && !row.organization) {
        patch.organization = body.organization.trim().slice(0, 200);
      }
      let user = row;
      if (Object.keys(patch).length) {
        const updated = await deps.db.orm
          .update(users)
          .set({ ...patch, updatedAt: sql`now()` })
          .where(eq(users.id, row.id))
          .returning();
        user = updated[0]!;
      }
      if (grantedRole) {
        // requireUser never runs on this route, so the actor is stamped directly.
        await deps.db.orm.insert(auditEvents).values({
          actorUserId: user.id,
          action: "user.role_set",
          subjectType: "user",
          subjectId: user.id,
          detail: {
            role: grantedRole,
            via: roleGrantOrigin(body.via),
            ...(req.reqId ? { reqId: req.reqId } : {}),
          },
        });
      }

      const access = await notesAccess(deps, user);
      const [unread] = await deps.db.orm
        .select({ count: sql<number>`count(*)::int` })
        .from(notes)
        .where(and(eq(notes.studentId, user.id), eq(notes.status, "sent"), isNull(notes.readAt)));

      // canRecord lets the app warn a lapsed student BEFORE they record two hours
      // of audio (the hard 402 still lives at lesson create/submit). needsRole is
      // derived on every read, never stored — an account with neither capability
      // can record nothing and connect with nobody, and must be told so by name.
      res.status(200).json({
        ...user,
        access,
        canRecord: access.status !== "lapsed",
        unreadNotes: unread?.count ?? 0,
        needsRole: !user.isTeacher && !user.isStudent,
      });
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

      // Collect this user's own lesson audio AND transcript derivatives to purge
      // from blob after the tx commits — transcripts live in the durable container
      // (no lifecycle rule), so "full erase" must delete them explicitly.
      const myLessons = await db
        .select({ id: lessonSessions.id, audioPath: lessonSessions.audioPath })
        .from(lessonSessions)
        .where(eq(lessonSessions.teacherId, me.id));
      const audioPaths = myLessons.map((l) => l.audioPath).filter((p): p is string => !!p);
      const lessonIdsForAssets = myLessons.map((l) => l.id);
      const myJobs = lessonIdsForAssets.length
        ? await db
            .select({ transcriptPath: noteJobs.transcriptPath, modelOutputPath: noteJobs.modelOutputPath })
            .from(noteJobs)
            .where(inArray(noteJobs.lessonSessionId, lessonIdsForAssets))
        : [];
      const transcriptPaths = myJobs
        .flatMap((j) => [j.transcriptPath, j.modelOutputPath])
        .filter((p): p is string => !!p);

      // Narration follows the note row: purged for the copies destroyed below, kept
      // for the SENT notes that stay with their students.
      const purgedNoteIds = await db.transaction(async (tx) => {
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
        // Lessons + their jobs are the recorder's private capture — remove entirely.
        // Surviving SENT notes to other students still reference them: detach those
        // refs first (the tombstone contract — the note outlives its provenance) or
        // the NO ACTION FKs abort the whole transaction with a 500.
        const lessonIds = myLessons.map((l) => l.id);
        if (lessonIds.length) {
          await tx
            .update(notes)
            .set({ noteJobId: null, lessonSessionId: null, updatedAt: sql`now()` })
            .where(inArray(notes.lessonSessionId, lessonIds));
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
            organization: null,
            trialStartedAt: null,
            notesConsentAt: null,
            soloConsentAt: null,
            teacherConsentAt: null,
            deletedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(users.id, me.id));

        return [...receivedIds, ...draftIds];
      });

      await userAudit(deps, req, "account.delete", { type: "user", id: me.id });
      // The delete sheet tells the person their audio and transcripts are destroyed, so a purge that
      // fails may not vanish into a console line: each blob gets three attempts, and a survivor is
      // reported as ONE structured event Ops can query and alert on. Transcripts matter most — the
      // durable container has no lifecycle rule, so a missed one persists indefinitely.
      const purge = async (label: string, key: string, act: () => Promise<unknown>) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await act();
            return;
          } catch (err) {
            if (attempt === 3) {
              console.log(JSON.stringify({
                kind: "purge_failed", op: "account.delete", label, key,
                userId: me.id, reqId: req.reqId ?? null,
                error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
              }));
              return;
            }
            await new Promise((r) => setTimeout(r, 250 * attempt));
          }
        }
      };
      if (deps.lessons) {
        for (const path of audioPaths) {
          await purge("audio", path, () => deps.lessons!.deleteAudio(path));
        }
      }
      if (deps.notesAssets) {
        for (const path of transcriptPaths) {
          await purge("transcript", path, () => deps.notesAssets!.deleteAsset(path));
        }
        for (const noteId of purgedNoteIds) {
          await purge("narration", noteId, () => deps.notesAssets!.deletePrefix(narrationPrefix(noteId)));
        }
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
