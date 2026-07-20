import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
  pieces,
  teacherStudentLinks,
  invites,
  lessonSessions,
  noteJobs,
  notes,
  noteAnnotations,
  entitlements,
  platformConfig,
  devices,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { LessonStore } from "../src/notes/lessons_store";
import type { NotesQueue } from "../src/queue";

// Mirrors composers.test.ts: PGlite through testdb, jose local JWKS, supertest.
const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;

// The Notes pipeline is faked: audio props and the queue are mutated per-test.
interface FakeLessons extends LessonStore {
  audio: { bytes: number } | null;
  deleted: string[];
}
function makeFakeLessons(): FakeLessons {
  const f: FakeLessons = {
    audio: { bytes: 1000 },
    deleted: [],
    blobPath: (t, l) => `${t}/${l}.m4a`,
    uploadUrl: (p) => `https://fake/${p}?sas`,
    async audioProps() {
      return f.audio;
    },
    async deleteAudio(p) {
      f.deleted.push(p);
    },
  };
  return f;
}

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
  };
  return q;
}

let fakeLessons: FakeLessons;
let fakeQueue: FakeQueue;

function makeApp() {
  return createServer({ db, auth: verifier, lessons: fakeLessons, notesQueue: fakeQueue });
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}
function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

async function mkToken(oid: string, name?: string, email?: string): Promise<string> {
  const claims: Record<string, unknown> = { oid };
  if (email) claims.email = email;
  if (name) claims.name = name;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

async function sync(token: string, body: Record<string, unknown> = {}) {
  return request(makeApp()).post("/v1/users/sync").set("Authorization", `Bearer ${token}`).send(body);
}

interface TestUser {
  token: string;
  id: string;
  oid: string;
}
async function makeUser(opts: {
  oid: string;
  name?: string;
  email?: string;
  role?: "teacher" | "student";
  notesConsent?: boolean;
}): Promise<TestUser> {
  const token = await mkToken(opts.oid, opts.name, opts.email);
  const body: Record<string, unknown> = {};
  if (opts.role) body.role = opts.role;
  if (opts.notesConsent) body.notesConsent = true;
  const res = await sync(token, body);
  if (res.status !== 200) throw new Error(`sync failed for ${opts.oid}: ${res.status} ${JSON.stringify(res.body)}`);
  return { token, id: res.body.id as string, oid: opts.oid };
}

async function linkActive(teacherId: string, studentId: string) {
  const [row] = await db.orm
    .insert(teacherStudentLinks)
    .values({ teacherId, studentId, status: "active", consentAt: new Date() })
    .returning();
  return row!;
}

async function setMonetization(iso: string | null) {
  await db.orm.delete(platformConfig).where(eq(platformConfig.key, "monetization_live_at"));
  if (iso) await db.orm.insert(platformConfig).values({ key: "monetization_live_at", value: iso });
}

// Simulates the (not-yet-built) worker's output: a note_job + a note with jsonb
// content and a handful of grounded/ungrounded annotations.
const DEFAULT_ANNOTATIONS = [
  {
    instruction: "Even out the right-hand sixteenths",
    quote: "these two bars are rushing",
    category: "rhythm",
    location: { type: "absolute", measureStart: 3, measureEnd: 4, grounded: true },
  },
  {
    instruction: "Softer entrance",
    quote: "those two bars",
    category: "dynamics",
    location: { type: "deixis", raw: "those two bars", grounded: false },
  },
];

async function seedNote(opts: {
  teacherId: string;
  studentId?: string | null;
  status?: "draft" | "sent" | "retracted";
  pieceId?: string | null;
  pieceLabel?: string | null;
  pieceVersion?: number | null;
  sentAt?: Date | null;
  readAt?: Date | null;
  retractedAt?: Date | null;
  content?: unknown;
  annotations?: {
    instruction: string;
    quote: string | null;
    category?: string;
    location?: unknown;
    doneAt?: Date | null;
  }[];
}) {
  const [lesson] = await db.orm
    .insert(lessonSessions)
    .values({
      teacherId: opts.teacherId,
      studentId: opts.studentId ?? null,
      pieceId: opts.pieceId ?? null,
      pieceLabel: opts.pieceLabel ?? null,
    })
    .returning();
  const [job] = await db.orm
    .insert(noteJobs)
    .values({ lessonSessionId: lesson!.id, status: "ready_for_review", createdBy: opts.teacherId })
    .returning();
  const content = opts.content ?? {
    lessonSummary: "Nice sense of line today.",
    practicePlan: ["Hands separate at 60bpm", "Watch the rests in the B section"],
  };
  const [note] = await db.orm
    .insert(notes)
    .values({
      noteJobId: job!.id,
      lessonSessionId: lesson!.id,
      teacherId: opts.teacherId,
      studentId: opts.studentId ?? null,
      pieceId: opts.pieceId ?? null,
      pieceLabel: opts.pieceLabel ?? null,
      pieceVersion: opts.pieceVersion ?? null,
      status: opts.status ?? "draft",
      contentOriginal: content,
      content,
      sentAt: opts.sentAt ?? null,
      readAt: opts.readAt ?? null,
      retractedAt: opts.retractedAt ?? null,
    })
    .returning();
  const anns = opts.annotations ?? DEFAULT_ANNOTATIONS;
  const annRows = anns.length
    ? await db.orm
        .insert(noteAnnotations)
        .values(
          anns.map((a, i) => ({
            noteId: note!.id,
            idx: i,
            category: a.category ?? "other",
            instruction: a.instruction,
            quote: a.quote,
            location: (a.location ?? {}) as Record<string, unknown>,
            doneAt: a.doneAt ?? null,
          })),
        )
        .returning()
    : [];
  return { note: note!, job: job!, lesson: lesson!, annotations: annRows };
}

// Shared fixtures.
let teacher: TestUser; // "Teacher Tessa" — global sender
let student: TestUser; // "Student Sam" — linked to teacher
let stranger: TestUser; // synced, unlinked, no role

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  verifier = createJoseVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
  db = await createTestDb();
  fakeLessons = makeFakeLessons();
  fakeQueue = makeFakeQueue();

  await db.orm.insert(pieces).values({
    id: "seed_piece",
    title: "Practical Method, Op. 599",
    subtitle: "No. 3",
    composer: "Carl Czerny",
    rights: "public_domain",
    rightsNote: "PD",
    status: "published",
    publishedVersion: 3,
  });

  teacher = await makeUser({ oid: "teacher-oid", name: "Teacher Tessa", email: "tessa@k.com", role: "teacher" });
  student = await makeUser({ oid: "student-oid", name: "Student Sam", email: "sam@k.com", role: "student" });
  stranger = await makeUser({ oid: "stranger-oid", name: "Stranger Sky" });
  await linkActive(teacher.id, student.id);
});

beforeEach(() => {
  // Each test starts from a completed, healthy upload + working queue.
  fakeLessons.audio = { bytes: 1000 };
  fakeQueue.throwNext = false;
});

// ── 1. users/sync ────────────────────────────────────────────────────────────────

describe("users/sync", () => {
  it("grants teacher role and returns teacher_free access", async () => {
    const u = await makeUser({ oid: "sync-teacher", name: "T", role: "teacher" });
    const res = await sync(u.token, { role: "teacher" });
    expect(res.status).toBe(200);
    expect(res.body.isTeacher).toBe(true);
    expect(res.body.access.status).toBe("teacher_free");
    expect(res.body.unreadNotes).toBe(0);
  });

  it("sets trialStartedAt on first student grant and notesConsentAt once (grow-only)", async () => {
    const token = await mkToken("sync-student", "S");
    const first = await sync(token, { role: "student", notesConsent: true });
    expect(first.status).toBe(200);
    expect(first.body.isStudent).toBe(true);
    expect(first.body.trialStartedAt).not.toBeNull();
    expect(first.body.notesConsentAt).not.toBeNull();
    expect(first.body.access.status).toBe("beta_free");
    expect(first.body.unreadNotes).toBe(0);

    const trialStart = first.body.trialStartedAt;
    const consentAt = first.body.notesConsentAt;

    const second = await sync(token, { role: "student", notesConsent: true });
    // Neither clock restarts.
    expect(second.body.trialStartedAt).toBe(trialStart);
    expect(second.body.notesConsentAt).toBe(consentAt);
  });

  it("role capabilities are additive: teacher then student yields both", async () => {
    const token = await mkToken("sync-both", "B");
    await sync(token, { role: "student" });
    const res = await sync(token, { role: "teacher" });
    expect(res.body.isStudent).toBe(true);
    expect(res.body.isTeacher).toBe(true);
  });
});

// ── 2. Entitlement resolver via response shapes ───────────────────────────────────

describe("entitlement resolver", () => {
  afterAll(async () => {
    await setMonetization(null);
  });

  it("teacher bypasses entitlements → teacher_free", async () => {
    const u = await makeUser({ oid: "ent-teacher", role: "teacher" });
    const res = await sync(u.token, {});
    expect(res.body.access.status).toBe("teacher_free");
  });

  it("no monetization config → beta_free for a student", async () => {
    await setMonetization(null);
    const u = await makeUser({ oid: "ent-beta", role: "student" });
    expect(u.token).toBeTruthy();
    const res = await sync(u.token, {});
    expect(res.body.access.status).toBe("beta_free");
  });

  it("monetization live in the past + old trial + no entitlement → lapsed", async () => {
    await setMonetization(daysAgo(90).toISOString());
    const u = await makeUser({ oid: "ent-lapsed", role: "student" });
    await db.orm.update(users).set({ trialStartedAt: daysAgo(90) }).where(eq(users.id, u.id));
    const res = await sync(u.token, {});
    expect(res.body.access.status).toBe("lapsed");
    expect(typeof res.body.access.lockedAfter).toBe("string");
  });

  it("recent trial under a live paywall → trial with trialEndsAt", async () => {
    await setMonetization(daysAgo(90).toISOString());
    const u = await makeUser({ oid: "ent-trial", role: "student" });
    const res = await sync(u.token, {});
    expect(res.body.access.status).toBe("trial");
    expect(typeof res.body.access.trialEndsAt).toBe("string");
  });

  it("an active entitlements row → active", async () => {
    await setMonetization(daysAgo(90).toISOString());
    const u = await makeUser({ oid: "ent-active", role: "student" });
    await db.orm.update(users).set({ trialStartedAt: daysAgo(90) }).where(eq(users.id, u.id));
    await db.orm.insert(entitlements).values({ userId: u.id, source: "apple_iap", status: "active" });
    const res = await sync(u.token, {});
    expect(res.body.access.status).toBe("active");
  });
});

// ── 3. Invites & redemption ───────────────────────────────────────────────────────

describe("invites", () => {
  let invT: TestUser;
  let invS: TestUser;
  let inviteA: { id: string; code: string };
  let linkId: string;

  beforeAll(async () => {
    invT = await makeUser({ oid: "inv-teacher", name: "Invite Teacher", role: "teacher" });
    invS = await makeUser({ oid: "inv-student", name: "Invite Student" });
  });

  it("create is teacher-only", async () => {
    const forbidden = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", `Bearer ${invS.token}`)
      .send({});
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe("teacher_only");

    const ok = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", `Bearer ${invT.token}`)
      .send({});
    expect(ok.status).toBe(201);
    expect(typeof ok.body.code).toBe("string");
    inviteA = { id: ok.body.id, code: ok.body.code };
  });

  it("GET lists only live invites; DELETE revokes; unknown DELETE 404s", async () => {
    const b = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", `Bearer ${invT.token}`)
      .send({});
    const bId = b.body.id as string;

    let list = await request(makeApp()).get("/v1/invites").set("Authorization", `Bearer ${invT.token}`);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([inviteA.id, bId]));

    const del = await request(makeApp()).delete(`/v1/invites/${bId}`).set("Authorization", `Bearer ${invT.token}`);
    expect(del.status).toBe(200);

    list = await request(makeApp()).get("/v1/invites").set("Authorization", `Bearer ${invT.token}`);
    const ids = list.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(inviteA.id);
    expect(ids).not.toContain(bId);

    const missing = await request(makeApp())
      .delete("/v1/invites/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${invT.token}`);
    expect(missing.status).toBe(404);
  });

  it("redeem without consent → 400 consent_required", async () => {
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", `Bearer ${invS.token}`)
      .send({ code: inviteA.code });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("consent_required");
  });

  it("invalid / expired / revoked / used-up codes all → 404", async () => {
    await db.orm.insert(invites).values([
      { code: "EXPIRED", teacherId: invT.id, expiresAt: daysAgo(1) },
      { code: "REVOKED", teacherId: invT.id, expiresAt: daysFromNow(7), revokedAt: new Date() },
      { code: "USEDUP", teacherId: invT.id, expiresAt: daysFromNow(7), maxUses: 1, usedCount: 1 },
    ]);
    for (const code of ["ZZZZZZ", "EXPIRED", "REVOKED", "USEDUP"]) {
      const res = await request(makeApp())
        .post("/v1/invites/redeem")
        .set("Authorization", `Bearer ${invS.token}`)
        .send({ code, consent: true });
      expect(res.status, code).toBe(404);
      expect(res.body.error).toBe("invalid_code");
    }
  });

  it("redeeming your own code → 400 own_code", async () => {
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", `Bearer ${invT.token}`)
      .send({ code: inviteA.code, consent: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("own_code");
  });

  it("successful redeem links, records consent, increments use, grows student role", async () => {
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", `Bearer ${invS.token}`)
      .send({ code: inviteA.code, consent: true });
    expect(res.status).toBe(201);
    expect(res.body.link.status).toBe("active");
    expect(res.body.link.consentAt).not.toBeNull();
    expect(res.body.teacher.displayName).toBe("Invite Teacher");
    linkId = res.body.link.id;

    const [inv] = await db.orm.select().from(invites).where(eq(invites.id, inviteA.id));
    expect(inv!.usedCount).toBe(1);

    const [row] = await db.orm.select().from(users).where(eq(users.id, invS.id));
    expect(row!.isStudent).toBe(true);
    expect(row!.trialStartedAt).not.toBeNull();
  });

  it("redeeming a second live code for an existing pair → 409 already_linked", async () => {
    const c = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", `Bearer ${invT.token}`)
      .send({});
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", `Bearer ${invS.token}`)
      .send({ code: c.body.code, consent: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_linked");
  });

  it("redeem after the link was removed reactivates the same row", async () => {
    const removed = await request(makeApp())
      .delete(`/v1/me/teachers/${invT.id}`)
      .set("Authorization", `Bearer ${invS.token}`);
    expect(removed.status).toBe(200);

    const d = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", `Bearer ${invT.token}`)
      .send({});
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", `Bearer ${invS.token}`)
      .send({ code: d.body.code, consent: true });
    expect(res.status).toBe(201);
    expect(res.body.link.id).toBe(linkId); // same row, reactivated
    expect(res.body.link.status).toBe("active");
    expect(res.body.link.removedAt).toBeNull();
  });
});

// ── 4. Roster ─────────────────────────────────────────────────────────────────────

describe("roster", () => {
  let rostT: TestUser;
  let rostS: TestUser;
  let rostS2: TestUser;

  beforeAll(async () => {
    rostT = await makeUser({ oid: "rost-teacher", name: "Roster Teacher", role: "teacher" });
    rostS = await makeUser({ oid: "rost-student", name: "Roster Student", role: "student" });
    rostS2 = await makeUser({ oid: "rost-student-2", name: "Roster Student Two", role: "student" });
    await linkActive(rostT.id, rostS.id);
    await linkActive(rostT.id, rostS2.id);
  });

  it("teacher sees linked students with canReceiveNotes true under beta_free", async () => {
    const res = await request(makeApp()).get("/v1/me/students").set("Authorization", `Bearer ${rostT.token}`);
    expect(res.status).toBe(200);
    const s = res.body.items.find((i: { studentId: string }) => i.studentId === rostS.id);
    expect(s.displayName).toBe("Roster Student");
    expect(s.canReceiveNotes).toBe(true);
  });

  it("student detail returns the notes timeline", async () => {
    await seedNote({ teacherId: rostT.id, studentId: rostS.id, status: "sent", sentAt: new Date(), pieceLabel: "Für Elise" });
    const res = await request(makeApp())
      .get(`/v1/me/students/${rostS.id}`)
      .set("Authorization", `Bearer ${rostT.token}`);
    expect(res.status).toBe(200);
    expect(res.body.studentId).toBe(rostS.id);
    expect(Array.isArray(res.body.notes)).toBe(true);
    expect(res.body.notes.length).toBeGreaterThanOrEqual(1);
  });

  it("teacher DELETE unlinks; a repeat DELETE 404s", async () => {
    const first = await request(makeApp())
      .delete(`/v1/me/students/${rostS.id}`)
      .set("Authorization", `Bearer ${rostT.token}`);
    expect(first.status).toBe(200);
    const again = await request(makeApp())
      .delete(`/v1/me/students/${rostS.id}`)
      .set("Authorization", `Bearer ${rostT.token}`);
    expect(again.status).toBe(404);
  });

  it("student sees teachers and can unlink (404 on repeat)", async () => {
    const list = await request(makeApp()).get("/v1/me/teachers").set("Authorization", `Bearer ${rostS2.token}`);
    expect(list.status).toBe(200);
    expect(list.body.items.find((i: { teacherId: string }) => i.teacherId === rostT.id)).toBeTruthy();

    const del = await request(makeApp())
      .delete(`/v1/me/teachers/${rostT.id}`)
      .set("Authorization", `Bearer ${rostS2.token}`);
    expect(del.status).toBe(200);
    const again = await request(makeApp())
      .delete(`/v1/me/teachers/${rostT.id}`)
      .set("Authorization", `Bearer ${rostS2.token}`);
    expect(again.status).toBe(404);
  });
});

// ── 5. Lessons ─────────────────────────────────────────────────────────────────────

describe("lessons", () => {
  it("POST is teacher-only", async () => {
    const res = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${student.token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("teacher_only");
  });

  it("rejects an unknown pieceId and an unlinked studentId", async () => {
    const badPiece = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ pieceId: "no_such_piece" });
    expect(badPiece.status).toBe(400);
    expect(badPiece.body.error).toBe("unknown_piece");

    const badStudent = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ studentId: stranger.id });
    expect(badStudent.status).toBe(400);
    expect(badStudent.body.error).toBe("not_your_student");
  });

  it("creation returns an uploadUrl and the server-chosen audioPath", async () => {
    const res = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ pieceId: "seed_piece", studentId: student.id });
    expect(res.status).toBe(201);
    const path = `${teacher.id}/${res.body.lesson.id}.m4a`;
    expect(res.body.lesson.audioPath).toBe(path);
    expect(res.body.uploadUrl).toBe(`https://fake/${path}?sas`);
  });

  it("submit with no finished upload → 409 audio_missing", async () => {
    const lesson = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ studentId: student.id });
    fakeLessons.audio = null;
    const res = await request(makeApp())
      .post(`/v1/lessons/${lesson.body.lesson.id}/submit`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("audio_missing");
  });

  it("submit queues a note_job, sends {jobId, reqId}, and marks the lesson submitted", async () => {
    const lesson = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ pieceId: "seed_piece", studentId: student.id });
    const lessonId = lesson.body.lesson.id;

    const res = await request(makeApp())
      .post(`/v1/lessons/${lessonId}/submit`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.lesson.status).toBe("submitted");
    expect(res.body.job.status).toBe("queued");

    const msg = fakeQueue.sent.find((m) => m.jobId === res.body.job.id);
    expect(msg).toBeTruthy();
    expect(msg!.reqId).toBeTruthy();

    const dup = await request(makeApp())
      .post(`/v1/lessons/${lessonId}/submit`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("already_submitted");
  });

  it("a queue failure rolls the note_job back and leaves the lesson created", async () => {
    const lesson = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ studentId: student.id });
    const lessonId = lesson.body.lesson.id;

    fakeQueue.throwNext = true;
    const res = await request(makeApp())
      .post(`/v1/lessons/${lessonId}/submit`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("queue_unavailable");

    const jobs = await db.orm.select().from(noteJobs).where(eq(noteJobs.lessonSessionId, lessonId));
    expect(jobs.length).toBe(0);
    const [row] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, lessonId));
    expect(row!.status).toBe("created");
  });

  it("GET /v1/lessons returns lessons with their latest job and note ids", async () => {
    const res = await request(makeApp()).get("/v1/lessons").set("Authorization", `Bearer ${teacher.token}`);
    expect(res.status).toBe(200);
    const submitted = res.body.items.find(
      (i: { lesson: { status: string } }) => i.lesson.status === "submitted",
    );
    expect(submitted).toBeTruthy();
    expect(submitted.job).not.toBeNull();
    expect(Array.isArray(submitted.notes)).toBe(true);
  });

  it("retry only fires on a failed job", async () => {
    const lesson = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ studentId: student.id });
    const lessonId = lesson.body.lesson.id;
    const submit = await request(makeApp())
      .post(`/v1/lessons/${lessonId}/submit`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    const jobId = submit.body.job.id;

    // Still queued → not retryable.
    const early = await request(makeApp())
      .post(`/v1/lessons/${lessonId}/retry`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("not_retryable");

    await db.orm.update(noteJobs).set({ status: "failed" }).where(eq(noteJobs.id, jobId));
    const retry = await request(makeApp())
      .post(`/v1/lessons/${lessonId}/retry`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body.job.status).toBe("queued");
    expect(fakeQueue.sent.filter((m) => m.jobId === jobId).length).toBeGreaterThanOrEqual(2);
  });

  it("cancel is pre-submit only and deletes the uploaded audio", async () => {
    const lesson = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ studentId: student.id });
    const audioPath = lesson.body.lesson.audioPath;

    const cancel = await request(makeApp())
      .delete(`/v1/lessons/${lesson.body.lesson.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(cancel.status).toBe(200);
    expect(fakeLessons.deleted).toContain(audioPath);

    // A submitted lesson can no longer be canceled.
    const submitted = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ studentId: student.id });
    await request(makeApp())
      .post(`/v1/lessons/${submitted.body.lesson.id}/submit`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    const late = await request(makeApp())
      .delete(`/v1/lessons/${submitted.body.lesson.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("already_submitted");
  });
});

// ── 6. Notes: teacher flow ──────────────────────────────────────────────────────────

describe("notes: teacher flow", () => {
  it("list and detail are scoped to the owning teacher; strangers get 404", async () => {
    const { note } = await seedNote({ teacherId: teacher.id, pieceId: "seed_piece" });
    const list = await request(makeApp()).get("/v1/notes").set("Authorization", `Bearer ${teacher.token}`);
    expect(list.status).toBe(200);
    expect(list.body.items.find((n: { id: string }) => n.id === note.id)).toBeTruthy();

    const detail = await request(makeApp())
      .get(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.annotations.length).toBe(2);

    const forbidden = await request(makeApp())
      .get(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${stranger.token}`);
    expect(forbidden.status).toBe(404);
  });

  it("PATCH edits content and full-replaces annotations, preserving stored quotes by id", async () => {
    const { note, annotations } = await seedNote({ teacherId: teacher.id, pieceId: "seed_piece" });
    const keepId = annotations[0]!.id;
    const originalQuote = annotations[0]!.quote;

    const res = await request(makeApp())
      .patch(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({
        content: { lessonSummary: "Edited summary", practicePlan: ["a", "b", "c"] },
        annotations: [
          {
            id: keepId,
            instruction: "Revised instruction",
            quote: "CLIENT-SUPPLIED QUOTE (must be ignored)",
            category: "rhythm",
            location: { type: "absolute", measureStart: 9, grounded: true },
          },
          {
            instruction: "Brand new annotation",
            quote: "should be nulled",
            category: "other",
            location: { type: "none", grounded: false },
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.note.content.lessonSummary).toBe("Edited summary");
    expect(res.body.annotations.length).toBe(2);
    // Row that kept its id keeps the ORIGINAL stored quote, not the payload's.
    expect(res.body.annotations[0].quote).toBe(originalQuote);
    expect(res.body.annotations[0].instruction).toBe("Revised instruction");
    // New row has no provenance quote.
    expect(res.body.annotations[1].quote).toBeNull();
  });

  it("PATCH on a sent note → 409 not_editable", async () => {
    const { note } = await seedNote({
      teacherId: teacher.id,
      studentId: student.id,
      status: "sent",
      sentAt: new Date(),
      pieceId: "seed_piece",
    });
    const res = await request(makeApp())
      .patch(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ content: { lessonSummary: "nope" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_editable");
  });

  it("send requires a student, an active link, and a piece reference", async () => {
    const noStudent = await seedNote({ teacherId: teacher.id, pieceId: "seed_piece" });
    let res = await request(makeApp())
      .post(`/v1/notes/${noStudent.note.id}/send`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("student_required");

    const badStudent = await seedNote({ teacherId: teacher.id, pieceId: "seed_piece" });
    res = await request(makeApp())
      .post(`/v1/notes/${badStudent.note.id}/send`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ studentId: stranger.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_your_student");

    const noPiece = await seedNote({ teacherId: teacher.id, studentId: student.id, pieceId: null, pieceLabel: null });
    res = await request(makeApp())
      .post(`/v1/notes/${noPiece.note.id}/send`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("piece_required");
  });

  it("send stamps sentAt and pins pieceVersion to the piece's publishedVersion", async () => {
    const { note } = await seedNote({ teacherId: teacher.id, studentId: student.id, pieceId: "seed_piece" });
    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/send`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.sentAt).not.toBeNull();
    expect(res.body.pieceVersion).toBe(3);
  });

  it("retract moves sent→retracted; a draft cannot be retracted", async () => {
    const sent = await seedNote({
      teacherId: teacher.id,
      studentId: student.id,
      status: "sent",
      sentAt: new Date(),
      pieceId: "seed_piece",
    });
    const ok = await request(makeApp())
      .post(`/v1/notes/${sent.note.id}/retract`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("retracted");

    const draft = await seedNote({ teacherId: teacher.id, pieceId: "seed_piece" });
    const bad = await request(makeApp())
      .post(`/v1/notes/${draft.note.id}/retract`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe("not_retractable");
  });

  it("duplicate copies content and annotations into a fresh draft with no student", async () => {
    const src = await seedNote({ teacherId: teacher.id, studentId: student.id, pieceId: "seed_piece" });
    const res = await request(makeApp())
      .post(`/v1/notes/${src.note.id}/duplicate`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.studentId).toBeNull();
    expect(res.body.status).toBe("draft");
    expect(res.body.content.lessonSummary).toBe(src.note.content.lessonSummary);

    const detail = await request(makeApp())
      .get(`/v1/notes/${res.body.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(detail.body.annotations.length).toBe(2);
    expect(detail.body.annotations[0].quote).toBe(src.annotations[0]!.quote);
  });

  it("duplicating a retracted note records supersededBy on the original", async () => {
    const src = await seedNote({
      teacherId: teacher.id,
      studentId: student.id,
      status: "retracted",
      sentAt: daysAgo(1),
      retractedAt: new Date(),
      pieceId: "seed_piece",
    });
    const res = await request(makeApp())
      .post(`/v1/notes/${src.note.id}/duplicate`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(res.status).toBe(201);
    const original = await request(makeApp())
      .get(`/v1/notes/${src.note.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(original.body.note.supersededBy).toBe(res.body.id);
  });
});

// ── 7. Notes: student flow ──────────────────────────────────────────────────────────

describe("notes: student flow", () => {
  let stuT: TestUser;
  let stuS: TestUser;

  beforeAll(async () => {
    stuT = await makeUser({ oid: "stu-teacher", name: "Student-Flow Teacher", role: "teacher" });
    stuS = await makeUser({ oid: "stu-student", name: "Student-Flow Student", role: "student" });
    await linkActive(stuT.id, stuS.id);
  });

  it("lists sent notes with annotation counts, unlocked under beta_free", async () => {
    const { note, annotations } = await seedNote({
      teacherId: stuT.id,
      studentId: stuS.id,
      status: "sent",
      sentAt: new Date(),
      pieceId: "seed_piece",
    });
    await db.orm.update(noteAnnotations).set({ doneAt: new Date() }).where(eq(noteAnnotations.id, annotations[0]!.id));

    const res = await request(makeApp()).get("/v1/me/notes").set("Authorization", `Bearer ${stuS.token}`);
    expect(res.status).toBe(200);
    expect(res.body.access.status).toBe("beta_free");
    const item = res.body.items.find((n: { id: string }) => n.id === note.id);
    expect(item.annotationCount).toBe(2);
    expect(item.doneCount).toBe(1);
    expect(item.locked).toBe(false);
    expect(item.teacherName).toBe("Student-Flow Teacher");
  });

  it("retracted notes surface only when they were already read", async () => {
    const unread = await seedNote({
      teacherId: stuT.id,
      studentId: stuS.id,
      status: "retracted",
      sentAt: daysAgo(2),
      retractedAt: new Date(),
      pieceId: "seed_piece",
    });
    const read = await seedNote({
      teacherId: stuT.id,
      studentId: stuS.id,
      status: "retracted",
      sentAt: daysAgo(2),
      readAt: daysAgo(1),
      retractedAt: new Date(),
      pieceId: "seed_piece",
    });
    const res = await request(makeApp()).get("/v1/me/notes").set("Authorization", `Bearer ${stuS.token}`);
    const ids = res.body.items.map((n: { id: string }) => n.id);
    expect(ids).not.toContain(unread.note.id);
    expect(ids).toContain(read.note.id);
  });

  it("detail returns annotations + teacher and does NOT mark the note read", async () => {
    const { note } = await seedNote({
      teacherId: stuT.id,
      studentId: stuS.id,
      status: "sent",
      sentAt: new Date(),
      pieceId: "seed_piece",
    });
    const res = await request(makeApp())
      .get(`/v1/me/notes/${note.id}`)
      .set("Authorization", `Bearer ${stuS.token}`);
    expect(res.status).toBe(200);
    expect(res.body.annotations.length).toBe(2);
    expect(res.body.teacher.displayName).toBe("Student-Flow Teacher");

    const [row] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.readAt).toBeNull();
  });

  it("detail of a retracted note returns a withdrawn stub", async () => {
    const { note } = await seedNote({
      teacherId: stuT.id,
      studentId: stuS.id,
      status: "retracted",
      sentAt: daysAgo(2),
      readAt: daysAgo(1),
      retractedAt: new Date(),
      pieceId: "seed_piece",
    });
    const res = await request(makeApp())
      .get(`/v1/me/notes/${note.id}`)
      .set("Authorization", `Bearer ${stuS.token}`);
    expect(res.status).toBe(200);
    expect(res.body.note.status).toBe("retracted");
    expect(res.body.annotations).toBeUndefined();
  });

  it("read is idempotent (readAt set once)", async () => {
    const { note } = await seedNote({
      teacherId: stuT.id,
      studentId: stuS.id,
      status: "sent",
      sentAt: new Date(),
      pieceId: "seed_piece",
    });
    const first = await request(makeApp())
      .post(`/v1/me/notes/${note.id}/read`)
      .set("Authorization", `Bearer ${stuS.token}`)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.readAt).not.toBeNull();
    const second = await request(makeApp())
      .post(`/v1/me/notes/${note.id}/read`)
      .set("Authorization", `Bearer ${stuS.token}`)
      .send({});
    expect(second.body.readAt).toBe(first.body.readAt);
  });

  it("practiced toggles doneAt and only the owning student may set it", async () => {
    const { note, annotations } = await seedNote({
      teacherId: stuT.id,
      studentId: stuS.id,
      status: "sent",
      sentAt: new Date(),
      pieceId: "seed_piece",
    });
    const aid = annotations[0]!.id;

    const done = await request(makeApp())
      .put(`/v1/me/notes/${note.id}/annotations/${aid}/practiced`)
      .set("Authorization", `Bearer ${stuS.token}`)
      .send({});
    expect(done.status).toBe(200);
    expect(done.body.doneAt).not.toBeNull();

    const undone = await request(makeApp())
      .delete(`/v1/me/notes/${note.id}/annotations/${aid}/practiced`)
      .set("Authorization", `Bearer ${stuS.token}`);
    expect(undone.status).toBe(200);
    expect(undone.body.doneAt).toBeNull();

    // The teacher is not the student on this note.
    const asTeacher = await request(makeApp())
      .put(`/v1/me/notes/${note.id}/annotations/${aid}/practiced`)
      .set("Authorization", `Bearer ${stuT.token}`)
      .send({});
    expect(asTeacher.status).toBe(404);
  });

  it("pin grounds an ungrounded annotation; a grounded one 409s; bad measures 400", async () => {
    const { note, annotations } = await seedNote({
      teacherId: stuT.id,
      studentId: stuS.id,
      status: "sent",
      sentAt: new Date(),
      pieceId: "seed_piece",
      annotations: [
        { instruction: "Place this", quote: "here somewhere", location: { type: "deixis", grounded: false } },
        { instruction: "Already placed", quote: "bar 3", location: { type: "absolute", measureStart: 3, grounded: true } },
      ],
    });
    const [ungrounded, grounded] = annotations;

    const pin = await request(makeApp())
      .post(`/v1/me/notes/${note.id}/annotations/${ungrounded!.id}/pin`)
      .set("Authorization", `Bearer ${stuS.token}`)
      .send({ measureStart: 5, measureEnd: 6 });
    expect(pin.status).toBe(200);
    expect(pin.body.location.studentPin).toEqual({ measureStart: 5, measureEnd: 6 });

    const already = await request(makeApp())
      .post(`/v1/me/notes/${note.id}/annotations/${grounded!.id}/pin`)
      .set("Authorization", `Bearer ${stuS.token}`)
      .send({ measureStart: 2, measureEnd: 2 });
    expect(already.status).toBe(409);
    expect(already.body.error).toBe("already_grounded");

    const bad = await request(makeApp())
      .post(`/v1/me/notes/${note.id}/annotations/${ungrounded!.id}/pin`)
      .set("Authorization", `Bearer ${stuS.token}`)
      .send({ measureStart: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_measures");
  });

  it("lapsed access locks notes sent after the boundary but keeps older ones readable", async () => {
    const lapS = await makeUser({ oid: "stu-lapsed", name: "Lapsed Student", role: "student" });
    await linkActive(stuT.id, lapS.id);
    await db.orm.update(users).set({ trialStartedAt: daysAgo(90) }).where(eq(users.id, lapS.id));
    await setMonetization(daysAgo(90).toISOString());
    try {
      // Trial ended ~60d ago; that is the lock boundary.
      const recent = await seedNote({
        teacherId: stuT.id,
        studentId: lapS.id,
        status: "sent",
        sentAt: new Date(),
        pieceId: "seed_piece",
      });
      const old = await seedNote({
        teacherId: stuT.id,
        studentId: lapS.id,
        status: "sent",
        sentAt: daysAgo(75),
        pieceId: "seed_piece",
      });

      const list = await request(makeApp()).get("/v1/me/notes").set("Authorization", `Bearer ${lapS.token}`);
      expect(list.body.access.status).toBe("lapsed");
      const recentItem = list.body.items.find((n: { id: string }) => n.id === recent.note.id);
      const oldItem = list.body.items.find((n: { id: string }) => n.id === old.note.id);
      expect(recentItem.locked).toBe(true);
      expect(oldItem.locked).toBe(false);

      const blocked = await request(makeApp())
        .get(`/v1/me/notes/${recent.note.id}`)
        .set("Authorization", `Bearer ${lapS.token}`);
      expect(blocked.status).toBe(402);
      expect(blocked.body.error).toBe("subscription_required");

      const readable = await request(makeApp())
        .get(`/v1/me/notes/${old.note.id}`)
        .set("Authorization", `Bearer ${lapS.token}`);
      expect(readable.status).toBe(200);
      expect(readable.body.annotations.length).toBe(2);
    } finally {
      await setMonetization(null);
    }
  });
});

// ── 8. Devices ──────────────────────────────────────────────────────────────────────

describe("devices", () => {
  let devU1: TestUser;
  let devU2: TestUser;

  beforeAll(async () => {
    devU1 = await makeUser({ oid: "dev-user-1" });
    devU2 = await makeUser({ oid: "dev-user-2" });
  });

  it("upsert by token rebinds ownership on the second user", async () => {
    const first = await request(makeApp())
      .post("/v1/devices")
      .set("Authorization", `Bearer ${devU1.token}`)
      .send({ token: "apns-token-A" });
    expect(first.status).toBe(201);
    expect(first.body.userId).toBe(devU1.id);

    const rebind = await request(makeApp())
      .post("/v1/devices")
      .set("Authorization", `Bearer ${devU2.token}`)
      .send({ token: "apns-token-A" });
    expect(rebind.status).toBe(201);
    expect(rebind.body.userId).toBe(devU2.id);

    const rows = await db.orm.select().from(devices).where(eq(devices.token, "apns-token-A"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(devU2.id);
  });

  it("DELETE removes only your own binding", async () => {
    await request(makeApp())
      .post("/v1/devices")
      .set("Authorization", `Bearer ${devU1.token}`)
      .send({ token: "apns-token-B" });

    // A different user cannot delete it.
    await request(makeApp()).delete("/v1/devices/apns-token-B").set("Authorization", `Bearer ${devU2.token}`);
    let rows = await db.orm.select().from(devices).where(eq(devices.token, "apns-token-B"));
    expect(rows.length).toBe(1);

    await request(makeApp()).delete("/v1/devices/apns-token-B").set("Authorization", `Bearer ${devU1.token}`);
    rows = await db.orm.select().from(devices).where(eq(devices.token, "apns-token-B"));
    expect(rows.length).toBe(0);
  });
});

// ── 9. Auth ───────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("no token → 401", async () => {
    const res = await request(makeApp()).get("/v1/notes");
    expect(res.status).toBe(401);
  });

  it("a valid token with no prior sync → 403 unknown_user", async () => {
    const token = await mkToken("never-synced-oid", "Ghost");
    const res = await request(makeApp()).get("/v1/notes").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("unknown_user");
  });
});
