import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
  type JWK,
} from "jose";
import { createServer } from "../src/server";
import { createJoseVerifier, type AuthVerifier } from "../src/auth";
import { createTestDb } from "./testdb";
import {
  users,
  teacherStudentLinks,
  invites,
  entitlements,
  platformConfig,
  lessonSessions,
  noteJobs,
  notes,
  auditEvents,
  scoreScans,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { NotesQueue } from "../src/queue";
import type { NotesAssetsStore } from "../src/notes/assets_store";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;
let adminToken: string;
let admin2Token: string;
let plainToken: string;

interface FakeQueue extends NotesQueue {
  sent: Record<string, unknown>[];
  throwNext: boolean;
}
function makeFakeQueue(): FakeQueue {
  const q: FakeQueue = {
    sent: [],
    throwNext: false,
    async send(body) {
      if (q.throwNext) throw new Error("service bus unavailable");
      q.sent.push(body);
    },
    async sendNarration(body) {
      if (q.throwNext) throw new Error("service bus unavailable");
      q.sent.push(body);
    },
  };
  return q;
}

interface FakeAssets extends NotesAssetsStore {
  body: unknown;
  reads: string[];
  deleted: string[];
  deletedPrefixes: string[];
}
function makeFakeAssets(): FakeAssets {
  const a: FakeAssets = {
    body: { text: "so let's fix the left hand in bars 3 to 5" },
    reads: [],
    deleted: [],
    deletedPrefixes: [],
    async readJson(path) {
      a.reads.push(path);
      return a.body;
    },
    readUrl(path) {
      return `https://fake.blob/notes-assets/${path}?sig=fake`;
    },
    async copyAsset() {},
    async deleteAsset(path) {
      a.deleted.push(path);
    },
    async deletePrefix(prefix) {
      a.deletedPrefixes.push(prefix);
    },
  };
  return a;
}

let fakeQueue: FakeQueue;
let fakeAssets: FakeAssets;

function app(over: Record<string, unknown> = {}) {
  return createServer({ db, auth: verifier, notesQueue: fakeQueue, notesAssets: fakeAssets, ...over });
}

async function sign(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

let seq = 0;
async function mkUser(over: Partial<typeof users.$inferInsert> = {}) {
  seq += 1;
  const [u] = await db.orm
    .insert(users)
    .values({ entraOid: `an-oid-${seq}`, email: `u${seq}@k.com`, displayName: `User ${seq}`, ...over })
    .returning();
  return u!;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}
function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

async function seedJob(teacherId: string, jobOver: Partial<typeof noteJobs.$inferInsert> = {}, lessonOver: Partial<typeof lessonSessions.$inferInsert> = {}) {
  const [lesson] = await db.orm
    .insert(lessonSessions)
    .values({ teacherId, ...lessonOver })
    .returning();
  const [job] = await db.orm
    .insert(noteJobs)
    .values({ lessonSessionId: lesson!.id, createdBy: teacherId, ...jobOver })
    .returning();
  return { lesson: lesson!, job: job! };
}

async function seedSentNote(teacherId: string, studentId: string, pieceLabel: string) {
  const { lesson, job } = await seedJob(teacherId, {}, { studentId, pieceLabel });
  const content = { lessonSummary: "x", practicePlan: [] };
  const [note] = await db.orm
    .insert(notes)
    .values({
      noteJobId: job.id,
      lessonSessionId: lesson.id,
      teacherId,
      studentId,
      pieceLabel,
      status: "sent",
      sentAt: new Date(),
      contentOriginal: content,
      content,
    })
    .returning();
  return { lesson, job, note: note! };
}

async function auditFor(action: string) {
  const rows = await db.orm.select().from(auditEvents).where(eq(auditEvents.action, action));
  return rows;
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  verifier = createJoseVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet({ keys: [jwk] }) });
  db = await createTestDb();
  fakeQueue = makeFakeQueue();
  fakeAssets = makeFakeAssets();

  await db.orm.insert(users).values([
    { entraOid: "an-admin-oid", email: "admin@karaorchee.com", displayName: "Notes Admin", isAdmin: true, canViewTranscripts: true },
    { entraOid: "an-admin2-oid", email: "admin2@karaorchee.com", displayName: "Pieces Admin", isAdmin: true },
    { entraOid: "an-plain-oid", email: "plain@example.com", displayName: "Plain" },
  ]);
  adminToken = await sign({ oid: "an-admin-oid" });
  admin2Token = await sign({ oid: "an-admin2-oid" });
  plainToken = await sign({ oid: "an-plain-oid" });
});

beforeEach(() => {
  fakeQueue.throwNext = false;
});

describe("adminNotes gate", () => {
  it("401s without a token", async () => {
    const res = await request(app()).get("/admin/notes/links");
    expect(res.status).toBe(401);
  });

  it("403s a signed-in non-admin on a sample route", async () => {
    const res = await request(app()).get("/admin/notes/links").set("Authorization", `Bearer ${plainToken}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });
});

describe("notes links", () => {
  let teacher: typeof users.$inferSelect;
  let studentActive: typeof users.$inferSelect;
  let studentRemoved: typeof users.$inferSelect;

  beforeAll(async () => {
    teacher = await mkUser({ displayName: "Link Teacher", email: "linkteach@k.com", isTeacher: true });
    studentActive = await mkUser({ displayName: "Active Student", email: "activestu@k.com", isStudent: true });
    studentRemoved = await mkUser({ displayName: "Removed Student", email: "removedstu@k.com", isStudent: true });
    await db.orm.insert(teacherStudentLinks).values([
      { teacherId: teacher.id, studentId: studentActive.id, status: "active", consentAt: new Date() },
      { teacherId: teacher.id, studentId: studentRemoved.id, status: "removed", removedAt: new Date(), consentAt: new Date() },
    ]);
  });

  it("lists links joined to both parties' identity", async () => {
    const res = await request(app()).get("/admin/notes/links").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((r: { teacherId: string; studentId: string }) => r.teacherId === teacher.id && r.studentId === studentActive.id);
    expect(row.teacherEmail).toBe("linkteach@k.com");
    expect(row.studentName).toBe("Active Student");
    expect(row.status).toBe("active");
  });

  it("filters by status", async () => {
    const removed = await request(app())
      .get("/admin/notes/links?status=removed")
      .set("Authorization", `Bearer ${adminToken}`);
    const ids = removed.body.items.map((r: { studentId: string }) => r.studentId);
    expect(ids).toContain(studentRemoved.id);
    expect(ids).not.toContain(studentActive.id);
  });

  it("searches by either party's email or name", async () => {
    const byStudent = await request(app())
      .get("/admin/notes/links?q=activestu")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byStudent.body.items.every((r: { studentEmail: string }) => r.studentEmail === "activestu@k.com")).toBe(true);
    const byTeacher = await request(app())
      .get("/admin/notes/links?q=Link Teacher")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byTeacher.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("force-creates a new link and grows both role flags", async () => {
    const t = await mkUser({ displayName: "Fresh Teacher" }); // no role flags
    const s = await mkUser({ displayName: "Fresh Student" });
    const res = await request(app())
      .post("/admin/notes/links")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId: t.id, studentId: s.id });
    expect(res.status).toBe(201);
    expect(res.body.link.status).toBe("active");
    expect(res.body.link.createdVia).toBe("admin");
    expect(res.body.link.consentAt).not.toBeNull();

    const [tr] = await db.orm.select().from(users).where(eq(users.id, t.id));
    const [sr] = await db.orm.select().from(users).where(eq(users.id, s.id));
    expect(tr!.isTeacher).toBe(true);
    expect(sr!.isStudent).toBe(true);

    const audits = await auditFor("link.admin_create");
    expect(audits.some((a) => a.subjectId === res.body.link.id)).toBe(true);
  });

  it("reactivates a removed pair in place (same row id)", async () => {
    const t = await mkUser({ isTeacher: true });
    const s = await mkUser({ isStudent: true });
    const [removed] = await db.orm
      .insert(teacherStudentLinks)
      .values({ teacherId: t.id, studentId: s.id, status: "removed", removedAt: new Date(), createdVia: "invite_code" })
      .returning();
    const res = await request(app())
      .post("/admin/notes/links")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId: t.id, studentId: s.id });
    expect(res.status).toBe(200);
    expect(res.body.link.id).toBe(removed!.id);
    expect(res.body.link.status).toBe("active");
    expect(res.body.link.removedAt).toBeNull();
  });

  it("rejects a non-distinct pair", async () => {
    const t = await mkUser();
    const res = await request(app())
      .post("/admin/notes/links")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId: t.id, studentId: t.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("same_user");
  });

  it("rejects an unknown user", async () => {
    const t = await mkUser();
    const res = await request(app())
      .post("/admin/notes/links")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId: t.id, studentId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_user");
  });

  it("soft-removes a link and audits; 404 on unknown", async () => {
    const t = await mkUser({ isTeacher: true });
    const s = await mkUser({ isStudent: true });
    const [link] = await db.orm
      .insert(teacherStudentLinks)
      .values({ teacherId: t.id, studentId: s.id, status: "active", consentAt: new Date() })
      .returning();
    const res = await request(app())
      .delete(`/admin/notes/links/${link!.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.link.status).toBe("removed");
    expect(res.body.link.removedAt).not.toBeNull();
    const audits = await auditFor("link.admin_remove");
    expect(audits.some((a) => a.subjectId === link!.id)).toBe(true);

    const missing = await request(app())
      .delete("/admin/notes/links/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(missing.status).toBe(404);
  });
});

describe("notes invites", () => {
  let teacher: typeof users.$inferSelect;
  let activeInvite: typeof invites.$inferSelect;

  beforeAll(async () => {
    teacher = await mkUser({ displayName: "Invite Teacher", email: "inviteteach@k.com", isTeacher: true });
    const rows = await db.orm
      .insert(invites)
      .values([
        { code: "ANACT1", teacherId: teacher.id, expiresAt: daysFromNow(7) },
        { code: "ANEXP1", teacherId: teacher.id, expiresAt: daysAgo(1) },
        { code: "ANREV1", teacherId: teacher.id, expiresAt: daysFromNow(7), revokedAt: new Date() },
        { code: "ANUSE1", teacherId: teacher.id, expiresAt: daysFromNow(7), maxUses: 1, usedCount: 1 },
      ])
      .returning();
    activeInvite = rows[0]!;
  });

  it("derives active | expired | exhausted | revoked", async () => {
    const res = await request(app())
      .get("/admin/notes/invites?q=inviteteach")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const byCode = new Map(res.body.items.map((r: { code: string; state: string }) => [r.code, r.state]));
    expect(byCode.get("ANACT1")).toBe("active");
    expect(byCode.get("ANEXP1")).toBe("expired");
    expect(byCode.get("ANREV1")).toBe("revoked");
    expect(byCode.get("ANUSE1")).toBe("exhausted");
    const active = res.body.items.find((r: { code: string }) => r.code === "ANACT1");
    expect(active.teacherEmail).toBe("inviteteach@k.com");
  });

  it("filters by state", async () => {
    const res = await request(app())
      .get("/admin/notes/invites?q=inviteteach&state=expired")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.items.map((r: { code: string }) => r.code)).toEqual(["ANEXP1"]);
  });

  it("revokes an invite and audits; 404 on unknown", async () => {
    const res = await request(app())
      .post(`/admin/notes/invites/${activeInvite.id}/revoke`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.invite.revokedAt).not.toBeNull();
    const [row] = await db.orm.select().from(invites).where(eq(invites.id, activeInvite.id));
    expect(row!.revokedAt).not.toBeNull();
    const audits = await auditFor("invite.admin_revoke");
    expect(audits.some((a) => a.subjectId === activeInvite.id)).toBe(true);

    const missing = await request(app())
      .post("/admin/notes/invites/00000000-0000-0000-0000-000000000000/revoke")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(missing.status).toBe(404);
  });
});

describe("notes entitlements", () => {
  let target: typeof users.$inferSelect;

  beforeAll(async () => {
    target = await mkUser({ displayName: "Ent Target", email: "enttarget@k.com", isStudent: true });
    await db.orm.insert(entitlements).values([
      { userId: target.id, source: "apple_iap", status: "active", appleOriginalTransactionId: "an-txn-1" },
      { userId: target.id, source: "trial", status: "expired" },
    ]);
  });

  it("lists entitlements joined to the user with filters", async () => {
    const res = await request(app())
      .get("/admin/notes/entitlements?q=enttarget&source=apple_iap")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].userEmail).toBe("enttarget@k.com");
    expect(res.body.items[0].appleOriginalTransactionId).toBe("an-txn-1");
  });

  it("rejects a grant with a missing/short reason", async () => {
    const res = await request(app())
      .post("/admin/notes/entitlements/grant")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: target.id, days: 30, reason: "too short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("reason_required");
  });

  it("grants an admin entitlement with correct expiry math and audits", async () => {
    const before = Date.now();
    const res = await request(app())
      .post("/admin/notes/entitlements/grant")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: target.id, days: 30, reason: "Comped for launch beta feedback." });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("admin_grant");
    expect(res.body.status).toBe("active");
    expect(res.body.note).toBe("Comped for launch beta feedback.");
    const expiresMs = new Date(res.body.expiresAt).getTime();
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresMs - expected)).toBeLessThan(60_000);

    const audits = await auditFor("entitlement.grant");
    const evt = audits.find((a) => a.subjectId === res.body.id);
    expect((evt!.detail as { days: number }).days).toBe(30);
    expect((evt!.detail as { userId: string }).userId).toBe(target.id);
  });

  it("revokes an entitlement (reason required), audits, and keeps the original grant reason", async () => {
    const [ent] = await db.orm
      .insert(entitlements)
      .values({ userId: target.id, source: "admin_grant", status: "active", note: "grant reason kept" })
      .returning();

    const short = await request(app())
      .post(`/admin/notes/entitlements/${ent!.id}/revoke`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "nope" });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe("reason_required");

    const res = await request(app())
      .post(`/admin/notes/entitlements/${ent!.id}/revoke`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Refund processed via Apple." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("revoked");
    expect(res.body.note).toBe("grant reason kept");
    const audits = await auditFor("entitlement.revoke");
    expect(audits.some((a) => a.subjectId === ent!.id)).toBe(true);
  });
});

describe("monetization config", () => {
  it("reads beta_free by default, flips to paid_after, then clears, auditing from/to", async () => {
    const initial = await request(app())
      .get("/admin/notes/config/monetization")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(initial.status).toBe(200);
    expect(initial.body.value).toBeNull();
    expect(initial.body.state).toBe("beta_free");

    const iso = daysAgo(5).toISOString();
    const set = await request(app())
      .put("/admin/notes/config/monetization")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ value: iso });
    expect(set.status).toBe(200);
    expect(set.body.value).toBe(iso);
    expect(set.body.state).toBe("paid_after");

    const get = await request(app())
      .get("/admin/notes/config/monetization")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(get.body.value).toBe(iso);

    const cleared = await request(app())
      .put("/admin/notes/config/monetization")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ value: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.value).toBeNull();
    expect(cleared.body.state).toBe("beta_free");

    const audits = await auditFor("config.monetization.set");
    const setEvt = audits.find((a) => (a.detail as { to?: string }).to === iso);
    expect((setEvt!.detail as { from: string | null }).from).toBeNull();
    const clearEvt = audits.find((a) => (a.detail as { from?: string }).from === iso && (a.detail as { to: string | null }).to === null);
    expect(clearEvt).toBeTruthy();
  });

  it("rejects a malformed value", async () => {
    const res = await request(app())
      .put("/admin/notes/config/monetization")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ value: "not-a-date" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_value");
  });
});

describe("note-jobs monitoring", () => {
  let teacher: typeof users.$inferSelect;
  let readyJob: string;

  beforeAll(async () => {
    teacher = await mkUser({ displayName: "Job Teacher", email: "jobteach@k.com", isTeacher: true });
    const { job } = await seedJob(
      teacher.id,
      { status: "ready_for_review", stage: "gates", transcriptPath: `${teacher.id}/lesson-1/transcript.json`, metrics: { reqId: "req-abc" } },
      { pieceLabel: "Minuet in G" },
    );
    readyJob = job.id;
    const content = { lessonSummary: "y", practicePlan: [] };
    await db.orm.insert(notes).values({
      noteJobId: job.id,
      lessonSessionId: job.lessonSessionId,
      teacherId: teacher.id,
      status: "draft",
      contentOriginal: content,
      content,
    });
  });

  it("lists jobs joined to lesson/teacher with status facets", async () => {
    const res = await request(app())
      .get("/admin/note-jobs?q=jobteach")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((r: { id: string }) => r.id === readyJob);
    expect(row.teacherEmail).toBe("jobteach@k.com");
    expect(row.pieceLabel).toBe("Minuet in G");
    expect(row.reqId).toBe("req-abc");
    expect(Array.isArray(res.body.facets.status)).toBe(true);
    expect(res.body.facets.status.some((f: { value: string }) => f.value === "ready_for_review")).toBe(true);
  });

  it("filters by status", async () => {
    const res = await request(app())
      .get("/admin/note-jobs?status=ready_for_review&q=jobteach")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.items.every((r: { status: string }) => r.status === "ready_for_review")).toBe(true);
  });

  it("returns detail with lesson summary and produced note ids (no transcript body)", async () => {
    const res = await request(app())
      .get(`/admin/note-jobs/${readyJob}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(readyJob);
    expect(res.body.lesson.pieceLabel).toBe("Minuet in G");
    expect(res.body.lesson.teacher.email).toBe("jobteach@k.com");
    expect(res.body.notes.length).toBe(1);
    expect(res.body).not.toHaveProperty("transcript");
  });

  it("answers 'can the recorder retry this?' on the detail, independently of admin requeue", async () => {
    const { job } = await seedJob(teacher.id, {
      status: "failed",
      failureCode: "no_speech",
      attempts: 1,
    }, { status: "submitted" });
    const res = await request(app())
      .get(`/admin/note-jobs/${job.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.retry).toMatchObject({ allowed: false, cap: 0, attempts: 1 });
    expect(res.body.retry.reason).toBe("retry_exhausted");

    const retryable = await seedJob(teacher.id, {
      status: "failed",
      failureCode: "asr_error",
      attempts: 1,
    }, { status: "submitted" });
    const ok = await request(app())
      .get(`/admin/note-jobs/${retryable.job.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(ok.body.retry).toMatchObject({ allowed: true, cap: 3, attempts: 1, reason: null });
  });

  it("404s an unknown job", async () => {
    const res = await request(app())
      .get("/admin/note-jobs/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("requeue is failed-only; sends to the queue; audits", async () => {
    const notFailed = await request(app())
      .post(`/admin/note-jobs/${readyJob}/requeue`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(notFailed.status).toBe(409);
    expect(notFailed.body.error).toBe("not_failed");

    const { job } = await seedJob(teacher.id, { status: "failed", stage: "asr", error: "asr boom", failureHints: ["retry"], attempts: 1 });
    const res = await request(app())
      .post(`/admin/note-jobs/${job.id}/requeue`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe("queued");
    expect(res.body.job.stage).toBeNull();
    expect(res.body.job.error).toBeNull();
    expect(res.body.job.attempts).toBe(2);
    expect(fakeQueue.sent.some((m) => m.jobId === job.id)).toBe(true);
    const audits = await auditFor("note_job.requeue");
    expect(audits.some((a) => a.subjectId === job.id)).toBe(true);
  });

  it("rolls the job back to failed if the queue send throws", async () => {
    const { job } = await seedJob(teacher.id, { status: "failed", stage: "llm", error: "llm boom", attempts: 2 });
    fakeQueue.throwNext = true;
    const res = await request(app())
      .post(`/admin/note-jobs/${job.id}/requeue`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("queue_unavailable");
    const [row] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job.id));
    expect(row!.status).toBe("failed");
  });

  it("list carries failureCode / discardedAt / lessonStatus and a failureCode facet", async () => {
    const codeTeacher = await mkUser({ displayName: "Code Teacher", email: "codeteach@k.com", isTeacher: true });
    await seedJob(codeTeacher.id, { status: "failed", failureCode: "no_speech" });
    await seedJob(codeTeacher.id, { status: "failed", failureCode: "thin_note" });
    await seedJob(
      codeTeacher.id,
      { status: "failed", failureCode: "thin_note", discardedAt: new Date() },
      { status: "canceled" },
    );
    const res = await request(app())
      .get("/admin/note-jobs?q=codeteach")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(3);
    const codes = res.body.items.map((r: { failureCode: string }) => r.failureCode).sort();
    expect(codes).toEqual(["no_speech", "thin_note", "thin_note"]);
    const discarded = res.body.items.find((r: { discardedAt: string | null }) => r.discardedAt !== null);
    expect(discarded.lessonStatus).toBe("canceled");
    const facet = res.body.facets.failureCode;
    expect(facet.find((f: { value: string }) => f.value === "thin_note").count).toBe(2);
    expect(facet.find((f: { value: string }) => f.value === "no_speech").count).toBe(1);
  });

  it("filters by failureCode, and that facet still ignores its own filter", async () => {
    const res = await request(app())
      .get("/admin/note-jobs?q=codeteach&failureCode=no_speech")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].failureCode).toBe("no_speech");
    expect(res.body.facets.failureCode.length).toBe(2);
  });

  it("detail exposes the code and the discard stamp", async () => {
    const { job } = await seedJob(
      teacher.id,
      { status: "failed", failureCode: "worker_crash", discardedAt: new Date() },
      { status: "canceled" },
    );
    const res = await request(app())
      .get(`/admin/note-jobs/${job.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.job.failureCode).toBe("worker_crash");
    expect(res.body.job.discardedAt).not.toBeNull();
    expect(res.body.lesson.status).toBe("canceled");
  });

  it("requeue refuses a discarded lesson — the owner asked for exactly that", async () => {
    const { job } = await seedJob(
      teacher.id,
      { status: "failed", failureCode: "lesson_discarded", discardedAt: new Date() },
      { status: "canceled" },
    );
    const before = fakeQueue.sent.length;
    const res = await request(app())
      .post(`/admin/note-jobs/${job.id}/requeue`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("lesson_discarded");
    expect(res.body.message).toBeTruthy();
    expect(fakeQueue.sent.length).toBe(before); // nothing enqueued
    const [row] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job.id));
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(0); // not charged for a run that was refused

    const stampless = await seedJob(teacher.id, { status: "failed", failureCode: "asr_error" }, { status: "canceled" });
    const second = await request(app())
      .post(`/admin/note-jobs/${stampless.job.id}/requeue`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("lesson_discarded");
  });

  it("requeue clears the stale code, re-anchors startedAt, and stays uncapped", async () => {
    const { job } = await seedJob(teacher.id, {
      status: "failed",
      failureCode: "no_speech",
      attempts: 9,
      startedAt: new Date(Date.now() - 47 * 60 * 1000),
    });
    const res = await request(app())
      .post(`/admin/note-jobs/${job.id}/requeue`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.job.failureCode).toBeNull();
    expect(res.body.job.attempts).toBe(10);
    const [row] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job.id));
    expect(Date.now() - row!.startedAt!.getTime()).toBeLessThan(60 * 1000);
  });
});

describe("transcript break-glass", () => {
  let teacher: typeof users.$inferSelect;
  let jobWithTranscript: string;
  let jobNoTranscript: string;

  beforeAll(async () => {
    teacher = await mkUser({ displayName: "Transcript Teacher", isTeacher: true });
    const a = await seedJob(teacher.id, { status: "ready_for_review", transcriptPath: `${teacher.id}/lesson-x/transcript.json` });
    jobWithTranscript = a.job.id;
    const b = await seedJob(teacher.id, { status: "processing" });
    jobNoTranscript = b.job.id;
  });

  it("requires a reason of at least 10 chars", async () => {
    const res = await request(app())
      .get(`/admin/note-jobs/${jobWithTranscript}/transcript?reason=short`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("reason_required");
  });

  it("an admin WITHOUT the capability flag gets 403 and NO transcript.view audit", async () => {
    const before = (await auditFor("transcript.view")).length;
    const reason = "A perfectly valid reason that is long enough.";
    const res = await request(app())
      .get(`/admin/note-jobs/${jobWithTranscript}/transcript?reason=${encodeURIComponent(reason)}`)
      .set("Authorization", `Bearer ${admin2Token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("transcript_forbidden");
    expect((await auditFor("transcript.view")).length).toBe(before);
    expect(fakeAssets.reads).not.toContain("never-read");
  });

  it("only a flag holder can change canViewTranscripts, and never on their own row", async () => {
    const [admin2] = await db.orm.select().from(users).where(eq(users.entraOid, "an-admin2-oid"));
    const [admin1] = await db.orm.select().from(users).where(eq(users.entraOid, "an-admin-oid"));
    const selfGrant = await request(app())
      .patch(`/admin/users/${admin2!.id}/roles`)
      .set("Authorization", `Bearer ${admin2Token}`)
      .send({ canViewTranscripts: true });
    expect(selfGrant.status).toBe(403);
    expect(selfGrant.body.error).toBe("transcript_grant_forbidden");
    const own = await request(app())
      .patch(`/admin/users/${admin1!.id}/roles`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ canViewTranscripts: false });
    expect(own.status).toBe(409);
    expect(own.body.error).toBe("cannot_change_own_transcript_access");
    const grant = await request(app())
      .patch(`/admin/users/${admin2!.id}/roles`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ canViewTranscripts: true });
    expect(grant.status).toBe(200);
    expect(grant.body.canViewTranscripts).toBe(true);
    const audits = await auditFor("user.set_transcript_access");
    expect(audits.length).toBeGreaterThan(0);
    const revoke = await request(app())
      .patch(`/admin/users/${admin2!.id}/roles`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ canViewTranscripts: false });
    expect(revoke.status).toBe(200);
    expect(revoke.body.canViewTranscripts).toBe(false);
  });

  it("returns the transcript body and writes a transcript.view audit with the reason", async () => {
    const reason = "Investigating a parent complaint about the tone of a note.";
    const res = await request(app())
      .get(`/admin/note-jobs/${jobWithTranscript}/transcript?reason=${encodeURIComponent(reason)}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.transcript).toEqual(fakeAssets.body);
    expect(fakeAssets.reads).toContain(`${teacher.id}/lesson-x/transcript.json`);
    const audits = await auditFor("transcript.view");
    const evt = audits.find((a) => a.subjectId === jobWithTranscript);
    expect((evt!.detail as { reason: string }).reason).toBe(reason);
  });

  it("409s when the job has no transcript yet", async () => {
    const res = await request(app())
      .get(`/admin/note-jobs/${jobNoTranscript}/transcript?reason=Looking into a stuck job for support.`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("transcript_not_ready");
  });

  it("410s once the owner discarded it — 'purged on request' is not 'never existed'", async () => {
    const { job } = await seedJob(teacher.id, {
      status: "failed",
      failureCode: "thin_note",
      transcriptPath: null,
      discardedAt: new Date(),
    });
    const before = (await auditFor("transcript.view")).length;
    const res = await request(app())
      .get(`/admin/note-jobs/${job.id}/transcript?reason=Checking a support ticket about a deleted lesson.`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("transcript_discarded");
    expect(fakeAssets.reads).not.toContain(null);
    expect((await auditFor("transcript.view")).length).toBe(before);
  });
});

describe("model output break-glass", () => {
  let teacher: typeof users.$inferSelect;
  let jobWithOutput: string;
  let jobWithout: string;
  const path = "transcripts/model-output/rejected.json";
  const reason = "Founder reported processing failed on a device test this morning.";

  beforeAll(async () => {
    teacher = await mkUser({ displayName: "Model Output Teacher", isTeacher: true });
    const a = await seedJob(teacher.id, {
      status: "failed",
      failureCode: "thin_note",
      modelOutputPath: path,
      metrics: { annotations_in: 3, kept: 1, dropped: 2, drop_reasons: { unverifiable_quote: 2 } },
    });
    jobWithOutput = a.job.id;
    const b = await seedJob(teacher.id, { status: "ready_for_review" });
    jobWithout = b.job.id;
  });

  it("requires a reason and the transcript capability, and audits neither without them", async () => {
    const before = (await auditFor("model_output.view")).length;
    const short = await request(app())
      .get(`/admin/note-jobs/${jobWithOutput}/model-output?reason=short`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(short.status).toBe(400);
    expect(short.body.error).toBe("reason_required");

    const noFlag = await request(app())
      .get(`/admin/note-jobs/${jobWithOutput}/model-output?reason=${encodeURIComponent(reason)}`)
      .set("Authorization", `Bearer ${admin2Token}`);
    expect(noFlag.status).toBe(403);
    expect(noFlag.body.error).toBe("transcript_forbidden");
    expect((await auditFor("model_output.view")).length).toBe(before);
  });

  it("returns what the model produced and audits the read with its reason", async () => {
    fakeAssets.body = {
      outcome: "thin_note",
      attempts: [{ n: 1, model: "claude-sonnet-5", error: null, text: '{"annotations": []}' }],
      evidence: { drops: [{ index: 0, reason: "unverifiable_quote", instruction: "Keep the wrist loose", quote: "made up" }] },
    };
    const res = await request(app())
      .get(`/admin/note-jobs/${jobWithOutput}/model-output?reason=${encodeURIComponent(reason)}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.modelOutput).toEqual(fakeAssets.body);
    expect(fakeAssets.reads).toContain(path);
    const evt = (await auditFor("model_output.view")).find((a) => a.subjectId === jobWithOutput);
    expect((evt!.detail as { reason: string }).reason).toBe(reason);
  });

  it("409s when nothing was rejected, and 410s once the owner discarded the lesson", async () => {
    const none = await request(app())
      .get(`/admin/note-jobs/${jobWithout}/model-output?reason=${encodeURIComponent(reason)}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(none.status).toBe(409);
    expect(none.body.error).toBe("model_output_not_recorded");

    const { job } = await seedJob(teacher.id, {
      status: "failed",
      failureCode: "thin_note",
      modelOutputPath: null,
      transcriptPath: null,
      discardedAt: new Date(),
    });
    const before = (await auditFor("model_output.view")).length;
    const gone = await request(app())
      .get(`/admin/note-jobs/${job.id}/model-output?reason=${encodeURIComponent(reason)}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe("model_output_discarded");
    expect((await auditFor("model_output.view")).length).toBe(before);
  });

  it("surfaces the path on the jobs list so the panel knows there is evidence to open", async () => {
    const res = await request(app())
      .get("/admin/note-jobs")
      .set("Authorization", `Bearer ${adminToken}`);
    const row = res.body.items.find((r: { id: string }) => r.id === jobWithOutput);
    expect(row.modelOutputPath).toBe(path);
    expect(row.metrics.drop_reasons).toEqual({ unverifiable_quote: 2 });
  });
});

describe("user notes-activity", () => {
  it("aggregates links, invites, lessons, note counts, and effective entitlement", async () => {
    const teacher = await mkUser({ displayName: "Activity Teacher", email: "actteach@k.com", isTeacher: true });
    const s1 = await mkUser({ isStudent: true });
    const s2 = await mkUser({ isStudent: true });
    await db.orm.insert(teacherStudentLinks).values([
      { teacherId: teacher.id, studentId: s1.id, status: "active", consentAt: new Date() },
      { teacherId: teacher.id, studentId: s2.id, status: "removed", removedAt: new Date() },
    ]);
    await db.orm.insert(invites).values({ code: "ANACTV", teacherId: teacher.id, expiresAt: daysFromNow(7) });
    await seedSentNote(teacher.id, s1.id, "Sonatina");
    await seedSentNote(teacher.id, s2.id, "Arabesque");

    const res = await request(app())
      .get(`/admin/users/${teacher.id}/notes-activity`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("actteach@k.com");
    expect(res.body.links.asTeacher.length).toBe(2);
    expect(res.body.links.asStudent.length).toBe(0);
    expect(res.body.invitesIssued.length).toBe(1);
    expect(res.body.invitesIssued[0].state).toBe("active");
    expect(res.body.lessons.count).toBe(2);
    expect(res.body.lessons.recentPieceLabels).toEqual(expect.arrayContaining(["Sonatina", "Arabesque"]));
    expect(res.body.notes.sent).toBe(2);
    expect(res.body.notes.received).toBe(0);
    expect(res.body.access.status).toBe("teacher_free");
  });

  it("404s an unknown user", async () => {
    const res = await request(app())
      .get("/admin/users/00000000-0000-0000-0000-000000000000/notes-activity")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe("admin actions honour the label's lifetime", () => {
  it("revoking a code retires its label and never returns it to the console", async () => {
    const t = await mkUser({ displayName: "Label Teacher", isTeacher: true });
    const [row] = await db.orm
      .insert(invites)
      .values({ code: "ADLBL1", teacherId: t.id, intendedLabel: "Emma", expiresAt: daysAgo(-7) })
      .returning();

    const res = await request(app())
      .post(`/admin/notes/invites/${row!.id}/revoke`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.invite.intendedLabel).toBeNull();

    const [after] = await db.orm.select().from(invites).where(eq(invites.id, row!.id));
    expect(after!.intendedLabel).toBeNull();
    expect(after!.revokedAt).not.toBeNull();
  });

  it("re-linking a removed pair dates the relationship from today, not from its first spell", async () => {
    const t = await mkUser({ displayName: "Relink Teacher", isTeacher: true });
    const s = await mkUser({ displayName: "Relink Student", isStudent: true });
    await db.orm.insert(teacherStudentLinks).values({
      teacherId: t.id,
      studentId: s.id,
      status: "removed",
      createdAt: daysAgo(400),
      removedAt: daysAgo(30),
    });

    const res = await request(app())
      .post("/admin/notes/links")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId: t.id, studentId: s.id });
    expect(res.status).toBe(200);
    expect(res.body.link.rejoinedAt).not.toBeNull();

    const [row] = await db.orm
      .select()
      .from(teacherStudentLinks)
      .where(and(eq(teacherStudentLinks.teacherId, t.id), eq(teacherStudentLinks.studentId, s.id)));
    expect(row!.rejoinedAt).not.toBeNull();
    expect(row!.createdAt.getTime()).toBeLessThan(daysAgo(300).getTime());
  });

  it("re-attesting an ALREADY active pair does not restate when it began", async () => {
    const t = await mkUser({ displayName: "Reattest Teacher", isTeacher: true });
    const s = await mkUser({ displayName: "Reattest Student", isStudent: true });
    await db.orm.insert(teacherStudentLinks).values({
      teacherId: t.id, studentId: s.id, status: "active", createdAt: daysAgo(100),
    });

    const res = await request(app())
      .post("/admin/notes/links")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId: t.id, studentId: s.id });
    expect(res.status).toBe(200);
    expect(res.body.link.rejoinedAt).toBeNull();
  });
});

describe("admin takedown of a score scan", () => {
  const deleted: string[] = [];
  const fakeScans = {
    incomingPath: () => "", incomingPrefix: (o: string, s: string) => `score-scans/${o}/${s}/incoming/`,
    blobPath: () => "", blobPrefix: (o: string, s: string) => `score-scans/${o}/${s}/`,
    uploadUrl: () => "", pageProps: async () => null, readHead: async () => null,
    promote: async () => {}, readUrl: () => "",
    deletePrefix: async (prefix: string) => { deleted.push(prefix); },
  };
  const takedownApp = () => app({ scans: fakeScans as never });

  async function seedScan(ownerId: string, over: Partial<typeof scoreScans.$inferInsert> = {}) {
    const [row] = await db.orm.insert(scoreScans).values({
      ownerId, title: "Op. 599 No. 31", pageCount: 3,
      blobPath: `score-scans/${ownerId}/x/`, status: "ready", ...over,
    }).returning();
    return row;
  }

  beforeEach(() => { deleted.length = 0; });

  it("refuses without a reason long enough to be an accountability record", async () => {
    const owner = await mkUser();
    const scan = await seedScan(owner.id);
    const res = await request(takedownApp()).post(`/admin/score-scans/${scan.id}/takedown`)
      .set("Authorization", `Bearer ${adminToken}`).send({ reason: "no" });
    expect(res.status).toBe(400);
    const [after] = await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scan.id));
    expect(after.status).toBe("ready");
  });

  it("refuses an account that is not an admin", async () => {
    const owner = await mkUser();
    const scan = await seedScan(owner.id);
    const res = await request(takedownApp()).post(`/admin/score-scans/${scan.id}/takedown`)
      .set("Authorization", `Bearer ${plainToken}`).send({ reason: "rights complaint from the publisher" });
    expect(res.status).toBe(403);
  });

  it("keeps the owner's row so their shelf can say what happened", async () => {
    const owner = await mkUser();
    const scan = await seedScan(owner.id);
    const res = await request(takedownApp()).post(`/admin/score-scans/${scan.id}/takedown`)
      .set("Authorization", `Bearer ${adminToken}`).send({ reason: "rights complaint from the publisher" });
    expect(res.status).toBe(200);
    const [after] = await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scan.id));
    expect(after.status).toBe("taken_down");
    expect(after.takenDownAt).not.toBeNull();
    expect(after.blobPath).toBeNull();
  });

  it("destroys the bytes under both prefixes", async () => {
    const owner = await mkUser();
    const scan = await seedScan(owner.id);
    await request(takedownApp()).post(`/admin/score-scans/${scan.id}/takedown`)
      .set("Authorization", `Bearer ${adminToken}`).send({ reason: "rights complaint from the publisher" });
    expect(deleted).toEqual([
      `score-scans/${owner.id}/${scan.id}/`,
      `score-scans/${owner.id}/${scan.id}/incoming/`,
    ]);
  });

  it("leaves the audit row behind even when destroying the bytes throws", async () => {
    const owner = await mkUser();
    const scan = await seedScan(owner.id);
    const throwing = () => app({ scans: { ...fakeScans, deletePrefix: async () => { throw new Error("blob down"); } } as never });
    await request(throwing()).post(`/admin/score-scans/${scan.id}/takedown`)
      .set("Authorization", `Bearer ${adminToken}`).send({ reason: "rights complaint from the publisher" });
    const rows = await db.orm.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "score_scan.takedown"), eq(auditEvents.subjectId, scan.id)));
    expect(rows).toHaveLength(1);
    expect((rows[0].detail as Record<string, unknown>).reason).toBe("rights complaint from the publisher");
  });

  it("refuses to take the same scan down twice", async () => {
    const owner = await mkUser();
    const scan = await seedScan(owner.id, { status: "taken_down" });
    const res = await request(takedownApp()).post(`/admin/score-scans/${scan.id}/takedown`)
      .set("Authorization", `Bearer ${adminToken}`).send({ reason: "rights complaint from the publisher" });
    expect(res.status).toBe(409);
  });

  it("answers 404 for a scan that does not exist", async () => {
    const res = await request(takedownApp()).post(`/admin/score-scans/${crypto.randomUUID()}/takedown`)
      .set("Authorization", `Bearer ${adminToken}`).send({ reason: "rights complaint from the publisher" });
    expect(res.status).toBe(404);
  });
});

describe("score scans on the user activity surface", () => {
  it("shows that a scan exists, its shape, and who points at it — and never a way to read it", async () => {
    const owner = await mkUser();
    const [scan] = await db.orm.insert(scoreScans).values({
      ownerId: owner.id, title: "Op. 599 No. 31", pageCount: 3, bytes: 240_000,
      blobPath: `score-scans/${owner.id}/x/`, status: "ready",
    }).returning();
    const res = await request(app()).get(`/admin/users/${owner.id}/notes-activity`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const [row] = res.body.scoreScans;
    expect(row).toMatchObject({
      id: scan.id, title: "Op. 599 No. 31", status: "ready",
      pageCount: 3, bytes: 240_000, hasBytes: true, referencedBy: 0,
    });
    expect(JSON.stringify(row)).not.toContain("blobPath");
    expect(JSON.stringify(row)).not.toContain("http");
  });

  it("counts the notes that point at a scan", async () => {
    const teacher = await mkUser({ isTeacher: true });
    const student = await mkUser({ isStudent: true });
    const [scan] = await db.orm.insert(scoreScans).values({
      ownerId: teacher.id, title: "Shared", pageCount: 1,
      blobPath: `score-scans/${teacher.id}/y/`, status: "ready",
    }).returning();
    for (let i = 0; i < 2; i += 1) {
      await db.orm.insert(notes).values({
        teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
        scoreScanId: scan.id, content: {}, contentOriginal: {},
      } as never);
    }
    const res = await request(app()).get(`/admin/users/${teacher.id}/notes-activity`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.scoreScans[0].referencedBy).toBe(2);
  });

  it("shows a taken-down scan as taken down with no bytes behind it", async () => {
    const owner = await mkUser();
    await db.orm.insert(scoreScans).values({
      ownerId: owner.id, title: "Gone", pageCount: 2,
      blobPath: null, status: "taken_down", takenDownAt: new Date(),
    }).returning();
    const res = await request(app()).get(`/admin/users/${owner.id}/notes-activity`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.scoreScans[0]).toMatchObject({ status: "taken_down", hasBytes: false });
    expect(res.body.scoreScans[0].takenDownAt).not.toBeNull();
  });
});

describe("the scans nothing else would ever surface", () => {
  async function seed(over: Partial<typeof scoreScans.$inferInsert>, agedHours: number) {
    const owner = await mkUser();
    const [row] = await db.orm.insert(scoreScans).values({
      ownerId: owner.id, title: "Op. 599", pageCount: 3, status: "created", ...over,
    }).returning();
    await db.orm.update(scoreScans)
      .set({ updatedAt: new Date(Date.now() - agedHours * 3600_000) })
      .where(eq(scoreScans.id, row.id));
    return row;
  }
  const ids = async (hours?: number) => {
    const res = await request(app())
      .get(`/admin/score-scans/stalled${hours ? `?hours=${hours}` : ""}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    return (res.body.scans as { id: string }[]).map((s) => s.id);
  };

  it("finds a scan that stopped before its commit and stayed there", async () => {
    const stuck = await seed({}, 9);
    expect(await ids()).toContain(stuck.id);
  });

  it("leaves an upload that is merely in progress alone", async () => {
    const fresh = await seed({}, 1);
    expect(await ids()).not.toContain(fresh.id);
  });

  it("says nothing about the scans that finished", async () => {
    const done = await seed({ status: "ready", blobPath: "score-scans/x/" }, 48);
    expect(await ids()).not.toContain(done.id);
  });

  it("says nothing about a scan an operator took down", async () => {
    const gone = await seed({ status: "taken_down", blobPath: null }, 48);
    expect(await ids()).not.toContain(gone.id);
  });

  it("takes the window from the caller and refuses a nonsense one", async () => {
    const old = await seed({}, 30);
    expect(await ids(24)).toContain(old.id);
    expect(await ids(48)).not.toContain(old.id);
    const res = await request(app()).get("/admin/score-scans/stalled?hours=-5")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.hours).toBe(6);
  });

  it("names the owner, because a stalled scan is a person to go and ask", async () => {
    const stuck = await seed({}, 9);
    const res = await request(app()).get("/admin/score-scans/stalled")
      .set("Authorization", `Bearer ${adminToken}`);
    const row = (res.body.scans as { id: string; ownerEmail: string | null }[])
      .find((s) => s.id === stuck.id)!;
    expect(row.ownerEmail).toBeTruthy();
  });

  it("refuses an account that is not an admin", async () => {
    const res = await request(app()).get("/admin/score-scans/stalled")
      .set("Authorization", `Bearer ${plainToken}`);
    expect(res.status).toBe(403);
  });
});
