import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { upsertCustomPiece } from "./customPieces";
import { notesAccess } from "../notes/entitlement";
import { narrationPrefix } from "../notes/narration";
import { REGROUND_HINT, regroundSlot } from "../notes/reground";
import { syncLessonSlot, syncNoteSlot } from "../notes/slot_sync";
import { lessonPieceWire, lessonPiecesFor } from "../notes/pieces_wire";
import { MAX_SLOTS, SLOT_STEP } from "../notes/slot_crud";
import { pgErrorCode } from "../db/pgerror";
import { isUuid } from "../ids";
import type { Orm } from "../db/client";
import {
  lessonPieces,
  lessonSessions,
  noteAnnotations,
  noteJobs,
  notes,
  pieces,
  scoreScans,
  teacherStudentLinks,
} from "../db/schema";

// Backstop only — the client already refuses an over-cap file before transferring it.
const MAX_AUDIO_BYTES = 320 * 1024 * 1024;

// Client renders `message` verbatim when unmapped, and create/PATCH share these strings so the two write paths cannot drift.
const MSG_SOLO_NO_STUDENT = "A recording you made yourself is your own — there is no student to send it to.";
const MSG_UNKNOWN_PIECE = "That piece isn't in the library. Choose another piece, or type its name instead.";
const MSG_NOT_YOUR_STUDENT = "That student isn't on your roster anymore. Invite them again, then choose them.";
// Lives here rather than in notes.ts because notes.ts already imports from this file; the reverse would be a cycle.
export const MSG_NOTE_NAMES_PIECE = "A note that names a piece from the library can't carry score photos.";

// ── Discard / retry policy ────────────────────────────────────────────────────
// Pure and shared: the same function computes both the route's decision and the *Allowed flag on the wire, so they cannot drift apart.

// ~1.5x ASR_POLL_MAX (40 min, worker/notes/main.py) — the worst honest time before a job is wedged.
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
  // Idempotency first — a retried discard must return 200, never flap with a 404/409.
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
  return { kind: "allow", action: "lesson.discard" };
}

export function discardAllowed(input: DiscardInput): boolean {
  return discardDecision(input).kind !== "deny";
}

// Cap 0 is CATEGORICAL — the `cap > 0` guard in retryDecision must stay, or a byte-identical re-run gets funded again.
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
  // Bonus is piece-change only — a student assignment must never fund it, and each further piece edit re-arms it by design.
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

export const PIECE_SOURCES = ["catalog", "vendored", "typed"] as const;
export type PieceSource = (typeof PIECE_SOURCES)[number];

// Unmapped values must stay NULL, never coerced — the off-catalog rate metric reads this column directly.
export function readPieceSource(raw: unknown): PieceSource | null {
  return typeof raw === "string" && (PIECE_SOURCES as readonly string[]).includes(raw)
    ? (raw as PieceSource)
    : null;
}

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];

type ScanCheck =
  | { kind: "ok"; id: string | null }
  | { kind: "miss" };

// A scan someone else owns, or one taken down, is not an error to explain — it is a scan that does not exist for this caller.
// Readiness is deliberately NOT required: a scan has its id before its first page uploads, and PATCH /v1/notes/:id accepts one too.
async function ownedScan(db: Orm, ownerId: string, value: unknown): Promise<ScanCheck> {
  if (value === null || value === undefined) return { kind: "ok", id: null };
  if (!isUuid(value)) return { kind: "miss" };
  const [scan] = await db
    .select({ id: scoreScans.id, status: scoreScans.status, blobPath: scoreScans.blobPath })
    .from(scoreScans)
    .where(and(eq(scoreScans.id, value), eq(scoreScans.ownerId, ownerId)))
    .limit(1);
  // Same two conditions the read path calls "gone" — a scan whose bytes can never be served again must not be attachable.
  if (!scan || scan.status === "taken_down" || (scan.status === "ready" && scan.blobPath === null)) {
    return { kind: "miss" };
  }
  return { kind: "ok", id: scan.id };
}

// Drizzle wraps the driver error, so the SQLSTATE is on a cause several links down.

type ReplayFacts = {
  studentId: string | null;
  pieceId: string | null;
  pieceLabel: string | null;
  pieceSource: string | null;
  scoreScanId: string | null;
};

// A retry whose first response never reached the client carries facts the row never received; fill only what is still null, so a deliberate later edit is never undone by a stale replay.
async function adoptMissingFacts(
  db: Orm,
  ownerId: string,
  row: typeof lessonSessions.$inferSelect,
  facts: ReplayFacts,
): Promise<typeof lessonSessions.$inferSelect> {
  const patch: Record<string, unknown> = {};
  if (row.studentId === null && facts.studentId !== null) patch.studentId = facts.studentId;
  const holdsScan = row.scoreScanId !== null;
  const holdsPiece = row.pieceId !== null;
  if (row.pieceId === null && facts.pieceId !== null && !holdsScan) patch.pieceId = facts.pieceId;
  if (row.pieceLabel === null && facts.pieceLabel !== null) patch.pieceLabel = facts.pieceLabel;
  if (row.pieceSource === null && facts.pieceSource !== null) patch.pieceSource = facts.pieceSource;
  if (row.scoreScanId === null && facts.scoreScanId !== null && !holdsPiece && patch.pieceId === undefined) {
    patch.scoreScanId = facts.scoreScanId;
  }
  if (patch.pieceId !== undefined || patch.pieceLabel !== undefined || patch.scoreScanId !== undefined) {
    patch.pieceUpdatedAt = sql`now()`;
  }
  if (Object.keys(patch).length === 0) return row;
  return await db.transaction(async (tx) => {
    // Only when the label itself was adopted — minting from a label this row rejected would hang a stranger's words off the lesson.
    if (patch.pieceLabel !== undefined && row.customPieceId === null && facts.pieceSource === "typed") {
      patch.customPieceId = await upsertCustomPiece(tx, ownerId, facts.pieceLabel!);
    }
    const [updated] = await tx
      .update(lessonSessions)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(lessonSessions.id, row.id))
      .returning();
    if (updated) await syncLessonSlot(tx, updated);
    return updated ?? row;
  });
}

// Must throw, not return — returning here would COMMIT the CAS despite the revoked permission.
class DiscardRaced extends Error {}

/// This list is the wire contract, not the table's columns — a new lessonSessions column reaches the app only by being added here.
function lessonWire(row: typeof lessonSessions.$inferSelect) {
  return {
    id: row.id,
    teacherId: row.teacherId,
    studentId: row.studentId,
    ownerRole: row.ownerRole,
    clientLessonId: row.clientLessonId,
    pieceId: row.pieceId,
    pieceLabel: row.pieceLabel,
    pieceSource: row.pieceSource,
    pieceUpdatedAt: row.pieceUpdatedAt,
    customPieceId: row.customPieceId,
    scoreScanId: row.scoreScanId,
    language: row.language,
    attested: row.attested,
    audioPath: row.audioPath,
    audioBytes: row.audioBytes,
    durationSec: row.durationSec,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// pieceId/studentId are deliberately nullable — both stay fixable later at review.
export function lessonsRouter(deps: Deps): Router {
  const router = Router();
  const guards = [requireAuth(deps.auth), requireUser(deps)];

  router.post(
    "/v1/lessons",
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
      if (!deps.lessons) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const body = req.body ?? {};
      // Snapshot at record time — never re-derived later, even if the account gains a role afterward.
      let ownerRole = me.isTeacher ? "teacher" : "student";
      let pieceId = typeof body.pieceId === "string" ? body.pieceId : null;
      let pieceLabel = typeof body.pieceLabel === "string" && body.pieceLabel.trim()
        ? body.pieceLabel.trim()
        : null;
      const studentId = typeof body.studentId === "string" ? body.studentId : null;
      const clientLessonId = typeof body.clientLessonId === "string" && body.clientLessonId.trim()
        ? body.clientLessonId
        : null;
      let pieceSource = readPieceSource(body.pieceSource);

      // Per-entry soft-drop, never a hard refusal: one stale id in the list must not cost the
      // recording, which is the irreplaceable half. An entry naming a piece keeps the piece and
      // drops its scan, the same exclusivity every other writer enforces.
      let planned: { pieceId: string | null; pieceLabel: string | null;
                     pieceSource: string | null; scoreScanId: string | null }[] = [];
      if (Array.isArray(body.pieces)) {
        for (const raw of (body.pieces as unknown[]).slice(0, MAX_SLOTS)) {
          if (typeof raw !== "object" || raw === null) continue;
          const item = raw as Record<string, unknown>;
          let entryPieceId = typeof item.pieceId === "string" ? item.pieceId : null;
          const entryLabel = typeof item.pieceLabel === "string" && item.pieceLabel.trim()
            ? item.pieceLabel.trim() : null;
          const entrySource = readPieceSource(item.pieceSource);
          let entryScanId: string | null = null;
          if (entryPieceId) {
            const [known] = await db.select({ id: pieces.id }).from(pieces)
              .where(eq(pieces.id, entryPieceId)).limit(1);
            if (!known) entryPieceId = null;
          }
          if (!entryPieceId && item.scoreScanId !== undefined) {
            const entryScan = await ownedScan(db, me.id, item.scoreScanId);
            entryScanId = entryScan.kind === "miss" ? null : entryScan.id;
          }
          if (entryPieceId === null && entryLabel === null && entryScanId === null) continue;
          planned.push({ pieceId: entryPieceId, pieceLabel: entryLabel,
                         pieceSource: entrySource, scoreScanId: entryScanId });
        }
      }

      // The singular columns stay what every reader and installed binary consults, so the first
      // planned piece BECOMES them rather than riding alongside.
      const singularFromBody = { pieceId, pieceLabel, pieceSource };
      if (planned.length) {
        pieceId = planned[0]!.pieceId;
        pieceLabel = planned[0]!.pieceLabel;
        pieceSource = planned[0]!.pieceSource as ReturnType<typeof readPieceSource>;
        body.scoreScanId = planned[0]!.scoreScanId;
      }

      // Absent falls back to the teacher-wins default — must stay for pre-B1.5 clients that never send this field.
      const requested = body.ownerRole;
      if (requested === "teacher" || requested === "student") {
        if ((requested === "teacher" && !me.isTeacher) || (requested === "student" && !me.isStudent)) {
          res.status(400).json({ error: "role_mismatch" });
          return;
        }
        ownerRole = requested;
      }

      // Validity gates run BEFORE the idempotency shortcut: a replay that adopts facts must not become a way around the checks a fresh create makes.
      if (ownerRole === "student" && studentId) {
        res.status(400).json({ error: "solo_lesson_no_student", message: MSG_SOLO_NO_STUDENT });
        return;
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
      // The recording is the irreplaceable half: a scan deleted between the lesson and its upload costs the score, never the lesson.
      const scan = await ownedScan(db, me.id, body.scoreScanId);
      const scoreScanId = scan.kind === "miss" ? null : scan.id;
      if (scoreScanId && pieceId) {
        res.status(409).json({ error: "note_names_piece", message: MSG_NOTE_NAMES_PIECE });
        return;
      }

      // The entitlement gate stays BELOW this — a retried POST for an existing row must return it even if the trial lapsed since.
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
          // Only onto a lesson with NO slots: a replay that re-planted rows would duplicate or
          // reorder a list the teacher may since have edited in review.
          let plantedOnReplay = false;
          if (planned.length) {
            plantedOnReplay = await db.transaction(async (tx) => {
              const [existing] = await tx.select({ id: lessonPieces.id }).from(lessonPieces)
                .where(eq(lessonPieces.lessonSessionId, dup.id)).limit(1);
              if (existing) return false;
              for (let i = 0; i < planned.length; i++) {
                const entry = planned[i]!;
                await tx.insert(lessonPieces).values({
                  lessonSessionId: dup.id,
                  sortIndex: i * SLOT_STEP,
                  pieceId: entry.pieceId,
                  pieceLabel: entry.pieceLabel,
                  pieceSource: entry.pieceSource,
                  customPieceId: entry.pieceSource === "typed" && entry.pieceLabel
                    ? await upsertCustomPiece(tx, me.id, entry.pieceLabel)
                    : null,
                  scoreScanId: entry.scoreScanId,
                });
              }
              return true;
            });
          }
          // A replay whose list did NOT land keeps its list's facts to itself: half-adopting
          // planned[0] onto a lesson that already has slots rewrites the first of a list the
          // teacher may since have edited.
          const adopted = await adoptMissingFacts(db, me.id, dup, plantedOnReplay || !planned.length ? {
            studentId,
            pieceId,
            pieceLabel,
            pieceSource,
            scoreScanId,
          } : { studentId, ...singularFromBody, scoreScanId: null });
          // audioPath must never be null in the response — the client's fielded decoder treats uploadUrl as non-optional.
          let audioPath = adopted.audioPath;
          if (!audioPath) {
            audioPath = deps.lessons.blobPath(me.id, adopted.id);
            await db.update(lessonSessions).set({ audioPath, updatedAt: sql`now()` }).where(eq(lessonSessions.id, adopted.id));
          }
          res.status(200).json({
            lesson: { ...adopted, audioPath },
            uploadUrl: deps.lessons.uploadUrl(audioPath),
          });
          return;
        }
      }

      if (ownerRole === "student") {
        if (body.attested !== true) {
          res.status(400).json({ error: "attestation_required", message: "Confirm your teacher knows this lesson is being recorded." });
          return;
        }
        // Create-time entitlement check is UX only; submit is the real cost guard (trial can lapse in between).
        const access = await notesAccess(deps, me);
        if (access.status === "lapsed") {
          res.status(402).json({ error: "entitlement_required", access });
          return;
        }
      }

      const startedAt = body.startedAt ? new Date(body.startedAt) : null;
      const endedAt = body.endedAt ? new Date(body.endedAt) : null;
      // One transaction — an entity that mints without its lesson (or vice versa) is worse than neither existing.
      let row: typeof lessonSessions.$inferSelect | undefined;
      try {
        row = await db.transaction(async (tx) => {
          const customPieceId = pieceSource === "typed" && pieceLabel
            ? await upsertCustomPiece(tx, me.id, pieceLabel)
            : null;
          const [inserted] = await tx
            .insert(lessonSessions)
            .values({
              teacherId: me.id,
              ownerRole,
              clientLessonId,
              studentId,
              pieceId,
              pieceLabel,
              pieceSource,
              customPieceId,
              scoreScanId,
              startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
              endedAt: endedAt && !Number.isNaN(endedAt.getTime()) ? endedAt : null,
              durationSec: Number.isFinite(body.durationSec) ? Math.round(body.durationSec) : null,
              attested: body.attested === true,
            })
            .returning();
          // Before the sync: it mirrors the singular columns into the LOWEST slot, and with these
          // rows already present that lowest slot is planned[0], so the mirror converges to a no-op.
          for (let i = 0; i < planned.length; i++) {
            const entry = planned[i]!;
            await tx.insert(lessonPieces).values({
              lessonSessionId: inserted!.id,
              sortIndex: i * SLOT_STEP,
              pieceId: entry.pieceId,
              pieceLabel: entry.pieceLabel,
              pieceSource: entry.pieceSource,
              customPieceId: entry.pieceSource === "typed" && entry.pieceLabel
                ? await upsertCustomPiece(tx, me.id, entry.pieceLabel)
                : null,
              scoreScanId: entry.scoreScanId,
            });
          }
          await syncLessonSlot(tx, inserted!);
          return inserted;
        });
      } catch (err) {
        // Two retries in flight at once: the loser must be handed the winner, not a 500 that costs the recording.
        if (!clientLessonId || pgErrorCode(err) !== "23505") throw err;
        const [winner] = await db
          .select()
          .from(lessonSessions)
          .where(and(
            eq(lessonSessions.teacherId, me.id),
            eq(lessonSessions.clientLessonId, clientLessonId),
          ))
          .limit(1);
        if (!winner) throw err;
        let audioPath = winner.audioPath;
        if (!audioPath) {
          audioPath = deps.lessons.blobPath(me.id, winner.id);
          await db.update(lessonSessions).set({ audioPath, updatedAt: sql`now()` }).where(eq(lessonSessions.id, winner.id));
        }
        res.status(200).json({
          lesson: { ...winner, audioPath },
          uploadUrl: deps.lessons.uploadUrl(audioPath),
        });
        return;
      }
      const path = deps.lessons.blobPath(me.id, row!.id);
      await db.update(lessonSessions).set({ audioPath: path }).where(eq(lessonSessions.id, row!.id));
      await userAudit(deps, req, "lesson.create", { type: "lesson", id: row!.id });
      // Logged only for typed pieces — this is how the off-catalog rate is measured without reading lesson labels directly.
      if (pieceSource === "typed") {
        console.log(JSON.stringify({
          kind: "piece_typed", op: "lesson.create", reqId: req.reqId ?? null,
          lessonId: row!.id, ownerRole,
        }));
      }
      res.status(201).json({
        lesson: { ...lessonWire(row!), audioPath: path },
        uploadUrl: deps.lessons.uploadUrl(path),
      });
    }),
  );

  // Route exists because the ~2h SAS minted at create can expire before an offline outbox retry fires.
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
      // Canceled must stay its own error, never already_submitted — the app treats that code as success and would resurrect the discard.
      if (lesson.status === "canceled") {
        res.status(409).json({ error: "lesson_canceled" });
        return;
      }
      if (lesson.status !== "created") {
        res.status(409).json({ error: "already_submitted" });
        return;
      }
      // Submit is the real cost gate — re-checks entitlement even though create already did, since the trial can lapse in between.
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

      // CAS out of 'created' first — only the winner of a race (submit vs cancel) may create a job; the check above is just a friendly early-out.
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

  // Feeds both the teacher home AND the student recordings shelf — ownerRole filter keeps a dual-role account's two pipelines apart.
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
      // notes.studentId is selected separately — a non-cascading PATCH can leave a draft's value diverged from the lesson's.
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
              ...lessonWire(lesson),
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
          ...lessonWire(lesson),
          discardAllowed: discardAllowed({ lessonStatus: lesson.status, job, notes: noteRows }),
        },
        // Additive beside the singular projection above; empty only when the lesson names nothing.
        pieces: (await lessonPiecesFor(db, lesson)).map(lessonPieceWire),
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

  // Assignment always writes the lesson fact; it cascades to the delivery only while that's still ours to change (teacher DRAFT or solo SELF) — never a human's sent choice.
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
      // pieceSource is only accepted alongside a pieceId/pieceLabel change — never patchable alone.
      const pieceSource = hasPieceId || hasPieceLabel ? readPieceSource(body.pieceSource) : undefined;
      if (!hasStudent && !hasPieceId && !hasPieceLabel) {
        res.status(400).json({ error: "nothing_to_update" });
        return;
      }
      // A miss is 404, never 403 — a 403 would confirm someone else's lesson exists.
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
        /// True when this PATCH is what took the photographed pages off — the client cannot see the pre-patch row and would otherwise report the loss to nobody.
        scoreDetached?: boolean;
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
        // Decided on the locked row, not the earlier read: naming a piece puts the photographs away here exactly as it already does on the note, and the caller is told which happened.
        const lessonScoreDetached = pieceId != null && locked.scoreScanId !== null;
        if (lessonScoreDetached) patch.scoreScanId = null;
        if (pieceLabel !== undefined) patch.pieceLabel = pieceLabel;
        if (pieceSource !== undefined) patch.pieceSource = pieceSource;
        // customPieceId must follow the resolved label (patch or existing), not just what this patch sent.
        const effectiveLabel = pieceLabel !== undefined ? pieceLabel : locked.pieceLabel;
        if (pieceSource === "typed" && effectiveLabel) {
          patch.customPieceId = await upsertCustomPiece(tx, me.id, effectiveLabel);
        } else if (pieceSource !== undefined) {
          // Must null customPieceId here — an entity outliving its label lets the chip claim a name nobody typed.
          patch.customPieceId = null;
        }
        // The retry bonus reads pieceUpdatedAt — it must mean "the prompt would differ", never just "the row was touched".
        const pieceChanged =
          (pieceId !== undefined && pieceId !== before.pieceId) ||
          (pieceLabel !== undefined && pieceLabel !== before.pieceLabel);
        if (pieceChanged) patch.pieceUpdatedAt = sql`now()`;
        const [updatedLesson] = await tx
          .update(lessonSessions)
          .set(patch)
          .where(and(eq(lessonSessions.id, locked.id), eq(lessonSessions.teacherId, me.id)))
          .returning();
        await syncLessonSlot(tx, updatedLesson!);

        // Reground fires because unpieced measures were accepted unbounded — naming the piece late is what can make a number go out of range.
        const shouldReground = pieceId !== undefined && pieceId !== null && pieceId !== before.pieceId && newPieceMeasures !== null;

        const rows = await tx.select().from(notes).where(eq(notes.lessonSessionId, locked.id));
        const touched: PatchedNote[] = [];
        let regrounded = 0;
        let studentCascadedTo: string | null = null;
        for (const n of rows) {
          const ours = (n.origin === "teacher" && n.status === "draft") || n.origin === "self";
          const np: Record<string, unknown> = {};
          if (ours) {
            // Inherit test: a note whose value still equals the pre-patch lesson value follows the change; a human-chosen different value is left alone.
            if (studentId !== undefined && n.origin === "teacher" && n.studentId === before.studentId) {
              np.studentId = studentId;
            }
            if (pieceId !== undefined && n.pieceId === before.pieceId) np.pieceId = pieceId;
            if (pieceLabel !== undefined && n.pieceLabel === before.pieceLabel) np.pieceLabel = pieceLabel;
            // Self notes are born 'sent' at worker insert — there's no later send event to pin pieceVersion at, so it happens here.
            if ("pieceId" in np && n.origin === "self") np.pieceVersion = newPieceVersion;
            if (np.pieceId) np.scoreScanId = null;
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
          const mirrored = await syncNoteSlot(tx, u!);
          if ("studentId" in np) studentCascadedTo = u!.id;
          // shouldReground implies a non-null pieceId, so the mirror always exists by here.
          if (shouldReground && mirrored && "pieceId" in np) {
            regrounded += await regroundSlot(tx, n.id, mirrored, newPieceMeasures!);
          }
          touched.push({
            id: u!.id,
            origin: u!.origin,
            status: u!.status,
            updated: true,
            studentId: u!.studentId,
            pieceId: u!.pieceId,
            scoreDetached: n.scoreScanId !== null && u!.scoreScanId === null,
          });
        }
        return { lesson: updatedLesson!, notes: touched, regrounded, before, studentCascadedTo,
                 lessonScoreDetached };
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
        // job must be included here — nothing refetches after an apply, so without it the UI keeps showing the pre-bonus retry message.
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
        // The caller cannot see the pre-patch row, so without this the photographs come off and nobody is told.
        scoreDetached: out.lessonScoreDetached,
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
          failureCode: null,
          failureHints: [],
          attempts: sql`${noteJobs.attempts} + 1`,
          // startedAt resets here because the client's elapsed-counter UI reads it — a retry must not show the first attempt's age.
          startedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(noteJobs.id, job!.id))
        .returning();
      try {
        await deps.notesQueue.send({ jobId: job!.id, reqId: req.reqId });
      } catch (err) {
        // Rollback must restore every prior field including updatedAt — re-stamping it would silently consume the piece bonus that authorized this retry.
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

  // One route for cancel+delete: client state is from a poll and can go stale before the tap, so the server decides via discardDecision(), not the client.
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
        // audio_path still set on a canceled lesson means the earlier delete FAILED — a repeat Discard tap must retry it, not just no-op.
        if (lesson.audioPath && deps.lessons) {
          try {
            await deps.lessons.deleteAudio(lesson.audioPath);
            await db
              .update(lessonSessions)
              .set({ audioPath: null })
              .where(and(eq(lessonSessions.id, lesson.id), eq(lessonSessions.teacherId, me.id)));
            // This second audit entry is the only record that the audio deletion the first discard promised actually happened.
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
        // Canceling releases clientLessonId — create's dedupe skips canceled rows, so keeping it set would collide with uq_lesson_client_id on a re-record.
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

        // Must re-read jobs/notes under this lock, never the pre-lock snapshot — the worker takes the same row FOR UPDATE, so a race-window write would otherwise survive the discard.
        const lockedJobs = await tx
          .select()
          .from(noteJobs)
          .where(eq(noteJobs.lessonSessionId, lesson.id))
          .orderBy(desc(noteJobs.createdAt));
        const lockedNotes = await tx
          .select({ id: notes.id, status: notes.status, origin: notes.origin })
          .from(notes)
          .where(eq(notes.lessonSessionId, lesson.id));
        // Re-runs the same policy on post-lock rows — a note that became sendable in the race window revokes permission and unwinds the CAS.
        const recheck = discardDecision({ lessonStatus: lesson.status, job: lockedJobs[0] ?? null, notes: lockedNotes });
        if (recheck.kind !== "allow") throw new DiscardRaced();

        // Mirrors users.ts's account-deletion cascade (destroy drafts, keep sent notes) — keep the two in sync.
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
              modelOutputPath: null,  // quotes the lesson verbatim, like the transcript
              // metrics.warnings holds verbatim lesson content (up to 60 chars per annotation) and must be stripped; the other counts must survive intact.
              metrics: sql`${noteJobs.metrics} - 'warnings'::text`,
              // Verbatim lesson words, like everything else stripped here.
              pieceMentions: [],
              updatedAt: sql`now()`,
            })
            .where(eq(noteJobs.lessonSessionId, lesson.id));
          // Only overwrite queued/processing jobs — an already-terminal job keeps its real failure code, or the discard corrupts the failure-code analytics.
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
          transcriptPaths: lockedJobs
            .flatMap((j) => [j.transcriptPath, j.modelOutputPath])
            .filter((p): p is string => Boolean(p)),
        };
      }).catch((err) => {
        if (err instanceof DiscardRaced) return "raced" as const;
        throw err;
      });
      if (claimed === "raced" || !claimed) {
        res.status(409).json({ error: "status_changed", message: "This recording changed while you were deciding — pull to refresh." });
        return;
      }

      // The create-time SAS can't be revoked without breaking concurrent uploads — a stray post-delete PUT creating an orphan blob is accepted, cleaned up by the 90-day lifecycle rule.
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
        for (const noteId of claimed.cascadable) {
          try {
            await deps.notesAssets.deletePrefix(narrationPrefix(noteId));
          } catch (err) {
            console.error("lesson discard: narration purge failed", noteId, err);
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
