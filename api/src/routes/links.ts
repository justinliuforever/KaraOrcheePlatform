import { Router } from "express";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { notesAccess } from "../notes/entitlement";
import { invites, lessonSessions, noteAnnotations, notes, teacherStudentLinks, users } from "../db/schema";

// No ambiguous chars (Crockford base32 minus vowel-lookalikes) — codes get read
// aloud across a piano.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;
const INVITE_DAYS = 7;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i]! % 32];
  return out;
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
        res.status(403).json({ error: "notes_role_required" });
        return;
      }
      const db = deps.db!.orm;
      // Direction follows the acting role (teacher wins for dual-role). A reverse
      // code is the solo student inviting THEIR teacher: the student's recording
      // consent is captured here at mint (createdAt = consent timestamp) because
      // the redeemer is the teacher, who only acknowledges.
      const direction = me.isTeacher ? "teacher_to_student" : "student_to_teacher";
      if (direction === "student_to_teacher" && req.body?.consent !== true) {
        res.status(400).json({ error: "consent_required", message: "Please accept the recording notice to invite your teacher." });
        return;
      }
      const sentToEmail =
        typeof req.body?.email === "string" && req.body.email.includes("@")
          ? (req.body.email as string).trim().toLowerCase()
          : null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = generateCode();
        try {
          const [row] = await db
            .insert(invites)
            .values({
              code,
              teacherId: me.id,
              direction,
              expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
              sentToEmail,
            })
            .returning();
          await userAudit(deps, req, "invite.create", { type: "invite", id: row!.id }, { direction });
          res.status(201).json(row);
          return;
        } catch (err) {
          if (attempt === 2) throw err; // code collision twice in a row ≈ impossible
        }
      }
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
      const [row] = await db
        .update(invites)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(invites.id, String(req.params.id)), eq(invites.teacherId, me.id)))
        .returning();
      if (!row) {
        res.status(404).json({ error: "not_found" });
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
      const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
      if (!code) {
        res.status(400).json({ error: "code_required" });
        return;
      }
      const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
      if (!invite || invite.revokedAt || invite.expiresAt < new Date() || invite.usedCount >= invite.maxUses) {
        res.status(404).json({ error: "invalid_code", message: "That code is invalid or has expired — ask for a new one." });
        return;
      }
      if (invite.teacherId === me.id) {
        res.status(400).json({ error: "own_code" });
        return;
      }
      const reverse = invite.direction === "student_to_teacher";
      if (reverse) {
        if (req.body?.acceptTeacherRole !== true) {
          res.status(400).json({ error: "teacher_confirm_required", message: "Confirm you are this student's teacher to accept the invite." });
          return;
        }
      } else if (req.body?.consent !== true) {
        res.status(400).json({ error: "consent_required", message: "Please accept the recording notice to link with your teacher." });
        return;
      }

      // The link pair, keyed by who ends up on which side of it.
      const linkTeacherId = reverse ? me.id : invite.teacherId;
      const linkStudentId = reverse ? invite.teacherId : me.id;
      const [existing] = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(eq(teacherStudentLinks.teacherId, linkTeacherId), eq(teacherStudentLinks.studentId, linkStudentId)))
        .limit(1);
      if (existing && existing.status === "active") {
        res.status(409).json({ error: "already_linked" });
        return;
      }
      // Claim a use-count slot atomically BEFORE creating the link — two redeemers
      // racing a single-use code must not both succeed.
      const [claimed] = await db
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
      if (!claimed) {
        res.status(404).json({ error: "invalid_code", message: "That code is invalid or has expired — ask for a new one." });
        return;
      }
      // Reverse consent lives at mint: the invite's createdAt is the student's
      // recorded consent timestamp, carried onto the link verbatim.
      const consentAt = reverse ? invite.createdAt : sql`now()`;
      let link;
      if (existing) {
        [link] = await db
          .update(teacherStudentLinks)
          .set({ status: "active", consentAt, removedAt: null, updatedAt: sql`now()` })
          .where(eq(teacherStudentLinks.id, existing.id))
          .returning();
      } else {
        [link] = await db
          .insert(teacherStudentLinks)
          .values({
            teacherId: linkTeacherId,
            studentId: linkStudentId,
            createdVia: reverse ? "student_invite" : invite.sentToEmail ? "email_invite" : "invite_code",
            consentAt,
          })
          .returning();
      }
      if (reverse) {
        // Accepting makes you a teacher (grow-only). NO trial clock: teachers are
        // free-side and must never start a subscription countdown by accepting.
        if (!me.isTeacher) {
          await db
            .update(users)
            .set({ isTeacher: true, updatedAt: sql`now()` })
            .where(eq(users.id, me.id));
        }
      } else if (!me.isStudent) {
        // Redeeming makes you a student; the trial clock starts at first student grant.
        await db
          .update(users)
          .set({
            isStudent: true,
            trialStartedAt: me.trialStartedAt ?? sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(users.id, me.id));
      }
      const [issuer] = await db.select().from(users).where(eq(users.id, invite.teacherId)).limit(1);
      await userAudit(deps, req, "invite.redeem", { type: "link", id: link!.id }, { inviteId: invite.id, direction: invite.direction });
      res.status(201).json(
        reverse
          ? { link, student: { id: issuer!.id, displayName: issuer!.displayName } }
          : { link, teacher: { id: issuer!.id, displayName: issuer!.displayName } },
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
        res.status(403).json({ error: "teacher_only" });
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
      const lastNotes = studentIds.length
        ? await db
            .select({
              studentId: notes.studentId,
              lastSentAt: sql<string>`max(${notes.sentAt})`,
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
              lastAt: sql<string>`max(coalesce(${lessonSessions.startedAt}, ${lessonSessions.createdAt}))`,
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
  // again lives here). Email surfaces ONLY on this detail view (founder-gated).
  router.get(
    "/v1/me/students/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [link] = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(
          eq(teacherStudentLinks.teacherId, me.id),
          eq(teacherStudentLinks.studentId, String(req.params.id)),
        ))
        .limit(1);
      if (!link) {
        res.status(404).json({ error: "not_found" });
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
        email: counterpartDeleted ? null : student!.email,
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
  router.delete(
    "/v1/me/students/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [row] = await db
        .update(teacherStudentLinks)
        .set({ status: "removed", removedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(
          eq(teacherStudentLinks.teacherId, me.id),
          eq(teacherStudentLinks.studentId, String(req.params.id)),
          eq(teacherStudentLinks.status, "active"),
        ))
        .returning();
      if (!row) {
        res.status(404).json({ error: "not_found" });
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
              lastAt: sql<string>`max(${notes.sentAt})`,
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
      const db = deps.db!.orm;
      const [row] = await db
        .update(teacherStudentLinks)
        .set({ status: "removed", removedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(
          eq(teacherStudentLinks.studentId, me.id),
          eq(teacherStudentLinks.teacherId, String(req.params.id)),
          eq(teacherStudentLinks.status, "active"),
        ))
        .returning();
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await userAudit(deps, req, "link.remove", { type: "link", id: row.id }, { by: "student" });
      res.json({ ok: true });
    }),
  );

  return router;
}
