import { Router } from "express";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { notesAccess } from "../notes/entitlement";
import { invites, notes, teacherStudentLinks, users } from "../db/schema";

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
      if (!me.isTeacher) {
        res.status(403).json({ error: "teacher_only" });
        return;
      }
      const db = deps.db!.orm;
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
              expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
              sentToEmail,
            })
            .returning();
          await userAudit(deps, req, "invite.create", { type: "invite", id: row!.id });
          res.status(201).json(row);
          return;
        } catch (err) {
          if (attempt === 2) throw err; // code collision twice in a row ≈ impossible
        }
      }
    }),
  );

  router.get(
    "/v1/invites",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const rows = await db
        .select()
        .from(invites)
        .where(and(eq(invites.teacherId, me.id), sql`${invites.revokedAt} IS NULL`))
        .orderBy(desc(invites.createdAt));
      const now = new Date();
      res.json(rows.filter((r) => r.expiresAt > now && r.usedCount < r.maxUses));
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

  // Redeeming IS the acceptance: the confirmation card in the app shows the
  // teacher's name plus the recording-consent checkbox before this fires.
  router.post(
    "/v1/invites/redeem",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
      const consent = req.body?.consent === true;
      if (!code) {
        res.status(400).json({ error: "code_required" });
        return;
      }
      if (!consent) {
        res.status(400).json({ error: "consent_required", message: "Please accept the recording notice to link with your teacher." });
        return;
      }
      const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
      if (!invite || invite.revokedAt || invite.expiresAt < new Date() || invite.usedCount >= invite.maxUses) {
        res.status(404).json({ error: "invalid_code", message: "That code is invalid or has expired — ask your teacher for a new one." });
        return;
      }
      if (invite.teacherId === me.id) {
        res.status(400).json({ error: "own_code" });
        return;
      }

      const [existing] = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(eq(teacherStudentLinks.teacherId, invite.teacherId), eq(teacherStudentLinks.studentId, me.id)))
        .limit(1);
      if (existing && existing.status === "active") {
        res.status(409).json({ error: "already_linked" });
        return;
      }
      // Claim a use-count slot atomically BEFORE creating the link — two students
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
        res.status(404).json({ error: "invalid_code", message: "That code is invalid or has expired — ask your teacher for a new one." });
        return;
      }
      let link;
      if (existing) {
        [link] = await db
          .update(teacherStudentLinks)
          .set({ status: "active", consentAt: sql`now()`, removedAt: null, updatedAt: sql`now()` })
          .where(eq(teacherStudentLinks.id, existing.id))
          .returning();
      } else {
        [link] = await db
          .insert(teacherStudentLinks)
          .values({
            teacherId: invite.teacherId,
            studentId: me.id,
            createdVia: invite.sentToEmail ? "email_invite" : "invite_code",
            consentAt: sql`now()`,
          })
          .returning();
      }
      // Redeeming makes you a student; the trial clock starts at first student grant.
      if (!me.isStudent) {
        await db
          .update(users)
          .set({
            isStudent: true,
            trialStartedAt: me.trialStartedAt ?? sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(users.id, me.id));
      }
      const [teacher] = await db.select().from(users).where(eq(users.id, invite.teacherId)).limit(1);
      await userAudit(deps, req, "invite.redeem", { type: "link", id: link!.id }, { inviteId: invite.id });
      res.status(201).json({
        link,
        teacher: { id: teacher!.id, displayName: teacher!.displayName },
      });
    }),
  );

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
      const links = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(eq(teacherStudentLinks.teacherId, me.id), eq(teacherStudentLinks.status, "active")))
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
      const items = await Promise.all(
        links.map(async (l) => {
          const student = studentRows.find((u) => u.id === l.studentId);
          // Delivery capability, deliberately NOT billing wording — the teacher
          // never sees a family's payment state.
          const access = student ? await notesAccess(deps, student) : null;
          return {
            linkId: l.id,
            studentId: l.studentId,
            displayName: student?.displayName ?? null,
            linkedAt: l.createdAt,
            lastNoteAt: lastByStudent.get(l.studentId) ?? null,
            canReceiveNotes: access ? access.status !== "lapsed" : false,
          };
        }),
      );
      res.json({ items });
    }),
  );

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
          eq(teacherStudentLinks.status, "active"),
        ))
        .limit(1);
      if (!link) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [student] = await db.select().from(users).where(eq(users.id, link.studentId)).limit(1);
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
      const access = await notesAccess(deps, student!);
      res.json({
        linkId: link.id,
        studentId: student!.id,
        displayName: student!.displayName,
        linkedAt: link.createdAt,
        canReceiveNotes: access.status !== "lapsed",
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

  router.get(
    "/v1/me/teachers",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const links = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(eq(teacherStudentLinks.studentId, me.id), eq(teacherStudentLinks.status, "active")))
        .orderBy(desc(teacherStudentLinks.createdAt));
      const teacherIds = links.map((l) => l.teacherId);
      const teacherRows = teacherIds.length
        ? await db.select().from(users).where(inArray(users.id, teacherIds))
        : [];
      res.json({
        items: links.map((l) => ({
          linkId: l.id,
          teacherId: l.teacherId,
          displayName: teacherRows.find((u) => u.id === l.teacherId)?.displayName ?? null,
          linkedAt: l.createdAt,
        })),
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
