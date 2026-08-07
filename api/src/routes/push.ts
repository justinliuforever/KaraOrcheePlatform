import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { notifyNotesReady } from "../notes/push";
import { lessonSessions, noteJobs, notes } from "../db/schema";

function keyMatches(presented: string | undefined, key: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Worker → API, container to container, authenticated by a shared Key Vault secret.
// Deliberately the smallest thing that can exist: it takes no body, reads no user
// input beyond a job id, and its only effect is one fixed-string alert about a job
// the database already says is ready. That is the whole blast radius of a leaked
// key — a spurious banner, never data.
// `key` is passed, never defaulted from the environment here: a default would make an
// explicit "no key configured" indistinguishable from an unread env var, and 503 vs 401
// is the whole diagnosis when the worker's pushes go quiet.
export function internalPushRouter(deps: Deps, key: string | undefined): Router {
  const router = Router();

  router.post(
    "/internal/notes/:jobId/ready-push",
    wrap(async (req, res) => {
      if (!key) {
        res.status(503).json({ error: "internal_key_unset" });
        return;
      }
      if (!keyMatches(req.get("X-Internal-Key") ?? undefined, key)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const db = deps.db!.orm;
      const jobId = String(req.params.jobId);
      const [job] = await db
        .select({
          status: noteJobs.status,
          recipientId: lessonSessions.teacherId,
          ownerRole: lessonSessions.ownerRole,
        })
        .from(noteJobs)
        .innerJoin(lessonSessions, eq(lessonSessions.id, noteJobs.lessonSessionId))
        .where(eq(noteJobs.id, jobId));
      if (!job) {
        res.status(404).json({ error: "unknown_job" });
        return;
      }
      // The alert says notes are ready; the row is the only thing that knows whether
      // they are. A push ahead of the flip would announce a note the app cannot open.
      if (job.status !== "ready_for_review") {
        res.status(409).json({ error: "not_ready", status: job.status });
        return;
      }
      const [note] = await db
        .select({ id: notes.id })
        .from(notes)
        .where(eq(notes.noteJobId, jobId))
        .orderBy(asc(notes.createdAt))
        .limit(1);
      if (!note) {
        res.status(404).json({ error: "note_missing" });
        return;
      }
      const push = await notifyNotesReady(deps, {
        userId: job.recipientId,
        noteId: note.id,
        ownerRole: job.ownerRole,
      });
      res.json({ ok: true, push });
    }),
  );

  return router;
}
