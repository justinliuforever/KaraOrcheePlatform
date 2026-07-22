import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { notesAccess } from "../notes/entitlement";
import { lessonSessions, noteJobs, notes, pieces, teacherStudentLinks } from "../db/schema";

const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // ~6h at 64kbps; anything bigger is a client bug

// Offline-first contract: recording is fully local; this row is created at SEND
// time. Piece and student stay nullable — both are fixable at review.
export function lessonsRouter(deps: Deps): Router {
  const router = Router();
  const guards = [requireAuth(deps.auth), requireUser(deps)];

  router.post(
    "/v1/lessons",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!me.isTeacher && !me.isStudent) {
        res.status(403).json({ error: "notes_role_required" });
        return;
      }
      if (!deps.lessons) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const body = req.body ?? {};
      // Snapshot of who held the phone; teacher wins for dual-role accounts unless
      // the client explicitly declares (below). Never re-derived later — a role
      // granted after the fact must not rewrite history.
      let ownerRole = me.isTeacher ? "teacher" : "student";
      const pieceId = typeof body.pieceId === "string" ? body.pieceId : null;
      const pieceLabel = typeof body.pieceLabel === "string" && body.pieceLabel.trim()
        ? body.pieceLabel.trim()
        : null;
      const studentId = typeof body.studentId === "string" ? body.studentId : null;
      const clientLessonId = typeof body.clientLessonId === "string" ? body.clientLessonId : null;

      // Client-declared recorder role (B1.5 app sends the local snapshot). An
      // explicit "student" beats the teacher-wins default — the beta view-as
      // override records solo on a dual-role account. Absent = old derivation.
      const requested = body.ownerRole;
      if (requested === "teacher" || requested === "student") {
        if ((requested === "teacher" && !me.isTeacher) || (requested === "student" && !me.isStudent)) {
          res.status(400).json({ error: "role_mismatch" });
          return;
        }
        ownerRole = requested;
      }

      // Idempotent create FIRST — before any gate: a retried outbox POST for a row
      // that already exists must return it even if the trial lapsed in between
      // (mirrors submit ordering 409-before-402), never paywall an existing row.
      // Canceled rows never match (cancel releases the clientLessonId), so a
      // discarded-then-rerecorded lesson gets a fresh row, not a dead one.
      if (clientLessonId) {
        const [dup] = await db
          .select()
          .from(lessonSessions)
          .where(and(
            eq(lessonSessions.teacherId, me.id),
            eq(lessonSessions.clientLessonId, clientLessonId),
            sql`${lessonSessions.status} <> 'canceled'`,
          ))
          .limit(1);
        if (dup) {
          // Crash-window repair: a row inserted before its audioPath update lost
          // its path — mint it now so uploadUrl is never null (fielded decoder
          // treats it as non-optional).
          let audioPath = dup.audioPath;
          if (!audioPath) {
            audioPath = deps.lessons.blobPath(me.id, dup.id);
            await db.update(lessonSessions).set({ audioPath, updatedAt: sql`now()` }).where(eq(lessonSessions.id, dup.id));
          }
          res.status(200).json({
            lesson: { ...dup, audioPath },
            uploadUrl: deps.lessons.uploadUrl(audioPath),
          });
          return;
        }
      }

      if (ownerRole === "student") {
        // Solo recordings are always the recorder's own; the paywall moment is
        // create (UX) — submit re-checks as the cost guarantee. Dormant in beta.
        if (studentId) {
          res.status(400).json({ error: "solo_lesson_no_student" });
          return;
        }
        if (body.attested !== true) {
          res.status(400).json({ error: "attestation_required", message: "Confirm your teacher knows this lesson is being recorded." });
          return;
        }
        const access = await notesAccess(deps, me);
        if (access.status === "lapsed") {
          res.status(402).json({ error: "entitlement_required", access });
          return;
        }
      }

      if (pieceId) {
        const [piece] = await db.select({ id: pieces.id }).from(pieces).where(eq(pieces.id, pieceId)).limit(1);
        if (!piece) {
          res.status(400).json({ error: "unknown_piece" });
          return;
        }
      }
      if (studentId) {
        const [link] = await db
          .select()
          .from(teacherStudentLinks)
          .where(and(
            eq(teacherStudentLinks.teacherId, me.id),
            eq(teacherStudentLinks.studentId, studentId),
            eq(teacherStudentLinks.status, "active"),
          ))
          .limit(1);
        if (!link) {
          res.status(400).json({ error: "not_your_student" });
          return;
        }
      }

      const startedAt = body.startedAt ? new Date(body.startedAt) : null;
      const endedAt = body.endedAt ? new Date(body.endedAt) : null;
      const [row] = await db
        .insert(lessonSessions)
        .values({
          teacherId: me.id,
          ownerRole,
          clientLessonId,
          studentId,
          pieceId,
          pieceLabel,
          startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
          endedAt: endedAt && !Number.isNaN(endedAt.getTime()) ? endedAt : null,
          durationSec: Number.isFinite(body.durationSec) ? Math.round(body.durationSec) : null,
          attested: body.attested === true,
        })
        .returning();
      const path = deps.lessons.blobPath(me.id, row!.id);
      await db.update(lessonSessions).set({ audioPath: path }).where(eq(lessonSessions.id, row!.id));
      await userAudit(deps, req, "lesson.create", { type: "lesson", id: row!.id });
      res.status(201).json({
        lesson: { ...row, audioPath: path },
        uploadUrl: deps.lessons.uploadUrl(path),
      });
    }),
  );

  // Fresh SAS for an existing un-submitted lesson: the ~2h link minted at create
  // can expire before an offline outbox retry fires.
  router.post(
    "/v1/lessons/:id/upload-url",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      if (!deps.lessons) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const [lesson] = await db
        .select()
        .from(lessonSessions)
        .where(and(eq(lessonSessions.id, String(req.params.id)), eq(lessonSessions.teacherId, me.id)))
        .limit(1);
      if (!lesson || !lesson.audioPath) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (lesson.status !== "created") {
        res.status(409).json({ error: "already_submitted" });
        return;
      }
      res.json({ uploadUrl: deps.lessons.uploadUrl(lesson.audioPath) });
    }),
  );

  router.post(
    "/v1/lessons/:id/submit",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      if (!deps.lessons || !deps.notesQueue) {
        res.status(503).json({ error: "notes_pipeline_not_configured" });
        return;
      }
      const [lesson] = await db
        .select()
        .from(lessonSessions)
        .where(and(eq(lessonSessions.id, String(req.params.id)), eq(lessonSessions.teacherId, me.id)))
        .limit(1);
      if (!lesson) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Canceled is TERMINAL, never "already submitted" — the app treats
      // already_submitted as success, which would resurrect a discarded lesson.
      if (lesson.status === "canceled") {
        res.status(409).json({ error: "lesson_canceled" });
        return;
      }
      if (lesson.status !== "created") {
        res.status(409).json({ error: "already_submitted" });
        return;
      }
      // The ASR+LLM cost moment: solo submissions re-check entitlement even though
      // create already did — the trial can lapse between recording and sending.
      if (lesson.ownerRole === "student") {
        const access = await notesAccess(deps, me);
        if (access.status === "lapsed") {
          res.status(402).json({ error: "entitlement_required", access });
          return;
        }
      }
      const props = await deps.lessons.audioProps(lesson.audioPath!);
      if (!props || props.bytes === 0) {
        res.status(409).json({ error: "audio_missing", message: "The recording upload has not finished — retry in a moment." });
        return;
      }
      if (props.bytes > MAX_AUDIO_BYTES) {
        res.status(413).json({ error: "audio_too_large" });
        return;
      }

      // CAS the lesson out of 'created' FIRST so only one racing submit (and never
      // a submit that lost to cancel) proceeds to create a job. The status guard
      // above is only a fast, friendly early-out.
      const [claimed] = await db
        .update(lessonSessions)
        .set({ status: "submitted", audioBytes: props.bytes, updatedAt: sql`now()` })
        .where(and(eq(lessonSessions.id, lesson.id), eq(lessonSessions.status, "created")))
        .returning();
      if (!claimed) {
        res.status(409).json({ error: "already_submitted" });
        return;
      }

      const [job] = await db
        .insert(noteJobs)
        .values({ lessonSessionId: lesson.id, createdBy: me.id })
        .returning();
      try {
        await deps.notesQueue.send({ jobId: job!.id, reqId: req.reqId });
      } catch (err) {
        // Roll the lesson back so a retry can re-claim it; drop the orphan job.
        await db.delete(noteJobs).where(eq(noteJobs.id, job!.id));
        await db
          .update(lessonSessions)
          .set({ status: "created", updatedAt: sql`now()` })
          .where(eq(lessonSessions.id, lesson.id));
        console.error("lesson submit: queue send failed, rolled back", err);
        res.status(503).json({ error: "queue_unavailable", message: "Processing is briefly unavailable — try again in a moment." });
        return;
      }
      await userAudit(deps, req, "lesson.submit", { type: "lesson", id: lesson.id }, { jobId: job!.id });
      res.json({ lesson: claimed, job });
    }),
  );

  // Home poll (feeds the teacher home AND the student recordings shelf): lessons +
  // their latest job + note ids, newest first. ownerRole filter keeps a dual-role
  // account's solo recordings out of its teacher pipeline and vice versa.
  router.get(
    "/v1/lessons",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const conds = [eq(lessonSessions.teacherId, me.id), sql`${lessonSessions.status} <> 'canceled'`];
      const ownerRole = typeof req.query.ownerRole === "string" ? req.query.ownerRole : undefined;
      if (ownerRole === "teacher" || ownerRole === "student") {
        conds.push(eq(lessonSessions.ownerRole, ownerRole));
      }
      const rows = await db
        .select()
        .from(lessonSessions)
        .where(and(...conds))
        .orderBy(desc(lessonSessions.createdAt))
        .limit(100);
      const ids = rows.map((r) => r.id);
      const jobs = ids.length
        ? await db.select().from(noteJobs).where(inArray(noteJobs.lessonSessionId, ids)).orderBy(desc(noteJobs.createdAt))
        : [];
      const noteRows = ids.length
        ? await db
            .select({
              id: notes.id,
              lessonSessionId: notes.lessonSessionId,
              status: notes.status,
              studentId: notes.studentId,
            })
            .from(notes)
            .where(inArray(notes.lessonSessionId, ids))
        : [];
      res.json({
        items: rows.map((lesson) => ({
          lesson,
          job: jobs.find((j) => j.lessonSessionId === lesson.id) ?? null,
          notes: noteRows.filter((n) => n.lessonSessionId === lesson.id),
        })),
      });
    }),
  );

  router.get(
    "/v1/lessons/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [lesson] = await db
        .select()
        .from(lessonSessions)
        .where(and(eq(lessonSessions.id, String(req.params.id)), eq(lessonSessions.teacherId, me.id)))
        .limit(1);
      if (!lesson) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const jobs = await db
        .select()
        .from(noteJobs)
        .where(eq(noteJobs.lessonSessionId, lesson.id))
        .orderBy(desc(noteJobs.createdAt));
      const noteRows = await db
        .select({ id: notes.id, status: notes.status, studentId: notes.studentId })
        .from(notes)
        .where(eq(notes.lessonSessionId, lesson.id));
      res.json({ lesson, job: jobs[0] ?? null, notes: noteRows });
    }),
  );

  router.post(
    "/v1/lessons/:id/retry",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      if (!deps.notesQueue) {
        res.status(503).json({ error: "notes_pipeline_not_configured" });
        return;
      }
      const [lesson] = await db
        .select()
        .from(lessonSessions)
        .where(and(eq(lessonSessions.id, String(req.params.id)), eq(lessonSessions.teacherId, me.id)))
        .limit(1);
      if (!lesson) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [job] = await db
        .select()
        .from(noteJobs)
        .where(eq(noteJobs.lessonSessionId, lesson.id))
        .orderBy(desc(noteJobs.createdAt))
        .limit(1);
      if (!job || job.status !== "failed") {
        res.status(409).json({ error: "not_retryable" });
        return;
      }
      const [requeued] = await db
        .update(noteJobs)
        .set({
          status: "queued",
          stage: null,
          error: null,
          failureHints: [],
          attempts: sql`${noteJobs.attempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(noteJobs.id, job.id))
        .returning();
      try {
        await deps.notesQueue.send({ jobId: job.id, reqId: req.reqId });
      } catch (err) {
        await db
          .update(noteJobs)
          .set({ status: "failed", updatedAt: sql`now()` })
          .where(eq(noteJobs.id, job.id));
        console.error("lesson retry: queue send failed, rolled back", err);
        res.status(503).json({ error: "queue_unavailable" });
        return;
      }
      await userAudit(deps, req, "lesson.retry", { type: "lesson", id: lesson.id }, { jobId: job.id });
      res.json({ job: requeued });
    }),
  );

  // Cancel is pre-pipeline only: a submitted lesson is in flight, a reviewed one
  // is a note. Deletes the uploaded blob so a dead lesson leaves no audio behind.
  router.delete(
    "/v1/lessons/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [lesson] = await db
        .select()
        .from(lessonSessions)
        .where(and(eq(lessonSessions.id, String(req.params.id)), eq(lessonSessions.teacherId, me.id)))
        .limit(1);
      if (!lesson) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (lesson.status !== "created") {
        res.status(409).json({ error: "already_submitted" });
        return;
      }
      // CAS so a submit that raced this cancel cannot be overwritten (which would
      // strand a queued job pointing at deleted audio). Cancel also RELEASES the
      // clientLessonId: the dedupe skips canceled rows, so without this a
      // re-record with the same local id would hit uq_lesson_client_id.
      const [canceled] = await db
        .update(lessonSessions)
        .set({ status: "canceled", clientLessonId: null, updatedAt: sql`now()` })
        .where(and(eq(lessonSessions.id, lesson.id), eq(lessonSessions.status, "created")))
        .returning();
      if (!canceled) {
        res.status(409).json({ error: "already_submitted" });
        return;
      }
      if (lesson.audioPath && deps.lessons) {
        await deps.lessons.deleteAudio(lesson.audioPath);
      }
      await userAudit(deps, req, "lesson.cancel", { type: "lesson", id: lesson.id });
      res.json({ ok: true });
    }),
  );

  return router;
}
