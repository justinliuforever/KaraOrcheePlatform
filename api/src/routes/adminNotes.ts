import { Router } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireAdmin, audit } from "../admin";
import { notesAccess } from "../notes/entitlement";
import { DEFAULT_RETRY_CAP, RETRY_CAPS, retryDecision } from "./lessons";
import {
  entitlements,
  invites,
  lessonSessions,
  noteJobs,
  notes,
  platformConfig,
  scoreScans,
  teacherStudentLinks,
  users,
} from "../db/schema";
import { scanPurgePrefixes, takeDownScan } from "../notes/scan_delete";
import { purgeRunner } from "../notes/purge";

const MONETIZATION_KEY = "monetization_live_at";
const ENTITLEMENT_SOURCES = ["trial", "apple_iap", "admin_grant", "org"];
const ENTITLEMENT_STATUSES = ["active", "grace", "expired", "revoked"];
const NOTE_JOB_STATUSES = ["queued", "processing", "failed", "ready_for_review"];
const NOTE_JOB_STAGES = ["asr", "llm", "gates"];
const OWNER_ROLES = ["teacher", "student"];
// Written by the worker (and by the discard path for lesson_discarded). NULL =
// never failed, or a pre-0016 row; the facet omits it rather than counting every
// healthy job as "unknown".
const FAILURE_CODES = [
  "no_speech",
  "thin_note",
  "asr_error",
  "llm_invalid",
  "worker_crash",
  "no_audio",
  "lesson_discarded",
];

// Server-derived invite lifecycle. An invite can be several of these at once;
// precedence is revoked > exhausted > expired > active (most-terminal wins).
function inviteState(inv: {
  revokedAt: Date | null;
  expiresAt: Date;
  maxUses: number;
  usedCount: number;
}): "active" | "expired" | "exhausted" | "revoked" {
  if (inv.revokedAt) return "revoked";
  if (inv.usedCount >= inv.maxUses) return "exhausted";
  if (inv.expiresAt.getTime() < Date.now()) return "expired";
  return "active";
}

export function adminNotesRouter(deps: Deps): Router {
  const router = Router();
  router.use("/admin", requireAuth(deps.auth), requireAdmin(deps));

  const like = (col: Parameters<typeof ilike>[0], q: string) => ilike(col, `%${q}%`);

  // ── Pairings ──────────────────────────────────────────────────────────────────

  const teacherU = alias(users, "teacher_u");
  const studentU = alias(users, "student_u");

  router.get(
    "/admin/notes/links",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const status = typeof req.query.status === "string" ? req.query.status : "";
      const conds = [];
      if (status === "active" || status === "removed") conds.push(eq(teacherStudentLinks.status, status));
      if (q) {
        conds.push(
          or(
            like(teacherU.email, q),
            like(teacherU.displayName, q),
            like(studentU.email, q),
            like(studentU.displayName, q),
          ),
        );
      }
      const items = await db
        .select({
          id: teacherStudentLinks.id,
          teacherId: teacherStudentLinks.teacherId,
          studentId: teacherStudentLinks.studentId,
          status: teacherStudentLinks.status,
          createdVia: teacherStudentLinks.createdVia,
          consentAt: teacherStudentLinks.consentAt,
          removedAt: teacherStudentLinks.removedAt,
          createdAt: teacherStudentLinks.createdAt,
          teacherEmail: teacherU.email,
          teacherName: teacherU.displayName,
          studentEmail: studentU.email,
          studentName: studentU.displayName,
        })
        .from(teacherStudentLinks)
        .leftJoin(teacherU, eq(teacherStudentLinks.teacherId, teacherU.id))
        .leftJoin(studentU, eq(teacherStudentLinks.studentId, studentU.id))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(teacherStudentLinks.createdAt))
        .limit(500);
      res.json({ items });
    }),
  );

  // Force-create a pairing outside the invite flow (support / school onboarding).
  // Upsert on the unique (teacher, student) pair: a removed row flips back to active.
  router.post(
    "/admin/notes/links",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const teacherId = typeof req.body?.teacherId === "string" ? req.body.teacherId : "";
      const studentId = typeof req.body?.studentId === "string" ? req.body.studentId : "";
      if (!teacherId || !studentId) {
        res.status(400).json({ error: "ids_required", message: "teacherId and studentId are required." });
        return;
      }
      if (teacherId === studentId) {
        res.status(400).json({ error: "same_user", message: "A user cannot be their own teacher." });
        return;
      }
      const [teacher] = await db.select().from(users).where(eq(users.id, teacherId)).limit(1);
      const [studentRow] = await db.select().from(users).where(eq(users.id, studentId)).limit(1);
      if (!teacher || !studentRow) {
        res.status(400).json({ error: "unknown_user", message: "Both users must exist." });
        return;
      }
      // Grow-only capability grant, exactly like invite redeem: never revoked here.
      if (!teacher.isTeacher) {
        await db.update(users).set({ isTeacher: true, updatedAt: sql`now()` }).where(eq(users.id, teacherId));
      }
      if (!studentRow.isStudent) {
        await db.update(users).set({ isStudent: true, updatedAt: sql`now()` }).where(eq(users.id, studentId));
      }
      // consentAt here is an ADMIN ATTESTATION of the pairing, NOT the family's
      // in-app recording consent — legally revisitable (founder decision #1).
      const [existing] = await db
        .select()
        .from(teacherStudentLinks)
        .where(and(eq(teacherStudentLinks.teacherId, teacherId), eq(teacherStudentLinks.studentId, studentId)))
        .limit(1);
      let link;
      if (existing) {
        [link] = await db
          .update(teacherStudentLinks)
          .set({
            status: "active",
            createdVia: "admin",
            consentAt: sql`now()`,
            removedAt: null,
            // Only when a pair is genuinely re-forming: re-attesting an ACTIVE link
            // must not restate today as the day the relationship began.
            ...(existing.status === "removed" ? { rejoinedAt: sql`now()` } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(teacherStudentLinks.id, existing.id))
          .returning();
      } else {
        [link] = await db
          .insert(teacherStudentLinks)
          .values({ teacherId, studentId, status: "active", createdVia: "admin", consentAt: sql`now()` })
          .returning();
      }
      await audit(deps, req, "link.admin_create", { type: "link", id: link!.id }, {
        teacherId,
        studentId,
        reactivated: Boolean(existing),
      });
      res.status(existing ? 200 : 201).json({ link: link! });
    }),
  );

  router.delete(
    "/admin/notes/links/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [row] = await db
        .update(teacherStudentLinks)
        .set({ status: "removed", removedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(teacherStudentLinks.id, id))
        .returning();
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await audit(deps, req, "link.admin_remove", { type: "link", id });
      res.json({ ok: true, link: row });
    }),
  );

  // ── Invites ───────────────────────────────────────────────────────────────────

  router.get(
    "/admin/notes/invites",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const stateFilter = typeof req.query.state === "string" ? req.query.state : "";
      const rows = await db
        .select({
          id: invites.id,
          code: invites.code,
          teacherId: invites.teacherId,
          expiresAt: invites.expiresAt,
          maxUses: invites.maxUses,
          usedCount: invites.usedCount,
          sentToEmail: invites.sentToEmail,
          direction: invites.direction,
          revokedAt: invites.revokedAt,
          createdAt: invites.createdAt,
          teacherEmail: users.email,
          teacherName: users.displayName,
        })
        .from(invites)
        .leftJoin(users, eq(invites.teacherId, users.id))
        .where(q ? or(like(users.email, q), like(users.displayName, q)) : undefined)
        .orderBy(desc(invites.createdAt))
        .limit(500);
      let items = rows.map((r) => ({ ...r, state: inviteState(r) }));
      if (["active", "expired", "exhausted", "revoked"].includes(stateFilter)) {
        items = items.filter((r) => r.state === stateFilter);
      }
      res.json({ items });
    }),
  );

  router.post(
    "/admin/notes/invites/:id/revoke",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [inv] = await db.select().from(invites).where(eq(invites.id, id)).limit(1);
      if (!inv) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // The label is usually a child's first name. It dies with the code here exactly
      // as it does on the teacher's own revoke, and never reaches the admin console.
      const [row] = await db
        .update(invites)
        .set({ revokedAt: sql`coalesce(${invites.revokedAt}, now())`, intendedLabel: null })
        .where(eq(invites.id, id))
        .returning();
      await audit(deps, req, "invite.admin_revoke", { type: "invite", id });
      res.json({ ok: true, invite: row! });
    }),
  );

  // ── Subscriptions / config ──────────────────────────────────────────────────────

  router.get(
    "/admin/notes/entitlements",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const source = typeof req.query.source === "string" ? req.query.source : "";
      const status = typeof req.query.status === "string" ? req.query.status : "";
      const conds = [];
      if (ENTITLEMENT_SOURCES.includes(source)) conds.push(eq(entitlements.source, source));
      if (ENTITLEMENT_STATUSES.includes(status)) conds.push(eq(entitlements.status, status));
      if (q) conds.push(or(like(users.email, q), like(users.displayName, q)));
      const items = await db
        .select({
          id: entitlements.id,
          userId: entitlements.userId,
          source: entitlements.source,
          status: entitlements.status,
          startsAt: entitlements.startsAt,
          expiresAt: entitlements.expiresAt,
          productId: entitlements.productId,
          // Read-only: the App Store receipt key, never mintable from here.
          appleOriginalTransactionId: entitlements.appleOriginalTransactionId,
          environment: entitlements.environment,
          autoRenew: entitlements.autoRenew,
          orgId: entitlements.orgId,
          // Grant reason lives in the note column; grantor identity is in the audit trail.
          reason: entitlements.note,
          createdAt: entitlements.createdAt,
          updatedAt: entitlements.updatedAt,
          userEmail: users.email,
          userName: users.displayName,
        })
        .from(entitlements)
        .leftJoin(users, eq(entitlements.userId, users.id))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(entitlements.createdAt))
        .limit(500);
      res.json({ items });
    }),
  );

  router.post(
    "/admin/notes/entitlements/grant",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (reason.length < 10) {
        res.status(400).json({ error: "reason_required", message: "A grant reason of at least 10 characters is required." });
        return;
      }
      const userId = typeof req.body?.userId === "string" ? req.body.userId : "";
      const days = Number(req.body?.days);
      if (!userId || !Number.isInteger(days) || days < 1 || days > 3650) {
        res.status(400).json({ error: "invalid_grant", message: "userId and a whole day count (1..3650) are required." });
        return;
      }
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) {
        res.status(400).json({ error: "unknown_user" });
        return;
      }
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const [row] = await db
        .insert(entitlements)
        .values({ userId, source: "admin_grant", status: "active", startsAt: sql`now()`, expiresAt, note: reason })
        .returning();
      await audit(deps, req, "entitlement.grant", { type: "entitlement", id: row!.id }, { userId, days });
      res.status(201).json(row!);
    }),
  );

  router.post(
    "/admin/notes/entitlements/:id/revoke",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (reason.length < 10) {
        res.status(400).json({ error: "reason_required", message: "A revoke reason of at least 10 characters is required." });
        return;
      }
      const [ent] = await db.select().from(entitlements).where(eq(entitlements.id, id)).limit(1);
      if (!ent) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Leave the grant reason in `note` intact; the revoke reason lives in the audit trail.
      const [row] = await db
        .update(entitlements)
        .set({ status: "revoked", updatedAt: sql`now()` })
        .where(eq(entitlements.id, id))
        .returning();
      await audit(deps, req, "entitlement.revoke", { type: "entitlement", id }, { reason, userId: ent.userId });
      res.json(row!);
    }),
  );

  // state describes the config, not the wall clock: a date is set ("paid_after") or
  // not ("beta_free"). The UI reasons about past-vs-future from `value` itself.
  function monetizationState(value: string | null): "beta_free" | "paid_after" {
    return value ? "paid_after" : "beta_free";
  }

  router.get(
    "/admin/notes/config/monetization",
    wrap(async (_req, res) => {
      const db = deps.db!.orm;
      const [row] = await db
        .select()
        .from(platformConfig)
        .where(eq(platformConfig.key, MONETIZATION_KEY))
        .limit(1);
      const value = typeof row?.value === "string" ? row.value : null;
      res.json({ value, state: monetizationState(value) });
    }),
  );

  // The dangerous global flip. Reversible to null (clears the row → everyone back to
  // beta_free). The UI gates it behind a hard confirm; the endpoint just audits from→to.
  router.put(
    "/admin/notes/config/monetization",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const raw = req.body?.value;
      let to: string | null;
      if (raw === null) {
        to = null;
      } else if (typeof raw === "string" && !Number.isNaN(new Date(raw).getTime())) {
        to = new Date(raw).toISOString();
      } else {
        res.status(400).json({ error: "invalid_value", message: "value must be an ISO-8601 timestamp or null." });
        return;
      }
      const [existing] = await db
        .select()
        .from(platformConfig)
        .where(eq(platformConfig.key, MONETIZATION_KEY))
        .limit(1);
      const from = typeof existing?.value === "string" ? existing.value : null;
      if (to === null) {
        await db.delete(platformConfig).where(eq(platformConfig.key, MONETIZATION_KEY));
      } else {
        await db
          .insert(platformConfig)
          .values({ key: MONETIZATION_KEY, value: to })
          .onConflictDoUpdate({ target: platformConfig.key, set: { value: to, updatedAt: sql`now()` } });
      }
      await audit(deps, req, "config.monetization.set", { type: "config", id: MONETIZATION_KEY }, { from, to });
      res.json({ value: to, state: monetizationState(to) });
    }),
  );

  // ── Notes-jobs monitoring ─────────────────────────────────────────────────────

  router.get(
    "/admin/note-jobs",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const status = typeof req.query.status === "string" ? req.query.status : "";
      const stage = typeof req.query.stage === "string" ? req.query.stage : "";
      const ownerRole = typeof req.query.ownerRole === "string" ? req.query.ownerRole : "";
      const conds = [];
      // Each facet reflects every filter EXCEPT its own, so switching within a facet
      // stays meaningful (the count shows how many are in each value under the others).
      const sharedConds = [];
      if (NOTE_JOB_STAGES.includes(stage)) {
        const c = eq(noteJobs.stage, stage);
        conds.push(c);
        sharedConds.push(c);
      }
      if (q) {
        const c = or(
          like(users.email, q),
          like(users.displayName, q),
          sql`${noteJobs.id}::text ILIKE ${`%${q}%`}`,
        );
        conds.push(c);
        sharedConds.push(c);
      }
      const failureCode = typeof req.query.failureCode === "string" ? req.query.failureCode : "";
      const statusCond = NOTE_JOB_STATUSES.includes(status) ? eq(noteJobs.status, status) : null;
      const ownerRoleCond = OWNER_ROLES.includes(ownerRole) ? eq(lessonSessions.ownerRole, ownerRole) : null;
      const failureCodeCond = FAILURE_CODES.includes(failureCode) ? eq(noteJobs.failureCode, failureCode) : null;
      if (statusCond) conds.push(statusCond);
      if (ownerRoleCond) conds.push(ownerRoleCond);
      if (failureCodeCond) conds.push(failureCodeCond);
      const statusFacetConds = [...sharedConds, ownerRoleCond, failureCodeCond].filter((c) => c !== null);
      const ownerRoleFacetConds = [...sharedConds, statusCond, failureCodeCond].filter((c) => c !== null);
      const failureCodeFacetConds = [...sharedConds, statusCond, ownerRoleCond].filter((c) => c !== null);
      const rows = await db
        .select({
          id: noteJobs.id,
          status: noteJobs.status,
          stage: noteJobs.stage,
          attempts: noteJobs.attempts,
          error: noteJobs.error,
          failureCode: noteJobs.failureCode,
          failureHints: noteJobs.failureHints,
          metrics: noteJobs.metrics,
          transcriptPath: noteJobs.transcriptPath,
          modelOutputPath: noteJobs.modelOutputPath,
          discardedAt: noteJobs.discardedAt,
          startedAt: noteJobs.startedAt,
          createdAt: noteJobs.createdAt,
          updatedAt: noteJobs.updatedAt,
          lessonSessionId: noteJobs.lessonSessionId,
          teacherId: lessonSessions.teacherId,
          ownerRole: lessonSessions.ownerRole,
          lessonStatus: lessonSessions.status,
          pieceId: lessonSessions.pieceId,
          pieceLabel: lessonSessions.pieceLabel,
          // teacherEmail/teacherName kept for compat; ownerEmail/ownerName are the
          // recorder-identity aliases (lesson.teacherId = owner, solo included).
          teacherEmail: users.email,
          teacherName: users.displayName,
          ownerEmail: users.email,
          ownerName: users.displayName,
        })
        .from(noteJobs)
        .leftJoin(lessonSessions, eq(noteJobs.lessonSessionId, lessonSessions.id))
        .leftJoin(users, eq(lessonSessions.teacherId, users.id))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(noteJobs.createdAt))
        .limit(200);
      // reqId is not a column — surface it if the worker stamped it into metrics.
      const items = rows.map((r) => ({
        ...r,
        reqId: (r.metrics as { reqId?: string } | null)?.reqId ?? null,
      }));
      const statusCounts = await db
        .select({ status: noteJobs.status, count: sql<number>`count(*)::int` })
        .from(noteJobs)
        .leftJoin(lessonSessions, eq(noteJobs.lessonSessionId, lessonSessions.id))
        .leftJoin(users, eq(lessonSessions.teacherId, users.id))
        .where(statusFacetConds.length ? and(...statusFacetConds) : undefined)
        .groupBy(noteJobs.status);
      const ownerRoleCounts = await db
        .select({ ownerRole: lessonSessions.ownerRole, count: sql<number>`count(*)::int` })
        .from(noteJobs)
        .leftJoin(lessonSessions, eq(noteJobs.lessonSessionId, lessonSessions.id))
        .leftJoin(users, eq(lessonSessions.teacherId, users.id))
        .where(ownerRoleFacetConds.length ? and(...ownerRoleFacetConds) : undefined)
        .groupBy(lessonSessions.ownerRole);
      // Turns "processing sometimes fails" into a number per cause.
      const failureCodeCounts = await db
        .select({ failureCode: noteJobs.failureCode, count: sql<number>`count(*)::int` })
        .from(noteJobs)
        .leftJoin(lessonSessions, eq(noteJobs.lessonSessionId, lessonSessions.id))
        .leftJoin(users, eq(lessonSessions.teacherId, users.id))
        .where(failureCodeFacetConds.length ? and(...failureCodeFacetConds) : undefined)
        .groupBy(noteJobs.failureCode);
      res.json({
        items,
        facets: {
          status: statusCounts.map((c) => ({ value: c.status, count: c.count })),
          ownerRole: ownerRoleCounts
            .filter((c): c is { ownerRole: string; count: number } => c.ownerRole !== null)
            .map((c) => ({ value: c.ownerRole, count: c.count })),
          failureCode: failureCodeCounts
            .filter((c): c is { failureCode: string; count: number } => c.failureCode !== null)
            .map((c) => ({ value: c.failureCode, count: c.count })),
        },
      });
    }),
  );

  router.get(
    "/admin/note-jobs/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [job] = await db.select().from(noteJobs).where(eq(noteJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [lesson] = await db
        .select()
        .from(lessonSessions)
        .where(eq(lessonSessions.id, job.lessonSessionId))
        .limit(1);
      const [teacher] = lesson
        ? await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, lesson.teacherId)).limit(1)
        : [];
      const [studentRow] = lesson?.studentId
        ? await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, lesson.studentId)).limit(1)
        : [];
      // Note ids only — NO transcript body here (that is the audited break-glass route).
      const producedNotes = await db
        .select({ id: notes.id, status: notes.status, studentId: notes.studentId })
        .from(notes)
        .where(eq(notes.noteJobId, job.id));
      // The OWNER's retry, not this console's: admin requeue is deliberately uncapped.
      const retry = lesson
        ? retryDecision({ lessonStatus: lesson.status, pieceUpdatedAt: lesson.pieceUpdatedAt, job })
        : { kind: "deny" as const, error: "not_retryable" };
      res.json({
        job,
        retry: {
          allowed: retry.kind === "allow",
          reason: retry.kind === "deny" ? retry.error : null,
          attempts: job.attempts,
          cap: RETRY_CAPS[job.failureCode ?? ""] ?? DEFAULT_RETRY_CAP,
        },
        lesson: lesson
          ? {
              id: lesson.id,
              status: lesson.status,
              teacherId: lesson.teacherId,
              teacher: teacher ?? null,
              // Recorder-identity aliases: owner = who held the phone (teacherId row;
              // solo lessons record themselves). teacher/teacherId kept for compat.
              ownerRole: lesson.ownerRole,
              owner: teacher ?? null,
              studentId: lesson.studentId,
              student: studentRow ?? null,
              pieceId: lesson.pieceId,
              pieceLabel: lesson.pieceLabel,
              durationSec: lesson.durationSec,
              language: lesson.language,
              createdAt: lesson.createdAt,
              updatedAt: lesson.updatedAt,
            }
          : null,
        notes: producedNotes,
      });
    }),
  );

  // A rights complaint stops the serving; it does not destroy the owner's row, and §13 rules out any
  // admin path that would read the pages.
  // A scan whose pages uploaded but whose commit never ran is a normal row, not an error: nothing logs
  // it, nothing alerts, and the first person to notice is the student with no score. This is the query
  // that makes it visible.
  router.get(
    "/admin/score-scans/stalled",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const raw = Number(req.query.hours);
      const hours = Number.isFinite(raw) && raw > 0 && raw <= 720 ? raw : 6;
      const rows = await db
        .select({
          id: scoreScans.id,
          ownerId: scoreScans.ownerId,
          ownerEmail: users.email,
          title: scoreScans.title,
          status: scoreScans.status,
          pageCount: scoreScans.pageCount,
          createdAt: scoreScans.createdAt,
          updatedAt: scoreScans.updatedAt,
          hasBytes: sql<boolean>`${scoreScans.blobPath} IS NOT NULL`,
          referencedBy: sql<number>`(SELECT count(*)::int FROM notes n WHERE n.score_scan_id = score_scans.id)`,
        })
        .from(scoreScans)
        .leftJoin(users, eq(users.id, scoreScans.ownerId))
        .where(and(
          eq(scoreScans.status, "created"),
          sql`${scoreScans.updatedAt} < now() - make_interval(hours => ${hours})`,
        ))
        .orderBy(desc(scoreScans.createdAt));
      res.json({ hours, scans: rows });
    }),
  );

  router.post(
    "/admin/score-scans/:id/takedown",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (reason.length < 10) {
        res.status(400).json({ error: "reason_required", message: "A reason of at least 10 characters is required to take a score down." });
        return;
      }
      if (!deps.scans) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const [scan] = await db.select({ id: scoreScans.id, status: scoreScans.status, ownerId: scoreScans.ownerId })
        .from(scoreScans).where(eq(scoreScans.id, id)).limit(1);
      if (!scan) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Audited before acting, so a takedown that dies half way is still on the record.
      await audit(deps, req, "score_scan.takedown", { type: "score_scan", id }, { reason });
      const taken = await db.transaction((tx) => takeDownScan(tx, id));
      // A row already taken down is re-purged rather than refused: the bytes are what the complaint is about, and a first attempt that failed to delete them must be repeatable.
      const ownerId = taken?.ownerId ?? scan.ownerId;
      const store = deps.scans;
      const purge = purgeRunner({ op: "score_scan.takedown", userId: ownerId, reqId: req.reqId ?? null });
      for (const prefix of scanPurgePrefixes(store, ownerId, [{ id }])) {
        await purge("scan", prefix, () => store.deletePrefix(prefix));
      }
      res.json({ ok: true, notesDetached: taken?.notesDetached ?? 0, repurged: taken === null });
    }),
  );

  router.post(
    "/admin/note-jobs/:id/requeue",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      if (!deps.notesQueue) {
        res.status(503).json({ error: "notes_pipeline_not_configured" });
        return;
      }
      const id = String(req.params.id);
      const [job] = await db.select().from(noteJobs).where(eq(noteJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Failed-only: a queued/processing/reviewed job re-enqueued would double-run.
      if (job.status !== "failed") {
        res.status(409).json({ error: "not_failed", status: job.status });
        return;
      }
      // A discarded lesson's audio and transcript are gone, and its owner asked
      // for exactly that. The failed-only check cannot see it — a discard leaves
      // the job in 'failed' — so read the lesson: permission to re-run lives
      // there, not on the job.
      const [lessonRow] = await db
        .select({ status: lessonSessions.status })
        .from(lessonSessions)
        .where(eq(lessonSessions.id, job.lessonSessionId))
        .limit(1);
      if (job.discardedAt || !lessonRow || lessonRow.status === "canceled") {
        res.status(409).json({
          error: "lesson_discarded",
          message: "The owner discarded this recording. Its audio and transcript are gone, so there is nothing to re-run.",
        });
        return;
      }
      // Deliberately UNCAPPED: the user-facing retry cap is a spend guard on a
      // button an end user taps, not a limit on a deliberate admin re-run.
      const [requeued] = await db
        .update(noteJobs)
        .set({
          status: "queued",
          stage: null,
          error: null,
          failureCode: null,
          failureHints: [],
          attempts: sql`${noteJobs.attempts} + 1`,
          startedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(noteJobs.id, job.id))
        .returning();
      try {
        await deps.notesQueue.send({ jobId: job.id, reqId: req.reqId });
      } catch (err) {
        // Roll back to failed so the row's state never lies about what is enqueued.
        await db.update(noteJobs).set({ status: "failed", updatedAt: sql`now()` }).where(eq(noteJobs.id, job.id));
        console.error("note_job requeue: queue send failed, rolled back", err);
        res.status(503).json({ error: "queue_unavailable", message: "Processing is briefly unavailable — try again in a moment." });
        return;
      }
      await audit(deps, req, "note_job.requeue", { type: "note_job", id: job.id }, { jobId: job.id });
      res.json({ job: requeued! });
    }),
  );

  // NOTE: POST /admin/note-jobs/dlq/redrive is intentionally NOT built. The OpsQueueStore
  // primitive exposes only counts() + peekDeadLetters() (a non-destructive peek); there is
  // no receive/redrive plumbing to reuse, and inventing Service Bus receivers here was out
  // of scope. When a DLQ redrive primitive is added to opsqueue.ts, wire it here (cap by
  // `max`, default 20) and audit "note_job.dlq_redrive".

  router.get(
    "/admin/note-jobs/:id/transcript",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      // Transcripts are verbatim lesson content, often minors'. Admin alone is not
      // enough — the DB capability flag gates it (settled 2026-07-20; a claim-based
      // Entra role would be the API's first token-trusted authorization and is
      // stale until re-login, so authorization stays in Postgres like requireAdmin).
      if (!req.adminUser!.canViewTranscripts) {
        res.status(403).json({ error: "transcript_forbidden", message: "Your account doesn't have transcript access. An existing holder can grant it from Users." });
        return;
      }
      const reason = typeof req.query.reason === "string" ? req.query.reason.trim() : "";
      // Break-glass read: the reason is the accountability record, so it is mandatory.
      if (reason.length < 10) {
        res.status(400).json({ error: "reason_required", message: "A reason of at least 10 characters is required to view a transcript." });
        return;
      }
      const [job] = await db.select().from(noteJobs).where(eq(noteJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // A break-glass reader must be able to tell "purged on the owner's request"
      // from "never existed" — 410 is the difference, and it is checked before the
      // null-path 409 because a discard nulls the path.
      if (job.discardedAt) {
        res.status(410).json({
          error: "transcript_discarded",
          message: "The owner deleted this recording and its transcript.",
        });
        return;
      }
      if (!job.transcriptPath) {
        res.status(409).json({ error: "transcript_not_ready", message: "This job has not produced a transcript." });
        return;
      }
      // Audit BEFORE the read so the break-glass access is recorded even if the read fails.
      await audit(deps, req, "transcript.view", { type: "note_job", id }, { reason, jobId: id });
      if (!deps.notesAssets) {
        // No reader wired: still return the path so the operator can retrieve it out of band.
        res.status(503).json({ error: "notes_assets_not_configured", transcriptPath: job.transcriptPath });
        return;
      }
      const transcript = await deps.notesAssets.readJson(job.transcriptPath);
      if (transcript === null) {
        res.status(404).json({ error: "transcript_missing", transcriptPath: job.transcriptPath });
        return;
      }
      res.json({ jobId: id, transcriptPath: job.transcriptPath, transcript });
    }),
  );

  // Quotes and instructions here are lifted verbatim from the lesson, so this is gated
  // and audited exactly like the transcript it derives from.
  router.get(
    "/admin/note-jobs/:id/model-output",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      if (!req.adminUser!.canViewTranscripts) {
        res.status(403).json({ error: "transcript_forbidden", message: "Your account doesn't have transcript access. An existing holder can grant it from Users." });
        return;
      }
      const reason = typeof req.query.reason === "string" ? req.query.reason.trim() : "";
      if (reason.length < 10) {
        res.status(400).json({ error: "reason_required", message: "A reason of at least 10 characters is required to view model output." });
        return;
      }
      const [job] = await db.select().from(noteJobs).where(eq(noteJobs.id, id)).limit(1);
      if (!job) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (job.discardedAt) {
        res.status(410).json({
          error: "model_output_discarded",
          message: "The owner deleted this recording, and its model output went with it.",
        });
        return;
      }
      if (!job.modelOutputPath) {
        res.status(409).json({
          error: "model_output_not_recorded",
          message: "This job produced no rejected model output — nothing was captured.",
        });
        return;
      }
      await audit(deps, req, "model_output.view", { type: "note_job", id }, { reason, jobId: id });
      if (!deps.notesAssets) {
        res.status(503).json({ error: "notes_assets_not_configured", modelOutputPath: job.modelOutputPath });
        return;
      }
      const modelOutput = await deps.notesAssets.readJson(job.modelOutputPath);
      if (modelOutput === null) {
        res.status(404).json({ error: "model_output_missing", modelOutputPath: job.modelOutputPath });
        return;
      }
      res.json({ jobId: id, modelOutputPath: job.modelOutputPath, modelOutput });
    }),
  );

  // ── User activity ─────────────────────────────────────────────────────────────

  router.get(
    "/admin/users/:id/notes-activity",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (!user) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const linksAsTeacher = await db
        .select({
          id: teacherStudentLinks.id,
          studentId: teacherStudentLinks.studentId,
          status: teacherStudentLinks.status,
          createdVia: teacherStudentLinks.createdVia,
          createdAt: teacherStudentLinks.createdAt,
          studentEmail: studentU.email,
          studentName: studentU.displayName,
        })
        .from(teacherStudentLinks)
        .leftJoin(studentU, eq(teacherStudentLinks.studentId, studentU.id))
        .where(eq(teacherStudentLinks.teacherId, id))
        .orderBy(desc(teacherStudentLinks.createdAt));
      const linksAsStudent = await db
        .select({
          id: teacherStudentLinks.id,
          teacherId: teacherStudentLinks.teacherId,
          status: teacherStudentLinks.status,
          createdVia: teacherStudentLinks.createdVia,
          createdAt: teacherStudentLinks.createdAt,
          teacherEmail: teacherU.email,
          teacherName: teacherU.displayName,
        })
        .from(teacherStudentLinks)
        .leftJoin(teacherU, eq(teacherStudentLinks.teacherId, teacherU.id))
        .where(eq(teacherStudentLinks.studentId, id))
        .orderBy(desc(teacherStudentLinks.createdAt));
      const invitesIssued = (
        await db.select().from(invites).where(eq(invites.teacherId, id)).orderBy(desc(invites.createdAt))
      ).map((r) => ({
        id: r.id,
        code: r.code,
        expiresAt: r.expiresAt,
        maxUses: r.maxUses,
        usedCount: r.usedCount,
        revokedAt: r.revokedAt,
        createdAt: r.createdAt,
        state: inviteState(r),
      }));
      const [lessonCount] = await db
        .select({
          count: sql<number>`count(*)::int`,
          // owner_role split: 'teacher' = recorded teaching someone, 'student' = solo self-recording.
          recordedAsTeacher: sql<number>`count(*) filter (where ${lessonSessions.ownerRole} = 'teacher')::int`,
          recordedAsSelf: sql<number>`count(*) filter (where ${lessonSessions.ownerRole} = 'student')::int`,
        })
        .from(lessonSessions)
        .where(eq(lessonSessions.teacherId, id));
      // Piece labels only — never transcript or audio.
      const recentLessons = await db
        .select({ pieceId: lessonSessions.pieceId, pieceLabel: lessonSessions.pieceLabel })
        .from(lessonSessions)
        .where(eq(lessonSessions.teacherId, id))
        .orderBy(desc(lessonSessions.createdAt))
        .limit(10);
      const recentPieceLabels = [
        ...new Set(recentLessons.map((l) => l.pieceLabel ?? l.pieceId).filter((x): x is string => Boolean(x))),
      ].slice(0, 8);
      const [sent] = await db
        .select({
          count: sql<number>`count(*)::int`,
          // origin split: self notes have teacherId = studentId = owner, so `count`
          // (kept as-is for compat) includes them — the annotations disambiguate.
          sentAsTeacher: sql<number>`count(*) filter (where ${notes.origin} = 'teacher')::int`,
          selfNotes: sql<number>`count(*) filter (where ${notes.origin} = 'self')::int`,
        })
        .from(notes)
        .where(and(eq(notes.teacherId, id), eq(notes.status, "sent")));
      const [received] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notes)
        .where(and(eq(notes.studentId, id), eq(notes.status, "sent")));
      // Metadata only, never a read URL: §13 draws the same line adminNotes already draws for
      // transcripts — the operator sees that a scan exists, not the scan.
      const scans = await db
        .select({
          id: scoreScans.id,
          title: scoreScans.title,
          status: scoreScans.status,
          pageCount: scoreScans.pageCount,
          bytes: scoreScans.bytes,
          createdAt: scoreScans.createdAt,
          takenDownAt: scoreScans.takenDownAt,
          hasBytes: sql<boolean>`${scoreScans.blobPath} IS NOT NULL`,
          referencedBy: sql<number>`(SELECT count(*)::int FROM notes n WHERE n.score_scan_id = score_scans.id)`,
        })
        .from(scoreScans)
        .where(eq(scoreScans.ownerId, id))
        .orderBy(desc(scoreScans.createdAt));
      const access = await notesAccess(deps, user);
      res.json({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          organization: user.organization,
          isTeacher: user.isTeacher,
          isStudent: user.isStudent,
          isAdmin: user.isAdmin,
          status: user.status,
        },
        links: { asTeacher: linksAsTeacher, asStudent: linksAsStudent },
        invitesIssued,
        scoreScans: scans,
        lessons: {
          count: lessonCount?.count ?? 0,
          recordedAsTeacher: lessonCount?.recordedAsTeacher ?? 0,
          recordedAsSelf: lessonCount?.recordedAsSelf ?? 0,
          recentPieceLabels,
        },
        notes: {
          sent: sent?.count ?? 0,
          received: received?.count ?? 0,
          sentAsTeacher: sent?.sentAsTeacher ?? 0,
          selfNotes: sent?.selfNotes ?? 0,
        },
        access,
      });
    }),
  );

  // Teacher-trust watch list — DERIVED LIVE, never a sticky flag. A teacher lists
  // only while ALL hold in the trailing 28 days: active account + isTeacher, zero
  // active student links, zero lifetime sent notes, zero teacher_to_student codes
  // minted, and >=1 submitted teacher-owned lesson. Minting any invite in-window
  // exits the list; one lifetime send exits forever — the "student hasn't
  // installed the app yet" teacher can never appear here. Read-only in B1.5:
  // outreach is a human emailing from a human mailbox, never automated.
  router.get(
    "/admin/notes/trust/watch",
    wrap(async (_req, res) => {
      const db = deps.db!.orm;
      const rows = await db
        .select({
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          organization: users.organization,
          createdAt: users.createdAt,
          // "users"."id" is hardcoded: drizzle renders a ${users.id} interpolation
          // UNQUALIFIED in select-field position, and the bare "id" resolves to
          // lesson_sessions.id inside the subquery (count was silently always 0).
          lessons28d: sql<number>`(
            SELECT count(*)::int FROM lesson_sessions l
            WHERE l.teacher_id = "users"."id" AND l.owner_role = 'teacher'
              AND l.status = 'submitted' AND l.created_at >= now() - interval '28 days'
          )`,
        })
        .from(users)
        .where(and(
          eq(users.isTeacher, true),
          eq(users.status, "active"),
          sql`NOT EXISTS (SELECT 1 FROM teacher_student_links tl
                          WHERE tl.teacher_id = ${users.id} AND tl.status = 'active')`,
          sql`NOT EXISTS (SELECT 1 FROM notes n
                          WHERE n.teacher_id = ${users.id} AND n.status IN ('sent', 'retracted') AND n.origin = 'teacher')`,
          sql`NOT EXISTS (SELECT 1 FROM invites i
                          WHERE i.teacher_id = ${users.id} AND i.direction = 'teacher_to_student'
                            AND i.created_at >= now() - interval '28 days')`,
          sql`EXISTS (SELECT 1 FROM lesson_sessions l
                      WHERE l.teacher_id = ${users.id} AND l.owner_role = 'teacher'
                        AND l.status = 'submitted' AND l.created_at >= now() - interval '28 days')`,
        ))
        .orderBy(desc(users.createdAt));
      res.json({
        items: rows.map((r) => ({ ...r, highVolume: r.lessons28d >= 8 })),
        windowDays: 28,
      });
    }),
  );

  return router;
}
