import { Router } from "express";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { noteIsLocked, notesAccess } from "../notes/entitlement";
import { ASSET_READ_SAS_MINUTES } from "../notes/assets_store";
import {
  DEFAULT_NARRATION_VOICE,
  NARRATION_OVERVIEW_CLIP,
  NARRATION_VOICES,
  isNarrationVoice,
  narrationClipPath,
  narrationPrefix,
} from "../notes/narration";
import { notifyNoteSent } from "../notes/push";
import { REGROUND_HINT } from "./lessons";
import type { Orm } from "../db/client";
import { normalizeLabel, upsertCustomPiece } from "./customPieces";
import {
  asStringArray,
  computeSuggestion,
  type CandidatePiece,
  type Suggestion,
} from "../notes/piece_suggestion";
import {
  customPieces,
  devices,
  lessonSessions,
  noteAnnotations,
  noteJobs,
  noteNarrationClips,
  notes,
  pieces,
  teacherStudentLinks,
  users,
} from "../db/schema";

type NoteRow = typeof notes.$inferSelect;

// Eligibility, then computation. Every arm here is a REMOVAL: a sent note, an
// explicit piece, a vendored pick (an explicit choice delivered as nil-id + label),
// a dismissal, or two survivors all end in silence.
async function suggestionFor(deps: Deps, note: NoteRow): Promise<Suggestion | null> {
  if (note.status !== "draft" || note.pieceId) return null;
  const db = deps.db!.orm;

  const [lesson] = note.lessonSessionId
    ? await db
        .select({
          pieceSource: lessonSessions.pieceSource,
          pieceLabel: lessonSessions.pieceLabel,
          customPieceId: lessonSessions.customPieceId,
        })
        .from(lessonSessions)
        .where(eq(lessonSessions.id, note.lessonSessionId))
        .limit(1)
    : [];
  if (lesson?.pieceSource === "vendored") return null;

  const mentions = note.noteJobId
    ? asStringArray(
        (
          await db
            .select({ pieceMentions: noteJobs.pieceMentions })
            .from(noteJobs)
            .where(eq(noteJobs.id, note.noteJobId))
            .limit(1)
        )[0]?.pieceMentions,
      )
    : [];

  const mine = await db
    .select()
    .from(customPieces)
    .where(eq(customPieces.teacherId, note.teacherId));
  const ownId = note.customPieceId ?? lesson?.customPieceId ?? null;
  const own = mine.find((c) => c.id === ownId) ?? null;
  if (!own && !mentions.length) return null;

  const catalog = await db
    .select({ id: pieces.id, title: pieces.title, subtitle: pieces.subtitle, composer: pieces.composer })
    .from(pieces)
    .where(eq(pieces.status, "published"));

  // The teacher's OWN vocabulary joins the candidate set (FG-18) as things a mention
  // could equally have meant. An unlinked one carries no piece to confirm, so when it
  // wins the chip stays silent — a linked one is already its catalog piece here.
  const ownPseudo: CandidatePiece[] = mine
    .filter((c) => c.id !== ownId && !c.linkedPieceId)
    .map((c) => ({ id: `custom:${c.id}`, title: c.displayLabel, subtitle: "", composer: "" }));

  const dismissed = [
    ...asStringArray(note.pieceSuggestionDismissed),
    ...(own ? asStringArray(own.dismissedPieceIds) : []),
  ];

  // The library arm claims the catalog holds THE NAME ON THE SCREEN. The entity
  // outlives a rename, so the claim dies unless the two are still the same name.
  const shown = note.pieceLabel ?? lesson?.pieceLabel ?? null;
  const claimable = own && shown && normalizeLabel(own.displayLabel) === normalizeLabel(shown);

  const suggestion = computeSuggestion({
    customLabel: claimable ? own.displayLabel : null,
    mentions,
    candidates: [...catalog, ...ownPseudo],
    dismissedPieceIds: dismissed,
  });
  if (!suggestion || suggestion.pieceId.startsWith("custom:")) return null;
  return suggestion;
}

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];

// Cleared at every resolution point (confirm, dismiss, send, discard): the chip is
// draft-only, nothing reads these afterward, and they are the teacher's and a
// minor's words quoted verbatim.
export async function clearPieceMentions(tx: Tx, jobId: string | null): Promise<void> {
  if (!jobId) return;
  await tx.update(noteJobs).set({ pieceMentions: [], updatedAt: sql`now()` }).where(eq(noteJobs.id, jobId));
}

// Demote every auto-placed anchor that points past the end of the newly named piece.
// Human pins are deliberate placements and are never touched.
async function reground(tx: Tx, noteId: string, measures: number): Promise<void> {
  const rows = await tx.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, noteId));
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
  }
}

async function noteWithAnnotations(deps: Deps, noteId: string) {
  const db = deps.db!.orm;
  const [note] = await db.select().from(notes).where(eq(notes.id, noteId)).limit(1);
  const annotations = await db
    .select()
    .from(noteAnnotations)
    .where(eq(noteAnnotations.noteId, noteId))
    .orderBy(asc(noteAnnotations.idx));
  return { note: note!, annotations, pieceSuggestion: note ? await suggestionFor(deps, note) : null };
}

function strippedForStudent(note: NoteRow) {
  const { pieceSuggestionDismissed: _d, customPieceId: _c, ...rest } = note;
  return rest;
}

export function notesRouter(deps: Deps): Router {
  const router = Router();
  const guards = [requireAuth(deps.auth), requireUser(deps)];

  // ── Teacher side ──────────────────────────────────────────────────────────────
  // Every teacher-side surface is HARD-scoped to origin='teacher' AND isTeacher:
  // a dual-role account's solo self-notes (teacher_id = student_id = them) must
  // never surface in review/retract/duplicate — they live exclusively behind
  // /v1/me/notes — and a pure-student token gets 403, never an empty-but-real list.
  const requireTeacher = (me: { isTeacher: boolean }, res: { status(n: number): { json(b: unknown): unknown } }): boolean => {
    if (me.isTeacher) return true;
    res.status(403).json({ error: "teacher_only", message: "This account isn't set up as a teacher." });
    return false;
  };

  router.get(
    "/v1/notes",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!requireTeacher(me, res)) return;
      const db = deps.db!.orm;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const studentId = typeof req.query.studentId === "string" ? req.query.studentId : undefined;
      const conds = [eq(notes.teacherId, me.id), eq(notes.origin, "teacher")];
      if (status) conds.push(eq(notes.status, status));
      if (studentId) conds.push(eq(notes.studentId, studentId));
      const rows = await db
        .select()
        .from(notes)
        .where(and(...conds))
        .orderBy(desc(notes.createdAt))
        .limit(200);
      res.json({ items: rows });
    }),
  );

  router.get(
    "/v1/notes/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!requireTeacher(me, res)) return;
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id), eq(notes.origin, "teacher")))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const annotations = await db
        .select()
        .from(noteAnnotations)
        .where(eq(noteAnnotations.noteId, note.id))
        .orderBy(asc(noteAnnotations.idx));
      // Computed at READ time, never stored: a catalog that grew after processing
      // still surfaces, and a dismissal applies the moment it is made.
      res.json({ note, annotations, pieceSuggestion: await suggestionFor(deps, note) });
    }),
  );

  // Draft-only edits. Annotations are a full replacement; quotes are provenance,
  // so rows keeping their id keep their stored quote regardless of the payload.
  router.patch(
    "/v1/notes/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!requireTeacher(me, res)) return;
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id), eq(notes.origin, "teacher")))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (note.status !== "draft") {
        res.status(409).json({ error: "not_editable", message: "Sent notes can't be edited — retract, fix, and resend." });
        return;
      }
      const body = req.body ?? {};
      const patch: Record<string, unknown> = { editedAt: sql`now()`, updatedAt: sql`now()` };
      if (body.content && typeof body.content === "object") patch.content = body.content;
      if ("studentId" in body) {
        const studentId = body.studentId as string | null;
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
        patch.studentId = studentId;
      }
      if ("pieceId" in body) {
        const pieceId = body.pieceId as string | null;
        if (pieceId) {
          const [piece] = await db.select({ id: pieces.id }).from(pieces).where(eq(pieces.id, pieceId)).limit(1);
          if (!piece) {
            res.status(400).json({ error: "unknown_piece" });
            return;
          }
        }
        patch.pieceId = pieceId;
      }
      if ("pieceLabel" in body) {
        patch.pieceLabel = typeof body.pieceLabel === "string" && body.pieceLabel.trim() ? body.pieceLabel.trim() : null;
      }
      // One transaction, CAS on draft: a racing send must never lose an edit to a
      // sent note, and a crash must never leave a note with content updated but its
      // annotations half-rewritten. Annotations are worker-authored — the client
      // may reorder, edit instruction/category/location, or DELETE (omit an id),
      // but NEVER create a row or alter a quote (verbatim provenance lives server-side).
      let dropped: string[] = [];
      const updated = await db.transaction(async (tx) => {
        const [u] = await tx
          .update(notes)
          .set(patch)
          .where(and(eq(notes.id, note.id), eq(notes.status, "draft")))
          .returning();
        if (!u) return null;

        if (Array.isArray(body.annotations)) {
          const existing = await tx
            .select()
            .from(noteAnnotations)
            .where(eq(noteAnnotations.noteId, note.id));
          const byId = new Map(existing.map((a) => [a.id, a]));
          const keep = new Set<string>();
          let idx = 0;
          for (const a of body.annotations as Record<string, unknown>[]) {
            const id = typeof a.id === "string" ? a.id : null;
            const row = id ? byId.get(id) : undefined;
            if (!row) continue; // no id / unknown id: cannot mint an unsourced annotation
            keep.add(row.id);
            await tx
              .update(noteAnnotations)
              .set({
                idx: idx++,
                category: typeof a.category === "string" ? a.category : row.category,
                instruction: typeof a.instruction === "string" ? a.instruction : row.instruction,
                location: a.location && typeof a.location === "object" ? a.location : row.location,
                updatedAt: sql`now()`,
              })
              .where(eq(noteAnnotations.id, row.id));
          }
          const drop = existing.filter((a) => !keep.has(a.id)).map((a) => a.id);
          if (drop.length) await tx.delete(noteAnnotations).where(inArray(noteAnnotations.id, drop));
          dropped = drop;
        }
        return u;
      });
      if (!updated) {
        res.status(409).json({ error: "not_editable", message: "Sent notes can't be edited — retract, fix, and resend." });
        return;
      }
      // The manifest row cascades with the annotation; its audio does not. Nothing
      // would ever address these blobs again — they are a pure storage leak.
      if (dropped.length && deps.notesAssets) {
        try {
          for (const clipId of dropped) {
            for (const voice of NARRATION_VOICES) {
              await deps.notesAssets.deleteAsset(narrationClipPath(note.id, voice, clipId));
            }
          }
        } catch (err) {
          console.error("note.patch: narration purge failed", note.id, err);
        }
      }
      const annotations = await db
        .select()
        .from(noteAnnotations)
        .where(eq(noteAnnotations.noteId, note.id))
        .orderBy(asc(noteAnnotations.idx));
      res.json({ note: updated, annotations });
    }),
  );

  router.post(
    "/v1/notes/:id/send",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!requireTeacher(me, res)) return;
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id), eq(notes.origin, "teacher")))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (note.status !== "draft") {
        res.status(409).json({ error: "already_sent" });
        return;
      }
      const studentId = (typeof req.body?.studentId === "string" ? req.body.studentId : null) ?? note.studentId;
      if (!studentId) {
        res.status(400).json({ error: "student_required", message: "Pick a student before sending." });
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
        res.status(400).json({ error: "not_your_student" });
        return;
      }
      if (!note.pieceId && !note.pieceLabel) {
        res.status(400).json({ error: "piece_required", message: "Name the piece before sending." });
        return;
      }
      // Anchors pin to the live published version — republish renumbers measures.
      let pieceVersion: number | null = null;
      if (note.pieceId) {
        const [piece] = await db
          .select({ publishedVersion: pieces.publishedVersion })
          .from(pieces)
          .where(eq(pieces.id, note.pieceId))
          .limit(1);
        pieceVersion = piece?.publishedVersion ?? null;
      }
      // Send is the third minting point and the commitment point: a name typed fresh
      // into the review label field patches only the note, so without this the piece
      // the teacher actually sent would never group. Precedence is label equality — a
      // note label that DIFFERS from its lesson's was retyped by a human and is typed
      // provenance whatever the lesson says; an equal one follows the lesson, which
      // means an unknown or vendored source mints nothing.
      const updated = await db.transaction(async (tx) => {
        let customPieceId = note.customPieceId;
        if (!note.pieceId && note.pieceLabel) {
          const [lesson] = note.lessonSessionId
            ? await tx
                .select({ pieceLabel: lessonSessions.pieceLabel, customPieceId: lessonSessions.customPieceId })
                .from(lessonSessions)
                .where(eq(lessonSessions.id, note.lessonSessionId))
                .limit(1)
            : [];
          if (lesson && lesson.pieceLabel === note.pieceLabel) {
            customPieceId = lesson.customPieceId;
          } else if (lesson) {
            customPieceId = await upsertCustomPiece(tx, me.id, note.pieceLabel);
          }
        }
        const [row] = await tx
          .update(notes)
          .set({
            status: "sent",
            studentId,
            pieceVersion,
            customPieceId,
            sentAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(notes.id, note.id), eq(notes.status, "draft")))
          .returning();
        if (row) await clearPieceMentions(tx, note.noteJobId);
        return row;
      });
      if (!updated) {
        res.status(409).json({ error: "status_changed" });
        return;
      }
      // Narration made while this was a draft can speak text the teacher edited
      // before sending. The worker re-synthesizes only the clips whose content hash
      // moved, so this fires unconditionally. ONE message, every voice, on the
      // dedicated narration lane — the shape pinned in narration_parity.json, which the
      // worker refuses to guess at. Best-effort: a Service Bus outage must not withhold
      // the note — narrationQueued:false is the trail for a manual requeue.
      let narrationQueued = false;
      if (deps.notesQueue) {
        try {
          await deps.notesQueue.sendNarration({
            noteId: note.id,
            voices: [...NARRATION_VOICES],
            reqId: req.reqId,
          });
          narrationQueued = true;
        } catch (err) {
          console.error("note.send: narration enqueue failed", note.id, err);
        }
      }
      // The out-of-app signal, and the only one: without it a note sent hours after the
      // lesson is discovered by pulling to refresh. It runs after the row is committed and
      // swallows everything, so a dead APNs costs the notification and nothing else.
      const pushed = await notifyNoteSent(deps, { studentId, noteId: note.id });
      await userAudit(deps, req, "note.send", { type: "note", id: note.id }, {
        studentId,
        narrationQueued,
        push: pushed,
      });
      res.json(updated);
    }),
  );

  // Confirm-only. Nothing here is ever reached by the worker, a job, or a read: the
  // ONLY path from a suggestion to notes.piece_id is a teacher pressing a button.
  router.post(
    "/v1/notes/:id/piece-suggestion",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!requireTeacher(me, res)) return;
      const db = deps.db!.orm;
      const body = req.body ?? {};
      const action = body.action;
      const pieceId = typeof body.pieceId === "string" ? body.pieceId : null;
      if ((action !== "confirm" && action !== "dismiss") || !pieceId) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id), eq(notes.origin, "teacher")))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (note.status !== "draft") {
        res.status(409).json({ error: "not_editable", message: "Sent notes can't be edited — retract, fix, and resend." });
        return;
      }

      const fresh = await suggestionFor(deps, note);
      if (action === "confirm" && fresh?.pieceId !== pieceId) {
        // A catalog republish or a second device moved the ground under the button.
        // The stale candidate is never applied.
        res.status(409).json({ error: "suggestion_changed", pieceSuggestion: fresh ?? null });
        return;
      }

      const [lesson] = note.lessonSessionId
        ? await db.select().from(lessonSessions).where(eq(lessonSessions.id, note.lessonSessionId)).limit(1)
        : [];

      if (action === "dismiss") {
        // Both dismissal stores are append-only, so an id that names no piece is
        // permanent litter. Re-checking the id (rather than the live suggestion)
        // keeps the specced silent retry idempotent after the first dismiss lands.
        const [dismissable] = await db
          .select({ id: pieces.id })
          .from(pieces)
          .where(eq(pieces.id, pieceId))
          .limit(1);
        if (!dismissable) {
          res.status(400).json({ error: "unknown_piece" });
          return;
        }
        await db.transaction(async (tx) => {
          const dismissed = [...new Set([...asStringArray(note.pieceSuggestionDismissed), pieceId])];
          await tx
            .update(notes)
            .set({ pieceSuggestionDismissed: dismissed, updatedAt: sql`now()` })
            .where(eq(notes.id, note.id));
          const customId = note.customPieceId ?? lesson?.customPieceId ?? null;
          if (customId) {
            const [entity] = await tx.select().from(customPieces).where(eq(customPieces.id, customId)).limit(1);
            if (entity) {
              await tx
                .update(customPieces)
                .set({
                  dismissedPieceIds: [...new Set([...asStringArray(entity.dismissedPieceIds), pieceId])],
                  updatedAt: sql`now()`,
                })
                .where(eq(customPieces.id, customId));
            }
          }
          await clearPieceMentions(tx, note.noteJobId);
        });
        await userAudit(deps, req, "note.piece_suggestion_dismiss", { type: "note", id: note.id }, { pieceId });
        res.json(await noteWithAnnotations(deps, note.id));
        return;
      }

      const [piece] = await db
        .select({ id: pieces.id, facts: pieces.facts, publishedVersion: pieces.publishedVersion })
        .from(pieces)
        .where(eq(pieces.id, pieceId))
        .limit(1);
      if (!piece) {
        res.status(400).json({ error: "unknown_piece" });
        return;
      }
      const measures = (piece.facts as { measures?: unknown } | null)?.measures;
      const measureCount = typeof measures === "number" && Number.isInteger(measures) && measures > 0 ? measures : null;
      // Undo has to be able to put back exactly what was there, including whether the
      // teacher had picked a vendored piece — restoring a hardcoded "typed" would
      // rewrite their provenance.
      const prior = {
        pieceId: lesson?.pieceId ?? null,
        pieceLabel: lesson?.pieceLabel ?? null,
        pieceSource: lesson?.pieceSource ?? null,
      };

      await db.transaction(async (tx) => {
        if (lesson) {
          await tx
            .update(lessonSessions)
            .set({
              pieceId,
              pieceSource: "catalog",
              customPieceId: null,
              pieceUpdatedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(lessonSessions.id, lesson.id));
        }
        await tx
          .update(notes)
          .set({ pieceId, updatedAt: sql`now()` })
          .where(eq(notes.id, note.id));
        if (measureCount !== null) await reground(tx, note.id, measureCount);
        // "The teacher said X" does not assert "X equals the typed label", so only the
        // library arm — exact name equality — may record a link.
        const customId = note.customPieceId ?? lesson?.customPieceId ?? null;
        if (fresh?.source === "library" && customId) {
          await tx
            .update(customPieces)
            .set({ linkedPieceId: pieceId, linkedAt: sql`now()`, updatedAt: sql`now()` })
            .where(eq(customPieces.id, customId));
        }
        await clearPieceMentions(tx, note.noteJobId);
      });
      await userAudit(deps, req, "note.piece_suggestion_confirm", { type: "note", id: note.id }, {
        pieceId,
        source: fresh?.source ?? null,
      });
      res.json({ ...(await noteWithAnnotations(deps, note.id)), prior });
    }),
  );

  router.post(
    "/v1/notes/:id/retract",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!requireTeacher(me, res)) return;
      const db = deps.db!.orm;
      const [updated] = await db
        .update(notes)
        .set({ status: "retracted", retractedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(
          eq(notes.id, String(req.params.id)),
          eq(notes.teacherId, me.id),
          eq(notes.origin, "teacher"),
          eq(notes.status, "sent"),
        ))
        .returning();
      if (!updated) {
        res.status(409).json({ error: "not_retractable" });
        return;
      }
      await userAudit(deps, req, "note.retract", { type: "note", id: updated.id });
      res.json(updated);
    }),
  );

  // A duplicate speaks the same words in the same order, so its clips are identical to
  // the origin's — and content_hash, which carries no note id, is exactly what makes the
  // worker skip a clip it already made. Copying the audio server-side inside the
  // container is what makes a group send free instead of one full vendor run per
  // recipient. Best-effort and per clip: the manifest row is written only once its blob
  // is actually there, so this can never produce a signed URL that 404s.
  async function copyNarration(
    fromNoteId: string,
    toNoteId: string,
    annotations: { id: string; idx: number }[],
    clipIdByIdx: Map<number, string>,
  ): Promise<void> {
    if (!deps.notesAssets) return;
    const db = deps.db!.orm;
    const rows = await db
      .select()
      .from(noteNarrationClips)
      .where(eq(noteNarrationClips.noteId, fromNoteId));
    const renamed = new Map(annotations.map((a) => [a.id, clipIdByIdx.get(a.idx)]));
    for (const row of rows) {
      const overview = row.clipId === NARRATION_OVERVIEW_CLIP;
      const clipId = overview ? NARRATION_OVERVIEW_CLIP : renamed.get(row.clipId);
      if (!clipId || !isNarrationVoice(row.voice)) continue;
      const blobPath = narrationClipPath(toNoteId, row.voice, clipId);
      try {
        await deps.notesAssets.copyAsset(narrationClipPath(fromNoteId, row.voice, row.clipId), blobPath);
        await db.insert(noteNarrationClips).values({
          noteId: toNoteId,
          annotationId: overview ? null : clipId,
          voice: row.voice,
          clipId,
          kind: row.kind,
          blobPath,
          contentHash: row.contentHash,
          textHash: row.textHash,
          chars: row.chars,
          // A copy is a blob copy: the vendor was never called, so it drained nothing.
          credits: 0,
          bytes: row.bytes,
          model: row.model,
        });
      } catch (err) {
        console.error("note.duplicate: narration copy failed", toNoteId, row.clipId, err);
      }
    }
  }

  // Group send (copy the reviewed draft per student) and fix-after-retract both
  // route through duplication; a retracted origin records its successor.
  router.post(
    "/v1/notes/:id/duplicate",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      if (!requireTeacher(me, res)) return;
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id), eq(notes.origin, "teacher")))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const annotations = await db
        .select()
        .from(noteAnnotations)
        .where(eq(noteAnnotations.noteId, note.id))
        .orderBy(asc(noteAnnotations.idx));
      // One transaction: a copy that exists without its annotations (or a retracted
      // origin pointing at a half-built successor) is worse than no copy.
      const { copy, clipIdByIdx } = await db.transaction(async (tx) => {
        const [c] = await tx
          .insert(notes)
          .values({
            noteJobId: note.noteJobId,
            lessonSessionId: note.lessonSessionId,
            teacherId: me.id,
            studentId: null,
            pieceId: note.pieceId,
            pieceLabel: note.pieceLabel,
            contentOriginal: note.contentOriginal,
            content: note.content,
          })
          .returning();
        const made = annotations.length
          ? await tx
              .insert(noteAnnotations)
              .values(
                annotations.map((a) => ({
                  noteId: c!.id,
                  idx: a.idx,
                  category: a.category,
                  instruction: a.instruction,
                  quote: a.quote,
                  location: a.location,
                })),
              )
              .returning({ id: noteAnnotations.id, idx: noteAnnotations.idx })
          : [];
        if (note.status === "retracted") {
          await tx.update(notes).set({ supersededBy: c!.id, updatedAt: sql`now()` }).where(eq(notes.id, note.id));
        }
        return { copy: c!, clipIdByIdx: new Map(made.map((a) => [a.idx, a.id])) };
      });
      await copyNarration(note.id, copy.id, annotations, clipIdByIdx);
      await userAudit(deps, req, "note.duplicate", { type: "note", id: note.id }, { copyId: copy.id });
      res.status(201).json(copy);
    }),
  );

  // ── Student side ──────────────────────────────────────────────────────────────

  router.get(
    "/v1/me/notes",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const access = await notesAccess(deps, me);
      // Retracted notes appear (as a "withdrawn" stub) only if the student had
      // already read them — unread retractions simply vanish.
      const rows = await db
        .select()
        .from(notes)
        .where(and(eq(notes.studentId, me.id), inArray(notes.status, ["sent", "retracted"])))
        .orderBy(desc(notes.sentAt));
      const visible = rows.filter((n) => n.status === "sent" || n.readAt !== null);
      // Self-notes never resolve a teacher identity: the author IS the student and
      // the app renders "your recording", not a name.
      const teacherIds = [...new Set(visible.filter((n) => n.origin !== "self").map((n) => n.teacherId))];
      const teacherRows = teacherIds.length
        ? await db.select().from(users).where(inArray(users.id, teacherIds))
        : [];
      const noteIds = visible.map((n) => n.id);
      const counts = noteIds.length
        ? await db
            .select({
              noteId: noteAnnotations.noteId,
              total: sql<number>`count(*)::int`,
              done: sql<number>`count(${noteAnnotations.doneAt})::int`,
            })
            .from(noteAnnotations)
            .where(inArray(noteAnnotations.noteId, noteIds))
            .groupBy(noteAnnotations.noteId)
        : [];
      const countByNote = new Map(counts.map((c) => [c.noteId, c]));
      res.json({
        access,
        items: visible.map((n) => {
          const locked = noteIsLocked(access, n.sentAt);
          const c = countByNote.get(n.id);
          return {
            id: n.id,
            status: n.status,
            origin: n.origin,
            teacherId: n.teacherId,
            teacherName: n.origin === "self" ? null : teacherRows.find((u) => u.id === n.teacherId)?.displayName ?? null,
            pieceId: n.pieceId,
            pieceLabel: n.pieceLabel,
            pieceVersion: n.pieceVersion,
            sentAt: n.sentAt,
            readAt: n.readAt,
            locked,
            annotationCount: c?.total ?? 0,
            doneCount: c?.done ?? 0,
          };
        }),
      });
    }),
  );

  router.get(
    "/v1/me/notes/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.studentId, me.id)))
        .limit(1);
      // A never-opened note that was retracted must vanish (same rule as the list):
      // only a note the student already read shows the "withdrawn" stub.
      if (!note || note.status === "draft" || (note.status === "retracted" && note.readAt === null)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (note.status === "retracted") {
        res.json({ note: { id: note.id, status: "retracted", retractedAt: note.retractedAt } });
        return;
      }
      const access = await notesAccess(deps, me);
      if (noteIsLocked(access, note.sentAt)) {
        res.status(402).json({ error: "subscription_required", access });
        return;
      }
      const annotations = await db
        .select()
        .from(noteAnnotations)
        .where(eq(noteAnnotations.noteId, note.id))
        .orderBy(asc(noteAnnotations.idx));
      // MC-6: a self-note's "teacher" is the student themselves — never byline it.
      const [teacher] = note.origin === "self"
        ? [null]
        : await db.select().from(users).where(eq(users.id, note.teacherId)).limit(1);
      res.json({
        // Tombstoned notes (author deleted their account) carry null job/lesson
        // refs — coalesce to "" because fielded B1 clients decode these as
        // non-optional strings and a null (or absent) key bricks the note forever.
        // The suggestion machinery is teacher-side entirely: the dismissal ledger and
        // the entity id are not the student's business and never ride to them.
        note: {
          ...strippedForStudent(note),
          noteJobId: note.noteJobId ?? "",
          lessonSessionId: note.lessonSessionId ?? "",
        },
        annotations,
        teacher: { id: note.teacherId, displayName: teacher?.displayName ?? null },
      });
    }),
  );

  // A solo note is the owner's own data end to end — deletable outright (no second
  // party holds a copy). Teacher-sent notes are the shared record and stay.
  router.delete(
    "/v1/me/notes/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.studentId, me.id)))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (note.origin !== "self") {
        res.status(403).json({ error: "self_note_only", message: "Notes from your teacher can't be deleted." });
        return;
      }
      // The model output records how THIS note was written, so it goes with the note.
      // The transcript belongs to the lesson and waits for the lesson's own discard.
      const modelOutputPath = await db.transaction(async (tx) => {
        await tx.delete(noteAnnotations).where(eq(noteAnnotations.noteId, note.id));
        await tx.delete(notes).where(eq(notes.id, note.id));
        if (!note.noteJobId) return null;
        // RETURNING would hand back the nulled value — read the path first.
        const [job] = await tx
          .select({ path: noteJobs.modelOutputPath })
          .from(noteJobs)
          .where(eq(noteJobs.id, note.noteJobId))
          .limit(1);
        if (!job?.path) return null;
        await tx
          .update(noteJobs)
          .set({ modelOutputPath: null, updatedAt: sql`now()` })
          .where(eq(noteJobs.id, note.noteJobId));
        return job.path;
      });
      await userAudit(deps, req, "note.self_delete", { type: "note", id: note.id });
      if (deps.notesAssets) {
        try {
          await deps.notesAssets.deletePrefix(narrationPrefix(note.id));
        } catch (err) {
          console.error("note.self_delete: narration purge failed", note.id, err);
        }
        if (modelOutputPath) {
          try {
            await deps.notesAssets.deleteAsset(modelOutputPath);
          } catch (err) {
            console.error("note.self_delete: model output purge failed", modelOutputPath, err);
          }
        }
      }
      res.json({ ok: true });
    }),
  );

  router.post(
    "/v1/me/notes/:id/read",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [updated] = await db
        .update(notes)
        .set({ readAt: sql`coalesce(${notes.readAt}, now())`, updatedAt: sql`now()` })
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.studentId, me.id), eq(notes.status, "sent")))
        .returning();
      if (!updated) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ readAt: updated!.readAt });
    }),
  );

  async function studentAnnotation(noteId: string, aid: string, studentId: string) {
    const db = deps.db!.orm;
    const [note] = await db
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.studentId, studentId), eq(notes.status, "sent")))
      .limit(1);
    if (!note) return null;
    const [annotation] = await db
      .select()
      .from(noteAnnotations)
      .where(and(eq(noteAnnotations.id, aid), eq(noteAnnotations.noteId, note.id)))
      .limit(1);
    return annotation ?? null;
  }

  router.put(
    "/v1/me/notes/:id/annotations/:aid/practiced",
    ...guards,
    wrap(async (req, res) => {
      const annotation = await studentAnnotation(String(req.params.id), String(req.params.aid), req.notesUser!.id);
      if (!annotation) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const db = deps.db!.orm;
      const [updated] = await db
        .update(noteAnnotations)
        .set({ doneAt: sql`coalesce(${noteAnnotations.doneAt}, now())`, updatedAt: sql`now()` })
        .where(eq(noteAnnotations.id, annotation.id))
        .returning();
      res.json({ doneAt: updated!.doneAt });
    }),
  );

  router.delete(
    "/v1/me/notes/:id/annotations/:aid/practiced",
    ...guards,
    wrap(async (req, res) => {
      const annotation = await studentAnnotation(String(req.params.id), String(req.params.aid), req.notesUser!.id);
      if (!annotation) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const db = deps.db!.orm;
      await db
        .update(noteAnnotations)
        .set({ doneAt: null, updatedAt: sql`now()` })
        .where(eq(noteAnnotations.id, annotation.id));
      res.json({ doneAt: null });
    }),
  );

  // Student self-grounding of an unplaced annotation. Stored beside the teacher's
  // location, never over it — the app renders studentPin only while ungrounded.
  router.post(
    "/v1/me/notes/:id/annotations/:aid/pin",
    ...guards,
    wrap(async (req, res) => {
      const annotation = await studentAnnotation(String(req.params.id), String(req.params.aid), req.notesUser!.id);
      if (!annotation) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const start = Number(req.body?.measureStart);
      const end = Number(req.body?.measureEnd ?? start);
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) {
        res.status(400).json({ error: "invalid_measures" });
        return;
      }
      const location = annotation.location as Record<string, unknown>;
      if (location.grounded === true) {
        res.status(409).json({ error: "already_grounded" });
        return;
      }
      const db = deps.db!.orm;
      const [updated] = await db
        .update(noteAnnotations)
        .set({
          location: { ...location, studentPin: { measureStart: start, measureEnd: end } },
          updatedAt: sql`now()`,
        })
        .where(eq(noteAnnotations.id, annotation.id))
        .returning();
      res.json({ location: updated!.location });
    }),
  );

  // ── Narration ─────────────────────────────────────────────────────────────────
  // Deliberately dual-role, unlike its /v1/notes siblings: the OR below IS the
  // authorization, so this route must never gain the requireTeacher guard.
  // Entitlement is the only check left after the fetch, mirroring GET /v1/me/notes/:id
  // — narration speaks the whole note, so a lapsed student must not hear it either.
  router.get(
    "/v1/notes/:id/narration",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const requested = typeof req.query.voice === "string" ? req.query.voice : DEFAULT_NARRATION_VOICE;
      if (!isNarrationVoice(requested)) {
        res.status(400).json({ error: "invalid_voice", voices: NARRATION_VOICES });
        return;
      }
      if (!deps.notesAssets) {
        res.status(503).json({ error: "notes_assets_not_configured", message: "KaraOrchee is having trouble right now." });
        return;
      }
      const [note] = await db
        .select({ id: notes.id, studentId: notes.studentId, sentAt: notes.sentAt })
        .from(notes)
        .where(and(
          eq(notes.id, String(req.params.id)),
          or(
            // Student (and the solo author, who is their own student): delivered only.
            and(eq(notes.studentId, me.id), eq(notes.status, "sent")),
            // Author, at any status — draft narration is the review preview.
            ...(me.isTeacher ? [and(eq(notes.teacherId, me.id), eq(notes.origin, "teacher"))] : []),
          ),
        ))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (note.studentId === me.id) {
        const access = await notesAccess(deps, me);
        if (noteIsLocked(access, note.sentAt)) {
          res.status(402).json({ error: "subscription_required", access });
          return;
        }
      }
      const annotations = await db
        .select({ id: noteAnnotations.id })
        .from(noteAnnotations)
        .where(eq(noteAnnotations.noteId, note.id))
        .orderBy(asc(noteAnnotations.idx));
      const rows = await db
        .select()
        .from(noteNarrationClips)
        .where(and(eq(noteNarrationClips.noteId, note.id), eq(noteNarrationClips.voice, requested)));
      const present = new Map(rows.map((r) => [r.clipId, r]));

      // Driven by the note as it stands NOW, and the URL is derived from the note in
      // the path — never from a stored blob_path — so a signed URL cannot address
      // anything outside this note's prefix.
      const expected = [NARRATION_OVERVIEW_CLIP, ...annotations.map((a) => a.id)];
      const clips: Record<string, unknown>[] = [];
      const pending: string[] = [];
      for (const clipId of expected) {
        const row = present.get(clipId);
        if (!row) {
          pending.push(clipId);
          continue;
        }
        clips.push({
          clipId,
          annotationId: row.annotationId,
          kind: row.kind,
          url: deps.notesAssets.readUrl(narrationClipPath(note.id, requested, clipId)),
          bytes: row.bytes,
          // The app re-derives this from its own read-aloud script and falls back to
          // system speech when they disagree — the guard against hearing stale text.
          textHash: row.textHash,
          updatedAt: row.updatedAt,
        });
      }
      res.set("Cache-Control", "no-store");
      res.json({
        noteId: note.id,
        voice: requested,
        voices: NARRATION_VOICES,
        expiresAt: new Date(Date.now() + ASSET_READ_SAS_MINUTES * 60 * 1000).toISOString(),
        clips,
        pending,
      });
    }),
  );

  // ── Devices (APNS) ────────────────────────────────────────────────────────────

  router.post(
    "/v1/devices",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
      if (!token) {
        res.status(400).json({ error: "token_required" });
        return;
      }
      const platform = typeof req.body?.platform === "string" ? req.body.platform : "ios";
      // A device changing owners rebinds its token to the new user.
      const [row] = await db
        .insert(devices)
        .values({ userId: me.id, token, platform })
        .onConflictDoUpdate({
          target: devices.token,
          set: { userId: me.id, platform, updatedAt: sql`now()` },
        })
        .returning();
      res.status(201).json(row);
    }),
  );

  router.delete(
    "/v1/devices/:token",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      await db
        .delete(devices)
        .where(and(eq(devices.token, String(req.params.token)), eq(devices.userId, me.id)));
      res.json({ ok: true });
    }),
  );

  return router;
}
