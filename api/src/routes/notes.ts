import { Router } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { noteIsLocked, notesAccess } from "../notes/entitlement";
import {
  devices,
  noteAnnotations,
  notes,
  pieces,
  teacherStudentLinks,
  users,
} from "../db/schema";

export function notesRouter(deps: Deps): Router {
  const router = Router();
  const guards = [requireAuth(deps.auth), requireUser(deps)];

  // ── Teacher side ──────────────────────────────────────────────────────────────

  router.get(
    "/v1/notes",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const studentId = typeof req.query.studentId === "string" ? req.query.studentId : undefined;
      const conds = [eq(notes.teacherId, me.id)];
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
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id)))
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
      res.json({ note, annotations });
    }),
  );

  // Draft-only edits. Annotations are a full replacement; quotes are provenance,
  // so rows keeping their id keep their stored quote regardless of the payload.
  router.patch(
    "/v1/notes/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id)))
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
      const [updated] = await db.update(notes).set(patch).where(eq(notes.id, note.id)).returning();

      if (Array.isArray(body.annotations)) {
        const existing = await db
          .select()
          .from(noteAnnotations)
          .where(eq(noteAnnotations.noteId, note.id));
        const quoteById = new Map(existing.map((a) => [a.id, a.quote]));
        await db.delete(noteAnnotations).where(eq(noteAnnotations.noteId, note.id));
        const values = (body.annotations as Record<string, unknown>[]).map((a, i) => ({
          noteId: note.id,
          idx: i,
          category: typeof a.category === "string" ? a.category : "other",
          instruction: typeof a.instruction === "string" ? a.instruction : "",
          quote: typeof a.id === "string" && quoteById.has(a.id) ? quoteById.get(a.id)! : null,
          location: a.location && typeof a.location === "object" ? a.location : {},
        }));
        if (values.length) await db.insert(noteAnnotations).values(values);
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
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id)))
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
      const [updated] = await db
        .update(notes)
        .set({ status: "sent", studentId, pieceVersion, sentAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(notes.id, note.id), eq(notes.status, "draft")))
        .returning();
      if (!updated) {
        res.status(409).json({ error: "status_changed" });
        return;
      }
      await userAudit(deps, req, "note.send", { type: "note", id: note.id }, { studentId });
      res.json(updated);
    }),
  );

  router.post(
    "/v1/notes/:id/retract",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [updated] = await db
        .update(notes)
        .set({ status: "retracted", retractedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id), eq(notes.status, "sent")))
        .returning();
      if (!updated) {
        res.status(409).json({ error: "not_retractable" });
        return;
      }
      await userAudit(deps, req, "note.retract", { type: "note", id: updated.id });
      res.json(updated);
    }),
  );

  // Group send (copy the reviewed draft per student) and fix-after-retract both
  // route through duplication; a retracted origin records its successor.
  router.post(
    "/v1/notes/:id/duplicate",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const [note] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.id, String(req.params.id)), eq(notes.teacherId, me.id)))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [copy] = await db
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
      const annotations = await db
        .select()
        .from(noteAnnotations)
        .where(eq(noteAnnotations.noteId, note.id))
        .orderBy(asc(noteAnnotations.idx));
      if (annotations.length) {
        await db.insert(noteAnnotations).values(
          annotations.map((a) => ({
            noteId: copy!.id,
            idx: a.idx,
            category: a.category,
            instruction: a.instruction,
            quote: a.quote,
            location: a.location,
          })),
        );
      }
      if (note.status === "retracted") {
        await db.update(notes).set({ supersededBy: copy!.id, updatedAt: sql`now()` }).where(eq(notes.id, note.id));
      }
      await userAudit(deps, req, "note.duplicate", { type: "note", id: note.id }, { copyId: copy!.id });
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
      const teacherIds = [...new Set(visible.map((n) => n.teacherId))];
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
            teacherId: n.teacherId,
            teacherName: teacherRows.find((u) => u.id === n.teacherId)?.displayName ?? null,
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
      if (!note || note.status === "draft") {
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
      const [teacher] = await db.select().from(users).where(eq(users.id, note.teacherId)).limit(1);
      res.json({
        note,
        annotations,
        teacher: { id: note.teacherId, displayName: teacher?.displayName ?? null },
      });
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
