import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireUser, userAudit } from "../notes/user";
import { isUuid } from "../ids";
import { lessonSessions, notes, scoreScans, users, type ScoreScan } from "../db/schema";
import { ASSET_READ_SAS_MINUTES } from "../notes/assets_store";
import type { ScanStore } from "../notes/scans_store";
import { ScanChangedError } from "../notes/scans_store";
import { SCAN_HEAD_BYTES, jpegHeadVerdict } from "../notes/jpeg";
import { purgeRunner } from "../notes/purge";
import { scanPurgePrefixes, stampAndDeleteScans } from "../notes/scan_delete";

// Backstop only — a "cw" SAS cannot cap a PUT, so an over-cap upload is rejected here and swept from incoming/ in a day.
const MAX_SCAN_BYTES = 40 * 1024 * 1024;
const MAX_PAGES = 20;

const MSG_ROLE_REQUIRED = "This account isn't set up as a teacher or a student yet.";
const MSG_PAGES_MISSING = "Some of your score pages didn't arrive.";

function scanWire(row: ScoreScan) {
  return {
    id: row.id,
    title: row.title,
    clientScanId: row.clientScanId,
    pageCount: row.pageCount,
    status: row.status,
    bytes: row.bytes,
    takenDownAt: row.takenDownAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function notCreatedError(status: string): string {
  return status === "taken_down" ? "scan_taken_down" : "already_committed";
}

function pageNumbers(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

function notAnImageMessage(n: number): string {
  return `Page ${n} isn't a photo we can use.`;
}

function existingScanBody(store: ScanStore, ownerId: string, row: ScoreScan) {
  if (row.status !== "created") return { scan: scanWire(row) };
  return {
    scan: scanWire(row),
    uploadUrls: pageNumbers(row.pageCount).map((page) => ({
      page,
      url: store.uploadUrl(store.incomingPath(ownerId, row.id, page)),
    })),
  };
}

function sasExpiresAt(): string {
  return new Date(Date.now() + ASSET_READ_SAS_MINUTES * 60 * 1000).toISOString();
}

function readTitle(value: unknown): string | null {
  const title = typeof value === "string" ? value.trim() : "";
  return title ? title : null;
}

export function scansRouter(deps: Deps): Router {
  const router = Router();
  const guards = [requireAuth(deps.auth), requireUser(deps)];

  router.post(
    "/v1/score-scans",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const body = req.body ?? {};
      const clientScanId = typeof body.clientScanId === "string" && body.clientScanId.trim()
        ? body.clientScanId
        : null;

      // Idempotency check must run before any gate — a retried POST for an existing row must return it even if the role lapsed since.
      if (clientScanId) {
        const [dup] = await db
          .select()
          .from(scoreScans)
          .where(and(eq(scoreScans.ownerId, me.id), eq(scoreScans.clientScanId, clientScanId)))
          .limit(1);
        if (dup) {
          if (dup.status === "created" && !deps.scans) {
            res.status(503).json({ error: "storage_not_configured" });
            return;
          }
          res.status(200).json(existingScanBody(deps.scans!, me.id, dup));
          return;
        }
      }

      if (!me.isTeacher && !me.isStudent) {
        res.status(403).json({ error: "notes_role_required", message: MSG_ROLE_REQUIRED });
        return;
      }
      if (!deps.scans) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const pageCount = body.pageCount;
      if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
        res.status(400).json({ error: "page_count_invalid" });
        return;
      }
      const title = readTitle(body.title);
      if (!title) {
        res.status(400).json({ error: "title_required" });
        return;
      }

      const [row] = await db
        .insert(scoreScans)
        .values({ ownerId: me.id, title, clientScanId, pageCount })
        .onConflictDoNothing({ target: [scoreScans.ownerId, scoreScans.clientScanId] })
        .returning();
      if (!row) {
        // Only a keyed insert can be refused — a null clientScanId never collides on uq_score_scans_owner_client.
        const [winner] = await db
          .select()
          .from(scoreScans)
          .where(and(eq(scoreScans.ownerId, me.id), eq(scoreScans.clientScanId, clientScanId!)))
          .limit(1);
        if (!winner) throw new Error("score scan create conflicted with a row that no longer exists");
        res.status(200).json(existingScanBody(deps.scans, me.id, winner));
        return;
      }
      await userAudit(deps, req, "scan.create", { type: "scan", id: row.id }, { pageCount });
      res.status(201).json({
        scan: scanWire(row),
        uploadUrls: pageNumbers(pageCount).map((page) => ({
          page,
          url: deps.scans!.uploadUrl(deps.scans!.incomingPath(me.id, row.id, page)),
        })),
      });
    }),
  );

  // Route exists because the ~2h SAS minted at create can expire before an offline outbox retry fires.
  router.post(
    "/v1/score-scans/:id/upload-url",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      if (!deps.scans) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const id = String(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [scan] = await db
        .select()
        .from(scoreScans)
        .where(and(eq(scoreScans.id, id), eq(scoreScans.ownerId, me.id)))
        .limit(1);
      if (!scan) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (scan.status !== "created") {
        res.status(409).json({ error: notCreatedError(scan.status) });
        return;
      }
      res.json({
        uploadUrls: pageNumbers(scan.pageCount).map((page) => ({
          page,
          url: deps.scans!.uploadUrl(deps.scans!.incomingPath(me.id, scan.id, page)),
        })),
      });
    }),
  );

  router.post(
    "/v1/score-scans/:id/commit",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const store = deps.scans;
      if (!store) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const id = String(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [scan] = await db
        .select()
        .from(scoreScans)
        .where(and(eq(scoreScans.id, id), eq(scoreScans.ownerId, me.id)))
        .limit(1);
      if (!scan) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // A retry whose 200 was lost must find the scan saved, not stranded — only a takedown refuses.
      if (scan.status === "ready") {
        res.json({ scan: scanWire(scan) });
        return;
      }
      if (scan.status !== "created") {
        res.status(409).json({ error: notCreatedError(scan.status) });
        return;
      }

      // Every 4xx below leaves the staged blobs where they are — the 1-day incoming sweep is the cleanup, and a deleted stage cannot be diagnosed.
      const pages = pageNumbers(scan.pageCount);
      let bytes = 0;
      // Kept so the copy below can be pinned to the bytes this loop measured — the write grant is live for two hours after it.
      const etags = new Map<number, string | null>();
      for (const page of pages) {
        const props = await store.pageProps(store.incomingPath(me.id, scan.id, page));
        if (!props || props.bytes === 0) {
          res.status(409).json({ error: "pages_missing", n: page, message: MSG_PAGES_MISSING });
          return;
        }
        bytes += props.bytes;
        etags.set(page, props.etag);
      }
      if (bytes > MAX_SCAN_BYTES) {
        res.status(413).json({ error: "scan_too_large", bytes, maxBytes: MAX_SCAN_BYTES });
        return;
      }
      for (const page of pages) {
        const head = await store.readHead(store.incomingPath(me.id, scan.id, page), SCAN_HEAD_BYTES);
        const verdict = jpegHeadVerdict(head);
        if (verdict !== "ok") {
          res.status(415).json({
            error: "not_an_image",
            n: page,
            reason: verdict,
            message: notAnImageMessage(page),
          });
          return;
        }
      }

      const purge = purgeRunner({ op: "scan.commit", userId: me.id, reqId: req.reqId ?? null });
      const answerSurvivor = async (): Promise<boolean> => {
        const [survivor] = await db
          .select()
          .from(scoreScans)
          .where(eq(scoreScans.id, scan.id))
          .limit(1);
        // Only when the row is gone: a concurrent successful commit put its pages at these same paths.
        if (!survivor) {
          for (const prefix of [store.blobPrefix(me.id, scan.id), store.incomingPrefix(me.id, scan.id)]) {
            await purge("scan", prefix, () => store.deletePrefix(prefix));
          }
          res.status(404).json({ error: "not_found" });
          return true;
        }
        if (survivor.status === "created") return false;
        if (survivor.status === "ready") {
          res.json({ scan: scanWire(survivor) });
          return true;
        }
        res.status(409).json({ error: notCreatedError(survivor.status) });
        return true;
      };

      try {
        for (const page of pages) {
          await store.promote(
            store.incomingPath(me.id, scan.id, page),
            store.blobPath(me.id, scan.id, page),
            { ifMatch: etags.get(page) ?? null },
          );
        }
      } catch (err) {
        if (err instanceof ScanChangedError) {
          res.status(409).json({ error: "pages_changed", message: MSG_PAGES_MISSING });
          return;
        }
        // The winner sweeps the stage mid-copy — the row it left behind is the honest answer, not the copy error.
        if (!(await answerSurvivor())) throw err;
        return;
      }
      // Flip before the stage is swept: a crash the other way round leaves a 'created' row whose pages no longer exist anywhere.
      const [updated] = await db
        .update(scoreScans)
        .set({
          status: "ready",
          bytes,
          pageCount: pages.length,
          blobPath: store.blobPrefix(me.id, scan.id),
          updatedAt: sql`now()`,
        })
        .where(and(eq(scoreScans.id, scan.id), eq(scoreScans.status, "created")))
        .returning();
      if (!updated) {
        if (!(await answerSurvivor())) throw new Error("score scan commit lost a race to a row still created");
        return;
      }
      // The row is already ready — a stage that will not sweep is the 1-day rule's problem, not a reason to tell the client the commit failed.
      const stage = store.incomingPrefix(me.id, scan.id);
      await purge("scan", stage, () => store.deletePrefix(stage));
      await userAudit(deps, req, "scan.commit", { type: "scan", id: scan.id }, {
        pageCount: pages.length,
        bytes,
      });
      res.json({ scan: scanWire(updated) });
    }),
  );

  router.get(
    "/v1/score-scans",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const store = deps.scans;
      if (!store) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const rows = await db
        .select()
        .from(scoreScans)
        .where(eq(scoreScans.ownerId, me.id))
        .orderBy(desc(scoreScans.createdAt));
      res.set("Cache-Control", "no-store");
      res.json({
        scans: rows.map((row) => ({
          ...scanWire(row),
          thumbnailUrl: row.status === "ready" && row.blobPath
            ? store.readUrl(store.blobPath(me.id, row.id, 1))
            : null,
        })),
        expiresAt: sasExpiresAt(),
      });
    }),
  );

  // No entitlement gate anywhere on this route — a lapsed trial must not lock someone out of their own photograph of their own book.
  router.get(
    "/v1/score-scans/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const store = deps.scans;
      if (!store) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const id = String(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Scope is in the predicate — a non-owner must meet the same 404 as a caller naming an id that never existed.
      const [scan] = await db
        .select()
        .from(scoreScans)
        .where(and(eq(scoreScans.id, id), eq(scoreScans.ownerId, me.id)))
        .limit(1);
      if (!scan) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (scan.status === "created") {
        res.status(409).json({ error: "scan_not_ready" });
        return;
      }
      // Takedown before purge: a taken-down row also carries a null blob_prefix, and the owner is entitled to the reason.
      if (scan.status === "taken_down") {
        res.status(410).json({ error: "scan_taken_down" });
        return;
      }
      if (!scan.blobPath) {
        res.status(410).json({ error: "scan_purged" });
        return;
      }
      // A null recipientName is also a live student who skipped the optional name — only this flag may be read as a deleted account.
      const usedByRows = await db
        .select({
          noteId: notes.id,
          status: notes.status,
          origin: notes.origin,
          recipientName: users.displayName,
          recipientStatus: users.status,
          sentAt: notes.sentAt,
          createdAt: notes.createdAt,
        })
        .from(notes)
        .leftJoin(users, eq(users.id, notes.studentId))
        .where(and(eq(notes.scoreScanId, scan.id), inArray(notes.status, ["draft", "sent"])))
        .orderBy(desc(notes.createdAt));
      const usedBy = usedByRows.map(({ recipientStatus, ...row }) => ({
        ...row,
        recipientDeleted: recipientStatus === "deleted",
      }));
      // A lesson can hold the scan for the whole ASR+LLM window before any note exists; without this the dialog says "No note is showing them" over pages a note is about to carry.
      const [heldByLesson] = await db
        .select({ id: lessonSessions.id })
        .from(lessonSessions)
        .where(eq(lessonSessions.scoreScanId, scan.id))
        .limit(1);
      res.set("Cache-Control", "no-store");
      res.json({
        scan: scanWire(scan),
        pages: pageNumbers(scan.pageCount).map((page) => ({
          page,
          url: store.readUrl(store.blobPath(me.id, scan.id, page)),
        })),
        expiresAt: sasExpiresAt(),
        usedBy,
        heldByLesson: Boolean(heldByLesson),
      });
    }),
  );

  router.patch(
    "/v1/score-scans/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const id = String(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const title = readTitle((req.body ?? {}).title);
      if (!title) {
        res.status(400).json({ error: "title_required" });
        return;
      }
      const [updated] = await db
        .update(scoreScans)
        .set({ title, updatedAt: sql`now()` })
        .where(and(eq(scoreScans.id, id), eq(scoreScans.ownerId, me.id)))
        .returning();
      if (!updated) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await userAudit(deps, req, "scan.rename", { type: "scan", id: updated.id });
      res.json({ scan: scanWire(updated) });
    }),
  );

  router.delete(
    "/v1/score-scans/:id",
    ...guards,
    wrap(async (req, res) => {
      const me = req.notesUser!;
      const db = deps.db!.orm;
      const store = deps.scans;
      // Refuse before the row goes: a delete that cannot even attempt the purge would leave bytes nothing names.
      if (!store) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const id = String(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const deleted = await db.transaction((tx) =>
        stampAndDeleteScans(tx, { ownerId: me.id, scanId: id }),
      );
      if (!deleted.length) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await userAudit(deps, req, "scan.delete", { type: "scan", id });
      const purge = purgeRunner({ op: "scan.delete", userId: me.id, reqId: req.reqId ?? null });
      for (const prefix of scanPurgePrefixes(store, me.id, deleted)) {
        await purge("scan", prefix, () => store.deletePrefix(prefix));
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
