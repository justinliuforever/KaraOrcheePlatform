import { Router } from "express";
import type { Response } from "express";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
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
import { MSG_NOTE_NAMES_PIECE } from "./lessons";
import { MOVED_HINT, REGROUND_HINT, reground, regroundSlot, ungrounded } from "../notes/reground";
import { stampSlotVersions } from "../notes/slot_version";
import { syncLessonSlot, syncNoteSingular, syncNoteSlot } from "../notes/slot_sync";
import { notePieceWire, notePieces, studentPieceWire, slotKind } from "../notes/pieces_wire";
import { UnknownPlanSlot, normalizePlanPieceIds, planItemsWire } from "../notes/plan_sidecar";
import { applyBinding, MAX_SLOTS, moveSlot, nextSortIndex, slotsOf, type SlotFacts } from "../notes/slot_crud";
import { isUuid } from "../ids";
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
  notedPieces,
  noteJobs,
  noteNarrationClips,
  notes,
  pieces,
  scoreScans,
  teacherStudentLinks,
  users,
} from "../db/schema";

type NoteRow = typeof notes.$inferSelect;

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

  // ownPseudo ids are prefixed "custom:" — the final filter below relies on that prefix to keep unlinked hits silent.
  const ownPseudo: CandidatePiece[] = mine
    .filter((c) => c.id !== ownId && !c.linkedPieceId)
    .map((c) => ({ id: `custom:${c.id}`, title: c.displayLabel, subtitle: "", composer: "" }));

  const dismissed = [
    ...asStringArray(note.pieceSuggestionDismissed),
    ...(own ? asStringArray(own.dismissedPieceIds) : []),
  ];

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

// Must be called at every resolution point (confirm, dismiss, send, discard) — these quote a teacher's and a minor's words verbatim.
export async function clearPieceMentions(tx: Tx, jobId: string | null): Promise<void> {
  if (!jobId) return;
  await tx.update(noteJobs).set({ pieceMentions: [], updatedAt: sql`now()` }).where(eq(noteJobs.id, jobId));
}

async function noteWithAnnotations(deps: Deps, noteId: string) {
  const db = deps.db!.orm;
  const [note] = await db.select().from(notes).where(eq(notes.id, noteId)).limit(1);
  const annotations = await db
    .select()
    .from(noteAnnotations)
    // The wire's annotations array is exactly the transcript rows; a plan row here renders as a marked spot.
    .where(and(eq(noteAnnotations.noteId, noteId), eq(noteAnnotations.source, "transcript")))
    .orderBy(asc(noteAnnotations.idx));
  return {
    note: note!,
    annotations,
    pieces: note ? (await notePieces(db, note)).map(notePieceWire) : [],
    pieceSuggestion: note ? await suggestionFor(deps, note) : null,
  };
}

// Dropping any of id/noteJobId/lessonSessionId/teacherId/status/content/createdAt bricks every note on installed builds that decode them as non-optional.
const STUDENT_NOTE_KEYS = [
  "id", "noteJobId", "lessonSessionId", "teacherId", "studentId", "origin",
  "pieceId", "pieceLabel", "pieceVersion", "status", "contentOriginal", "content",
  "editedAt", "sentAt", "retractedAt", "supersededBy", "readAt", "createdAt", "updatedAt",
] as const satisfies readonly (keyof NoteRow)[];

function strippedForStudent(note: NoteRow): Pick<NoteRow, (typeof STUDENT_NOTE_KEYS)[number]> {
  const out = {} as Record<string, unknown>;
  for (const key of STUDENT_NOTE_KEYS) out[key] = note[key];
  return out as Pick<NoteRow, (typeof STUDENT_NOTE_KEYS)[number]>;
}

interface ScoreFields {
  hasScorePhotos: boolean;
  scorePageCount: number | null;
  scoreGone: boolean;
}

function scoreFields(photos: boolean, pageCount: number | null, gone: boolean): ScoreFields {
  return { hasScorePhotos: photos, scorePageCount: pageCount, scoreGone: gone };
}

// Resolved from the scan row, never from the pointer alone — a client must never render a viewer over bytes the image route would then refuse.
async function scoreFieldsFor(deps: Deps, note: NoteRow): Promise<ScoreFields> {
  if (!note.scoreScanId) {
    return scoreFields(false, null, note.scoreScanDetachedAt !== null);
  }
  const [scan] = await deps
    .db!.orm.select({
      status: scoreScans.status,
      blobPath: scoreScans.blobPath,
      pageCount: scoreScans.pageCount,
    })
    .from(scoreScans)
    .where(eq(scoreScans.id, note.scoreScanId))
    .limit(1);
  const ready = scan?.status === "ready" && scan.blobPath !== null;
  // `created` is still on its way and must stay absent; these three can never be served again, and a reader who already had the pages must be told rather than watch the pane disappear.
  const gone = !scan || scan.status === "taken_down" || (scan.status === "ready" && scan.blobPath === null);
  return scoreFields(ready, ready ? scan!.pageCount : null, gone);
}

// A scan someone else owns is not an error to explain — it is a scan that does not exist for this caller.
async function ownedScanId(deps: Deps, ownerId: string, value: unknown): Promise<string | null | "miss"> {
  if (value === null) return null;
  if (!isUuid(value)) return "miss";
  const [scan] = await deps
    .db!.orm.select({ id: scoreScans.id, status: scoreScans.status, blobPath: scoreScans.blobPath })
    .from(scoreScans)
    .where(and(eq(scoreScans.id, value), eq(scoreScans.ownerId, ownerId)))
    .limit(1);
  // Same two conditions the read path calls "gone": neither can ever be served again, so attaching one promises pages nothing can deliver.
  if (!scan || scan.status === "taken_down" || (scan.status === "ready" && scan.blobPath === null)) {
    return "miss";
  }
  return scan.id;
}

// Scoping by teacherId alone leaks a dual-role account's own self-notes into the teacher-side routes.
const teacherOwned = (teacherId: string) =>
  and(eq(notes.teacherId, teacherId), eq(notes.origin, "teacher"));

const teacherNote = (id: string, teacherId: string) =>
  and(eq(notes.id, id), teacherOwned(teacherId));

/// Thrown inside the edit transaction so a bad slot id rolls the whole edit back rather than committing half of it.
class UnknownSlot extends Error {}


export function notesRouter(deps: Deps): Router {
  const router = Router();
  const guards = [requireAuth(deps.auth), requireUser(deps)];

  // ── Teacher side ──────────────────────────────────────────────────────────────
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
      const conds = [teacherOwned(me.id)];
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
        .where(teacherNote(String(req.params.id), me.id))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const annotations = await db
        .select()
        .from(noteAnnotations)
        // The wire's annotations array is exactly the transcript rows; a plan row here renders as a marked spot.
        .where(and(eq(noteAnnotations.noteId, note.id), eq(noteAnnotations.source, "transcript")))
        .orderBy(asc(noteAnnotations.idx));
      // Must stay computed at READ time, never cached — a catalog that grows or a dismissal has to apply immediately.
      const slotRows = await notePieces(db, note);
      res.json({
        note,
        annotations,
        // Additive: the singular projection above is untouched and remains what an installed binary reads.
        pieces: slotRows.map(notePieceWire),
        planItems: planItemsWire(note, new Set(slotRows.map((r) => r.id))),
        pieceSuggestion: await suggestionFor(deps, note),
      });
    }),
  );

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
        .where(teacherNote(String(req.params.id), me.id))
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
      // null = there is no engraving to check bar numbers against, so nothing grounded may survive.
      // Safe to leave null when the body names no piece: the only other way to reach the sweep below is
      // a scan change, and a scan may only land on a note that names no piece — so there is no ruler.
      let newPieceMeasures: number | null = null;
      if ("pieceId" in body) {
        const pieceId = body.pieceId as string | null;
        if (pieceId) {
          const [piece] = await db
            .select({ id: pieces.id, facts: pieces.facts })
            .from(pieces)
            .where(eq(pieces.id, pieceId))
            .limit(1);
          if (!piece) {
            res.status(400).json({ error: "unknown_piece" });
            return;
          }
          const m = (piece.facts as { measures?: unknown } | null)?.measures;
          newPieceMeasures = typeof m === "number" && Number.isInteger(m) && m > 0 ? m : null;
        }
        patch.pieceId = pieceId;
      }
      if ("pieceLabel" in body) {
        patch.pieceLabel = typeof body.pieceLabel === "string" && body.pieceLabel.trim() ? body.pieceLabel.trim() : null;
      }
      if ("scoreScanId" in body) {
        // Keeps score_scans.owner_id equal to notes.teacher_id on every referencing note — the invariant every read path assumes.
        const scanId = await ownedScanId(deps, me.id, body.scoreScanId);
        if (scanId === "miss") {
          res.status(404).json({ error: "not_found" });
          return;
        }
        patch.scoreScanId = scanId;
      }
      // The piece is the note's identity and the scan is the addition, so a scan arriving onto a named piece is refused, never traded for it.
      if (patch.pieceId) {
        patch.scoreScanId = null;
      } else if (patch.scoreScanId && !("pieceId" in patch) && note.pieceId) {
        res.status(409).json({ error: "note_names_piece", message: MSG_NOTE_NAMES_PIECE });
        return;
      }
      const scoreChanged =
        ("pieceId" in patch && patch.pieceId !== note.pieceId) ||
        ("scoreScanId" in patch && patch.scoreScanId !== note.scoreScanId);
      const cameFromPhotographs = scoreChanged && note.scoreScanId !== null;
      // One transaction, CAS on draft — a racing send must never lose an edit, and quote (verbatim provenance) is never alterable via this payload.
      let dropped: string[] = [];
      let updated;
      try {
        updated = await db.transaction(async (tx) => {
          const [u] = await tx
            .update(notes)
            .set(patch)
            .where(and(eq(notes.id, note.id), eq(notes.status, "draft")))
            .returning();
          if (!u) return null;
          const mirrored = await syncNoteSlot(tx, u);

          // A number spoken while the teacher read photographed pages is a coordinate in THAT edition — landing in range against ours is coincidence, so nothing survives the swap.
          // Scoped to the slot the singular columns mirror into: this change cannot have touched another.
          if (scoreChanged && mirrored) {
            await regroundSlot(tx, note.id, mirrored, cameFromPhotographs ? null : newPieceMeasures);
          }

          if (Array.isArray(body.annotations)) {
            const existing = await tx
              .select()
              .from(noteAnnotations)
              .where(eq(noteAnnotations.noteId, note.id));
            const byId = new Map(existing.map((a) => [a.id, a]));
            const keep = new Set<string>();
            const items = body.annotations as Record<string, unknown>[];
            // Read after the slot sync above, so the row minted from the singular columns is already there.
            // Always, not only for a move: the bound check below needs every slot's piece.
            const slots = await slotsOf(tx, note.id);
            // How many bars each slot's piece actually has. A client that has not reloaded keeps posting
            // bars the server already demoted, so the refusal has to live on the write, not in the answer.
            const boundOf = new Map<string, number | null>();
            for (const slot of slots) {
              if (!slot.pieceId) { boundOf.set(slot.id, null); continue; }
              const [row] = await tx
                .select({ facts: pieces.facts })
                .from(pieces)
                .where(eq(pieces.id, slot.pieceId))
                .limit(1);
              const m = (row?.facts as { measures?: unknown } | null)?.measures;
              boundOf.set(slot.id, typeof m === "number" && Number.isInteger(m) && m > 0 ? m : null);
            }
            const slotIds = new Set(slots.map((s) => s.id));
            const synthesised = `pending:${note.id}`;
            const resolve = (v: unknown): string | null => {
              if (typeof v !== "string") return null;
              if (v === synthesised) return slots[0]?.id ?? null;
              if (!slotIds.has(v)) throw new UnknownSlot();
              return v;
            };
            let idx = 0;
            for (const a of items) {
              const id = typeof a.id === "string" ? a.id : null;
              const row = id ? byId.get(id) : undefined;
              if (!row) continue;  // no id / unknown id: cannot mint an unsourced annotation
              keep.add(row.id);
              const piece = "notePieceId" in a ? resolve(a.notePieceId) : row.notePieceId;
              const sent = a.location && typeof a.location === "object" ? (a.location as Record<string, unknown>) : null;
              let loc = (sent ?? row.location ?? {}) as Record<string, unknown>;
              let grounding = row.groundedPieceId;
              if (loc.grounded === true) {
                // Compared field by field, never as whole objects: jsonb hands the stored copy back with its keys in another order.
                const was = (row.location ?? {}) as Record<string, unknown>;
                const replaced = was.grounded !== true
                  || loc.measureStart !== was.measureStart
                  || loc.measureEnd !== was.measureEnd;
                if (replaced) grounding = piece;
                // A bar number holds only for the score it was written against, so carrying one to another piece is the same lie as carrying it across a score swap.
                else if (piece !== row.groundedPieceId) { loc = ungrounded(loc, MOVED_HINT); grounding = null; }
              } else {
                grounding = null;
              }
              // Never store a bar the piece provably does not have, whoever sent it.
              if (loc.grounded === true) {
                const bound = piece ? boundOf.get(piece) ?? null : null;
                const end = typeof loc.measureEnd === "number"
                  ? loc.measureEnd
                  : typeof loc.measureStart === "number" ? loc.measureStart : null;
                if (bound !== null && end !== null && end > bound) {
                  loc = ungrounded(loc, REGROUND_HINT);
                  grounding = null;
                }
              }
              await tx
                .update(noteAnnotations)
                .set({
                  idx: idx++,
                  category: typeof a.category === "string" ? a.category : row.category,
                  instruction: typeof a.instruction === "string" ? a.instruction : row.instruction,
                  location: loc,
                  notePieceId: piece,
                  groundedPieceId: grounding,
                  updatedAt: sql`now()`,
                })
                .where(eq(noteAnnotations.id, row.id));
            }
            // Scoped to the sources the payload actually carries: an old binary sends only transcript
            // rows, and an unscoped sweep reads every plan row's absence as a deletion.
            const sentSources = new Set(
              items
                .map((a) => (typeof a.id === "string" ? byId.get(a.id)?.source : undefined))
                .filter((v): v is string => typeof v === "string"),
            );
            if (!sentSources.size) sentSources.add("transcript");
            const drop = existing
              .filter((a) => sentSources.has(a.source) && !keep.has(a.id))
              .map((a) => a.id);
            if (drop.length) await tx.delete(noteAnnotations).where(inArray(noteAnnotations.id, drop));
            dropped = drop;
          }
          if (Array.isArray(body.planItems)) {
            const liveSlots = new Set((await slotsOf(tx, note.id)).map((slot) => slot.id));
            const [row] = await tx
              .update(notes)
              .set({ planPieceIds: normalizePlanPieceIds(body.planItems, u.content, liveSlots) })
              .where(eq(notes.id, note.id))
              .returning();
            return row!;
          }
          return u;
        });
      } catch (err) {
        if (!(err instanceof UnknownSlot) && !(err instanceof UnknownPlanSlot)) throw err;
        res.status(400).json({ error: "unknown_note_piece" });
        return;
      }
      if (!updated) {
        res.status(409).json({ error: "not_editable", message: "Sent notes can't be edited — retract, fix, and resend." });
        return;
      }
      // The manifest row cascades with the annotation; its blob doesn't — skip this and it's an unaddressable storage leak.
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
        // The wire's annotations array is exactly the transcript rows; a plan row here renders as a marked spot.
        .where(and(eq(noteAnnotations.noteId, note.id), eq(noteAnnotations.source, "transcript")))
        .orderBy(asc(noteAnnotations.idx));
      // The app assigns this straight into its live list, so a save that omits it empties the screen.
      const slotRows = await notePieces(db, updated);
      res.json({ note: updated, annotations, pieces: slotRows.map(notePieceWire),
                 planItems: planItemsWire(updated, new Set(slotRows.map((r) => r.id))) });
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
        .where(teacherNote(String(req.params.id), me.id))
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
      // An installed binary can mint a blank slot, so only the server can stop one being sent.
      const slots = await db
        .select()
        .from(notedPieces)
        .where(eq(notedPieces.noteId, note.id))
        .orderBy(asc(notedPieces.sortIndex));
      const blank = slots.findIndex((slot) => slotKind(slot) === "none");
      if (slots.length > 1 && blank >= 0) {
        res.status(400).json({
          error: "piece_untitled",
          message: `Unable to send — Piece ${blank + 1} is missing a title.`,
        });
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
      // customPieceId follows the lesson only when labels match — a note label that DIFFERS from the lesson's was retyped by a human and must mint fresh provenance.
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
        if (row) {
          await syncNoteSlot(tx, row);
          await stampSlotVersions(tx, note.id);
          await clearPieceMentions(tx, note.noteJobId);
        }
        return row;
      });
      if (!updated) {
        res.status(409).json({ error: "status_changed" });
        return;
      }
      // Message shape (one message, every voice, dedicated lane) is pinned in narration_parity.json — the worker refuses to guess at anything looser.
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
      // Must run after the note is committed and never throw — notifyNoteSent swallows its own failures so a dead APNs costs only the notification.
      const pushed = await notifyNoteSent(deps, { studentId, noteId: note.id });
      await userAudit(deps, req, "note.send", { type: "note", id: note.id }, {
        studentId,
        narrationQueued,
        push: pushed,
      });
      res.json(updated);
    }),
  );

  // Confirm-only — must stay the ONLY path from a suggestion to notes.piece_id; no worker or job may set it.
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
        .where(teacherNote(String(req.params.id), me.id))
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
        res.status(409).json({ error: "suggestion_changed", pieceSuggestion: fresh ?? null });
        return;
      }

      const [lesson] = note.lessonSessionId
        ? await db.select().from(lessonSessions).where(eq(lessonSessions.id, note.lessonSessionId)).limit(1)
        : [];

      if (action === "dismiss") {
        // Re-check the id itself here, not the live suggestion (unlike confirm) — that's what keeps a repeated dismiss idempotent.
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
          const [dismissedRow] = await tx
            .update(notes)
            .set({ pieceSuggestionDismissed: dismissed, updatedAt: sql`now()` })
            .where(eq(notes.id, note.id))
            .returning();
          if (dismissedRow) await syncNoteSlot(tx, dismissedRow);
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
      // prior.pieceSource must read the lesson's actual value, not a hardcoded "typed" — undo would otherwise rewrite provenance.
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
              // Traded away, like the note's own reference below — ck_lesson_piece_excludes_scan refuses the pair outright.
              scoreScanId: null,
              pieceUpdatedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(lessonSessions.id, lesson.id))
            .returning()
            .then(async ([confirmedLesson]) => {
              if (confirmedLesson) await syncLessonSlot(tx, confirmedLesson);
            });
        }
        const [confirmedRow] = await tx
          .update(notes)
          .set({ pieceId, scoreScanId: null, updatedAt: sql`now()` })
          .where(eq(notes.id, note.id))
          .returning();
        const confirmedSlot = confirmedRow ? await syncNoteSlot(tx, confirmedRow) : null;
        if (measureCount !== null && confirmedSlot) {
          await regroundSlot(tx, note.id, confirmedSlot, measureCount);
        }
        // Only fresh.source === "library" (exact name match) may set linkedPieceId — a mention-based match isn't proof enough.
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
          teacherNote(String(req.params.id), me.id),
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

  // contentHash is copied verbatim — it excludes noteId, so the worker's cross-note dedup still recognizes it.
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
        .where(teacherNote(String(req.params.id), me.id))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const annotations = await db
        .select()
        .from(noteAnnotations)
        // The wire's annotations array is exactly the transcript rows; a plan row here renders as a marked spot.
        .where(and(eq(noteAnnotations.noteId, note.id), eq(noteAnnotations.source, "transcript")))
        .orderBy(asc(noteAnnotations.idx));
      // Insert + annotations + supersededBy must stay one transaction — a copy without its annotations is worse than no copy.
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
            scoreScanId: note.pieceId ? null : note.scoreScanId,
            // scoreScanDetachedAt is deliberately absent: a fresh note that never had a score must not render "isn't available any more".
            contentOriginal: note.contentOriginal,
            content: note.content,
          })
          .returning();
        // Slots first: the items below carry pointers into them, and a copy pointing at the source note's slots is a note whose pieces belong to another note.
        const sourceSlots = await tx
          .select()
          .from(notedPieces)
          .where(eq(notedPieces.noteId, note.id))
          .orderBy(asc(notedPieces.sortIndex));
        const slotIdBySource = new Map<string, string>();
        for (const slot of sourceSlots) {
          const [copied] = await tx
            .insert(notedPieces)
            .values({
              noteId: c!.id,
              sortIndex: slot.sortIndex,
              practiceSubjectId: slot.practiceSubjectId,
              pieceId: slot.pieceId,
              pieceLabel: slot.pieceLabel,
              pieceSource: slot.pieceSource,
              customPieceId: slot.customPieceId,
              scoreScanId: slot.pieceId ? null : slot.scoreScanId,
              pieceVersion: slot.pieceVersion,
              summary: slot.summary,
            })
            .returning({ id: notedPieces.id });
          if (copied) slotIdBySource.set(slot.id, copied.id);
        }
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
                  source: a.source,
                  groupLabel: a.groupLabel,
                  target: a.target,
                  notePieceId: a.notePieceId ? slotIdBySource.get(a.notePieceId) ?? null : null,
                  groundedPieceId: a.groundedPieceId ? slotIdBySource.get(a.groundedPieceId) ?? null : null,
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
      // Unread retractions must vanish entirely — only previously-read ones show the "withdrawn" stub.
      const rows = await db
        .select()
        .from(notes)
        .where(and(eq(notes.studentId, me.id), inArray(notes.status, ["sent", "retracted"])))
        .orderBy(desc(notes.sentAt));
      const visible = rows.filter((n) => n.status === "sent" || n.readAt !== null);
      // origin==="self" notes are excluded here — the app renders "your recording" for them, never a resolved name.
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
            .where(and(inArray(noteAnnotations.noteId, noteIds), eq(noteAnnotations.source, "transcript")))
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
      // Same rule as the notes list — a never-opened retracted note must vanish, not show the "withdrawn" stub.
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
        // The wire's annotations array is exactly the transcript rows; a plan row here renders as a marked spot.
        .where(and(eq(noteAnnotations.noteId, note.id), eq(noteAnnotations.source, "transcript")))
        .orderBy(asc(noteAnnotations.idx));
      const [teacher] = note.origin === "self"
        ? [null]
        : await db.select().from(users).where(eq(users.id, note.teacherId)).limit(1);
      const studentSlotRows = await notePieces(db, note);
      res.json({
        // Coalesce noteJobId/lessonSessionId to "" — already-shipped clients decode these as non-optional strings; null bricks the note.
        note: {
          ...strippedForStudent(note),
          noteJobId: note.noteJobId ?? "",
          lessonSessionId: note.lessonSessionId ?? "",
          ...(await scoreFieldsFor(deps, note)),
        },
        annotations,
        pieces: studentSlotRows.map(studentPieceWire),
        planItems: planItemsWire(note, new Set(studentSlotRows.map((r) => r.id))),
        teacher: { id: note.teacherId, displayName: teacher?.displayName ?? null },
      });
    }),
  );

  // Self notes are born sent, so this writes to a sent note on purpose — the teacher side's draft-only rule must not be inherited here.
  router.patch(
    "/v1/me/notes/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const id = String(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, id), eq(notes.studentId, me.id)))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (note.origin !== "self") {
        res.status(403).json({ error: "self_note_only", message: "Notes from your teacher can't be edited." });
        return;
      }
      const body = req.body ?? {};
      if (!("scoreScanId" in body)) {
        res.status(400).json({ error: "score_scan_id_required" });
        return;
      }
      const scanId = await ownedScanId(deps, me.id, body.scoreScanId);
      if (scanId === "miss") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (scanId && note.pieceId) {
        res.status(409).json({ error: "note_names_piece", message: MSG_NOTE_NAMES_PIECE });
        return;
      }
      // One transaction: the row and its mirror must not be observable apart, or a racing takedown lands between them.
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(notes)
          .set({
            scoreScanId: scanId,
            // A note that has a score again must stop reporting the old one as gone.
            scoreScanDetachedAt: scanId ? null : note.scoreScanDetachedAt,
            updatedAt: sql`now()`,
          })
          .where(eq(notes.id, note.id))
          .returning();
        if (row) await syncNoteSlot(tx, row);
        return row;
      });
      res.json(await scoreFieldsFor(deps, updated!));
    }),
  );

  // Only origin==="self" notes are deletable here — teacher-sent notes are the shared record between two parties and must survive.
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
      // Only modelOutputPath is cleared here — transcriptPath belongs to the lesson and waits for the lesson's own discard.
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

  // studentPin is merged into location, never replacing it — the teacher's own placement fields must survive alongside it.
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
  // This route must never gain the requireTeacher guard — the OR in the where clause below IS the authorization for both roles.
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
            and(eq(notes.studentId, me.id), eq(notes.status, "sent")),
            // Author, at any status — draft narration is the review preview.
            ...(me.isTeacher ? [teacherOwned(me.id)] : []),
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
        // Must match narration.py's own filter exactly — a clip the worker never planned reads here as one that failed to arrive.
        .where(and(eq(noteAnnotations.noteId, note.id), eq(noteAnnotations.source, "transcript")))
        .orderBy(asc(noteAnnotations.idx));
      const rows = await db
        .select()
        .from(noteNarrationClips)
        .where(and(eq(noteNarrationClips.noteId, note.id), eq(noteNarrationClips.voice, requested)));
      const present = new Map(rows.map((r) => [r.clipId, r]));

      // URL is derived from the note id in the path, never a stored blob_path — keeps a signed URL from addressing outside this note's prefix.
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
          // The app compares this against its own script and falls back to system speech on mismatch — must stay accurate.
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

  // ── Piece slots ───────────────────────────────────────────────────────────────

  async function editableTeacherNote(db: Orm, noteId: string, meId: string, res: Response) {
    if (!isUuid(noteId)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    const [note] = await db.select().from(notes).where(teacherNote(noteId, meId)).limit(1);
    if (!note) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    if (note.status !== "draft") {
      res.status(409).json({ error: "not_editable", message: "Sent notes can't be edited — retract, fix, and resend." });
      return null;
    }
    return note;
  }

  router.post(
    "/v1/notes/:id/pieces",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      if (!requireTeacher(me, res)) return;
      const note = await editableTeacherNote(db, String(req.params.id), me.id, res);
      if (!note) return;
      const body = req.body ?? {};

      const pieceId = typeof body.pieceId === "string" ? body.pieceId : null;
      if (pieceId) {
        const [piece] = await db.select({ id: pieces.id }).from(pieces).where(eq(pieces.id, pieceId)).limit(1);
        if (!piece) {
          res.status(400).json({ error: "unknown_piece" });
          return;
        }
      }
      const scanId = "scoreScanId" in body ? await ownedScanId(deps, me.id, body.scoreScanId) : null;
      if (scanId === "miss") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (pieceId && scanId) {
        res.status(409).json({ error: "note_names_piece", message: MSG_NOTE_NAMES_PIECE });
        return;
      }

      const created = await db.transaction(async (tx) => {
        const existing = await slotsOf(tx, note.id);
        if (existing.length >= MAX_SLOTS) return "full" as const;
        const [row] = await tx
          .insert(notedPieces)
          .values({
            noteId: note.id,
            sortIndex: await nextSortIndex(tx, note.id),
            pieceId,
            pieceLabel: typeof body.pieceLabel === "string" && body.pieceLabel.trim()
              ? body.pieceLabel.trim()
              : null,
            scoreScanId: scanId,
          })
          .returning();
        await syncNoteSingular(tx, note.id);
        return row!;
      });
      if (created === "full") {
        res.status(409).json({
          error: "too_many_pieces",
          message: `A lesson can hold up to ${MAX_SLOTS} pieces.`,
        });
        return;
      }
      await userAudit(deps, req, "note.piece_add", { type: "note", id: note.id }, { slotId: created.id });
      res.status(201).json({ piece: notePieceWire(created) });
    }),
  );

  router.patch(
    "/v1/notes/:id/pieces/:slotId",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      if (!requireTeacher(me, res)) return;
      const note = await editableTeacherNote(db, String(req.params.id), me.id, res);
      if (!note) return;
      const slotId = String(req.params.slotId);
      const body = req.body ?? {};

      // null = there is no engraving to check bar numbers against, so nothing grounded may survive.
      let newSlotMeasures: number | null = null;
      if ("pieceId" in body && typeof body.pieceId === "string") {
        const [piece] = await db
          .select({ id: pieces.id, facts: pieces.facts })
          .from(pieces)
          .where(eq(pieces.id, body.pieceId))
          .limit(1);
        if (!piece) {
          res.status(400).json({ error: "unknown_piece" });
          return;
        }
        const m = (piece.facts as { measures?: unknown } | null)?.measures;
        newSlotMeasures = typeof m === "number" && Number.isInteger(m) && m > 0 ? m : null;
      }
      let scanId: string | null | "miss" = null;
      if ("scoreScanId" in body) {
        scanId = await ownedScanId(deps, me.id, body.scoreScanId);
        if (scanId === "miss") {
          res.status(404).json({ error: "not_found" });
          return;
        }
      }

      const out = await db.transaction(async (tx) => {
        const [slot] = await tx
          .select()
          .from(notedPieces)
          .where(and(eq(notedPieces.id, slotId), eq(notedPieces.noteId, note.id)))
          .for("update")
          .limit(1);
        if (!slot) return "gone" as const;
        const facts: SlotFacts = {};
        if ("pieceId" in body) facts.pieceId = typeof body.pieceId === "string" ? body.pieceId : null;
        if ("pieceLabel" in body) {
          facts.pieceLabel = typeof body.pieceLabel === "string" && body.pieceLabel.trim()
            ? body.pieceLabel.trim()
            : null;
        }
        if ("scoreScanId" in body) facts.scoreScanId = scanId as string | null;
        const decided = applyBinding(facts, slot);
        // Beside the binding, not inside it: the summary names no score, so it neither sheds nor
        // refuses anything.
        if ("summary" in body) {
          decided.values.summary = typeof body.summary === "string" && body.summary.trim()
            ? body.summary.trim()
            : null;
        }
        if (decided.refused) return "refused" as const;
        if (typeof body.sortIndex === "number" && Number.isInteger(body.sortIndex)) {
          await moveSlot(tx, note.id, slot.id, body.sortIndex);
        }
        if (Object.keys(decided.values).length) {
          await tx
            .update(notedPieces)
            .set({ ...decided.values, updatedAt: sql`now()` })
            .where(eq(notedPieces.id, slot.id));
        }
        const [after] = await tx.select().from(notedPieces).where(eq(notedPieces.id, slot.id)).limit(1);
        // A bar number belongs to the score it was written against; swapping this slot's score leaves it
        // pointing into music the student is no longer reading, and nothing downstream can tell.
        const scoreMoved = ("pieceId" in body && after!.pieceId !== slot.pieceId)
          || ("scoreScanId" in body && after!.scoreScanId !== slot.scoreScanId)
          || decided.scoreDetached;
        if (scoreMoved) {
          const cameFromPhotographs = slot.scoreScanId !== null;
          await regroundSlot(tx, note.id, slot.id, cameFromPhotographs ? null : newSlotMeasures);
        }
        await syncNoteSingular(tx, note.id);
        return { row: after!, scoreDetached: decided.scoreDetached };
      });
      if (out === "gone") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (out === "refused") {
        res.status(409).json({ error: "note_names_piece", message: MSG_NOTE_NAMES_PIECE });
        return;
      }
      res.json({ piece: notePieceWire(out.row), scoreDetached: out.scoreDetached });
    }),
  );

  router.delete(
    "/v1/notes/:id/pieces/:slotId",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      if (!requireTeacher(me, res)) return;
      const note = await editableTeacherNote(db, String(req.params.id), me.id, res);
      if (!note) return;

      // The items survive in General: deleting a card must never take a teacher's words with it.
      const gone = await db.transaction(async (tx) => {
        const rows = await tx
          .delete(notedPieces)
          .where(and(eq(notedPieces.id, String(req.params.slotId)), eq(notedPieces.noteId, note.id)))
          .returning({ id: notedPieces.id });
        if (rows.length) await syncNoteSingular(tx, note.id);
        return rows;
      });
      if (!gone.length) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await userAudit(deps, req, "note.piece_remove", { type: "note", id: note.id },
                      { slotId: String(req.params.slotId) });
      res.json({ ok: true });
    }),
  );

  // ── Score scan ────────────────────────────────────────────────────────────────

  // Narration-shaped, not detail-shaped: the detail route serves a stub for a read-then-retracted note, and an image must not follow that softer rule.
  router.get(
    "/v1/notes/:id/score-scan",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const store = deps.scans;
      const id = String(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (!store) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const [note] = await db
        .select({
          id: notes.id,
          studentId: notes.studentId,
          sentAt: notes.sentAt,
          scoreScanId: notes.scoreScanId,
          scoreScanDetachedAt: notes.scoreScanDetachedAt,
        })
        .from(notes)
        .where(and(
          eq(notes.id, id),
          or(
            and(eq(notes.studentId, me.id), eq(notes.status, "sent")),
            ...(me.isTeacher ? [teacherOwned(me.id)] : []),
          ),
        ))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [scan] = note.scoreScanId
        ? await db.select().from(scoreScans).where(eq(scoreScans.id, note.scoreScanId)).limit(1)
        : [];
      // Owner check first: on a self note the owner IS the student, and nobody is locked out of their own photograph of their own book.
      if (scan?.ownerId !== me.id && note.studentId === me.id) {
        const access = await notesAccess(deps, me);
        if (noteIsLocked(access, note.sentAt)) {
          res.status(402).json({ error: "subscription_required", access });
          return;
        }
      }
      // The marker is the only thing that separates "a score was destroyed under you" from "this note never had one".
      if (!scan) {
        if (note.scoreScanDetachedAt) {
          res.status(410).json({ error: "scan_gone" });
          return;
        }
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (scan.status === "created") {
        res.status(409).json({ error: "scan_not_ready" });
        return;
      }
      if (scan.status === "taken_down") {
        res.status(410).json({ error: "scan_taken_down" });
        return;
      }
      if (!scan.blobPath) {
        res.status(410).json({ error: "scan_purged" });
        return;
      }
      res.set("Cache-Control", "no-store");
      res.json({
        noteId: note.id,
        // Derived from the owner's id, never from the stored prefix — a signed URL must not address outside this scan's own prefix.
        pages: Array.from({ length: scan.pageCount }, (_, i) => ({
          page: i + 1,
          url: store.readUrl(store.blobPath(scan.ownerId, scan.id, i + 1)),
        })),
        expiresAt: new Date(Date.now() + ASSET_READ_SAS_MINUTES * 60 * 1000).toISOString(),
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
