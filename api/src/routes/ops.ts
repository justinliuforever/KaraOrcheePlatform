import { Router } from "express";
import { and, desc, eq, inArray, like, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireAdmin, audit } from "../admin";
import { auditEvents, studioJobs, users } from "../db/schema";
import { OpsQueryError, type OpsFilters, type OpsLogRow } from "../opslogs";

// Time-range guardrails: the server, not the client, owns how expensive a
// query may get. 30d matches the workspace's interactive retention.
const MAX_RANGE_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_RANGE_MS = 24 * 3600 * 1000;

const filterSchema = z.object({
  kind: z.string().max(20).optional(),
  source: z.string().max(20).optional(),
  severity: z.string().max(40).optional(),
  statusClass: z.string().max(5).optional(),
  route: z.string().max(300).optional(),
  method: z.string().max(10).optional(),
  reqId: z.string().max(80).optional(),
  oid: z.string().max(80).optional(),
  admin: z.string().max(80).optional(),
  job: z.string().max(80).optional(),
  event: z.string().max(60).optional(),
  text: z.string().max(200).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  order: z.enum(["asc", "desc"]).default("desc"),
});

function parseWindow(q: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  let from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);
  if (from.getTime() >= to.getTime()) from = new Date(to.getTime() - DEFAULT_RANGE_MS);
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) from = new Date(to.getTime() - MAX_RANGE_MS);
  return { from, to };
}

function toFilters(q: z.infer<typeof filterSchema>): OpsFilters {
  const { from: _f, to: _t, limit: _l, order: _o, ...filters } = q;
  return filters;
}

function sendOpsError(res: import("express").Response, err: unknown): boolean {
  if (err instanceof OpsQueryError) {
    const status = err.code === "query_timeout" ? 504 : err.code === "busy" ? 429 : 502;
    res.status(status).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

export function opsRouter(deps: Deps): Router {
  const router = Router();
  router.use("/admin/ops", requireAuth(deps.auth), requireAdmin(deps));

  const needStore = (res: import("express").Response): boolean => {
    if (!deps.opsLogs) {
      res.status(503).json({ error: "ops_not_configured", message: "Log Analytics workspace is not configured for this environment." });
      return false;
    }
    return true;
  };

  router.get(
    "/admin/ops/logs",
    wrap(async (req, res) => {
      if (!needStore(res)) return;
      const parsed = filterSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_query", detail: parsed.error.issues });
        return;
      }
      const { from, to } = parseWindow(parsed.data);
      try {
        const result = await deps.opsLogs!.queryLogs(toFilters(parsed.data), from, to, parsed.data.limit, parsed.data.order);
        res.json(result);
      } catch (err) {
        if (!sendOpsError(res, err)) throw err;
      }
    }),
  );

  router.get(
    "/admin/ops/histogram",
    wrap(async (req, res) => {
      if (!needStore(res)) return;
      const parsed = filterSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_query", detail: parsed.error.issues });
        return;
      }
      const { from, to } = parseWindow(parsed.data);
      try {
        res.json(await deps.opsLogs!.queryHistogram(toFilters(parsed.data), from, to));
      } catch (err) {
        if (!sendOpsError(res, err)) throw err;
      }
    }),
  );

  router.get(
    "/admin/ops/facets",
    wrap(async (req, res) => {
      if (!needStore(res)) return;
      const parsed = filterSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_query", detail: parsed.error.issues });
        return;
      }
      const { from, to } = parseWindow(parsed.data);
      try {
        const facets = await deps.opsLogs!.queryFacets(toFilters(parsed.data), from, to);
        // The admin facet shows operator emails, not opaque user ids.
        if (facets.admin?.length && deps.db) {
          const rows = await deps.db.orm.select({ id: users.id, email: users.email }).from(users);
          const byId = new Map(rows.map((r) => [r.id, r.email]));
          facets.admin = facets.admin.map((f) => ({ ...f, label: byId.get(f.value) ?? undefined })) as typeof facets.admin;
        }
        res.json({ facets });
      } catch (err) {
        if (!sendOpsError(res, err)) throw err;
      }
    }),
  );

  // The reqId pivot: one merged chronological timeline across the API request
  // logs, the worker's job logs, and the business audit trail — the three
  // surfaces already share the id, this endpoint just joins them.
  router.get(
    "/admin/ops/request/:reqId",
    wrap(async (req, res) => {
      if (!needStore(res)) return;
      const reqId = String(req.params.reqId);
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(reqId)) {
        res.status(400).json({ error: "invalid_query", message: "Malformed request id." });
        return;
      }
      let logRows: OpsLogRow[];
      try {
        logRows = await deps.opsLogs!.queryRequest(reqId);
      } catch (err) {
        if (!sendOpsError(res, err)) throw err;
        return;
      }
      type TimelineEvent = {
        t: string;
        lane: "api" | "worker" | "audit";
        severity?: "error" | "warn" | "info";
        msg: string;
        method?: string | null;
        route?: string | null;
        status?: number | null;
        ms?: number | null;
        job?: string | null;
        event?: string | null;
        action?: string;
        actorEmail?: string | null;
        detail?: unknown;
      };
      const events: TimelineEvent[] = logRows.map((r) => ({
        t: r.t,
        lane: r.source,
        severity: r.severity,
        msg: r.msg,
        method: r.method,
        route: r.route,
        status: r.status,
        ms: r.ms,
        job: r.job,
        event: r.event,
      }));
      if (deps.db) {
        const audits = await deps.db.orm
          .select({
            action: auditEvents.action,
            subjectType: auditEvents.subjectType,
            subjectId: auditEvents.subjectId,
            detail: auditEvents.detail,
            createdAt: auditEvents.createdAt,
            actorEmail: users.email,
          })
          .from(auditEvents)
          .leftJoin(users, eq(auditEvents.actorUserId, users.id))
          .where(sql`${auditEvents.detail} ->> 'reqId' = ${reqId}`)
          .orderBy(auditEvents.createdAt);
        for (const a of audits) {
          events.push({
            t: a.createdAt.toISOString(),
            lane: "audit",
            msg: `${a.action}${a.subjectType ? ` · ${a.subjectType}/${a.subjectId}` : ""}`,
            action: a.action,
            actorEmail: a.actorEmail,
            detail: a.detail,
          });
        }
      }
      events.sort((a, b) => a.t.localeCompare(b.t));
      res.json({ events });
    }),
  );

  // Staging sweeper, safest slice: blobs of canceled/failed jobs older than 7 days
  // that never became a real piece (draft_* ids). Published pieces' staged sources
  // double as their source archive and are never touched. Dry-run by default.
  router.post(
    "/admin/ops/gc",
    wrap(async (req, res) => {
      const dryRun = req.body?.dryRun !== false;
      if (!deps.studio?.listBundles || !deps.studio.deleteBundleBlob || !deps.studio.deleteSourceBlob) {
        res.status(503).json({ error: "ops_not_configured", message: "Storage is not configured for GC." });
        return;
      }
      const db = deps.db!.orm;
      const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const stale = await db
        .select({ id: studioJobs.id, status: studioJobs.status, updatedAt: studioJobs.updatedAt })
        .from(studioJobs)
        .where(and(
          inArray(studioJobs.status, ["canceled", "failed"]),
          like(studioJobs.pieceId, "draft\\_%"),
          lt(studioJobs.updatedAt, cutoff),
        ));
      let blobs = 0;
      let bytes = 0;
      const jobs: string[] = [];
      for (const job of stale) {
        const staged = await deps.studio.listBundles(`staging/${job.id}/`);
        const sources = await deps.studio.listSources(`staging/${job.id}/`);
        if (staged.length + sources.length === 0) continue;
        jobs.push(job.id);
        blobs += staged.length + sources.length;
        bytes += [...staged, ...sources].reduce((n, b) => n + b.bytes, 0);
        if (!dryRun) {
          for (const b of staged) await deps.studio.deleteBundleBlob(b.path);
          for (const b of sources) await deps.studio.deleteSourceBlob(b.path);
        }
      }
      if (!dryRun && jobs.length > 0) {
        await audit(deps, req, "ops.gc", undefined, { jobs, blobs, bytes });
      }
      res.json({ dryRun, jobs: jobs.length, blobs, bytes });
    }),
  );

  router.get(
    "/admin/ops/queue",
    wrap(async (_req, res) => {
      if (!deps.opsQueue) {
        res.status(503).json({ error: "ops_not_configured", message: "Service Bus is not configured for this environment." });
        return;
      }
      const [queues, dlq] = await Promise.all([deps.opsQueue.counts(), deps.opsQueue.peekDeadLetters()]);
      const recentJobs = deps.db
        ? await deps.db.orm
            .select({
              id: studioJobs.id,
              pieceId: studioJobs.pieceId,
              status: studioJobs.status,
              checkStatus: studioJobs.checkStatus,
              error: studioJobs.error,
              createdAt: studioJobs.createdAt,
              updatedAt: studioJobs.updatedAt,
            })
            .from(studioJobs)
            .orderBy(desc(studioJobs.updatedAt))
            .limit(15)
        : [];
      res.json({ queues, dlq, recentJobs });
    }),
  );

  return router;
}
