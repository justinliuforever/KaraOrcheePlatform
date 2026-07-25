import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { notesAccess } from "../notes/entitlement";
import type { Orm } from "../db/client";
import {
  lessonSessions,
  noteAnnotations,
  noteJobs,
  notes,
  pieces,
  teacherStudentLinks,
} from "../db/schema";

// ~167 min of the 24kbps AAC remux, or ~2.5h of the CAF fallback. The client
// refuses an over-cap file BEFORE transferring it; this is the backstop.
const MAX_AUDIO_BYTES = 320 * 1024 * 1024;

// Every 400 the app can hit after a 45-minute recording. The client renders
// `message` verbatim when it has no mapped copy, so each one names the repair
// the app already ships rather than the rule that was broken. Create and PATCH
// share the strings so the two write paths cannot drift.
const MSG_SOLO_NO_STUDENT = "A recording you made yourself is your own — there is no student to send it to.";
const MSG_UNKNOWN_PIECE = "That piece isn't in the library. Choose another piece, or type its name instead.";
const MSG_NOT_YOUR_STUDENT = "That student isn't on your roster anymore. Invite them again, then choose them.";

// ── Discard / retry policy ────────────────────────────────────────────────────
// Pure, exported, and called by BOTH the mutating route and the *Allowed flags on
// the wire. The client renders what it is told and predicts nothing: the button a
// user sees and the answer the server gives cannot drift apart if there is only
// one function that knows the answer.

// A queued/processing job that has not moved in this long is wedged, and its
// owner gets an escape hatch. ASR_POLL_MAX is 40 min (worker/notes/main.py), so
// this is ~1.5x the worst honest case.
export const STUCK_JOB_MS = 60 * 60 * 1000;

export type DiscardDecision =
  | { kind: "allow"; action: "lesson.cancel" | "lesson.discard" }
  | { kind: "noop" }
  | { kind: "deny"; status: number; error: string; message: string };

export interface DiscardInput {
  lessonStatus: string;
  job: { status: string; updatedAt: Date | null } | null;
  notes: { status: string; origin: string }[];
  now?: number;
}

export function discardDecision(input: DiscardInput): DiscardDecision {
  const now = input.now ?? Date.now();
  // Idempotency first: a retried discard must return 200, never flap the card
  // with a 404/409. (A canceled lesson can never hold a sent note — the sent-note
  // guard below is what would have stopped it being canceled at all.)
  if (input.lessonStatus === "canceled") return { kind: "noop" };
  if (input.notes.some((n) => n.origin === "teacher" && (n.status === "sent" || n.status === "retracted"))) {
    return {
      kind: "deny",
      status: 409,
      error: "lesson_has_sent_note",
      message: "A note from this lesson was already sent. Retract it first, or delete it from the student's copy.",
    };
  }
  if (input.lessonStatus === "created") return { kind: "allow", action: "lesson.cancel" };
  const job = input.job;
  if (job && (job.status === "queued" || job.status === "processing")) {
    const movedAt = job.updatedAt ? job.updatedAt.getTime() : 0;
    if (now - movedAt < STUCK_JOB_MS) {
      return {
        kind: "deny",
        status: 409,
        error: "lesson_processing",
        message: "Processing is still running. You can discard this once it finishes.",
      };
    }
  }
  // submitted with no job (submit crashed before the insert), a failed job, a
  // ready_for_review job, or a wedged one past the hatch.
  return { kind: "allow", action: "lesson.discard" };
}

export function discardAllowed(input: DiscardInput): boolean {
  return discardDecision(input).kind !== "deny";
}

// Each retry re-runs paid ASR from the top, so the cap is a cost guard keyed on
// WHY it failed. A cap of 0 is CATEGORICAL — the re-run would be byte-identical,
// so no bonus below can resurrect it. no_speech is raised before the LLM ever
// runs, which is exactly that case (and what the app's own explainer says).
export const RETRY_CAPS: Record<string, number> = {
  no_speech: 0,
  thin_note: 2,
  asr_error: 3,
  llm_invalid: 3,
  worker_crash: 3,
  no_audio: 0,
  lesson_discarded: 0,
};
export const DEFAULT_RETRY_CAP = 3;

export type RetryDecision =
  | { kind: "allow" }
  | { kind: "deny"; status: number; error: string; message?: string };

export interface RetryInput {
  lessonStatus: string;
  pieceUpdatedAt: Date | null;
  job: { status: string; attempts: number; failureCode: string | null; updatedAt: Date | null } | null;
}

export function retryDecision(input: RetryInput): RetryDecision {
  if (input.lessonStatus === "canceled") {
    return { kind: "deny", status: 409, error: "lesson_discarded", message: "This recording was discarded." };
  }
  const job = input.job;
  if (!job || job.status !== "failed") return { kind: "deny", status: 409, error: "not_retryable" };
  const cap = RETRY_CAPS[job.failureCode ?? ""] ?? DEFAULT_RETRY_CAP;
  // "Something changed between attempts": the PIECE is the only lesson fact the
  // prompt reads, so naming it after a failure buys exactly one more attempt —
  // the one case where the LLM's inputs genuinely differ (the prompt gains the
  // piece and its measure bound). A student assignment changes nothing the
  // worker would do differently and must not fund a paid run. Each further
  // piece change re-arms it, which is the contract, not a leak: every re-arm
  // costs the user a real edit that really does change the prompt.
  const bonus =
    cap > 0 && input.pieceUpdatedAt && job.updatedAt && input.pieceUpdatedAt.getTime() > job.updatedAt.getTime()
      ? 1
      : 0;
  if (job.attempts >= cap + bonus) {
    return {
      kind: "deny",
      status: 409,
      error: "retry_exhausted",
      message: "This recording has been through processing as many times as it usefully can.",
    };
  }
  return { kind: "allow" };
}

export function retryAllowed(input: RetryInput): boolean {
  return retryDecision(input).kind === "allow";
}

// Hint stamped on an annotation whose auto-placed measure fell outside the piece
// named after the fact. Wording mirrors the app's ungrounded copy: it must read
// as "needs a location", never as an error.
const REGROUND_HINT = "This pointed past the end of the piece — place it on the score.";

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];

// Thrown to unwind the discard CAS when the post-lock re-read revokes the
// permission the pre-lock read granted. Returning would COMMIT the CAS.
class DiscardRaced extends Error {}

// Demote every auto-placed anchor that points past the end of the newly named
// piece. Teacher- and student-pinned locations are deliberate human placements
// and are never touched. `raw` survives so the original words are still a clue;
// the row is left in exactly the shape the worker writes for an unplaced
// annotation (no measures, no pinnedBy), which is what re-opens it to a pin.
async function reground(tx: Tx, noteId: string, measures: number): Promise<number> {
  const rows = await tx.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, noteId));
  let n = 0;
  for (const a of rows) {
    const loc = (a.location ?? {}) as Record<string, unknown>;
    if (loc.grounded !== true || loc.pinnedBy !== "auto") continue;
    const end = typeof loc.measureEnd === "number"
      ? loc.measureEnd
      : typeof loc.measureStart === "number"
        ? loc.measureStart
        : null;
    if (end === null || end <= measures) continue;
    const { measureStart: _s, measureEnd: _e, pinnedBy: _p, ...rest } = loc;
    await tx
      .update(noteAnnotations)
      .set({ location: { ...rest, grounded: false, hint: REGROUND_HINT }, updatedAt: sql`now()` })
      .where(eq(noteAnnotations.id, a.id));
    n++;
  }
  return n;
}

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
          res.status(400).json({ error: "solo_lesson_no_student", message: MSG_SOLO_NO_STUDENT });
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
          res.status(400).json({ error: "unknown_piece", message: MSG_UNKNOWN_PIECE });
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
          res.status(400).json({ error: "not_your_student", message: MSG_NOT_YOUR_STUDENT });
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
        .values({ lessonSessionId: lesson.id, createdBy: me.id, startedAt: sql`now()` })
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
      // origin travels so the client can tell a teacher draft from a solo self
      // note; studentId is the NOTE's own — a non-cascading PATCH leaves a draft
      // pointing at the old student and the draft row must name that one, not
      // the lesson's new value.
      const noteRows = ids.length
        ? await db
            .select({
              id: notes.id,
              lessonSessionId: notes.lessonSessionId,
              status: notes.status,
              origin: notes.origin,
              studentId: notes.studentId,
            })
            .from(notes)
            .where(inArray(notes.lessonSessionId, ids))
        : [];
      res.json({
        items: rows.map((lesson) => {
          const job = jobs.find((j) => j.lessonSessionId === lesson.id) ?? null;
          const mine = noteRows.filter((n) => n.lessonSessionId === lesson.id);
          return {
            lesson: {
              ...lesson,
              discardAllowed: discardAllowed({ lessonStatus: lesson.status, job, notes: mine }),
            },
            job: job
              ? {
                  ...job,
                  retryAllowed: retryAllowed({
                    lessonStatus: lesson.status,
                    pieceUpdatedAt: lesson.pieceUpdatedAt,
                    job,
                  }),
                }
              : null,
            notes: mine,
          };
        }),
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
        .select({ id: notes.id, status: notes.status, origin: notes.origin, studentId: notes.studentId })
        .from(notes)
        .where(eq(notes.lessonSessionId, lesson.id));
      const job = jobs[0] ?? null;
      res.json({
        lesson: {
          ...lesson,
          discardAllowed: discardAllowed({ lessonStatus: lesson.status, job, notes: noteRows }),
        },
        job: job
          ? {
              ...job,
              retryAllowed: retryAllowed({
                lessonStatus: lesson.status,
                pieceUpdatedAt: lesson.pieceUpdatedAt,
                job,
              }),
            }
          : null,
        notes: noteRows,
      });
    }),
  );

  // Fix the FACT after the recording. The lesson row is the fact (this lesson was
  // with X, on piece Y); the note row is the delivery. An assignment always writes
  // the fact and is never blocked by note state; it cascades to the delivery only
  // while the delivery is still ours to change (a teacher DRAFT, or a solo SELF
  // note — the owner's own data end to end), and never clobbers a human choice.
  //
  // This cannot be a local-only client edit: LessonUploader skips create once a
  // serverLessonId exists, and create's dedupe branch returns the existing row
  // untouched — so every already-created lesson would diverge silently.
  router.patch(
    "/v1/lessons/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const body = req.body ?? {};
      const hasStudent = "studentId" in body;
      const hasPieceId = "pieceId" in body;
      const hasPieceLabel = "pieceLabel" in body;
      if (!hasStudent && !hasPieceId && !hasPieceLabel) {
        res.status(400).json({ error: "nothing_to_update" });
        return;
      }
      // Scope is in the predicate, and a miss is 404 (never 403 — do not confirm
      // that someone else's lesson exists).
      const [lesson] = await db
        .select()
        .from(lessonSessions)
        .where(and(eq(lessonSessions.id, String(req.params.id)), eq(lessonSessions.teacherId, me.id)))
        .limit(1);
      if (!lesson) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (lesson.status === "canceled") {
        res.status(409).json({ error: "lesson_discarded", message: "This recording was discarded." });
        return;
      }

      // Tri-state: absent = unchanged, null = clear, value = set.
      const studentId = hasStudent ? (typeof body.studentId === "string" ? body.studentId : null) : undefined;
      const pieceId = hasPieceId ? (typeof body.pieceId === "string" ? body.pieceId : null) : undefined;
      const pieceLabel = hasPieceLabel
        ? (typeof body.pieceLabel === "string" && body.pieceLabel.trim() ? body.pieceLabel.trim() : null)
        : undefined;

      // Each check mirrors the create path so the two write paths cannot drift.
      if (studentId) {
        if (lesson.ownerRole === "student") {
          res.status(400).json({ error: "solo_lesson_no_student", message: MSG_SOLO_NO_STUDENT });
          return;
        }
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
          res.status(400).json({ error: "not_your_student", message: MSG_NOT_YOUR_STUDENT });
          return;
        }
      }
      let newPieceMeasures: number | null = null;
      let newPieceVersion: number | null = null;
      if (pieceId) {
        const [piece] = await db
          .select({ id: pieces.id, facts: pieces.facts, publishedVersion: pieces.publishedVersion })
          .from(pieces)
          .where(eq(pieces.id, pieceId))
          .limit(1);
        if (!piece) {
          res.status(400).json({ error: "unknown_piece", message: MSG_UNKNOWN_PIECE });
          return;
        }
        const m = (piece.facts as { measures?: unknown } | null)?.measures;
        newPieceMeasures = typeof m === "number" && Number.isInteger(m) && m > 0 ? m : null;
        newPieceVersion = piece.publishedVersion ?? null;
      }

      interface PatchedNote {
        id: string;
        origin: string;
        status: string;
        updated: boolean;
        studentId: string | null;
        pieceId: string | null;
      }

      // One transaction: a lesson updated without its draft is worse than neither.
      const out = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(lessonSessions)
          .where(and(eq(lessonSessions.id, lesson.id), eq(lessonSessions.teacherId, me.id)))
          .for("update")
          .limit(1);
        if (!locked) return null;
        if (locked.status === "canceled") return "discarded" as const;
        const before = { studentId: locked.studentId, pieceId: locked.pieceId, pieceLabel: locked.pieceLabel };

        const patch: Record<string, unknown> = { updatedAt: sql`now()` };
        if (studentId !== undefined) patch.studentId = studentId;
        if (pieceId !== undefined) patch.pieceId = pieceId;
        if (pieceLabel !== undefined) patch.pieceLabel = pieceLabel;
        // The retry bonus reads this, so it must mean "the prompt would differ",
        // not "someone touched the row": a re-send of the same value is not a
        // change, and a student assignment is never one.
        const pieceChanged =
          (pieceId !== undefined && pieceId !== before.pieceId) ||
          (pieceLabel !== undefined && pieceLabel !== before.pieceLabel);
        if (pieceChanged) patch.pieceUpdatedAt = sql`now()`;
        const [updatedLesson] = await tx
          .update(lessonSessions)
          .set(patch)
          .where(and(eq(lessonSessions.id, locked.id), eq(lessonSessions.teacherId, me.id)))
          .returning();

        // Grounding was validated against the measure count that existed at write
        // time — with no piece that is NULL, so every syntactically valid measure
        // number was accepted unbounded. Naming the piece late is the act that
        // would otherwise produce "measure 84" on a 32-bar Burgmüller.
        const shouldReground = pieceId !== undefined && pieceId !== null && pieceId !== before.pieceId && newPieceMeasures !== null;

        const rows = await tx.select().from(notes).where(eq(notes.lessonSessionId, locked.id));
        const touched: PatchedNote[] = [];
        let regrounded = 0;
        let studentCascadedTo: string | null = null;
        for (const n of rows) {
          const ours = (n.origin === "teacher" && n.status === "draft") || n.origin === "self";
          const np: Record<string, unknown> = {};
          if (ours) {
            // The inherit test, exact and stateless: a note still carrying the
            // lesson's pre-patch value merely inherited the fact and follows it;
            // a different value was chosen by a human at review and is left alone.
            // Never touch studentId on a self note — that IS the owner.
            if (studentId !== undefined && n.origin === "teacher" && n.studentId === before.studentId) {
              np.studentId = studentId;
            }
            if (pieceId !== undefined && n.pieceId === before.pieceId) np.pieceId = pieceId;
            if (pieceLabel !== undefined && n.pieceLabel === before.pieceLabel) np.pieceLabel = pieceLabel;
            // A self note is born 'sent' at worker insert, so there is no later
            // send event at which a version could ever be pinned.
            if ("pieceId" in np && n.origin === "self") np.pieceVersion = newPieceVersion;
          }
          if (!Object.keys(np).length) {
            touched.push({
              id: n.id,
              origin: n.origin,
              status: n.status,
              updated: false,
              studentId: n.studentId,
              pieceId: n.pieceId,
            });
            continue;
          }
          np.updatedAt = sql`now()`;
          const [u] = await tx.update(notes).set(np).where(eq(notes.id, n.id)).returning();
          if ("studentId" in np) studentCascadedTo = u!.id;
          if (shouldReground && "pieceId" in np) {
            regrounded += await reground(tx, n.id, newPieceMeasures!);
          }
          touched.push({
            id: u!.id,
            origin: u!.origin,
            status: u!.status,
            updated: true,
            studentId: u!.studentId,
            pieceId: u!.pieceId,
          });
        }
        return { lesson: updatedLesson!, notes: touched, regrounded, before, studentCascadedTo };
      });
      if (out === null) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (out === "discarded") {
        res.status(409).json({ error: "lesson_discarded", message: "This recording was discarded." });
        return;
      }

      if (hasStudent) {
        await userAudit(deps, req, "lesson.assign_student", { type: "lesson", id: lesson.id }, {
          from: out.before.studentId,
          to: studentId ?? null,
          noteUpdated: out.studentCascadedTo !== null,
          noteId: out.studentCascadedTo,
        });
      }
      if (hasPieceId || hasPieceLabel) {
        await userAudit(deps, req, "lesson.set_piece", { type: "lesson", id: lesson.id }, {
          fromPieceId: out.before.pieceId,
          toPieceId: pieceId === undefined ? out.before.pieceId : pieceId,
          pieceLabel: pieceLabel === undefined ? out.before.pieceLabel : pieceLabel,
          regrounded: out.regrounded,
        });
      }

      const [job] = await db
        .select()
        .from(noteJobs)
        .where(eq(noteJobs.lessonSessionId, lesson.id))
        .orderBy(desc(noteJobs.createdAt))
        .limit(1);
      res.json({
        lesson: {
          ...out.lesson,
          discardAllowed: discardAllowed({
            lessonStatus: out.lesson.status,
            job: job ?? null,
            notes: out.notes,
          }),
        },
        // The bonus this PATCH may just have granted is only visible through
        // retryAllowed, and nothing else refetches after an apply — without the
        // job here the sheet keeps saying "as many times as it usefully can"
        // right after the server decided otherwise.
        job: job
          ? {
              ...job,
              retryAllowed: retryAllowed({
                lessonStatus: out.lesson.status,
                pieceUpdatedAt: out.lesson.pieceUpdatedAt,
                job,
              }),
            }
          : null,
        notes: out.notes,
        regrounded: out.regrounded,
      });
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
      const decision = retryDecision({
        lessonStatus: lesson.status,
        pieceUpdatedAt: lesson.pieceUpdatedAt,
        job: job ?? null,
      });
      if (decision.kind === "deny") {
        res.status(decision.status).json(
          decision.message ? { error: decision.error, message: decision.message } : { error: decision.error },
        );
        return;
      }
      const [requeued] = await db
        .update(noteJobs)
        .set({
          status: "queued",
          stage: null,
          error: null,
          // The code describes the last failure; a requeued job has none yet.
          failureCode: null,
          failureHints: [],
          attempts: sql`${noteJobs.attempts} + 1`,
          // Re-anchor: the card's elapsed counter reads startedAt, so a retry must
          // not present the first attempt's age as this attempt's.
          startedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(noteJobs.id, job!.id))
        .returning();
      try {
        await deps.notesQueue.send({ jobId: job!.id, reqId: req.reqId });
      } catch (err) {
        // Full unwind, like the submit path: a half-restored row charges the user
        // for an attempt that never ran, and re-stamping updated_at would silently
        // consume the piece bonus that made this retry possible at all.
        await db
          .update(noteJobs)
          .set({
            status: job!.status,
            stage: job!.stage,
            error: job!.error,
            failureCode: job!.failureCode,
            failureHints: job!.failureHints,
            attempts: job!.attempts,
            startedAt: job!.startedAt,
            updatedAt: job!.updatedAt,
          })
          .where(eq(noteJobs.id, job!.id));
        console.error("lesson retry: queue send failed, rolled back", err);
        res.status(503).json({ error: "queue_unavailable", message: "Processing is briefly unavailable — try again in a moment." });
        return;
      }
      await userAudit(deps, req, "lesson.retry", { type: "lesson", id: lesson.id }, {
        jobId: job!.id,
        attempts: job!.attempts,
        failureCode: job!.failureCode,
      });
      res.json({ job: requeued });
    }),
  );

  // ONE route for both "cancel this before it was sent" and "delete this dead
  // recording": the shelf's status comes from a poll, so a job can finish or fail
  // in the gap between the poll and the tap. With two endpoints the app would
  // pick from stale state and get a 409 it has to translate; with one, the server
  // reads the current row and decides. discardDecision() is the whole policy and
  // the same function computes `discardAllowed` on the wire.
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
      const jobs = await db
        .select()
        .from(noteJobs)
        .where(eq(noteJobs.lessonSessionId, lesson.id))
        .orderBy(desc(noteJobs.createdAt));
      const noteRows = await db
        .select({ id: notes.id, status: notes.status, origin: notes.origin })
        .from(notes)
        .where(eq(notes.lessonSessionId, lesson.id));

      const decision = discardDecision({ lessonStatus: lesson.status, job: jobs[0] ?? null, notes: noteRows });
      if (decision.kind === "noop") {
        // Idempotent, but not inert: audio_path still set on a canceled lesson
        // means the first delete FAILED (it is nulled below on success), so the
        // user's natural remedy — tap Discard again — has to actually retry.
        if (lesson.audioPath && deps.lessons) {
          try {
            await deps.lessons.deleteAudio(lesson.audioPath);
            await db
              .update(lessonSessions)
              .set({ audioPath: null })
              .where(and(eq(lessonSessions.id, lesson.id), eq(lessonSessions.teacherId, me.id)));
            // The first discard's audit recorded audioDeleted:false; this is the
            // only record that the deletion it promised finally happened.
            await userAudit(deps, req, "lesson.discard", { type: "lesson", id: lesson.id }, {
              retriedAudioDelete: true,
              audioDeleted: true,
            });
          } catch (err) {
            console.error("lesson discard: retried audio delete failed", lesson.audioPath, err);
          }
        }
        res.json({ ok: true });
        return;
      }
      if (decision.kind === "deny") {
        res.status(decision.status).json({ error: decision.error, message: decision.message });
        return;
      }

      const claimed = await db.transaction(async (tx) => {
        // CAS on the status we OBSERVED, not on 'created': a submit or a worker
        // write that raced this discard must lose cleanly rather than be
        // overwritten (which would strand a queued job pointing at deleted audio).
        // Canceling also RELEASES the clientLessonId — the create dedupe skips
        // canceled rows, so without this a re-record with the same local id would
        // hit uq_lesson_client_id.
        const [row] = await tx
          .update(lessonSessions)
          .set({ status: "canceled", clientLessonId: null, updatedAt: sql`now()` })
          .where(and(
            eq(lessonSessions.id, lesson.id),
            eq(lessonSessions.teacherId, me.id),
            eq(lessonSessions.status, lesson.status),
          ))
          .returning();
        if (!row) return null;

        // EVERYTHING the discard acts on is re-read HERE, under the lock the CAS
        // just took — never from the pre-lock snapshot. The worker takes the same
        // lesson row FOR UPDATE before it inserts a note or stamps a transcript,
        // so a note committed in that window would otherwise survive the discard
        // and a transcript stamped in it would be orphaned PERMANENTLY (the
        // notes-assets container has no lifecycle rule) while the audit and the
        // admin 410 both say the owner deleted it.
        const lockedJobs = await tx
          .select()
          .from(noteJobs)
          .where(eq(noteJobs.lessonSessionId, lesson.id))
          .orderBy(desc(noteJobs.createdAt));
        const lockedNotes = await tx
          .select({ id: notes.id, status: notes.status, origin: notes.origin })
          .from(notes)
          .where(eq(notes.lessonSessionId, lesson.id));
        // Same policy function, post-lock rows: a note that became sendable in
        // the window revokes the permission, and the CAS unwinds.
        const recheck = discardDecision({ lessonStatus: lesson.status, job: lockedJobs[0] ?? null, notes: lockedNotes });
        if (recheck.kind !== "allow") throw new DiscardRaced();

        // A draft is ours to destroy and a self note is the owner's own data end
        // to end (users.ts already destroys drafts and keeps sent notes on account
        // deletion, for exactly this reason). A sent teacher note is the shared
        // record and never reaches here — the guard refused above.
        const cascadable = lockedNotes
          .filter((n) => (n.origin === "teacher" && n.status === "draft") || n.origin === "self")
          .map((n) => n.id);
        if (cascadable.length) {
          await tx.delete(noteAnnotations).where(inArray(noteAnnotations.noteId, cascadable));
          await tx.delete(notes).where(inArray(notes.id, cascadable));
        }
        if (lockedJobs.length) {
          await tx
            .update(noteJobs)
            .set({
              discardedAt: sql`now()`,
              transcriptPath: null,
              // metrics.warnings carries up to 60 characters of the model's
              // instruction per dropped annotation — verbatim lesson content about
              // a named student. A discard that promises to delete the transcript
              // must strip it; the counts D5 exists to protect all survive.
              metrics: sql`${noteJobs.metrics} - 'warnings'::text`,
              updatedAt: sql`now()`,
            })
            .where(eq(noteJobs.lessonSessionId, lesson.id));
          // A queued job's Service Bus message outlives the discard, and the
          // worker gates on THIS status — terminalizing it here is what stops the
          // run. A job that already reached its own terminal state keeps the code
          // that describes why: overwriting it would attribute a real ASR failure
          // to the discard in the failure-code facet.
          await tx
            .update(noteJobs)
            .set({
              status: "failed",
              stage: null,
              failureCode: "lesson_discarded",
              error: "lesson discarded by owner",
              updatedAt: sql`now()`,
            })
            .where(and(
              eq(noteJobs.lessonSessionId, lesson.id),
              inArray(noteJobs.status, ["queued", "processing"]),
            ));
        }
        return {
          row,
          cascadable,
          jobs: lockedJobs,
          transcriptPaths: lockedJobs.map((j) => j.transcriptPath).filter((p): p is string => Boolean(p)),
        };
      }).catch((err) => {
        if (err instanceof DiscardRaced) return "raced" as const;
        throw err;
      });
      if (claimed === "raced" || !claimed) {
        res.status(409).json({ error: "status_changed", message: "This recording changed while you were deciding — pull to refresh." });
        return;
      }

      // Best-effort blob work outside the transaction: a failed delete must not
      // roll back a discard the user was told succeeded. audio_path is the
      // sentinel — nulled ONLY on a confirmed delete, so "canceled but audio
      // still present" is a one-line reaper query and the repeat-discard path
      // above knows there is something left to retry.
      //
      // The upload SAS minted at create (2h, account-key) cannot be revoked: only
      // rotating the storage key or a container-wide stored access policy would
      // do it, and both break every concurrent upload. Shortening the TTL was
      // rejected — a 320 MB background upload on a slow link needs the headroom.
      // Residual, accepted: a PUT that lands after a successful delete re-creates
      // an orphan blob that no route can reach, collected by the lesson-audio
      // 90-day lifecycle rule.
      let audioDeleted = false;
      if (lesson.audioPath && deps.lessons) {
        try {
          await deps.lessons.deleteAudio(lesson.audioPath);
          audioDeleted = true;
          await db
            .update(lessonSessions)
            .set({ audioPath: null })
            .where(and(eq(lessonSessions.id, lesson.id), eq(lessonSessions.teacherId, me.id)));
        } catch (err) {
          console.error("lesson discard: audio delete failed", lesson.audioPath, err);
        }
      }
      let transcriptDeleted = false;
      if (deps.notesAssets) {
        for (const path of claimed.transcriptPaths) {
          try {
            await deps.notesAssets.deleteAsset(path);
            transcriptDeleted = true;
          } catch (err) {
            console.error("lesson discard: transcript delete failed", path, err);
          }
        }
      }

      if (decision.action === "lesson.cancel") {
        await userAudit(deps, req, "lesson.cancel", { type: "lesson", id: lesson.id }, { audioDeleted });
      } else {
        await userAudit(deps, req, "lesson.discard", { type: "lesson", id: lesson.id }, {
          jobId: claimed.jobs[0]?.id ?? null,
          failureCode: claimed.jobs[0]?.failureCode ?? null,
          attempts: claimed.jobs[0]?.attempts ?? 0,
          notesDeleted: claimed.cascadable.length,
          audioDeleted,
          transcriptDeleted,
        });
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
