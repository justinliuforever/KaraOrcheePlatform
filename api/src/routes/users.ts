import type { Request } from "express";
import { Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { graphFromEnv, unresolvedGraphLog, type GraphResolution } from "../graph";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { deleteCustomPiecesOf } from "./customPieces";
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
import { scanPurgePrefixes, stampAndDeleteScans } from "../notes/scan_delete";

const ROLE_GRANT_ORIGINS = ["signup", "setup"] as const;
type RoleGrantOrigin = (typeof ROLE_GRANT_ORIGINS)[number];

// Matches NotesConsent.Kind on the app.
const CONSENT_KINDS = ["teacher", "solo"] as const;
type ConsentKind = (typeof CONSENT_KINDS)[number];

function roleGrantOrigin(via: unknown): RoleGrantOrigin {
  return ROLE_GRANT_ORIGINS.includes(via as RoleGrantOrigin) ? (via as RoleGrantOrigin) : "signup";
}

const AGE_BRACKETS = ["over_13", "under_13"] as const;
type AgeBracket = (typeof AGE_BRACKETS)[number];

function ageBracket(value: unknown): AgeBracket | null {
  return AGE_BRACKETS.includes(value as AgeBracket) ? (value as AgeBracket) : null;
}

// Never throws (callers rely on this); return value is true ONLY after a Graph call actually answered.
async function deleteCiamIdentity(
  deps: Deps,
  req: Request,
  args: { userId: string; oid: string | null },
): Promise<boolean> {
  const reqId = req.reqId ?? null;
  if (!args.oid) {
    console.log(JSON.stringify({ kind: "ciam_delete_skipped", reason: "no_oid", userId: args.userId, reqId }));
    return false;
  }
  const resolved: GraphResolution = deps.graph
    ? { client: deps.graph, incomplete: false }
    : graphFromEnv();
  if (!resolved.client) {
    console.log(JSON.stringify({
      ...unresolvedGraphLog(resolved), userId: args.userId, reqId,
    }));
    return false;
  }
  const result = await resolved.client.deleteUser(args.oid);
  if (!result.ok) {
    console.log(JSON.stringify({
      kind: "ciam_delete_pending", userId: args.userId, reqId, reason: result.reason,
    }));
    return false;
  }
  try {
    await deps.db!.orm
      .update(users)
      .set({ ciamDeletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(users.id, args.userId));
  } catch {
    // Stamp failure is safe: an unstamped row self-heals via Graph 404 on the next retry.
    console.log(JSON.stringify({ kind: "ciam_delete_stamp_failed", userId: args.userId, reqId }));
  }
  return true;
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

      // Must run BEFORE the upsert, or the upsert resurrects this tombstoned account (entra_oid was released at deletion).
      const [tombstone] = await deps.db.orm
        .select({ id: users.id, ciamDeletedAt: users.ciamDeletedAt })
        .from(users)
        .where(eq(users.ciamOidAtDelete, claims.oid))
        .limit(1);
      if (tombstone) {
        if (!tombstone.ciamDeletedAt) {
          await deleteCiamIdentity(deps, req, { userId: tombstone.id, oid: claims.oid });
        }
        res.status(410).json({ error: "account_deleted", message: "This account was deleted." });
        return;
      }

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

      // Role grant is roleless-accounts-only — allowing it on an existing account is a self-service teacher_free paywall bypass.
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
      // Solo consent must never satisfy the teacher gate — an unnamed/unrecognized consentKind stamps only the legacy column, satisfying neither.
      const accepted = body.notesConsent === true;
      const consentKind = CONSENT_KINDS.includes(body.consentKind as ConsentKind)
        ? (body.consentKind as ConsentKind)
        : null;
      if (accepted && !row.notesConsentAt) patch.notesConsentAt = sql`now()`;
      if (accepted && consentKind === "solo" && !row.soloConsentAt) patch.soloConsentAt = sql`now()`;
      if (accepted && consentKind === "teacher" && !row.teacherConsentAt) patch.teacherConsentAt = sql`now()`;
      if (typeof body.organization === "string" && body.organization.trim() && !row.organization) {
        patch.organization = body.organization.trim().slice(0, 200);
      }
      const attestedAge = grantedRole ? ageBracket(body.ageBracket) : null;
      if (attestedAge && !row.ageBracket) {
        patch.ageBracket = attestedAge;
        patch.ageAttestedAt = sql`now()`;
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
            ...(patch.ageBracket ? { ageBracket: patch.ageBracket } : {}),
            ...(req.reqId ? { reqId: req.reqId } : {}),
          },
        });
      }

      const access = await notesAccess(deps, user);
      const [unread] = await deps.db.orm
        .select({ count: sql<number>`count(*)::int` })
        .from(notes)
        .where(and(eq(notes.studentId, user.id), eq(notes.status, "sent"), isNull(notes.readAt)));

      // canRecord is an early warning only — the actual enforcement is the 402 at lesson create/submit, not this flag.
      res.status(200).json({
        ...user,
        access,
        canRecord: access.status !== "lapsed",
        unreadNotes: unread?.count ?? 0,
        needsRole: !user.isTeacher && !user.isStudent,
        // Mirrors PASSWORD_SIGNIN_ENABLED — the app gates the set-a-password UI on this staying false until sign-in is rebound.
        features: { passwordSignIn: process.env.PASSWORD_SIGNIN_ENABLED === "true" },
      });
    }),
  );

  // ORDER LOAD-BEARING: platform purge before CIAM identity delete, or a failed purge could orphan data nobody can authenticate to retry.
  router.delete(
    "/v1/me",
    requireAuth(deps.auth),
    requireUser(deps),
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const me = req.notesUser!;

      // Transcripts live in the durable container with no lifecycle rule — must be purged explicitly or they persist forever.
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

      // Narration is purged only for purged.noteIds — sent notes (and their narration) must survive with the student.
      let ciamOid: string | null = null;
      const purged = await db.transaction(async (tx) => {
        await tx
          .update(teacherStudentLinks)
          .set({ status: "removed", removedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(
            sql`(${teacherStudentLinks.teacherId} = ${me.id} OR ${teacherStudentLinks.studentId} = ${me.id})`,
            eq(teacherStudentLinks.status, "active"),
          ));
        // intendedLabel often names a child who never signed up — must not outlive the account that wrote it.
        await tx.update(invites).set({ revokedAt: sql`now()`, intendedLabel: null })
          .where(and(eq(invites.teacherId, me.id), isNull(invites.revokedAt)));
        await tx.update(invites).set({ intendedLabel: null })
          .where(and(
            eq(invites.teacherId, me.id),
            sql`${invites.intendedLabel} IS NOT NULL`,
          ));

        const received = await tx.select({ id: notes.id }).from(notes).where(eq(notes.studentId, me.id));
        const receivedIds = received.map((n) => n.id);
        if (receivedIds.length) {
          await tx.delete(noteAnnotations).where(inArray(noteAnnotations.noteId, receivedIds));
          await tx.delete(notes).where(inArray(notes.id, receivedIds));
        }

        // SENT notes must NOT be deleted here — they stay with their students, attributed to this tombstone row.
        const drafts = await tx
          .select({ id: notes.id })
          .from(notes)
          .where(and(eq(notes.teacherId, me.id), eq(notes.status, "draft")));
        const draftIds = drafts.map((n) => n.id);
        if (draftIds.length) {
          await tx.delete(noteAnnotations).where(inArray(noteAnnotations.noteId, draftIds));
          await tx.delete(notes).where(inArray(notes.id, draftIds));
        }
        // Must null notes.lessonSessionId/noteJobId before deleting lessons/jobs — NO ACTION FKs abort the whole tx otherwise.
        const lessonIds = myLessons.map((l) => l.id);
        if (lessonIds.length) {
          await tx
            .update(notes)
            .set({ noteJobId: null, lessonSessionId: null, updatedAt: sql`now()` })
            .where(inArray(notes.lessonSessionId, lessonIds));
          await tx.delete(noteJobs).where(inArray(noteJobs.lessonSessionId, lessonIds));
          await tx.delete(lessonSessions).where(inArray(lessonSessions.id, lessonIds));
        }
        const deletedScans = await stampAndDeleteScans(tx, { ownerId: me.id });
        // custom_piece_id is ON DELETE SET NULL on surviving notes — piece_label (what students see) is a separate column, untouched.
        await deleteCustomPiecesOf(tx, me.id);

        await tx.delete(devices).where(eq(devices.userId, me.id));
        await tx.delete(entitlements).where(eq(entitlements.userId, me.id));

        // entraOid must move to ciamOidAtDelete in this same statement — the RHS reads the pre-update row, closing the race window.
        const [tombstoned] = await tx
          .update(users)
          .set({
            status: "deleted",
            email: null,
            displayName: null,
            ciamOidAtDelete: sql`${users.entraOid}`,
            entraOid: null,
            organization: null,
            trialStartedAt: null,
            notesConsentAt: null,
            soloConsentAt: null,
            teacherConsentAt: null,
            deletedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(users.id, me.id))
          .returning({ ciamOidAtDelete: users.ciamOidAtDelete });
        ciamOid = tombstoned?.ciamOidAtDelete ?? null;

        return { noteIds: [...receivedIds, ...draftIds], deletedScans };
      });

      await userAudit(deps, req, "account.delete", { type: "user", id: me.id });
      // Purge failures must surface as an alertable structured event, never a swallowed error — the delete sheet promises this is destroyed.
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
        for (const noteId of purged.noteIds) {
          await purge("narration", noteId, () => deps.notesAssets!.deletePrefix(narrationPrefix(noteId)));
        }
      }
      if (deps.scans) {
        for (const prefix of scanPurgePrefixes(deps.scans, me.id, purged.deletedScans)) {
          await purge("scan", prefix, () => deps.scans!.deletePrefix(prefix));
        }
      } else {
        // The rows are gone before the blobs, so with no store to purge them this line is the only thing left that names the bytes.
        for (const scan of purged.deletedScans) {
          console.log(JSON.stringify({
            kind: "purge_failed", op: "account.delete", label: "scan", key: scan.id,
            userId: me.id, reqId: req.reqId ?? null, error: "storage_not_configured",
          }));
        }
      }
      // identityDeleted drives the delete-sheet's sign-in-service sentence — false whenever Graph never answered, unconfigured included.
      const identityDeleted = await deleteCiamIdentity(deps, req, { userId: me.id, oid: ciamOid });
      res.json({ ok: true, identityDeleted });
    }),
  );

  return router;
}
