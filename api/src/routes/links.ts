import { Router } from "express";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { notesAccess } from "../notes/entitlement";
import {
  auditEvents,
  invites,
  lessonSessions,
  noteAnnotations,
  notes,
  teacherStudentLinks,
  users,
} from "../db/schema";
import type { Db } from "../db/client";

// No ambiguous chars (Crockford base32 minus vowel-lookalikes) — codes get read
// aloud across a piano.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;
const INVITE_DAYS = 7;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Containment is per ACCOUNT, not per IP: rotating IPs is free, rotating CIAM
// accounts is not. Only unknown-code failures count toward the lock — own-code and
// wrong-direction attempts are users who did nothing wrong.
const REDEEM_FAIL_THRESHOLD = 5;
const REDEEM_WINDOW_MIN = 10;
const REDEEM_WINDOW_MAX_MIN = 60;

const DIRECTIONS = ["teacher_to_student", "student_to_teacher"] as const;
type Direction = (typeof DIRECTIONS)[number];

// A code that predates the departure is a DIFFERENT refusal from an unknown code:
// the characters are right and re-typing them can never work. It gets its own code
// and sentence, and (like own-code/consent failures) never counts toward the lock.
const STALE_CODE_MESSAGE = "That code was made before your connection ended. Ask for a new one.";

type RedeemOutcome =
  | { kind: "invalid" }
  | { kind: "stale" }
  | { kind: "already" }
  | { kind: "ok"; link: typeof teacherStudentLinks.$inferSelect };

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i]! % 32];
  return out;
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// Seconds left on this account's redeem lock, or null when it is not locked.
// 5 unknown codes inside the window locks it; every further block of five doubles
// the window. Derived from the audit trail alone, so it survives a restart, holds
// across replicas, and needs no state of its own.
async function redeemLockSeconds(orm: Db["orm"], userId: string): Promise<number | null> {
  const rows = await orm
    .select({ createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(
      eq(auditEvents.actorUserId, userId),
      eq(auditEvents.action, "invite.redeem_failed"),
      sql`${auditEvents.detail}->>'reason' = 'invalid_code'`,
      sql`${auditEvents.createdAt} > now() - ${`${REDEEM_WINDOW_MAX_MIN} minutes`}::interval`,
    ))
    .orderBy(desc(auditEvents.createdAt));
  if (rows.length < REDEEM_FAIL_THRESHOLD) return null;
  const rounds = Math.floor(rows.length / REDEEM_FAIL_THRESHOLD);
  const windowMin = Math.min(REDEEM_WINDOW_MIN * 2 ** (rounds - 1), REDEEM_WINDOW_MAX_MIN);
  const cutoff = Date.now() - windowMin * 60_000;
  const inWindow = rows.filter((r) => r.createdAt.getTime() > cutoff);
  if (inWindow.length < REDEEM_FAIL_THRESHOLD) return null;
  const left = inWindow[0]!.createdAt.getTime() + windowMin * 60_000 - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : null;
}

// Deliberately NO user lookup/search endpoint exists: linking is invite-code
// only (students are often minors — a searchable directory is the abuse surface).
export function linksRouter(deps: Deps): Router {
  const router = Router();
  const guards = [requireAuth(deps.auth), requireUser(deps)];

  router.post(
    "/v1/invites",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!me.isTeacher && !me.isStudent) {
        res.status(403).json({
          error: "notes_role_required",
          message: "This account isn't set up as a teacher or a student yet.",
        });
        return;
      }
      const db = deps.db!.orm;
      // Direction is STATED by the client and authorized here; the old derivation
      // survives only as back-compat for clients that send nothing (it can never
      // express a dual-role account's reverse mint).
      const stated = req.body?.direction;
      let direction: Direction;
      if (stated === undefined || stated === null) {
        direction = me.isTeacher ? "teacher_to_student" : "student_to_teacher";
      } else if (DIRECTIONS.includes(stated as Direction)) {
        direction = stated as Direction;
      } else {
        res.status(400).json({
          error: "invalid_direction",
          message: "That kind of invitation isn't recognized.",
        });
        return;
      }
      if (direction === "teacher_to_student" && !me.isTeacher) {
        res.status(403).json({ error: "teacher_only", message: "This account isn't set up as a teacher." });
        return;
      }
      if (direction === "student_to_teacher" && !me.isStudent) {
        res.status(403).json({ error: "student_only", message: "This account isn't set up as a student." });
        return;
      }
      // A reverse code is the solo student inviting THEIR teacher: the student's
      // recording consent is captured here at mint (createdAt = consent timestamp)
      // because the redeemer is the teacher, who only acknowledges.
      if (direction === "student_to_teacher" && req.body?.consent !== true) {
        res.status(400).json({ error: "consent_required", message: "Please accept the recording notice to invite your teacher." });
        return;
      }
      // Re-inviting someone the caller was linked to before. The body only NAMES the
      // counterpart; the freshness floor is read from the link row, so the client
      // cannot move it. Without this, the idempotent branch below hands back a code
      // minted before the departure — which redeem is guaranteed to refuse as stale.
      const rejoinUserId: unknown = req.body?.rejoinUserId;
      if (rejoinUserId !== undefined && rejoinUserId !== null && !isUuid(rejoinUserId)) {
        res.status(400).json({ error: "invalid_rejoin", message: "That person isn't on your past list." });
        return;
      }
      let rejoinFloor: Date | null = null;
      if (isUuid(rejoinUserId)) {
        const forward = direction === "teacher_to_student";
        const [past] = await db
          .select({ removedAt: teacherStudentLinks.removedAt })
          .from(teacherStudentLinks)
          .where(and(
            eq(teacherStudentLinks.teacherId, forward ? me.id : rejoinUserId),
            eq(teacherStudentLinks.studentId, forward ? rejoinUserId : me.id),
            eq(teacherStudentLinks.status, "removed"),
          ))
          .limit(1);
        rejoinFloor = past?.removedAt ?? null;
      }
      // ONE LIVE CODE PER ISSUER PER DIRECTION. Spent, revoked and expired codes are
      // not live, so serial onboarding is unaffected; a second mint is idempotent.
      const minted = await db.transaction(async (tx) => {
        // "No live code" is a gap condition, so only a lock on the issuer serializes
        // a double tap — a predicate on invites has nothing to lock.
        await tx.select({ id: users.id }).from(users).where(eq(users.id, me.id)).for("update");
        let [live] = await tx
          .select()
          .from(invites)
          .where(and(
            eq(invites.teacherId, me.id),
            eq(invites.direction, direction),
            isNull(invites.revokedAt),
            sql`${invites.usedCount} < ${invites.maxUses}`,
            sql`${invites.expiresAt} > now()`,
          ))
          .orderBy(desc(invites.createdAt))
          .limit(1);
        // Retiring it (rather than minting alongside) is what keeps the one-live-code
        // cap true; the CAS on revoked_at means a concurrent revoke cannot double-count.
        let retiredStaleId: string | undefined;
        if (live && rejoinFloor && live.createdAt < rejoinFloor) {
          const [retired] = await tx
            .update(invites)
            .set({ revokedAt: sql`now()` })
            .where(and(eq(invites.id, live.id), isNull(invites.revokedAt)))
            .returning({ id: invites.id });
          retiredStaleId = retired?.id;
          live = undefined;
        }
        if (live) return { row: live, created: false, retiredStaleId };
        let row: typeof invites.$inferSelect | undefined;
        for (let attempt = 0; attempt < 3 && !row; attempt++) {
          [row] = await tx
            .insert(invites)
            .values({
              code: generateCode(),
              teacherId: me.id,
              direction,
              expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
            })
            .onConflictDoNothing({ target: invites.code })
            .returning();
        }
        if (!row) throw new Error("invite code generation collided three times");
        return { row, created: true, retiredStaleId };
      });
      if (minted.retiredStaleId) {
        await userAudit(deps, req, "invite.revoke", { type: "invite", id: minted.retiredStaleId }, { direction, reason: "rejoin" });
      }
      if (minted.created) {
        await userAudit(deps, req, "invite.create", { type: "invite", id: minted.row.id }, { direction });
      }
      res.status(minted.created ? 201 : 200).json(minted.row);
    }),
  );

  // Default = live codes only (B1 shape, untouched). include=history returns every
  // code the caller ever minted with a derived state + resolved redeemers ("Code
  // history: who redeemed what"). redeemedBy is a legacy array of user ids — no
  // per-redemption timestamp exists, so redeemers carry identity only.
  router.get(
    "/v1/invites",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const history = req.query.include === "history";
      const rows = await db
        .select()
        .from(invites)
        .where(history
          ? eq(invites.teacherId, me.id)
          : and(eq(invites.teacherId, me.id), sql`${invites.revokedAt} IS NULL`))
        .orderBy(desc(invites.createdAt));
      const now = new Date();
      if (!history) {
        res.json(rows.filter((r) => r.expiresAt > now && r.usedCount < r.maxUses));
        return;
      }
      const redeemerIds = [...new Set(rows.flatMap((r) => (Array.isArray(r.redeemedBy) ? (r.redeemedBy as string[]) : [])))];
      const userRows = redeemerIds.length
        ? await db
            .select({ id: users.id, displayName: users.displayName, status: users.status })
            .from(users)
            .where(inArray(users.id, redeemerIds))
        : [];
      const byId = new Map(userRows.map((u) => [u.id, u]));
      res.json(rows.map((r) => ({
        ...r,
        state: r.revokedAt
          ? "revoked"
          : r.usedCount >= r.maxUses
            ? "used"
            : r.expiresAt < now
              ? "expired"
              : "active",
        redeemers: (Array.isArray(r.redeemedBy) ? (r.redeemedBy as string[]) : []).map((uid) => {
          const u = byId.get(uid);
          return {
            userId: uid,
            displayName: u?.status === "deleted" ? null : u?.displayName ?? null,
            deleted: u?.status === "deleted",
          };
        }),
      })));
    }),
  );

  router.delete(
    "/v1/invites/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const id = String(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: "not_found", message: "That code no longer exists." });
        return;
      }
      const [row] = await db
        .update(invites)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(invites.id, id), eq(invites.teacherId, me.id), isNull(invites.revokedAt)))
        .returning();
      if (row) {
        // Revocation is the security-relevant half of the lifecycle and the user's
        // only kill switch — it audits like every other write, once per transition.
        await userAudit(deps, req, "invite.revoke", { type: "invite", id: row.id }, { direction: row.direction });
        res.json({ ok: true });
        return;
      }
      // Already revoked is the outcome the caller asked for: replace-then-mint must
      // not dead-end on a stale screen.
      const [owned] = await db
        .select({ id: invites.id })
        .from(invites)
        .where(and(eq(invites.id, id), eq(invites.teacherId, me.id)))
        .limit(1);
      if (!owned) {
        res.status(404).json({ error: "not_found", message: "That code no longer exists." });
        return;
      }
      res.json({ ok: true });
    }),
  );

  // Redeeming IS the acceptance. Forward codes: the app's confirmation card shows
  // the teacher's name plus the recording-consent checkbox before this fires.
  // Reverse codes: the issuing student consented at mint; the redeeming teacher
  // must explicitly confirm becoming this student's teacher (a mis-redeem grants
  // isTeacher — a deliberate action, never a default).
  router.post(
    "/v1/invites/redeem",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const fail = async (reason: string) => {
        await userAudit(deps, req, "invite.redeem_failed", undefined, { reason });
      };

      const locked = await redeemLockSeconds(db, me.id);
      if (locked !== null) {
        const mins = Math.max(1, Math.ceil(locked / 60));
        res.set("Retry-After", String(locked));
        res.status(429).json({
          error: "too_many_attempts",
          message: `Too many incorrect codes. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
          retryAfterSec: locked,
        });
        return;
      }

      const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
      if (!code) {
        res.status(400).json({ error: "code_required", message: "Enter the six characters first." });
        return;
      }
      const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
      if (!invite || invite.revokedAt || invite.expiresAt < new Date() || invite.usedCount >= invite.maxUses) {
        await fail("invalid_code");
        res.status(404).json({ error: "invalid_code", message: "That code is invalid or has expired — ask for a new one." });
        return;
      }
      if (invite.teacherId === me.id) {
        await fail("own_code");
        res.status(400).json({ error: "own_code", message: "That's your own code." });
        return;
      }
      const reverse = invite.direction === "student_to_teacher";
      if (reverse) {
        if (req.body?.acceptTeacherRole !== true) {
          await fail("teacher_confirm_required");
          res.status(400).json({ error: "teacher_confirm_required", message: "Confirm you are this student's teacher to accept the invite." });
          return;
        }
      } else if (req.body?.consent !== true) {
        await fail("consent_required");
        res.status(400).json({ error: "consent_required", message: "Please accept the recording notice to link with your teacher." });
        return;
      }

      // The link pair, keyed by who ends up on which side of it.
      const linkTeacherId = reverse ? me.id : invite.teacherId;
      const linkStudentId = reverse ? invite.teacherId : me.id;
      const [issuer] = await db.select().from(users).where(eq(users.id, invite.teacherId)).limit(1);
      const counterpart = { id: issuer!.id, displayName: issuer!.displayName };
      const alreadyLinked = () => {
        res.status(409).json({
          error: "already_linked",
          message: counterpart.displayName
            ? `You're already connected with ${counterpart.displayName}.`
            : "You're already connected with this person.",
          counterpart,
        });
      };
      const [existing] = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(eq(teacherStudentLinks.teacherId, linkTeacherId), eq(teacherStudentLinks.studentId, linkStudentId)))
        .limit(1);
      if (existing && existing.status === "active") {
        alreadyLinked();
        return;
      }
      // Consent never travels backwards: a code minted BEFORE the pair was ended
      // cannot re-form it. Rejoining takes a code minted after the departure.
      if (existing && existing.removedAt && invite.createdAt < existing.removedAt) {
        await fail("stale_code");
        res.status(404).json({ error: "stale_code", message: STALE_CODE_MESSAGE });
        return;
      }

      const outcome = await db.transaction(async (tx): Promise<RedeemOutcome> => {
        // Claim a use-count slot atomically BEFORE creating the link — two redeemers
        // racing a single-use code must not both succeed. KNOWN GAP (risk register):
        // drizzle COMMITs on a normal callback return, so a refusal returned from here
        // keeps the claim and burns the code; only a thrown error would roll it back.
        const [claimed] = await tx
          .update(invites)
          .set({
            usedCount: sql`${invites.usedCount} + 1`,
            redeemedBy: sql`${invites.redeemedBy} || ${JSON.stringify([me.id])}::jsonb`,
          })
          .where(and(
            eq(invites.id, invite.id),
            sql`${invites.usedCount} < ${invites.maxUses}`,
            sql`${invites.revokedAt} IS NULL`,
            sql`${invites.expiresAt} > now()`,
          ))
          .returning();
        if (!claimed) return { kind: "invalid" as const };
        // Reverse consent lives at mint: the invite's createdAt is the student's
        // recorded consent timestamp. A REACTIVATION always re-consents at now() —
        // a resumed relationship never inherits the old one's timestamp.
        const [link] = await tx
          .insert(teacherStudentLinks)
          .values({
            teacherId: linkTeacherId,
            studentId: linkStudentId,
            createdVia: reverse ? "student_invite" : "invite_code",
            consentAt: reverse ? invite.createdAt : sql`now()`,
          })
          .onConflictDoUpdate({
            target: [teacherStudentLinks.teacherId, teacherStudentLinks.studentId],
            set: { status: "active", consentAt: sql`now()`, removedAt: null, updatedAt: sql`now()` },
            setWhere: sql`${teacherStudentLinks.status} = 'removed' AND (${teacherStudentLinks.removedAt} IS NULL OR ${teacherStudentLinks.removedAt} <= ${invite.createdAt}::timestamptz)`,
          })
          .returning();
        if (!link) {
          const [row] = await tx
            .select()
            .from(teacherStudentLinks)
            .where(and(
              eq(teacherStudentLinks.teacherId, linkTeacherId),
              eq(teacherStudentLinks.studentId, linkStudentId),
            ))
            .limit(1);
          if (row?.status === "active") return { kind: "already" as const };
          // The pair ended between the pre-check and this insert: the same stale
          // refusal, and it must not be charged to the redeem lock as a bad guess.
          if (row?.removedAt && invite.createdAt < row.removedAt) return { kind: "stale" as const };
          return { kind: "invalid" as const };
        }
        if (reverse) {
          // Accepting makes you a teacher (grow-only). NO trial clock: teachers are
          // free-side and must never start a subscription countdown by accepting.
          await tx
            .update(users)
            .set({ isTeacher: true, updatedAt: sql`now()` })
            .where(and(eq(users.id, me.id), eq(users.isTeacher, false)));
        } else {
          // Redeeming makes you a student; the trial clock starts at first student grant.
          await tx
            .update(users)
            .set({
              isStudent: true,
              trialStartedAt: sql`coalesce(${users.trialStartedAt}, now())`,
              updatedAt: sql`now()`,
            })
            .where(and(eq(users.id, me.id), eq(users.isStudent, false)));
        }
        return { kind: "ok" as const, link };
      });

      if (outcome.kind === "already") {
        alreadyLinked();
        return;
      }
      if (outcome.kind === "stale") {
        await fail("stale_code");
        res.status(404).json({ error: "stale_code", message: STALE_CODE_MESSAGE });
        return;
      }
      if (outcome.kind === "invalid") {
        await fail("invalid_code");
        res.status(404).json({ error: "invalid_code", message: "That code is invalid or has expired — ask for a new one." });
        return;
      }
      await userAudit(deps, req, "invite.redeem", { type: "link", id: outcome.link.id }, { inviteId: invite.id, direction: invite.direction });
      res.status(201).json(
        reverse ? { link: outcome.link, student: counterpart } : { link: outcome.link, teacher: counterpart },
      );
    }),
  );

  // include=removed adds ended links (Past students): status/removedAt flow, and
  // counterpartDeleted marks a scrubbed account so the UI shows a placeholder
  // instead of a null-name row. Email stays OFF the list (founder: detail only).
  router.get(
    "/v1/me/students",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!me.isTeacher) {
        res.status(403).json({ error: "teacher_only", message: "This account isn't set up as a teacher." });
        return;
      }
      const db = deps.db!.orm;
      const includeRemoved = req.query.include === "removed";
      const links = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(
          eq(teacherStudentLinks.teacherId, me.id),
          includeRemoved
            ? inArray(teacherStudentLinks.status, ["active", "removed"])
            : eq(teacherStudentLinks.status, "active"),
        ))
        .orderBy(desc(teacherStudentLinks.createdAt));
      const studentIds = links.map((l) => l.studentId);
      const studentRows = studentIds.length
        ? await db.select().from(users).where(inArray(users.id, studentIds))
        : [];
      // INVARIANT: every timestamp on the wire is ISO-8601. A bare `sql` expression
      // carries no column decoder, so the driver's own text ("2026-07-25 13:38:26+00")
      // would reach the client — which parses dates with ISO8601DateFormatter and
      // fails the whole response. mapWith borrows the column's decoder.
      const lastNotes = studentIds.length
        ? await db
            .select({
              studentId: notes.studentId,
              lastSentAt: sql<Date>`max(${notes.sentAt})`.mapWith(notes.sentAt),
            })
            .from(notes)
            .where(and(eq(notes.teacherId, me.id), eq(notes.status, "sent"), inArray(notes.studentId, studentIds)))
            .groupBy(notes.studentId)
        : [];
      const lastByStudent = new Map(lastNotes.map((r) => [r.studentId, r.lastSentAt]));
      const lastLessons = studentIds.length
        ? await db
            .select({
              studentId: lessonSessions.studentId,
              lastAt: sql<Date>`max(coalesce(${lessonSessions.startedAt}, ${lessonSessions.createdAt}))`
                .mapWith(lessonSessions.startedAt),
            })
            .from(lessonSessions)
            .where(and(
              eq(lessonSessions.teacherId, me.id),
              inArray(lessonSessions.studentId, studentIds),
              sql`${lessonSessions.status} <> 'canceled'`,
            ))
            .groupBy(lessonSessions.studentId)
        : [];
      const lessonByStudent = new Map(lastLessons.map((r) => [r.studentId, r.lastAt]));
      const practiced = studentIds.length
        ? await db
            .select({
              studentId: notes.studentId,
              total: sql<number>`count(${noteAnnotations.id})::int`,
              done: sql<number>`count(${noteAnnotations.doneAt})::int`,
            })
            .from(noteAnnotations)
            .innerJoin(notes, eq(noteAnnotations.noteId, notes.id))
            .where(and(eq(notes.teacherId, me.id), eq(notes.status, "sent"), inArray(notes.studentId, studentIds)))
            .groupBy(notes.studentId)
        : [];
      const practicedByStudent = new Map(practiced.map((r) => [r.studentId, r]));
      const items = await Promise.all(
        links.map(async (l) => {
          const student = studentRows.find((u) => u.id === l.studentId);
          // Delivery capability, deliberately NOT billing wording — the teacher
          // never sees a family's payment state.
          const access = student && student.status !== "deleted" ? await notesAccess(deps, student) : null;
          const p = practicedByStudent.get(l.studentId);
          return {
            linkId: l.id,
            studentId: l.studentId,
            displayName: student?.displayName ?? null,
            linkedAt: l.createdAt,
            consentAt: l.consentAt,
            status: l.status,
            removedAt: l.removedAt,
            counterpartDeleted: student?.status === "deleted",
            lastNoteAt: lastByStudent.get(l.studentId) ?? null,
            lastLessonAt: lessonByStudent.get(l.studentId) ?? null,
            practicedTotal: p?.total ?? 0,
            practicedDone: p?.done ?? 0,
            canReceiveNotes: access ? access.status !== "lapsed" : false,
          };
        }),
      );
      res.json({ items });
    }),
  );

  // Serves removed links too (Past-student detail: history stays readable, Invite
  // again lives here). Email surfaces ONLY on this detail view (founder-gated) and
  // ONLY while the link is active — a student who leaves withdraws their address.
  router.get(
    "/v1/me/students/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!me.isTeacher) {
        res.status(403).json({ error: "teacher_only", message: "This account isn't set up as a teacher." });
        return;
      }
      const db = deps.db!.orm;
      const studentId = String(req.params.id);
      if (!isUuid(studentId)) {
        res.status(404).json({ error: "not_found", message: "That student isn't on your list." });
        return;
      }
      const [link] = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(
          eq(teacherStudentLinks.teacherId, me.id),
          eq(teacherStudentLinks.studentId, studentId),
        ))
        .limit(1);
      if (!link) {
        res.status(404).json({ error: "not_found", message: "That student isn't on your list." });
        return;
      }
      const [student] = await db.select().from(users).where(eq(users.id, link.studentId)).limit(1);
      const counterpartDeleted = student?.status === "deleted";
      const timeline = await db
        .select({
          id: notes.id,
          status: notes.status,
          pieceId: notes.pieceId,
          pieceLabel: notes.pieceLabel,
          sentAt: notes.sentAt,
          readAt: notes.readAt,
        })
        .from(notes)
        .where(and(
          eq(notes.teacherId, me.id),
          eq(notes.studentId, link.studentId),
          inArray(notes.status, ["sent", "retracted"]),
        ))
        .orderBy(desc(notes.sentAt));
      const access = counterpartDeleted ? null : await notesAccess(deps, student!);
      res.json({
        linkId: link.id,
        studentId: student!.id,
        displayName: student!.displayName,
        email: counterpartDeleted || link.status === "removed" ? null : student!.email,
        linkedAt: link.createdAt,
        consentAt: link.consentAt,
        createdVia: link.createdVia,
        status: link.status,
        removedAt: link.removedAt,
        counterpartDeleted,
        canReceiveNotes: access ? access.status !== "lapsed" : false,
        notes: timeline,
      });
    }),
  );

  // Either side may end the link; sent notes stay with the student (their record).
  // Ending retires only the codes that could re-form THIS pair — see endLink.
  router.delete(
    "/v1/me/students/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!me.isTeacher) {
        res.status(403).json({ error: "teacher_only", message: "This account isn't set up as a teacher." });
        return;
      }
      const studentId = String(req.params.id);
      if (!isUuid(studentId)) {
        res.status(404).json({ error: "not_found", message: "That student isn't on your list." });
        return;
      }
      const row = await endLink(deps, me.id, { teacherId: me.id, studentId });
      if (!row) {
        res.status(404).json({ error: "not_found", message: "That student isn't on your list." });
        return;
      }
      await userAudit(deps, req, "link.remove", { type: "link", id: row.id }, { by: "teacher" });
      res.json({ ok: true });
    }),
  );

  // include=removed adds ended links (Past teachers). NO organization and NO email
  // here — the sign-up copy promises "Not shown publicly" (founder-gated).
  router.get(
    "/v1/me/teachers",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const includeRemoved = req.query.include === "removed";
      const links = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(
          eq(teacherStudentLinks.studentId, me.id),
          includeRemoved
            ? inArray(teacherStudentLinks.status, ["active", "removed"])
            : eq(teacherStudentLinks.status, "active"),
        ))
        .orderBy(desc(teacherStudentLinks.createdAt));
      const teacherIds = links.map((l) => l.teacherId);
      const teacherRows = teacherIds.length
        ? await db.select().from(users).where(inArray(users.id, teacherIds))
        : [];
      const noteAgg = teacherIds.length
        ? await db
            .select({
              teacherId: notes.teacherId,
              count: sql<number>`count(*)::int`,
              lastAt: sql<Date>`max(${notes.sentAt})`.mapWith(notes.sentAt),
            })
            .from(notes)
            .where(and(
              eq(notes.studentId, me.id),
              eq(notes.status, "sent"),
              eq(notes.origin, "teacher"),
              inArray(notes.teacherId, teacherIds),
            ))
            .groupBy(notes.teacherId)
        : [];
      const aggByTeacher = new Map(noteAgg.map((r) => [r.teacherId, r]));
      res.json({
        items: links.map((l) => {
          const teacher = teacherRows.find((u) => u.id === l.teacherId);
          const agg = aggByTeacher.get(l.teacherId);
          return {
            linkId: l.id,
            teacherId: l.teacherId,
            displayName: teacher?.displayName ?? null,
            linkedAt: l.createdAt,
            consentAt: l.consentAt,
            status: l.status,
            removedAt: l.removedAt,
            counterpartDeleted: teacher?.status === "deleted",
            noteCount: agg?.count ?? 0,
            lastNoteAt: agg?.lastAt ?? null,
          };
        }),
      });
    }),
  );

  router.delete(
    "/v1/me/teachers/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const teacherId = String(req.params.id);
      if (!isUuid(teacherId)) {
        res.status(404).json({ error: "not_found", message: "That teacher isn't on your list." });
        return;
      }
      const row = await endLink(deps, me.id, { teacherId, studentId: me.id });
      if (!row) {
        res.status(404).json({ error: "not_found", message: "That teacher isn't on your list." });
        return;
      }
      await userAudit(deps, req, "link.remove", { type: "link", id: row.id }, { by: "student" });
      res.json({ ok: true });
    }),
  );

  return router;
}

// One batch: end THIS pair, and retire only the codes that could re-form it — the
// remover's, in the direction that made this pair, already redeemed by this
// counterpart (a multi-use code). A live code the remover has out for someone else
// is a different invitation and survives. Codes minted before the departure need no
// revoke: redeem refuses them as stale on its own.
async function endLink(
  deps: Deps,
  removerId: string,
  pair: { teacherId: string; studentId: string },
): Promise<typeof teacherStudentLinks.$inferSelect | undefined> {
  return deps.db!.orm.transaction(async (tx) => {
    const [row] = await tx
      .update(teacherStudentLinks)
      .set({ status: "removed", removedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(
        eq(teacherStudentLinks.teacherId, pair.teacherId),
        eq(teacherStudentLinks.studentId, pair.studentId),
        eq(teacherStudentLinks.status, "active"),
      ))
      .returning();
    if (!row) return undefined;
    const removerIsTeacher = removerId === pair.teacherId;
    const counterpartId = removerIsTeacher ? pair.studentId : pair.teacherId;
    const direction: Direction = removerIsTeacher ? "teacher_to_student" : "student_to_teacher";
    await tx
      .update(invites)
      .set({ revokedAt: sql`now()` })
      .where(and(
        eq(invites.teacherId, removerId),
        eq(invites.direction, direction),
        isNull(invites.revokedAt),
        sql`${invites.redeemedBy} @> ${JSON.stringify([counterpartId])}::jsonb`,
      ));
    return row;
  });
}
