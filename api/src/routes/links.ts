import { Router } from "express";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { notesAccess, notesAccessMany } from "../notes/entitlement";
import {
  auditEvents,
  invites,
  lessonSessions,
  noteAnnotations,
  notes,
  pieces,
  teacherStudentLinks,
  users,
} from "../db/schema";
import type { Db } from "../db/client";

// No ambiguous chars (Crockford base32 minus vowel-lookalikes) — codes get read aloud across a piano.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;
const INVITE_DAYS = 7;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-account, not per-IP (IP rotation is free); only invalid-code failures count toward the lock.
const REDEEM_FAIL_THRESHOLD = 5;
const REDEEM_WINDOW_MIN = 10;
const REDEEM_WINDOW_MAX_MIN = 60;

const DIRECTIONS = ["teacher_to_student", "student_to_teacher"] as const;
type Direction = (typeof DIRECTIONS)[number];

// Ceiling keeps the roster's seats section from outgrowing the roster — one code per named seat.
const MAX_LIVE_CODES = 10;
const MAX_LABEL_LENGTH = 40;

// Separate refusal from invalid_code — re-typing the right characters can never work, and it must never count toward the lock.
const STALE_CODE_MESSAGE = "That code was made before your connection ended. Ask for a new one.";

// Must be thrown, never returned — drizzle commits a callback that returns normally, burning the code's use-count claim.
class RedeemRefusal extends Error {
  constructor(readonly kind: "invalid" | "stale" | "already") {
    super(kind);
  }
}

class MintRefusal extends Error {
  constructor(readonly liveCount: number) {
    super("too_many_codes");
  }
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i]! % 32];
  return out;
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// Derived entirely from the audit trail, with no counter of its own — must survive restarts and hold across replicas.
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

// Deliberately NO user lookup/search endpoint — a searchable directory of (often-minor) students is the abuse surface.
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
      // Fallback derivation is back-compat only, for clients sending no direction — it can't express a dual-role account's reverse mint.
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
      // Reverse invite: invite.createdAt IS the student's consent timestamp, captured at mint — the redeeming teacher only acknowledges.
      if (direction === "student_to_teacher" && req.body?.consent !== true) {
        res.status(400).json({ error: "consent_required", message: "Please accept the recording notice to invite your teacher." });
        return;
      }
      // Labels are teacher-side only — giving students labels would silently lift the one-live-code rule the reverse flow depends on.
      const rawLabel: unknown = req.body?.intendedLabel;
      let intendedLabel: string | null = null;
      if (rawLabel !== undefined && rawLabel !== null) {
        if (typeof rawLabel !== "string") {
          res.status(400).json({ error: "invalid_label", message: "That name isn't something we can save." });
          return;
        }
        const trimmed = rawLabel.trim();
        if (trimmed.length > MAX_LABEL_LENGTH) {
          res.status(400).json({ error: "invalid_label", message: "That name is too long — first names work best." });
          return;
        }
        intendedLabel = trimmed.length ? trimmed : null;
      }
      if (intendedLabel && direction !== "teacher_to_student") {
        res.status(400).json({ error: "invalid_label", message: "A code for your teacher can't be named." });
        return;
      }
      // Freshness floor is read from the link row, never the client — a client-supplied floor could dodge the stale-code refusal.
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
      // Enforced here, not a unique index — liveness includes expires_at > now(), which can't sit in an index predicate.
      const liveForIssuer = and(
        eq(invites.teacherId, me.id),
        eq(invites.direction, direction),
        isNull(invites.revokedAt),
        sql`${invites.usedCount} < ${invites.maxUses}`,
        sql`${invites.expiresAt} > now()`,
      );
      let minted: { row: typeof invites.$inferSelect; created: boolean; retiredStaleId?: string };
      try {
        minted = await db.transaction(async (tx) => {
        // Locks the issuer row, not invites — "no live code" is a gap condition with nothing to row-lock.
        await tx.select({ id: users.id }).from(users).where(eq(users.id, me.id)).for("update");
        let [live] = await tx
          .select()
          .from(invites)
          .where(and(
            liveForIssuer,
            intendedLabel === null
              ? isNull(invites.intendedLabel)
              : eq(invites.intendedLabel, intendedLabel),
          ))
          .orderBy(desc(invites.createdAt))
          .limit(1);
        // CAS on revoked_at (not just id) — a concurrent revoke of this same code must not double-count.
        let retiredStaleId: string | undefined;
        if (live && rejoinFloor && live.createdAt < rejoinFloor) {
          const [retired] = await tx
            .update(invites)
            .set({ revokedAt: sql`now()`, intendedLabel: null })
            .where(and(eq(invites.id, live.id), isNull(invites.revokedAt)))
            .returning({ id: invites.id });
          retiredStaleId = retired?.id;
          live = undefined;
        }
        if (live) return { row: live, created: false, retiredStaleId };
        // Checked before any write, and only when not replacing a stale slot, so a refusal leaves nothing behind.
        if (!retiredStaleId) {
          const [tally] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(invites)
            .where(liveForIssuer);
          const liveCount = tally?.n ?? 0;
          if (liveCount >= MAX_LIVE_CODES) throw new MintRefusal(liveCount);
        }
        let row: typeof invites.$inferSelect | undefined;
        for (let attempt = 0; attempt < 3 && !row; attempt++) {
          [row] = await tx
            .insert(invites)
            .values({
              code: generateCode(),
              teacherId: me.id,
              direction,
              intendedLabel,
              expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
            })
            .onConflictDoNothing({ target: invites.code })
            .returning();
        }
        if (!row) throw new Error("invite code generation collided three times");
        return { row, created: true, retiredStaleId };
        });
      } catch (err) {
        if (!(err instanceof MintRefusal)) throw err;
        res.status(409).json({
          error: "too_many_codes",
          message: `You have ${err.liveCount} invite codes waiting. Revoke one to create another.`,
        });
        return;
      }
      if (minted.retiredStaleId) {
        await userAudit(deps, req, "invite.revoke", { type: "invite", id: minted.retiredStaleId }, { direction, reason: "rejoin" });
      }
      if (minted.created) {
        await userAudit(deps, req, "invite.create", { type: "invite", id: minted.row.id }, { direction });
      }
      res.status(minted.created ? 201 : 200).json(minted.row);
    }),
  );

  // redeemedBy is a legacy array of user ids only — no per-redemption timestamp exists.
  router.get(
    "/v1/invites",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const history = req.query.include === "history";
      const seats = req.query.include === "seats";
      const rows = await db
        .select()
        .from(invites)
        .where(history
          ? eq(invites.teacherId, me.id)
          : and(eq(invites.teacherId, me.id), sql`${invites.revokedAt} IS NULL`))
        .orderBy(desc(invites.createdAt));
      const now = new Date();
      // Seats include expired codes — expiry doesn't retire a named seat, only redemption or dismissal does.
      if (seats) {
        res.json(rows
          .filter((r) => !r.dismissedAt && r.usedCount < r.maxUses)
          .map((r) => ({ ...r, state: r.expiresAt > now ? "active" : "expired" })));
        return;
      }
      // Must exclude labelled codes — an old client renders "the" live code with Replace and would revoke a named seat that isn't its own.
      if (!history) {
        res.json(rows
          .filter((r) => r.expiresAt > now && r.usedCount < r.maxUses && !r.intendedLabel)
          .map(({ intendedLabel: _label, dismissedAt: _dismissed, ...legacy }) => legacy));
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
      // Clears intendedLabel on revoke — it's usually a child's name, and a dead code has no seat left to hold it.
      const [row] = await db
        .update(invites)
        .set({ revokedAt: sql`now()`, intendedLabel: null })
        .where(and(eq(invites.id, id), eq(invites.teacherId, me.id), isNull(invites.revokedAt)))
        .returning();
      if (row) {
        await userAudit(deps, req, "invite.revoke", { type: "invite", id: row.id }, { direction: row.direction });
        res.json({ ok: true });
        return;
      }
      // Already-revoked still returns ok — replace-then-mint must not dead-end on a stale screen.
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

  // Dismiss ≠ revoke — history must keep reading "Expired", and a still-live code must never be silently hidden.
  router.post(
    "/v1/invites/:id/dismiss",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const notFound = () => {
        res.status(404).json({ error: "not_found", message: "That code no longer exists." });
      };
      if (!isUuid(id)) {
        notFound();
        return;
      }
      const [owned] = await db
        .select()
        .from(invites)
        .where(and(eq(invites.id, id), eq(invites.teacherId, me.id)))
        .limit(1);
      if (!owned) {
        notFound();
        return;
      }
      if (!owned.revokedAt && owned.usedCount < owned.maxUses && owned.expiresAt > new Date()) {
        res.status(409).json({
          error: "code_still_live",
          message: "That code still works. Revoke it if you don't want it used.",
        });
        return;
      }
      if (!owned.dismissedAt) {
        await db
          .update(invites)
          .set({ dismissedAt: sql`now()`, intendedLabel: null })
          .where(and(eq(invites.id, id), isNull(invites.dismissedAt)));
      }
      res.json({ ok: true });
    }),
  );

  // Reverse redeem requires explicit acceptTeacherRole — a mis-redeem would otherwise silently grant isTeacher.
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
      // Consent never travels backwards — a code minted before the pair ended cannot re-form it.
      if (existing && existing.removedAt && invite.createdAt < existing.removedAt) {
        await fail("stale_code");
        res.status(404).json({ error: "stale_code", message: STALE_CODE_MESSAGE });
        return;
      }

      let outcomeLink: typeof teacherStudentLinks.$inferSelect;
      try {
        outcomeLink = await db.transaction(async (tx) => {
        // Claimed atomically before creating the link — two redeemers racing a single-use code must not both succeed.
        const [claimed] = await tx
          .update(invites)
          .set({
            usedCount: sql`${invites.usedCount} + 1`,
            redeemedBy: sql`${invites.redeemedBy} || ${JSON.stringify([me.id])}::jsonb`,
            intendedLabel: null,
          })
          .where(and(
            eq(invites.id, invite.id),
            sql`${invites.usedCount} < ${invites.maxUses}`,
            sql`${invites.revokedAt} IS NULL`,
            sql`${invites.expiresAt} > now()`,
          ))
          .returning();
        if (!claimed) throw new RedeemRefusal("invalid");
        // A reactivation always re-consents at now() — must never inherit the invite's original consent timestamp.
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
            // rejoinedAt exists because this UPDATE overwrites the row — createdAt alone can't describe a resumed relationship.
            set: {
              status: "active",
              consentAt: sql`now()`,
              removedAt: null,
              rejoinedAt: sql`now()`,
              // createdVia must be re-set here — it has to name the mechanism that (re)formed THIS pair, not the original one.
              createdVia: reverse ? "student_invite" : "invite_code",
              updatedAt: sql`now()`,
            },
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
          if (row?.status === "active") throw new RedeemRefusal("already");
          // Same stale refusal as the pre-check (race window) — must stay "stale", never "invalid", so it isn't charged to the lock.
          if (row?.removedAt && invite.createdAt < row.removedAt) throw new RedeemRefusal("stale");
          throw new RedeemRefusal("invalid");
        }
        if (reverse) {
          // Grow-only isTeacher grant — no trial clock; teachers are free-side and must never start a subscription countdown.
          await tx
            .update(users)
            .set({ isTeacher: true, updatedAt: sql`now()` })
            .where(and(eq(users.id, me.id), eq(users.isTeacher, false)));
        } else {
          // trialStartedAt uses coalesce — the clock starts only on the FIRST grant and must never reset on a later redeem.
          await tx
            .update(users)
            .set({
              isStudent: true,
              trialStartedAt: sql`coalesce(${users.trialStartedAt}, now())`,
              updatedAt: sql`now()`,
            })
            .where(and(eq(users.id, me.id), eq(users.isStudent, false)));
        }
        return link;
        });
      } catch (err) {
        if (!(err instanceof RedeemRefusal)) throw err;
        if (err.kind === "already") {
          alreadyLinked();
          return;
        }
        if (err.kind === "stale") {
          await fail("stale_code");
          res.status(404).json({ error: "stale_code", message: STALE_CODE_MESSAGE });
          return;
        }
        await fail("invalid_code");
        res.status(404).json({ error: "invalid_code", message: "That code is invalid or has expired — ask for a new one." });
        return;
      }
      await userAudit(deps, req, "invite.redeem", { type: "link", id: outcomeLink.id }, { inviteId: invite.id, direction: invite.direction });
      res.status(201).json(
        reverse ? { link: outcomeLink, student: counterpart } : { link: outcomeLink, teacher: counterpart },
      );
    }),
  );

  // Email is deliberately excluded from this list — detail view only (founder-gated).
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
      // INVARIANT: mapWith borrows the column's decoder — a bare sql date reaches the client as driver text and breaks ISO8601DateFormatter.
      const noteAgg = studentIds.length
        ? await db
            .select({
              studentId: notes.studentId,
              lastSentAt: sql<Date>`max(${notes.sentAt})`.mapWith(notes.sentAt),
              lastTouchAt: sql<Date>`greatest(max(${notes.readAt}), max(${noteAnnotations.doneAt}))`
                .mapWith(notes.sentAt),
              total: sql<number>`count(${noteAnnotations.id})::int`,
              done: sql<number>`count(${noteAnnotations.doneAt})::int`,
            })
            .from(notes)
            // The filter rides the JOIN, never the WHERE: in the WHERE it turns this into an inner join
            // and a sent note with no marked spots would vanish from the roster entirely.
            .leftJoin(noteAnnotations, and(eq(noteAnnotations.noteId, notes.id),
                                           eq(noteAnnotations.source, "transcript")))
            .where(and(
              eq(notes.teacherId, me.id),
              eq(notes.status, "sent"),
              inArray(notes.studentId, studentIds),
            ))
            .groupBy(notes.studentId)
        : [];
      const noteAggByStudent = new Map(noteAgg.map((r) => [r.studentId, r]));
      // DISTINCT ON requires the ordering to lead with the key (studentId) — the sent-first preference must ride second, not first.
      const latestNotes = studentIds.length
        ? await db
            .selectDistinctOn([notes.studentId], {
              studentId: notes.studentId,
              id: notes.id,
              status: notes.status,
              pieceLabel: notes.pieceLabel,
              catalogTitle: pieces.title,
              sentAt: notes.sentAt,
              readAt: notes.readAt,
              retractedAt: notes.retractedAt,
            })
            .from(notes)
            .leftJoin(pieces, eq(notes.pieceId, pieces.id))
            .where(and(
              eq(notes.teacherId, me.id),
              inArray(notes.studentId, studentIds),
              inArray(notes.status, ["sent", "retracted"]),
            ))
            .orderBy(notes.studentId, sql`(${notes.status} = 'sent') desc`, desc(notes.sentAt))
        : [];
      const latestNoteIds = latestNotes.map((n) => n.id);
      const stepAgg = latestNoteIds.length
        ? await db
            .select({
              noteId: noteAnnotations.noteId,
              total: sql<number>`count(*)::int`,
              done: sql<number>`count(${noteAnnotations.doneAt})::int`,
            })
            .from(noteAnnotations)
            // Practice-plan rows live in this table too and never reach a client, so counting them
            // makes "all N practiced" unreachable and disagrees with the student's own screen.
            .where(and(inArray(noteAnnotations.noteId, latestNoteIds),
                       eq(noteAnnotations.source, "transcript")))
            .groupBy(noteAnnotations.noteId)
        : [];
      const stepsByNote = new Map(stepAgg.map((r) => [r.noteId, r]));
      const latestByStudent = new Map(latestNotes.map((n) => [n.studentId, n]));
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
      // canReceiveNotes must stay a capability boolean — the teacher must never see the student's billing/payment state.
      const accessByStudent = await notesAccessMany(
        deps,
        studentRows.filter((u) => u.status !== "deleted"),
      );
      const items = links.map((l) => {
        const student = studentRows.find((u) => u.id === l.studentId);
        const agg = noteAggByStudent.get(l.studentId);
        const latest = latestByStudent.get(l.studentId);
        const steps = latest ? stepsByNote.get(latest.id) : undefined;
        const access = student && student.status !== "deleted"
          ? accessByStudent.get(student.id) ?? null
          : null;
        const lastLessonAt = lessonByStudent.get(l.studentId) ?? null;
        // rejoinedAt must be in this set — a resumed relationship needs to sort as fresh activity, not by its original createdAt.
        const lastActivityAt = [
          agg?.lastSentAt ?? null,
          agg?.lastTouchAt ?? null,
          lastLessonAt,
          l.rejoinedAt ?? l.createdAt,
        ]
          .filter((d): d is Date => d instanceof Date)
          .reduce<Date | null>((a, b) => (a && a > b ? a : b), null);
        return {
          linkId: l.id,
          studentId: l.studentId,
          displayName: student?.displayName ?? null,
          linkedAt: l.rejoinedAt ?? l.createdAt,
          consentAt: l.consentAt,
          status: l.status,
          removedAt: l.removedAt,
          counterpartDeleted: student?.status === "deleted",
          lastNoteAt: agg?.lastSentAt ?? null,
          lastLessonAt,
          lastActivityAt,
          // Piece title resolved here — a catalog note's pieceLabel is null, so the pieces join (catalogTitle) is the only way to name it.
          latestNote: latest
            ? {
                id: latest.id,
                status: latest.status,
                pieceTitle: latest.pieceLabel ?? latest.catalogTitle ?? null,
                sentAt: latest.sentAt,
                readAt: latest.readAt,
                retractedAt: latest.retractedAt,
                stepCount: steps?.total ?? 0,
                doneCount: steps?.done ?? 0,
              }
            : null,
          practicedTotal: agg?.total ?? 0,
          practicedDone: agg?.done ?? 0,
          canReceiveNotes: access ? access.status !== "lapsed" : false,
        };
      });
      res.json({ items });
    }),
  );

  // Email surfaces only while the link is active — a departed student withdraws their address, even on this founder-gated detail view.
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
          catalogTitle: pieces.title,
          sentAt: notes.sentAt,
          readAt: notes.readAt,
          retractedAt: notes.retractedAt,
          supersededBy: notes.supersededBy,
        })
        .from(notes)
        .leftJoin(pieces, eq(notes.pieceId, pieces.id))
        .where(and(
          eq(notes.teacherId, me.id),
          eq(notes.studentId, link.studentId),
          inArray(notes.status, ["sent", "retracted"]),
        ))
        .orderBy(desc(notes.sentAt));
      const timelineIds = timeline.map((n) => n.id);
      const steps = timelineIds.length
        ? await db
            .select({
              noteId: noteAnnotations.noteId,
              total: sql<number>`count(*)::int`,
              done: sql<number>`count(${noteAnnotations.doneAt})::int`,
            })
            .from(noteAnnotations)
            .where(and(inArray(noteAnnotations.noteId, timelineIds),
                       eq(noteAnnotations.source, "transcript")))
            .groupBy(noteAnnotations.noteId)
        : [];
      const stepsByNote = new Map(steps.map((r) => [r.noteId, r]));
      // startedAt ships RAW (possibly null) though ordering falls back to coalesce(startedAt, created_at) — never coalesce the displayed value.
      const lessons = await db
        .select({
          id: lessonSessions.id,
          startedAt: lessonSessions.startedAt,
          durationSec: lessonSessions.durationSec,
          pieceLabel: lessonSessions.pieceLabel,
          catalogTitle: pieces.title,
        })
        .from(lessonSessions)
        .leftJoin(pieces, eq(lessonSessions.pieceId, pieces.id))
        .where(and(
          eq(lessonSessions.teacherId, me.id),
          eq(lessonSessions.studentId, link.studentId),
          sql`${lessonSessions.status} <> 'canceled'`,
        ))
        .orderBy(desc(sql`coalesce(${lessonSessions.startedAt}, ${lessonSessions.createdAt})`));
      const access = counterpartDeleted ? null : await notesAccess(deps, student!);
      res.json({
        linkId: link.id,
        studentId: student!.id,
        displayName: student!.displayName,
        email: counterpartDeleted || link.status === "removed" ? null : student!.email,
        // firstLinkedAt is null unless this is a resumed relationship (rejoinedAt set) — its presence alone signals an earlier spell.
        linkedAt: link.rejoinedAt ?? link.createdAt,
        firstLinkedAt: link.rejoinedAt ? link.createdAt : null,
        consentAt: link.consentAt,
        createdVia: link.createdVia,
        status: link.status,
        removedAt: link.removedAt,
        counterpartDeleted,
        canReceiveNotes: access ? access.status !== "lapsed" : false,
        notes: timeline.map((n) => {
          const s = stepsByNote.get(n.id);
          return {
            id: n.id,
            status: n.status,
            pieceId: n.pieceId,
            pieceLabel: n.pieceLabel,
            pieceTitle: n.pieceLabel ?? n.catalogTitle ?? null,
            sentAt: n.sentAt,
            readAt: n.readAt,
            retractedAt: n.retractedAt,
            supersededBy: n.supersededBy,
            stepCount: s?.total ?? 0,
            doneCount: s?.done ?? 0,
          };
        }),
        lessons: lessons.map((l) => ({
          id: l.id,
          startedAt: l.startedAt,
          durationSec: l.durationSec,
          pieceTitle: l.pieceLabel ?? l.catalogTitle ?? null,
        })),
      });
    }),
  );

  // Ending a link does not touch notes — they stay with the student as their own record.
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

  // No organization/email here — the sign-up copy promises "Not shown publicly" (founder-gated).
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

// Revokes only the remover's own codes already redeemed by THIS counterpart — a live code held for someone else must survive.
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
      .set({ revokedAt: sql`now()`, intendedLabel: null })
      .where(and(
        eq(invites.teacherId, removerId),
        eq(invites.direction, direction),
        isNull(invites.revokedAt),
        sql`${invites.redeemedBy} @> ${JSON.stringify([counterpartId])}::jsonb`,
      ));
    return row;
  });
}
