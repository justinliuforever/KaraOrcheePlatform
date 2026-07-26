import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { and, asc, eq, sql as sqlRaw } from "drizzle-orm";
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
  noteNarrationClips,
  entitlements,
  platformConfig,
  devices,
  auditEvents,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { LessonStore } from "../src/notes/lessons_store";
import type { NotesAssetsStore } from "../src/notes/assets_store";
import { createBlobNotesAssetsStore } from "../src/notes/assets_store";
import { narrationClipPath, narrationPrefix } from "../src/notes/narration";
import type { NotesQueue } from "../src/queue";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// THE cross-repo contract (worker + API + app all assert this one file). Read, never
// re-derived: a constant copied into this suite could agree with itself forever.
const GOLDEN = JSON.parse(
  readFileSync(join(__dirname, "../../worker/notes/narration_parity.json"), "utf8"),
) as {
  overview: { textHash: string }[];
  step: { textHash: string }[];
  wire: {
    voices: string[];
    overviewClipId: string;
    endpoint: string;
    queue: string;
    message: Record<string, unknown>;
    response: Record<string, unknown> & { clips: Record<string, unknown>[] };
  };
};

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
  failNextDelete: boolean;
}
function makeFakeLessons(): FakeLessons {
  const f: FakeLessons = {
    audio: { bytes: 1000 },
    deleted: [],
    failNextDelete: false,
    blobPath: (t, l) => `${t}/${l}.m4a`,
    uploadUrl: (p) => `https://fake/${p}?sas`,
    async audioProps() {
      return f.audio;
    },
    async deleteAudio(p) {
      if (f.failNextDelete) {
        f.failNextDelete = false;
        throw new Error("blob service unavailable");
      }
      f.deleted.push(p);
    },
  };
  return f;
}

// In-memory notes-assets container: put() seeds a blob, signed[] records the exact
// paths a request minted URLs for, deletePrefix sweeps like the real one.
interface FakeAssets extends NotesAssetsStore {
  blobs: Map<string, number>;
  copied: [string, string][];
  deleted: string[];
  deletedPrefixes: string[];
  reads: string[];
  signed: string[];
  put(path: string, bytes?: number): void;
}
function makeFakeAssets(): FakeAssets {
  const a: FakeAssets = {
    blobs: new Map(),
    copied: [],
    deleted: [],
    deletedPrefixes: [],
    reads: [],
    signed: [],
    put(path, bytes = 4096) {
      a.blobs.set(path, bytes);
    },
    async readTranscript(p) {
      a.reads.push(p);
      return { text: "transcript" };
    },
    readUrl(p) {
      a.signed.push(p);
      return `https://fake.blob/notes-assets/${p}?sp=r&se=fake`;
    },
    async copyAsset(from, to) {
      a.copied.push([from, to]);
      const bytes = a.blobs.get(from);
      if (bytes === undefined) throw new Error(`no such blob: ${from}`);
      a.blobs.set(to, bytes);
    },
    async deleteAsset(p) {
      a.deleted.push(p);
      a.blobs.delete(p);
    },
    async deletePrefix(prefix) {
      a.deletedPrefixes.push(prefix);
      for (const path of [...a.blobs.keys()]) {
        if (path.startsWith(prefix)) {
          a.deleted.push(path);
          a.blobs.delete(path);
        }
      }
    },
  };
  return a;
}

// Two lanes, kept apart on purpose: a narration message on notes-jobs is one the ASR
// consumer cannot read — it would redeliver until it dead-lettered.
interface FakeQueue extends NotesQueue {
  sent: Record<string, unknown>[];
  narrationSent: Record<string, unknown>[];
  throwNext: boolean;
}
function makeFakeQueue(): FakeQueue {
  const q: FakeQueue = {
    sent: [],
    narrationSent: [],
    throwNext: false,
    async send(body) {
      if (q.throwNext) throw new Error("service bus unavailable");
      q.sent.push(body);
    },
    async sendNarration(body) {
      if (q.throwNext) throw new Error("service bus unavailable");
      q.narrationSent.push(body);
    },
  };
  return q;
}

let fakeLessons: FakeLessons;
let fakeQueue: FakeQueue;
let fakeAssets: FakeAssets;

function makeApp() {
  return createServer({
    db,
    auth: verifier,
    lessons: fakeLessons,
    notesQueue: fakeQueue,
    notesAssets: fakeAssets,
  });
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
  fakeAssets = makeFakeAssets();

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
  fakeLessons.failNextDelete = false;
  fakeQueue.throwNext = false;
  fakeQueue.sent.length = 0;
  fakeQueue.narrationSent.length = 0;
  fakeAssets.blobs.clear();
  fakeAssets.copied.length = 0;
  fakeAssets.deleted.length = 0;
  fakeAssets.deletedPrefixes.length = 0;
  fakeAssets.signed.length = 0;
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

  // I-5/NEW-14: the two recording notices are different promises. The teacher one
  // carries the responsibility-to-inform language, so accepting the solo notice must
  // never satisfy it — and one shared column could not tell them apart.
  it("solo consent does not satisfy the teacher gate, and vice versa", async () => {
    const soloToken = await mkToken("consent-solo", "Solo Sam");
    const solo = await sync(soloToken, { role: "student", notesConsent: true, consentKind: "solo" });
    expect(solo.status).toBe(200);
    expect(solo.body.soloConsentAt).not.toBeNull();
    expect(solo.body.teacherConsentAt).toBeNull();

    const teacherToken = await mkToken("consent-teacher", "Consent Cleo");
    const teacher = await sync(teacherToken, { role: "teacher", notesConsent: true, consentKind: "teacher" });
    expect(teacher.body.teacherConsentAt).not.toBeNull();
    expect(teacher.body.soloConsentAt).toBeNull();
  });

  it("each consent is write-once and the two accumulate independently", async () => {
    const token = await mkToken("consent-both", "Both Bo");
    const first = await sync(token, { role: "student", notesConsent: true, consentKind: "solo" });
    const soloAt = first.body.soloConsentAt;
    expect(soloAt).not.toBeNull();

    const second = await sync(token, { notesConsent: true, consentKind: "teacher" });
    expect(second.body.soloConsentAt).toBe(soloAt); // never re-stamped
    expect(second.body.teacherConsentAt).not.toBeNull();
    const teacherAt = second.body.teacherConsentAt;

    const third = await sync(token, { notesConsent: true, consentKind: "teacher" });
    expect(third.body.teacherConsentAt).toBe(teacherAt);
    expect(third.body.soloConsentAt).toBe(soloAt);
  });

  it("an acceptance that names no kind satisfies NEITHER gate (fail closed)", async () => {
    const legacy = await mkToken("consent-legacy", "Legacy Lee");
    const res = await sync(legacy, { role: "student", notesConsent: true });
    expect(res.body.notesConsentAt).not.toBeNull();
    expect(res.body.soloConsentAt).toBeNull();
    expect(res.body.teacherConsentAt).toBeNull();

    const bogus = await mkToken("consent-bogus", "Bogus Bea");
    const two = await sync(bogus, { role: "student", notesConsent: true, consentKind: "everything" });
    expect(two.body.soloConsentAt).toBeNull();
    expect(two.body.teacherConsentAt).toBeNull();
  });

  it("a named kind without the acceptance flag stamps nothing", async () => {
    const token = await mkToken("consent-unflagged", "Unflagged Uma");
    const res = await sync(token, { role: "student", consentKind: "teacher" });
    expect(res.body.notesConsentAt).toBeNull();
    expect(res.body.teacherConsentAt).toBeNull();
    expect(res.body.soloConsentAt).toBeNull();
  });

  // S-2: the client may name a role for an account that has NONE, and never again.
  // Self-granting isTeacher was a permanent paywall bypass (teacher_free).
  it("a role sent for an account that already holds one is a silent no-op", async () => {
    const token = await mkToken("sync-both", "B");
    const first = await sync(token, { role: "student" });
    expect(first.body.isStudent).toBe(true);
    expect(first.body.needsRole).toBe(false);

    const second = await sync(token, { role: "teacher" });
    expect(second.status).toBe(200);
    expect(second.body.isStudent).toBe(true);
    expect(second.body.isTeacher).toBe(false);
    expect(second.body.access.status).toBe("beta_free");

    const third = await sync(token, { role: "teacher" });
    expect(third.body.isTeacher).toBe(false);
  });

  it("a teacher cannot self-grant the student role either", async () => {
    const token = await mkToken("sync-teacher-then-student", "TS");
    await sync(token, { role: "teacher" });
    const res = await sync(token, { role: "student" });
    expect(res.body.isTeacher).toBe(true);
    expect(res.body.isStudent).toBe(false);
    expect(res.body.trialStartedAt).toBeNull();
  });

  it("needsRole is derived on every sync and the role step clears it", async () => {
    const token = await mkToken("sync-roleless", "R");
    const bare = await sync(token, {});
    expect(bare.status).toBe(200);
    expect(bare.body.needsRole).toBe(true);
    expect(bare.body.isTeacher).toBe(false);
    expect(bare.body.isStudent).toBe(false);

    const repaired = await sync(token, { role: "student", via: "setup" });
    expect(repaired.body.needsRole).toBe(false);
    expect(repaired.body.isStudent).toBe(true);

    const [event] = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorUserId, repaired.body.id), eq(auditEvents.action, "user.role_set")));
    expect(event!.detail).toMatchObject({ role: "student", via: "setup" });
  });

  // G-8/I-13: the origin is what lets an admin tell a repair from a sign-up. A
  // client that sends nothing (or something unrecognized) still reads as a sign-up,
  // which is what the trail assumed before the field existed.
  it("a role grant with no origin records as a sign-up", async () => {
    const token = await mkToken("via-absent", "Via Vera");
    const res = await sync(token, { role: "teacher" });
    const [event] = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorUserId, res.body.id), eq(auditEvents.action, "user.role_set")));
    expect(event!.detail).toMatchObject({ role: "teacher", via: "signup" });
  });

  it("an unrecognized origin is recorded as a sign-up, never verbatim", async () => {
    const token = await mkToken("via-bogus", "Via Bogus");
    const res = await sync(token, { role: "student", via: "totally-made-up" });
    const [event] = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorUserId, res.body.id), eq(auditEvents.action, "user.role_set")));
    expect(event!.detail).toMatchObject({ role: "student", via: "signup" });
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

  it("create requires a Notes role; teacher mint is teacher_to_student", async () => {
    const forbidden = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", `Bearer ${invS.token}`)
      .send({});
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe("notes_role_required");
    expect(forbidden.body.message).toBe("This account isn't set up as a teacher or a student yet.");

    const ok = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", `Bearer ${invT.token}`)
      .send({});
    expect(ok.status).toBe(201);
    expect(typeof ok.body.code).toBe("string");
    expect(ok.body.direction).toBe("teacher_to_student");
    inviteA = { id: ok.body.id, code: ok.body.code };
  });

  it("GET lists only live invites; DELETE revokes; unknown DELETE 404s", async () => {
    // Seeded, not minted: one live code per issuer per direction means a second
    // POST would return inviteA rather than a new row.
    const [b] = await db.orm
      .insert(invites)
      .values({ code: "SEEDB1", teacherId: invT.id, expiresAt: daysFromNow(7) })
      .returning();
    const bId = b!.id;

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
    expect(res.body.message).toBe("That's your own code.");
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

  it("redeeming a second live code for an existing pair → 409 already_linked with the counterpart", async () => {
    const c = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", `Bearer ${invT.token}`)
      .send({});
    expect(c.status).toBe(201); // inviteA is spent, so this is a fresh code
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", `Bearer ${invS.token}`)
      .send({ code: c.body.code, consent: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_linked");
    expect(res.body.message).toBe("You're already connected with Invite Teacher.");
    expect(res.body.counterpart).toEqual({ id: invT.id, displayName: "Invite Teacher" });
    // The 409 fires before the claim, so the code is not burned.
    const [row] = await db.orm.select().from(invites).where(eq(invites.id, c.body.id));
    expect(row!.usedCount).toBe(0);
  });

  it("a code minted after the removal reactivates the same row and re-consents at now()", async () => {
    const removed = await request(makeApp())
      .delete(`/v1/me/teachers/${invT.id}`)
      .set("Authorization", `Bearer ${invS.token}`);
    expect(removed.status).toBe(200);
    const [link] = await db.orm.select().from(teacherStudentLinks).where(eq(teacherStudentLinks.id, linkId));
    const removedAt = link!.removedAt!;

    // The teacher's pre-removal code is still live; it cannot re-form the pair, so
    // the fresh code has to replace it.
    const live = await request(makeApp()).get("/v1/invites").set("Authorization", `Bearer ${invT.token}`);
    for (const r of live.body as { id: string }[]) {
      await request(makeApp()).delete(`/v1/invites/${r.id}`).set("Authorization", `Bearer ${invT.token}`);
    }
    const d = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", `Bearer ${invT.token}`)
      .send({});
    expect(d.status).toBe(201);

    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", `Bearer ${invS.token}`)
      .send({ code: d.body.code, consent: true });
    expect(res.status).toBe(201);
    expect(res.body.link.id).toBe(linkId); // same row, reactivated
    expect(res.body.link.status).toBe("active");
    expect(res.body.link.removedAt).toBeNull();
    expect(new Date(res.body.link.consentAt).getTime()).toBeGreaterThan(removedAt.getTime());
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
  it("POST requires a Notes role; solo student path validates its own contract", async () => {
    const noRole = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${stranger.token}`)
      .send({});
    expect(noRole.status).toBe(403);
    expect(noRole.body.error).toBe("notes_role_required");

    // Solo recordings are always the recorder's own and must be attested.
    const withStudent = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${student.token}`)
      .send({ studentId: teacher.id, attested: true });
    expect(withStudent.status).toBe(400);
    expect(withStudent.body.error).toBe("solo_lesson_no_student");

    const unattested = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${student.token}`)
      .send({});
    expect(unattested.status).toBe(400);
    expect(unattested.body.error).toBe("attestation_required");
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

  it("create is idempotent on clientLessonId (a retried outbox POST returns the same row)", async () => {
    const first = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ clientLessonId: "local-uuid-1", studentId: student.id });
    expect(first.status).toBe(201);
    const second = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ clientLessonId: "local-uuid-1", studentId: student.id });
    expect(second.status).toBe(200);
    expect(second.body.lesson.id).toBe(first.body.lesson.id);
    expect(second.body.uploadUrl).toBe(first.body.uploadUrl);
    // A different client id is a genuinely new lesson.
    const other = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ clientLessonId: "local-uuid-2", studentId: student.id });
    expect(other.body.lesson.id).not.toBe(first.body.lesson.id);
  });

  it("upload-url re-mints a fresh SAS for an un-submitted lesson only", async () => {
    const lesson = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ studentId: student.id });
    const id = lesson.body.lesson.id;
    const fresh = await request(makeApp())
      .post(`/v1/lessons/${id}/upload-url`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(fresh.status).toBe(200);
    expect(fresh.body.uploadUrl).toBe(`https://fake/${teacher.id}/${id}.m4a?sas`);

    await request(makeApp())
      .post(`/v1/lessons/${id}/submit`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    const after = await request(makeApp())
      .post(`/v1/lessons/${id}/upload-url`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(after.status).toBe(409);

    const stranger404 = await request(makeApp())
      .post(`/v1/lessons/${id}/upload-url`)
      .set("Authorization", `Bearer ${stranger.token}`)
      .send({});
    expect(stranger404.status).toBe(404);
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

    // CONTRACT CHANGE (r4 fix 2): a submitted lesson with a live job is refused
    // as lesson_processing, not already_submitted — "already submitted" is no
    // longer a reason to refuse, only "still running" is.
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
    expect(late.body.error).toBe("lesson_processing");
  });
});

// ── 5b. Lesson metadata lifecycle: PATCH, discard, retry policy (r4) ────────────────

describe("lesson metadata lifecycle", () => {
  let mdT: TestUser; // recording teacher
  let mdS: TestUser; // linked student the lesson was really with
  let mdS2: TestUser; // a second linked student, for the "teacher chose someone else" case
  let solo: TestUser; // solo (student-owned) recorder

  const HOUR = 60 * 60 * 1000;

  beforeAll(async () => {
    mdT = await makeUser({ oid: "md-teacher", name: "Meta Teacher", role: "teacher" });
    mdS = await makeUser({ oid: "md-student", name: "Meta Student", role: "student" });
    mdS2 = await makeUser({ oid: "md-student-2", name: "Meta Student Two", role: "student" });
    solo = await makeUser({ oid: "md-solo", name: "Meta Solo", role: "student", notesConsent: true });
    await linkActive(mdT.id, mdS.id);
    await linkActive(mdT.id, mdS2.id);
    // 32 bars: everything past bar 32 is out of range once this piece is named.
    await db.orm.insert(pieces).values({
      id: "short_piece",
      title: "Burgmüller Op. 100 No. 2",
      composer: "Friedrich Burgmüller",
      rights: "public_domain",
      status: "published",
      publishedVersion: 5,
      facts: { measures: 32 },
    });
  });

  async function mkLesson(opts: {
    owner?: TestUser;
    ownerRole?: "teacher" | "student";
    studentId?: string | null;
    pieceId?: string | null;
    pieceLabel?: string | null;
    status?: string;
  } = {}) {
    const owner = opts.owner ?? mdT;
    const [row] = await db.orm
      .insert(lessonSessions)
      .values({
        teacherId: owner.id,
        ownerRole: opts.ownerRole ?? "teacher",
        studentId: opts.studentId ?? null,
        pieceId: opts.pieceId ?? null,
        pieceLabel: opts.pieceLabel ?? null,
        status: opts.status ?? "submitted",
      })
      .returning();
    const [withPath] = await db.orm
      .update(lessonSessions)
      .set({ audioPath: `${owner.id}/${row!.id}.m4a` })
      .where(eq(lessonSessions.id, row!.id))
      .returning();
    return withPath!;
  }

  async function mkJob(lessonSessionId: string, opts: {
    status?: string;
    failureCode?: string | null;
    attempts?: number;
    transcriptPath?: string | null;
    metrics?: Record<string, unknown>;
    movedAgoMs?: number;
  } = {}) {
    const [row] = await db.orm
      .insert(noteJobs)
      .values({
        lessonSessionId,
        status: opts.status ?? "failed",
        failureCode: opts.failureCode ?? null,
        attempts: opts.attempts ?? 0,
        transcriptPath: opts.transcriptPath ?? null,
        metrics: opts.metrics ?? {},
        createdBy: mdT.id,
        startedAt: new Date(),
      })
      .returning();
    if (opts.movedAgoMs !== undefined) {
      const [aged] = await db.orm
        .update(noteJobs)
        .set({ updatedAt: new Date(Date.now() - opts.movedAgoMs) })
        .where(eq(noteJobs.id, row!.id))
        .returning();
      return aged!;
    }
    return row!;
  }

  async function mkNote(lessonSessionId: string, opts: {
    teacherId?: string;
    studentId?: string | null;
    origin?: "teacher" | "self";
    status?: "draft" | "sent" | "retracted";
    pieceId?: string | null;
    pieceLabel?: string | null;
    pieceVersion?: number | null;
    annotations?: { instruction: string; quote: string; location: Record<string, unknown> }[];
  } = {}) {
    const content = { lessonSummary: "Good work.", practicePlan: [] };
    const [note] = await db.orm
      .insert(notes)
      .values({
        lessonSessionId,
        teacherId: opts.teacherId ?? mdT.id,
        studentId: opts.studentId ?? null,
        origin: opts.origin ?? "teacher",
        status: opts.status ?? "draft",
        pieceId: opts.pieceId ?? null,
        pieceLabel: opts.pieceLabel ?? null,
        pieceVersion: opts.pieceVersion ?? null,
        contentOriginal: content,
        content,
      })
      .returning();
    const anns = opts.annotations ?? [];
    const rows = anns.length
      ? await db.orm
          .insert(noteAnnotations)
          .values(anns.map((a, i) => ({
            noteId: note!.id,
            idx: i,
            category: "other",
            instruction: a.instruction,
            quote: a.quote,
            location: a.location,
          })))
          .returning()
      : [];
    return { note: note!, annotations: rows };
  }

  const patch = (id: string, body: Record<string, unknown>, who: TestUser = mdT) =>
    request(makeApp()).patch(`/v1/lessons/${id}`).set("Authorization", `Bearer ${who.token}`).send(body);
  const del = (id: string, who: TestUser = mdT) =>
    request(makeApp()).delete(`/v1/lessons/${id}`).set("Authorization", `Bearer ${who.token}`);
  const getOne = (id: string, who: TestUser = mdT) =>
    request(makeApp()).get(`/v1/lessons/${id}`).set("Authorization", `Bearer ${who.token}`);

  // ── PATCH ───────────────────────────────────────────────────────────────────

  it("assigns a student on a submitted lesson that has no note yet", async () => {
    const lesson = await mkLesson();
    await mkJob(lesson.id, { status: "failed", failureCode: "thin_note" });
    const res = await patch(lesson.id, { studentId: mdS.id });
    expect(res.status).toBe(200);
    expect(res.body.lesson.studentId).toBe(mdS.id);
    expect(res.body.notes).toEqual([]);
    expect(res.body.regrounded).toBe(0);
  });

  it("cascades to a draft that merely inherited the lesson's old value", async () => {
    const lesson = await mkLesson({ studentId: null });
    const { note } = await mkNote(lesson.id, { studentId: null, status: "draft" });
    const res = await patch(lesson.id, { studentId: mdS.id });
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0]).toMatchObject({ id: note.id, updated: true, studentId: mdS.id });
    const [row] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.studentId).toBe(mdS.id);
  });

  it("never clobbers a student the teacher chose at review", async () => {
    // The lesson never named anyone; the teacher picked mdS2 while reviewing.
    const lesson = await mkLesson({ studentId: null });
    const { note } = await mkNote(lesson.id, { studentId: mdS2.id, status: "draft" });
    const res = await patch(lesson.id, { studentId: mdS.id });
    expect(res.status).toBe(200);
    expect(res.body.lesson.studentId).toBe(mdS.id);
    expect(res.body.notes[0]).toMatchObject({ id: note.id, updated: false, studentId: mdS2.id });
    const [row] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.studentId).toBe(mdS2.id); // untouched
  });

  it("M7: the wire carries the DRAFT's own studentId after a non-cascading PATCH", async () => {
    // The teacher home resolves its Needs-attention row from the LESSON today,
    // which would name the newly assigned student on a draft that still goes to
    // the one the teacher chose. The list must expose the note's own studentId
    // for that row to be fixable, and it does.
    const lesson = await mkLesson({ studentId: null });
    await mkNote(lesson.id, { studentId: mdS2.id, status: "draft" });
    await patch(lesson.id, { studentId: mdS.id });
    const list = await request(makeApp()).get("/v1/lessons").set("Authorization", `Bearer ${mdT.token}`);
    const item = list.body.items.find((i: { lesson: { id: string } }) => i.lesson.id === lesson.id);
    expect(item.lesson.studentId).toBe(mdS.id);
    expect(item.notes[0].studentId).toBe(mdS2.id);
    expect(item.notes[0].origin).toBe("teacher");
  });

  it("updates the fact but never a sent note", async () => {
    const lesson = await mkLesson({ studentId: mdS.id, pieceLabel: "Old label" });
    const { note } = await mkNote(lesson.id, {
      studentId: mdS.id,
      status: "sent",
      pieceLabel: "Old label",
    });
    const res = await patch(lesson.id, { pieceLabel: "New label" });
    expect(res.status).toBe(200);
    expect(res.body.lesson.pieceLabel).toBe("New label");
    expect(res.body.notes[0]).toMatchObject({ id: note.id, updated: false, status: "sent" });
    const [row] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.pieceLabel).toBe("Old label");
  });

  it("rejects a student on a solo lesson and an unlinked student on a teacher lesson", async () => {
    const soloLesson = await mkLesson({ owner: solo, ownerRole: "student" });
    const soloRes = await patch(soloLesson.id, { studentId: mdS.id }, solo);
    expect(soloRes.status).toBe(400);
    expect(soloRes.body.error).toBe("solo_lesson_no_student");

    const lesson = await mkLesson();
    const unlinked = await patch(lesson.id, { studentId: stranger.id });
    expect(unlinked.status).toBe(400);
    expect(unlinked.body.error).toBe("not_your_student");

    const badPiece = await patch(lesson.id, { pieceId: "no_such_piece" });
    expect(badPiece.status).toBe(400);
    expect(badPiece.body.error).toBe("unknown_piece");
  });

  // ── D1: no bare 400 after a 45-minute recording ─────────────────────────────

  it("every repairable 400 carries the same message on create and on PATCH", async () => {
    const post = (body: Record<string, unknown>, who: TestUser = mdT) =>
      request(makeApp()).post("/v1/lessons").set("Authorization", `Bearer ${who.token}`).send(body);

    const created = await post({ pieceId: "no_such_piece" });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe("unknown_piece");
    expect(created.body.message).toBeTruthy();

    const unlinkedCreate = await post({ studentId: stranger.id });
    expect(unlinkedCreate.body.error).toBe("not_your_student");
    expect(unlinkedCreate.body.message).toBeTruthy();

    const soloCreate = await post({ ownerRole: "student", studentId: mdS.id, attested: true }, solo);
    expect(soloCreate.body.error).toBe("solo_lesson_no_student");
    expect(soloCreate.body.message).toBeTruthy();

    // The two write paths must say the SAME thing about the same problem.
    const lesson = await mkLesson();
    const soloLesson = await mkLesson({ owner: solo, ownerRole: "student" });
    expect((await patch(lesson.id, { pieceId: "no_such_piece" })).body.message).toBe(created.body.message);
    expect((await patch(lesson.id, { studentId: stranger.id })).body.message).toBe(unlinkedCreate.body.message);
    expect((await patch(soloLesson.id, { studentId: mdS.id }, solo)).body.message).toBe(soloCreate.body.message);
  });

  it("pins pieceVersion on a self note, which has no later send event", async () => {
    const lesson = await mkLesson({ owner: solo, ownerRole: "student" });
    const { note } = await mkNote(lesson.id, {
      teacherId: solo.id,
      studentId: solo.id,
      origin: "self",
      status: "sent",
    });
    const res = await patch(lesson.id, { pieceId: "short_piece" }, solo);
    expect(res.status).toBe(200);
    expect(res.body.notes[0]).toMatchObject({ id: note.id, updated: true, pieceId: "short_piece" });
    const [row] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.pieceVersion).toBe(5);
    expect(row!.studentId).toBe(solo.id); // a self note's student is the owner, never rewritten
  });

  it("re-grounds only the auto anchors that now point past the end of the piece", async () => {
    const lesson = await mkLesson({ studentId: mdS.id });
    const { note, annotations } = await mkNote(lesson.id, {
      studentId: mdS.id,
      status: "draft",
      annotations: [
        {
          instruction: "Past the end",
          quote: "bar eighty four",
          location: { type: "absolute", raw: "bar 84", grounded: true, measureStart: 84, measureEnd: 84, pinnedBy: "auto" },
        },
        {
          instruction: "Still inside",
          quote: "bar four",
          location: { type: "absolute", raw: "bar 4", grounded: true, measureStart: 4, measureEnd: 4, pinnedBy: "auto" },
        },
        {
          instruction: "A human put this here",
          quote: "over there",
          location: { type: "absolute", raw: "over there", grounded: true, measureStart: 90, measureEnd: 90, pinnedBy: "teacher" },
        },
      ],
    });
    const res = await patch(lesson.id, { pieceId: "short_piece" });
    expect(res.status).toBe(200);
    expect(res.body.regrounded).toBe(1);

    const rows = await db.orm
      .select()
      .from(noteAnnotations)
      .where(eq(noteAnnotations.noteId, note.id));
    const byId = new Map(rows.map((r) => [r.id, r.location as Record<string, unknown>]));
    const demoted = byId.get(annotations[0]!.id)!;
    expect(demoted.grounded).toBe(false);
    expect(demoted.measureStart).toBeUndefined();
    expect(demoted.measureEnd).toBeUndefined();
    expect(demoted.pinnedBy).toBeUndefined();
    expect(demoted.raw).toBe("bar 84"); // the words survive as the clue
    expect(typeof demoted.hint).toBe("string");
    expect(byId.get(annotations[1]!.id)!.grounded).toBe(true); // in range
    const human = byId.get(annotations[2]!.id)!;
    expect(human.grounded).toBe(true); // a deliberate human placement is never touched
    expect(human.measureStart).toBe(90);
  });

  it("refuses a discarded lesson, an empty body, and someone else's lesson", async () => {
    const canceled = await mkLesson({ status: "canceled" });
    const discarded = await patch(canceled.id, { pieceLabel: "x" });
    expect(discarded.status).toBe(409);
    expect(discarded.body.error).toBe("lesson_discarded");

    const lesson = await mkLesson();
    const empty = await patch(lesson.id, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("nothing_to_update");

    // 404, never 403 — do not confirm that someone else's lesson exists.
    const notMine = await patch(lesson.id, { pieceLabel: "x" }, stranger);
    expect(notMine.status).toBe(404);
    const alsoNotMine = await patch(lesson.id, { pieceLabel: "x" }, teacher);
    expect(alsoNotMine.status).toBe(404);
  });

  it("is allowed on a created lesson — the divergence case a local-only edit cannot fix", async () => {
    const created = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({ clientLessonId: "md-created-1" });
    const id = created.body.lesson.id;
    const res = await patch(id, { studentId: mdS.id, pieceLabel: "  Trimmed  " });
    expect(res.status).toBe(200);
    expect(res.body.lesson.studentId).toBe(mdS.id);
    expect(res.body.lesson.pieceLabel).toBe("Trimmed");

    // Re-creating with the same clientLessonId returns the row WITH the patch —
    // create's dedupe stays idempotent-pure and the PATCH is what carried the edit.
    const again = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({ clientLessonId: "md-created-1", studentId: null });
    expect(again.status).toBe(200);
    expect(again.body.lesson.studentId).toBe(mdS.id);
  });

  it("clears a field with an explicit null and leaves absent fields alone", async () => {
    const lesson = await mkLesson({ studentId: mdS.id, pieceId: "short_piece", pieceLabel: "Keep me" });
    const res = await patch(lesson.id, { studentId: null });
    expect(res.status).toBe(200);
    expect(res.body.lesson.studentId).toBeNull();
    expect(res.body.lesson.pieceId).toBe("short_piece");
    expect(res.body.lesson.pieceLabel).toBe("Keep me");
  });

  it("writes lesson.assign_student and lesson.set_piece audits", async () => {
    const lesson = await mkLesson();
    await patch(lesson.id, { studentId: mdS.id, pieceId: "short_piece", pieceLabel: "Op. 100 No. 2" });
    const rows = await db.orm
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, lesson.id));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("lesson.assign_student");
    expect(actions).toContain("lesson.set_piece");
    const assign = rows.find((r) => r.action === "lesson.assign_student")!;
    expect((assign.detail as { to: string }).to).toBe(mdS.id);
    const setPiece = rows.find((r) => r.action === "lesson.set_piece")!;
    expect((setPiece.detail as { toPieceId: string }).toPieceId).toBe("short_piece");
  });

  // ── DELETE / discard ────────────────────────────────────────────────────────

  it("discards a permanently failed lesson: audio, transcript, draft and warnings all go", async () => {
    const lesson = await mkLesson({ studentId: mdS.id, pieceLabel: "Op. 100" });
    await db.orm
      .update(lessonSessions)
      .set({ clientLessonId: "md-discard-1" })
      .where(eq(lessonSessions.id, lesson.id));
    const job = await mkJob(lesson.id, {
      status: "failed",
      failureCode: "thin_note",
      attempts: 1,
      transcriptPath: `transcripts/${lesson.id}.json`,
      // r4_verify M1: metrics.warnings is verbatim lesson content.
      metrics: { asr_secs: 12, warnings: ["dropped_unverifiable_quote: keep your wrist relaxed on"] },
    });
    const { note, annotations } = await mkNote(lesson.id, {
      studentId: mdS.id,
      status: "draft",
      annotations: [{ instruction: "x", quote: "y", location: {} }],
    });

    const res = await del(lesson.id);
    expect(res.status).toBe(200);

    const [row] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, lesson.id));
    expect(row!.status).toBe("canceled");
    expect(row!.clientLessonId).toBeNull(); // released, so a re-record can reuse it
    const [jobRow] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job.id));
    expect(jobRow).toBeTruthy(); // the stub survives: the only record the failure happened
    expect(jobRow!.discardedAt).not.toBeNull();
    expect(jobRow!.transcriptPath).toBeNull();
    expect(jobRow!.metrics).toEqual({ asr_secs: 12 }); // counts survive, content does not
    expect(fakeLessons.deleted).toContain(lesson.audioPath);
    expect(fakeAssets.deleted).toContain(`transcripts/${lesson.id}.json`);
    const noteRows = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(noteRows.length).toBe(0);
    const annRows = await db.orm
      .select()
      .from(noteAnnotations)
      .where(eq(noteAnnotations.id, annotations[0]!.id));
    expect(annRows.length).toBe(0);

    const audit = await db.orm.select().from(auditEvents).where(eq(auditEvents.subjectId, lesson.id));
    const discard = audit.find((a) => a.action === "lesson.discard")!;
    expect(discard).toBeTruthy();
    expect(discard.detail).toMatchObject({
      failureCode: "thin_note",
      attempts: 1,
      notesDeleted: 1,
      audioDeleted: true,
      transcriptDeleted: true,
    });
  });

  it("is idempotent: a second discard returns 200 and deletes nothing twice", async () => {
    const lesson = await mkLesson();
    await mkJob(lesson.id, { status: "failed", failureCode: "no_speech" });
    expect((await del(lesson.id)).status).toBe(200);
    const deletionsAfterFirst = fakeLessons.deleted.filter((p) => p === lesson.audioPath).length;
    const second = await del(lesson.id);
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(fakeLessons.deleted.filter((p) => p === lesson.audioPath).length).toBe(deletionsAfterFirst);
  });

  it("refuses while a job is genuinely running, and allows it once wedged past the hatch", async () => {
    const running = await mkLesson();
    await mkJob(running.id, { status: "processing", movedAgoMs: 5 * 60 * 1000 });
    const fresh = await del(running.id);
    expect(fresh.status).toBe(409);
    expect(fresh.body.error).toBe("lesson_processing");
    expect(fresh.body.message).toContain("once it finishes");

    const wedged = await mkLesson();
    await mkJob(wedged.id, { status: "processing", movedAgoMs: 61 * 60 * 1000 });
    expect((await del(wedged.id)).status).toBe(200);
  });

  it("refuses a lesson whose note was already sent", async () => {
    const lesson = await mkLesson({ studentId: mdS.id });
    await mkJob(lesson.id, { status: "ready_for_review" });
    await mkNote(lesson.id, { studentId: mdS.id, status: "sent" });
    const res = await del(lesson.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("lesson_has_sent_note");
    const [row] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, lesson.id));
    expect(row!.status).toBe("submitted"); // nothing happened
  });

  it("allows discarding an unwanted ready_for_review draft", async () => {
    const lesson = await mkLesson({ studentId: mdS.id });
    await mkJob(lesson.id, { status: "ready_for_review", metrics: { warnings: ["dropped_unverifiable_quote: sit up"] } });
    const { note } = await mkNote(lesson.id, { studentId: mdS.id, status: "draft" });
    expect((await del(lesson.id)).status).toBe(200);
    expect((await db.orm.select().from(notes).where(eq(notes.id, note.id))).length).toBe(0);
    const [jobRow] = await db.orm.select().from(noteJobs).where(eq(noteJobs.lessonSessionId, lesson.id));
    expect(jobRow!.metrics).toEqual({});
  });

  it("a solo self note never blocks the discard — it is the owner's own data", async () => {
    // The sent-note guard is scoped to origin='teacher': a self note is 'sent' by
    // construction, so scoping it wrongly would make every solo recording
    // undeletable the moment its note landed.
    const lesson = await mkLesson({ owner: solo, ownerRole: "student" });
    await mkJob(lesson.id, { status: "ready_for_review" });
    const { note } = await mkNote(lesson.id, {
      teacherId: solo.id,
      studentId: solo.id,
      origin: "self",
      status: "sent",
      annotations: [{ instruction: "x", quote: "y", location: {} }],
    });
    const read = await getOne(lesson.id, solo);
    expect(read.body.lesson.discardAllowed).toBe(true);
    expect((await del(lesson.id, solo)).status).toBe(200);
    expect((await db.orm.select().from(notes).where(eq(notes.id, note.id))).length).toBe(0);
    const anns = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, note.id));
    expect(anns.length).toBe(0);
  });

  it("loses cleanly to a racing submit (CAS on the observed status)", async () => {
    const created = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    const id = created.body.lesson.id;
    // Simulate the race: the row leaves 'created' between the read and the CAS.
    const app = makeApp();
    const inFlight = request(app).delete(`/v1/lessons/${id}`).set("Authorization", `Bearer ${mdT.token}`);
    await db.orm
      .update(lessonSessions)
      .set({ status: "submitted" })
      .where(and(eq(lessonSessions.id, id), eq(lessonSessions.status, "created")));
    const res = await inFlight;
    // Either the CAS lost (409) or it won before the update landed (200) — but a
    // 409 must never have mutated anything.
    if (res.status === 409) {
      expect(res.body.error).toBe("status_changed");
      const [row] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, id));
      expect(row!.status).toBe("submitted");
    } else {
      expect(res.status).toBe(200);
    }
  });

  // ── D2: what the discard destroys is read UNDER the lock ────────────────────

  it("cascades and deletes from the post-lock read, not from the pre-lock snapshot", async () => {
    // The worker takes the same lesson row FOR UPDATE before it inserts a note or
    // stamps a transcript, so its write lands in the window between the pre-lock
    // read and the CAS. A trigger on the CAS itself reproduces that window
    // exactly and deterministically: what a snapshot cannot see is a note that
    // then outlives the discard, and a transcript blob orphaned PERMANENTLY
    // (notes-assets has no lifecycle rule) behind an audit that says it is gone.
    const lesson = await mkLesson({ studentId: mdS.id });
    const job = await mkJob(lesson.id, { status: "failed", failureCode: "thin_note" });
    await db.orm.execute(sqlRaw`
      CREATE OR REPLACE FUNCTION test_worker_lands_mid_discard() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'canceled' AND OLD.status <> 'canceled' THEN
          INSERT INTO notes (note_job_id, lesson_session_id, teacher_id, student_id,
                             origin, status, content_original, content)
          SELECT j.id, NEW.id, NEW.teacher_id, NEW.student_id, 'teacher', 'draft',
                 '{"lessonSummary":"landed mid-discard"}'::jsonb,
                 '{"lessonSummary":"landed mid-discard"}'::jsonb
          FROM note_jobs j WHERE j.lesson_session_id = NEW.id LIMIT 1;
          UPDATE note_jobs SET transcript_path = 'transcripts/raced.json'
          WHERE lesson_session_id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
    `);
    await db.orm.execute(sqlRaw`
      CREATE TRIGGER test_worker_lands_mid_discard BEFORE UPDATE ON lesson_sessions
      FOR EACH ROW EXECUTE FUNCTION test_worker_lands_mid_discard()
    `);
    try {
      const res = await del(lesson.id);
      expect(res.status).toBe(200);
      // Neither write may survive a discard the user was told deleted the
      // recording and its transcript.
      const survivors = await db.orm.select().from(notes).where(eq(notes.lessonSessionId, lesson.id));
      expect(survivors.length).toBe(0);
      expect(fakeAssets.deleted).toContain("transcripts/raced.json");
      const [jobRow] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job.id));
      expect(jobRow!.transcriptPath).toBeNull();
      const audits = await db.orm.select().from(auditEvents).where(eq(auditEvents.subjectId, lesson.id));
      const detail = audits.find((a) => a.action === "lesson.discard")!.detail as {
        notesDeleted: number;
        transcriptDeleted: boolean;
      };
      expect(detail.notesDeleted).toBe(1);
      expect(detail.transcriptDeleted).toBe(true);
    } finally {
      await db.orm.execute(sqlRaw`DROP TRIGGER test_worker_lands_mid_discard ON lesson_sessions`);
    }
  });

  it("unwinds the CAS when the post-lock read revokes the permission", async () => {
    // Same window, other direction: a note that becomes SENT in it must revoke a
    // discard the pre-lock read had already allowed. Returning from the callback
    // would commit the cancel, so the recheck has to throw.
    const lesson = await mkLesson({ studentId: mdS.id });
    const job = await mkJob(lesson.id, { status: "failed", failureCode: "thin_note" });
    await db.orm.execute(sqlRaw`
      CREATE OR REPLACE FUNCTION test_note_sent_mid_discard() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'canceled' AND OLD.status <> 'canceled' THEN
          INSERT INTO notes (note_job_id, lesson_session_id, teacher_id, student_id,
                             origin, status, sent_at, content_original, content)
          SELECT j.id, NEW.id, NEW.teacher_id, NEW.student_id, 'teacher', 'sent', now(),
                 '{"lessonSummary":"sent mid-discard"}'::jsonb,
                 '{"lessonSummary":"sent mid-discard"}'::jsonb
          FROM note_jobs j WHERE j.lesson_session_id = NEW.id LIMIT 1;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
    `);
    await db.orm.execute(sqlRaw`
      CREATE TRIGGER test_note_sent_mid_discard BEFORE UPDATE ON lesson_sessions
      FOR EACH ROW EXECUTE FUNCTION test_note_sent_mid_discard()
    `);
    try {
      const res = await del(lesson.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("status_changed");
      // Nothing committed: the lesson is still live and the job untouched.
      const [row] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, lesson.id));
      expect(row!.status).toBe("submitted");
      expect(row!.audioPath).toBe(lesson.audioPath);
      const [jobRow] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job.id));
      expect(jobRow!.discardedAt).toBeNull();
      expect(jobRow!.failureCode).toBe("thin_note");
      expect((await db.orm.select().from(notes).where(eq(notes.lessonSessionId, lesson.id))).length).toBe(0);
    } finally {
      await db.orm.execute(sqlRaw`DROP TRIGGER test_note_sent_mid_discard ON lesson_sessions`);
    }
  });

  // ── D6: a discarded lesson's queued work cannot still run ───────────────────

  it("terminalizes a live job, and never relabels one that already had a real cause", async () => {
    // The Service Bus message outlives the discard; the worker gates on this
    // status, so this is what stops the run.
    const wedged = await mkLesson();
    const live = await mkJob(wedged.id, { status: "queued", movedAgoMs: 2 * HOUR });
    expect((await del(wedged.id)).status).toBe(200);
    const [liveRow] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, live.id));
    expect(liveRow!.status).toBe("failed");
    expect(liveRow!.failureCode).toBe("lesson_discarded");
    expect(liveRow!.stage).toBeNull();
    expect(liveRow!.discardedAt).not.toBeNull();

    // An ASR failure is a real statistic; the discard must not claim it.
    const failed = await mkLesson();
    const real = await mkJob(failed.id, { status: "failed", failureCode: "asr_error", attempts: 1 });
    expect((await del(failed.id)).status).toBe(200);
    const [realRow] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, real.id));
    expect(realRow!.status).toBe("failed");
    expect(realRow!.failureCode).toBe("asr_error");
    expect(realRow!.discardedAt).not.toBeNull();

    // ready_for_review is an outcome too, not a failure.
    const ready = await mkLesson();
    const done = await mkJob(ready.id, { status: "ready_for_review" });
    expect((await del(ready.id)).status).toBe(200);
    const [doneRow] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, done.id));
    expect(doneRow!.status).toBe("ready_for_review");
    expect(doneRow!.failureCode).toBeNull();
  });

  // ── D5 / D7: audio_path is the sentinel, and Discard-again really retries ────

  it("nulls audio_path on a confirmed delete, keeps it on a failure, and retries on the next tap", async () => {
    const ok = await mkLesson();
    await mkJob(ok.id, { status: "failed", failureCode: "thin_note" });
    expect((await del(ok.id)).status).toBe(200);
    const [okRow] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, ok.id));
    expect(okRow!.audioPath).toBeNull();

    const bad = await mkLesson();
    await mkJob(bad.id, { status: "failed", failureCode: "thin_note" });
    fakeLessons.failNextDelete = true;
    const res = await del(bad.id);
    expect(res.status).toBe(200); // best effort: a blob failure never un-discards
    const [badRow] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, bad.id));
    expect(badRow!.status).toBe("canceled");
    // "canceled AND audio_path IS NOT NULL" is the whole reaper query.
    expect(badRow!.audioPath).toBe(bad.audioPath);
    const audits = await db.orm.select().from(auditEvents).where(eq(auditEvents.subjectId, bad.id));
    expect((audits.find((a) => a.action === "lesson.discard")!.detail as { audioDeleted: boolean }).audioDeleted).toBe(false);

    // The second tap is idempotent for the row and NOT a no-op for the blob.
    expect(fakeLessons.deleted).not.toContain(bad.audioPath);
    expect((await del(bad.id)).status).toBe(200);
    expect(fakeLessons.deleted).toContain(bad.audioPath);
    const [healed] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, bad.id));
    expect(healed!.audioPath).toBeNull();
    // The ledger records that the deletion the first discard promised finally happened.
    const after = await db.orm.select().from(auditEvents).where(eq(auditEvents.subjectId, bad.id));
    expect(after.some((a) => (a.detail as { retriedAudioDelete?: boolean }).retriedAudioDelete === true)).toBe(true);
  });

  // ── C3 anti-drift: discardAllowed and the DELETE guard are one function ──────

  it("discardAllowed on the wire agrees with the DELETE guard on every row of the table", async () => {
    const cases: { name: string; build: () => Promise<string>; allowed: boolean }[] = [
      {
        name: "created, no job",
        allowed: true,
        build: async () => (await mkLesson({ status: "created" })).id,
      },
      {
        name: "canceled (idempotent no-op)",
        allowed: true,
        build: async () => (await mkLesson({ status: "canceled" })).id,
      },
      {
        name: "submitted, no job",
        allowed: true,
        build: async () => (await mkLesson()).id,
      },
      {
        name: "submitted, failed job + draft",
        allowed: true,
        build: async () => {
          const l = await mkLesson({ studentId: mdS.id });
          await mkJob(l.id, { status: "failed", failureCode: "no_speech" });
          await mkNote(l.id, { studentId: mdS.id, status: "draft" });
          return l.id;
        },
      },
      {
        name: "submitted, ready_for_review + draft",
        allowed: true,
        build: async () => {
          const l = await mkLesson({ studentId: mdS.id });
          await mkJob(l.id, { status: "ready_for_review" });
          await mkNote(l.id, { studentId: mdS.id, status: "draft" });
          return l.id;
        },
      },
      {
        name: "submitted, queued and fresh",
        allowed: false,
        build: async () => {
          const l = await mkLesson();
          await mkJob(l.id, { status: "queued", movedAgoMs: 60 * 1000 });
          return l.id;
        },
      },
      {
        name: "submitted, processing past the 60-minute hatch",
        allowed: true,
        build: async () => {
          const l = await mkLesson();
          await mkJob(l.id, { status: "processing", movedAgoMs: 2 * HOUR });
          return l.id;
        },
      },
      {
        name: "a sent teacher note exists",
        allowed: false,
        build: async () => {
          const l = await mkLesson({ studentId: mdS.id });
          await mkJob(l.id, { status: "failed" });
          await mkNote(l.id, { studentId: mdS.id, status: "sent" });
          return l.id;
        },
      },
    ];

    for (const c of cases) {
      const id = await c.build();
      const read = await getOne(id);
      expect(read.status, c.name).toBe(200);
      expect(read.body.lesson.discardAllowed, c.name).toBe(c.allowed);
      const res = await del(id);
      // The flag on the wire IS the answer the route gives. No second implementation.
      expect(res.status === 200, c.name).toBe(c.allowed);
    }
  });

  // ── Retry policy ────────────────────────────────────────────────────────────

  it("caps retries by failure code, and naming the piece buys exactly one more", async () => {
    const lesson = await mkLesson({ studentId: mdS.id });
    await mkJob(lesson.id, { status: "failed", failureCode: "thin_note", attempts: 2 });
    const exhausted = await request(makeApp())
      .post(`/v1/lessons/${lesson.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(exhausted.status).toBe(409);
    expect(exhausted.body.error).toBe("retry_exhausted");
    expect(exhausted.body.message).toContain("as many times as it usefully can");

    // Naming the piece changes the prompt, so it is a genuinely different attempt.
    const edited = await patch(lesson.id, { pieceId: "short_piece" });
    expect(edited.status).toBe(200);
    const allowed = await request(makeApp())
      .post(`/v1/lessons/${lesson.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(allowed.status).toBe(200);
    expect(allowed.body.job.status).toBe("queued");
    expect(allowed.body.job.attempts).toBe(3);
    expect(allowed.body.job.failureCode).toBeNull(); // the code described the LAST failure
    expect(allowed.body.job.startedAt).not.toBe(null);
  });

  // ── D4: what the bonus is allowed to fund ───────────────────────────────────

  it("a student assignment never funds a paid re-run — only the piece does", async () => {
    // The prompt reads the piece and nothing else about the lesson, so a pure
    // reassignment must leave a byte-identical run un-armed.
    const lesson = await mkLesson({ pieceId: "short_piece" });
    await mkJob(lesson.id, { status: "failed", failureCode: "thin_note", attempts: 2 });
    const assigned = await patch(lesson.id, { studentId: mdS.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.job.retryAllowed).toBe(false);
    const denied = await request(makeApp())
      .post(`/v1/lessons/${lesson.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("retry_exhausted");

    // Re-sending the SAME piece is not a change either.
    const same = await patch(lesson.id, { pieceId: "short_piece" });
    expect(same.status).toBe(200);
    expect(same.body.job.retryAllowed).toBe(false);

    // A different piece is.
    const changed = await patch(lesson.id, { pieceId: "seed_piece" });
    expect(changed.body.job.retryAllowed).toBe(true);
  });

  it("no_speech is categorical: cap 0, and no piece edit can resurrect it", async () => {
    // no_speech is raised before the LLM ever runs, so a funded re-run would be a
    // byte-identical paid ASR call the app's own explainer says cannot help.
    const lesson = await mkLesson();
    await mkJob(lesson.id, { status: "failed", failureCode: "no_speech", attempts: 0 });
    const first = await request(makeApp())
      .post(`/v1/lessons/${lesson.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(first.status).toBe(409);
    expect(first.body.error).toBe("retry_exhausted");

    const edited = await patch(lesson.id, { pieceId: "short_piece" });
    expect(edited.status).toBe(200);
    expect(edited.body.job.retryAllowed).toBe(false);
    const stillDenied = await request(makeApp())
      .post(`/v1/lessons/${lesson.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(stillDenied.status).toBe(409);

    // Same for the other categorical code.
    const noAudio = await mkLesson();
    await mkJob(noAudio.id, { status: "failed", failureCode: "no_audio", attempts: 0 });
    await patch(noAudio.id, { pieceId: "short_piece" });
    const na = await request(makeApp())
      .post(`/v1/lessons/${noAudio.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(na.status).toBe(409);
    expect(na.body.error).toBe("retry_exhausted");
  });

  // ── D8: the PATCH answer carries the job it just re-armed ───────────────────

  it("PATCH returns the job so a freshly granted retry is visible without a refetch", async () => {
    const lesson = await mkLesson();
    const job = await mkJob(lesson.id, { status: "failed", failureCode: "thin_note", attempts: 2 });
    const before = await getOne(lesson.id);
    expect(before.body.job.retryAllowed).toBe(false);
    const res = await patch(lesson.id, { pieceId: "short_piece" });
    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(job.id);
    expect(res.body.job.retryAllowed).toBe(true);
    expect(res.body.job.attempts).toBe(2);
    // A lesson with no job at all still answers, with null rather than a missing key.
    const jobless = await mkLesson();
    const noJob = await patch(jobless.id, { pieceLabel: "Anything" });
    expect(noJob.body.job).toBeNull();
  });

  // ── D3: a failed requeue send unwinds completely ────────────────────────────

  it("a queue failure on retry restores the job exactly, bonus included", async () => {
    const lesson = await mkLesson();
    const job = await mkJob(lesson.id, {
      status: "failed",
      failureCode: "thin_note",
      attempts: 2,
      transcriptPath: "transcripts/x.json",
    });
    await db.orm
      .update(noteJobs)
      .set({ stage: "llm", error: "thin_note: too few annotations", failureHints: ["Try naming the piece."] })
      .where(eq(noteJobs.id, job.id));
    // The piece edit is what funds this attempt; a rollback must not eat it.
    await patch(lesson.id, { pieceId: "short_piece" });
    const [armed] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job.id));

    fakeQueue.throwNext = true;
    const res = await request(makeApp())
      .post(`/v1/lessons/${lesson.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("queue_unavailable");
    expect(res.body.message).toContain("try again in a moment");

    const [after] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job.id));
    expect(after!.status).toBe("failed");
    expect(after!.attempts).toBe(2); // NOT charged for an attempt that never ran
    expect(after!.stage).toBe("llm");
    expect(after!.error).toBe("thin_note: too few annotations");
    expect(after!.failureCode).toBe("thin_note");
    expect(after!.failureHints).toEqual(["Try naming the piece."]);
    expect(after!.startedAt!.getTime()).toBe(armed!.startedAt!.getTime());
    expect(after!.updatedAt.getTime()).toBe(armed!.updatedAt.getTime());

    // The bonus survives, so the next tap is still allowed — the sheet's
    // "as many times as it usefully can" would have been a lie otherwise.
    const detail = await getOne(lesson.id);
    expect(detail.body.job.retryAllowed).toBe(true);
    fakeQueue.throwNext = false;
    const second = await request(makeApp())
      .post(`/v1/lessons/${lesson.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(second.status).toBe(200);
  });

  it("no_audio is never retryable and a discarded lesson refuses retry outright", async () => {
    const noAudio = await mkLesson();
    await mkJob(noAudio.id, { status: "failed", failureCode: "no_audio", attempts: 0 });
    const res = await request(makeApp())
      .post(`/v1/lessons/${noAudio.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("retry_exhausted");

    const gone = await mkLesson({ status: "canceled" });
    await mkJob(gone.id, { status: "failed", failureCode: "thin_note" });
    const dead = await request(makeApp())
      .post(`/v1/lessons/${gone.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(dead.status).toBe(409);
    expect(dead.body.error).toBe("lesson_discarded");
  });

  it("a retry re-anchors startedAt so the card does not show the first attempt's age", async () => {
    const lesson = await mkLesson();
    const job = await mkJob(lesson.id, { status: "failed", failureCode: "worker_crash" });
    await db.orm
      .update(noteJobs)
      .set({ startedAt: new Date(Date.now() - 47 * 60 * 1000) })
      .where(eq(noteJobs.id, job.id));
    const res = await request(makeApp())
      .post(`/v1/lessons/${lesson.id}/retry`)
      .set("Authorization", `Bearer ${mdT.token}`)
      .send({});
    expect(res.status).toBe(200);
    const [row] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job.id));
    expect(Date.now() - row!.startedAt!.getTime()).toBeLessThan(60 * 1000);
    expect(row!.createdAt.getTime()).toBeLessThanOrEqual(row!.startedAt!.getTime());
  });

  // ── Wire contract ───────────────────────────────────────────────────────────

  it("list and detail both carry attempts/failureCode/retryAllowed and discardAllowed", async () => {
    const lesson = await mkLesson({ studentId: mdS.id });
    await mkJob(lesson.id, { status: "failed", failureCode: "thin_note", attempts: 2 });

    const list = await request(makeApp()).get("/v1/lessons").set("Authorization", `Bearer ${mdT.token}`);
    const item = list.body.items.find((i: { lesson: { id: string } }) => i.lesson.id === lesson.id);
    expect(item.job.attempts).toBe(2);
    expect(item.job.failureCode).toBe("thin_note");
    expect(item.job.retryAllowed).toBe(false); // thin_note caps at 2
    expect(item.lesson.discardAllowed).toBe(true);

    const detail = await getOne(lesson.id);
    expect(detail.body.job.attempts).toBe(2);
    expect(detail.body.job.failureCode).toBe("thin_note");
    expect(detail.body.job.retryAllowed).toBe(false);
    expect(detail.body.lesson.discardAllowed).toBe(true);
  });

  it("a null failureCode (pre-0016 row) still allows the historical three attempts", async () => {
    const lesson = await mkLesson();
    await mkJob(lesson.id, { status: "failed", failureCode: null, attempts: 2 });
    const detail = await getOne(lesson.id);
    expect(detail.body.job.failureCode).toBeNull();
    expect(detail.body.job.retryAllowed).toBe(true);
  });
});

// ── 6. Notes: teacher flow ──────────────────────────────────────────────────────────

describe("notes: teacher flow", () => {
  it("list and detail are scoped to the owning teacher; non-teachers 403, other teachers 404", async () => {
    const { note } = await seedNote({ teacherId: teacher.id, pieceId: "seed_piece" });
    const list = await request(makeApp()).get("/v1/notes").set("Authorization", `Bearer ${teacher.token}`);
    expect(list.status).toBe(200);
    expect(list.body.items.find((n: { id: string }) => n.id === note.id)).toBeTruthy();

    const detail = await request(makeApp())
      .get(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.annotations.length).toBe(2);

    const noRole = await request(makeApp())
      .get(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${stranger.token}`);
    expect(noRole.status).toBe(403);
    expect(noRole.body.error).toBe("teacher_only");

    const otherTeacher = await makeUser({ oid: "scoping-other-teacher", role: "teacher" });
    const forbidden = await request(makeApp())
      .get(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${otherTeacher.token}`);
    expect(forbidden.status).toBe(404);
  });

  it("PATCH edits annotations by stable id, deletes omitted ones, ignores unsourced new rows, and never lets a client alter a quote", async () => {
    const { note, annotations } = await seedNote({ teacherId: teacher.id, pieceId: "seed_piece" });
    // seedNote inserts >= 2 annotations; keep the first (edited), drop the rest.
    const keepId = annotations[0]!.id;
    const originalQuote = annotations[0]!.quote;
    const droppedId = annotations[1]!.id;

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
            // No id: annotations are worker-authored, so this must be dropped, not created.
            instruction: "Brand new annotation",
            quote: "should never appear",
            category: "other",
            location: { type: "none", grounded: false },
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.note.content.lessonSummary).toBe("Edited summary");
    // Only the kept row survives: the omitted id was deleted, the id-less row ignored.
    expect(res.body.annotations.length).toBe(1);
    expect(res.body.annotations[0].id).toBe(keepId);
    // The kept row's stored quote is untouched by the client payload.
    expect(res.body.annotations[0].quote).toBe(originalQuote);
    expect(res.body.annotations[0].instruction).toBe("Revised instruction");
    expect(res.body.annotations[0].category).toBe("rhythm");
    expect(res.body.annotations[0].location.measureStart).toBe(9);

    // A second PATCH using the (still valid) id keeps the quote — no stale-id nulling.
    const again = await request(makeApp())
      .patch(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ annotations: [{ id: keepId, instruction: "Second edit" }] });
    expect(again.status).toBe(200);
    expect(again.body.annotations[0].quote).toBe(originalQuote);
    expect(again.body.annotations[0].instruction).toBe("Second edit");
    expect(droppedId).toBeDefined();
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

// ── 7b. Narration read path ─────────────────────────────────────────────────────────

describe("notes: narration", () => {
  let narT: TestUser;
  let narS: TestUser;
  let otherS: TestUser; // same teacher, different student
  let otherT: TestUser;
  // The worker asserts these same digests are what it produces for the golden's scripts.
  const goldenHashes = (GOLDEN.wire.response.clips as { textHash: string }[]).map((c) => c.textHash);

  beforeAll(async () => {
    narT = await makeUser({ oid: "nar-teacher", name: "Narration Teacher", role: "teacher" });
    narS = await makeUser({ oid: "nar-student", name: "Narration Student", role: "student" });
    otherS = await makeUser({ oid: "nar-other-student", name: "Other Student", role: "student" });
    otherT = await makeUser({ oid: "nar-other-teacher", name: "Other Teacher", role: "teacher" });
    await linkActive(narT.id, narS.id);
    await linkActive(narT.id, otherS.id);
  });

  // What the worker leaves behind: one manifest row per synthesized clip, plus its blob.
  // The hashes are the golden's own — this route's only job is to hand them back whole.
  async function seedClips(noteId: string, clipIds: string[], voice: "jessica" | "george" = "jessica") {
    for (const [i, clipId] of clipIds.entries()) {
      const blobPath = narrationClipPath(noteId, voice, clipId);
      await db.orm.insert(noteNarrationClips).values({
        noteId,
        annotationId: clipId === "overview" ? null : clipId,
        voice,
        clipId,
        kind: clipId === "overview" ? "overview" : "step",
        blobPath,
        contentHash: `content-${voice}-${clipId}`,
        textHash: goldenHashes[i % goldenHashes.length]!,
        chars: 120,
        bytes: 4096,
        model: "eleven_multilingual_v2",
      });
      fakeAssets.put(blobPath);
    }
  }

  // The path comes from the golden, so the client and this route cannot drift apart:
  // the app builds the same string from the same file.
  function narrationPath(noteId: string, voice?: string) {
    const [path, query] = GOLDEN.wire.endpoint.split("?") as [string, string];
    const base = path.replace("{noteId}", noteId);
    return voice === undefined ? base : `${base}?${query.replace("{voice}", voice)}`;
  }

  function get(noteId: string, token: string, voice?: string) {
    return request(makeApp()).get(narrationPath(noteId, voice)).set("Authorization", `Bearer ${token}`);
  }

  it("returns per-clip signed URLs for the student the note was sent to", async () => {
    const { note, annotations } = await seedNote({
      teacherId: narT.id,
      studentId: narS.id,
      status: "sent",
      sentAt: new Date(),
      pieceId: "seed_piece",
    });
    await seedClips(note.id, ["overview", annotations[0]!.id, annotations[1]!.id]);

    const res = await get(note.id, narS.token, "jessica");
    expect(res.status).toBe(200);
    expect(res.body.voice).toBe("jessica");
    expect(res.body.pending).toEqual([]);
    expect(res.body.clips.map((c: { clipId: string }) => c.clipId)).toEqual([
      "overview",
      annotations[0]!.id,
      annotations[1]!.id,
    ]);
    expect(res.body.clips[0].annotationId).toBeNull();
    expect(res.body.clips[0].kind).toBe("overview");
    expect(res.body.clips[1].annotationId).toBe(annotations[0]!.id);
    expect(res.body.clips[1].kind).toBe("step");
    expect(res.body.clips[0].bytes).toBe(4096);
    // The app re-derives this and refuses to play a clip whose text moved. Handed back
    // WHOLE and from the manifest table — a truncated or re-derived hash is one the app
    // can never match, and every clip would fall silently to the error path.
    expect(res.body.clips[0].textHash).toBe(goldenHashes[0]);
    expect(res.body.clips[0].textHash).toHaveLength(64);
    // Every URL is minted for exactly one blob under this note's prefix.
    expect(fakeAssets.signed).toEqual([
      narrationClipPath(note.id, "jessica", "overview"),
      narrationClipPath(note.id, "jessica", annotations[0]!.id),
      narrationClipPath(note.id, "jessica", annotations[1]!.id),
    ]);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(res.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
  });

  // A silent fallback is indistinguishable from correct behaviour, so the wire is pinned
  // to the sample the iOS decoder is tested against byte-for-byte. If either side renames
  // a field, adds one the other must see, or drops one, this fails here and there.
  it("answers in exactly the shape the iOS client is tested against", async () => {
    const sample = GOLDEN.wire.response as {
      clips: Record<string, unknown>[];
      [k: string]: unknown;
    };
    const { note, annotations } = await seedNote({
      teacherId: narT.id,
      studentId: narS.id,
      status: "sent",
      sentAt: new Date(),
    });
    await seedClips(note.id, [GOLDEN.wire.overviewClipId, annotations[0]!.id]);

    const res = await get(note.id, narS.token, "jessica");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(sample).sort());
    expect(Object.keys(res.body.clips[0]).sort()).toEqual(Object.keys(sample.clips[0]!).sort());
    expect(res.body.voices).toEqual(GOLDEN.wire.voices);
    expect(res.body.clips[0].clipId).toBe(GOLDEN.wire.overviewClipId);
    expect(res.body.clips[0].annotationId).toBeNull();
    // The sample's own clips are the golden's first two scripts, in order.
    expect(res.body.clips.map((c: { textHash: string }) => c.textHash)).toEqual(
      sample.clips.map((c) => c.textHash),
    );
    expect(String(res.body.clips[0].url)).toContain(
      narrationClipPath(note.id, "jessica", GOLDEN.wire.overviewClipId),
    );
    expect(String(sample.clips[0]!.url)).toContain(".mp3?");
  });

  it("names clips that do not exist yet instead of signing a URL that 404s", async () => {
    const { note, annotations } = await seedNote({
      teacherId: narT.id,
      studentId: narS.id,
      status: "sent",
      sentAt: new Date(),
    });
    await seedClips(note.id, ["overview"]);

    const res = await get(note.id, narS.token);
    expect(res.status).toBe(200);
    expect(res.body.clips.length).toBe(1);
    expect(res.body.pending).toEqual([annotations[0]!.id, annotations[1]!.id]);
  });

  it("serves each voice from its own prefix", async () => {
    const { note } = await seedNote({
      teacherId: narT.id,
      studentId: narS.id,
      status: "sent",
      sentAt: new Date(),
      annotations: [],
    });
    await seedClips(note.id, ["overview"], "george");

    const george = await get(note.id, narS.token, "george");
    expect(george.body.clips.length).toBe(1);
    const jessica = await get(note.id, narS.token, "jessica");
    expect(jessica.body.clips.length).toBe(0);
    expect(jessica.body.pending).toEqual(["overview"]);

    const bad = await get(note.id, narS.token, "alexander");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_voice");
  });

  it("never signs a clip left behind by an annotation deleted at review", async () => {
    const { note, annotations } = await seedNote({
      teacherId: narT.id,
      studentId: narS.id,
      status: "sent",
      sentAt: new Date(),
    });
    await seedClips(note.id, ["overview", annotations[0]!.id, annotations[1]!.id]);
    await db.orm.delete(noteAnnotations).where(eq(noteAnnotations.id, annotations[1]!.id));

    const res = await get(note.id, narS.token);
    const ids = res.body.clips.map((c: { clipId: string }) => c.clipId);
    expect(ids).toEqual(["overview", annotations[0]!.id]);
    expect(res.body.pending).toEqual([]);
    // The blob outlives the annotation; nothing may hand it to a client.
    expect(fakeAssets.blobs.has(narrationClipPath(note.id, "jessica", annotations[1]!.id))).toBe(true);
    expect(fakeAssets.signed).not.toContain(narrationClipPath(note.id, "jessica", annotations[1]!.id));
  });

  it("takes the audio with the annotation the teacher deleted at review", async () => {
    const { note, annotations } = await seedNote({ teacherId: narT.id, status: "draft" });
    await seedClips(note.id, ["overview", annotations[0]!.id, annotations[1]!.id]);
    await seedClips(note.id, ["overview", annotations[0]!.id, annotations[1]!.id], "george");

    const res = await request(makeApp())
      .patch(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${narT.token}`)
      .send({ annotations: [{ id: annotations[0]!.id }] });
    expect(res.status).toBe(200);

    // The manifest row cascades with the annotation; without this the audio would sit in
    // the container forever, addressable by nothing.
    for (const voice of ["jessica", "george"] as const) {
      expect(fakeAssets.deleted).toContain(narrationClipPath(note.id, voice, annotations[1]!.id));
      expect(fakeAssets.blobs.has(narrationClipPath(note.id, voice, annotations[0]!.id))).toBe(true);
      expect(fakeAssets.blobs.has(narrationClipPath(note.id, voice, "overview"))).toBe(true);
    }
  });

  it("carries a duplicate's narration across instead of re-buying it", async () => {
    const { note, annotations } = await seedNote({ teacherId: narT.id, status: "draft", pieceId: "seed_piece" });
    await seedClips(note.id, ["overview", annotations[0]!.id, annotations[1]!.id]);

    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/duplicate`)
      .set("Authorization", `Bearer ${narT.token}`);
    expect(res.status).toBe(201);
    const copyId = res.body.id as string;
    const copied = await db.orm
      .select()
      .from(noteAnnotations)
      .where(eq(noteAnnotations.noteId, copyId))
      .orderBy(asc(noteAnnotations.idx));

    // Same words in the same order = the same content hash, which is exactly what makes
    // the worker skip a clip. A group send is N duplicates: without this it is N full
    // vendor runs for audio the account already owns.
    const rows = await db.orm
      .select()
      .from(noteNarrationClips)
      .where(eq(noteNarrationClips.noteId, copyId));
    expect(rows.map((r) => r.clipId).sort()).toEqual(
      ["overview", copied[0]!.id, copied[1]!.id].sort(),
    );
    const overview = rows.find((r) => r.clipId === "overview")!;
    expect(overview.annotationId).toBeNull();
    expect(overview.textHash).toBe(goldenHashes[0]);
    expect(rows.find((r) => r.clipId === copied[0]!.id)!.annotationId).toBe(copied[0]!.id);
    // The copy's audio is where the copy's own signed URL points.
    for (const row of rows) {
      expect(row.blobPath).toBe(narrationClipPath(copyId, "jessica", row.clipId));
      expect(fakeAssets.blobs.has(row.blobPath)).toBe(true);
    }
    expect(fakeAssets.copied.length).toBe(3);

    const manifest = await get(copyId, narT.token, "jessica");
    expect(manifest.status).toBe(200);
    expect(manifest.body.pending).toEqual([]);
  });

  it("a duplicate whose audio cannot be copied is still a duplicate, minus the clip", async () => {
    const { note, annotations } = await seedNote({ teacherId: narT.id, status: "draft", pieceId: "seed_piece" });
    await seedClips(note.id, ["overview", annotations[0]!.id]);
    // The manifest row exists but the blob does not: the copy must not claim audio.
    fakeAssets.blobs.delete(narrationClipPath(note.id, "jessica", "overview"));

    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/duplicate`)
      .set("Authorization", `Bearer ${narT.token}`);
    expect(res.status).toBe(201);
    const rows = await db.orm
      .select()
      .from(noteNarrationClips)
      .where(eq(noteNarrationClips.noteId, res.body.id as string));
    expect(rows.map((r) => r.clipId)).not.toContain("overview");
    const manifest = await get(res.body.id as string, narT.token, "jessica");
    expect(manifest.body.pending).toContain("overview");
  });

  it("refuses another student's narration even inside the same studio", async () => {
    const { note } = await seedNote({
      teacherId: narT.id,
      studentId: narS.id,
      status: "sent",
      sentAt: new Date(),
    });
    await seedClips(note.id, ["overview"]);

    const res = await get(note.id, otherS.token);
    expect(res.status).toBe(404);
    expect(fakeAssets.signed).toEqual([]);
  });

  it("refuses another teacher's note and an unrelated account", async () => {
    const { note } = await seedNote({ teacherId: narT.id, status: "draft" });
    await seedClips(note.id, ["overview"]);

    expect((await get(note.id, otherT.token)).status).toBe(404);
    expect((await get(note.id, stranger.token)).status).toBe(404);
    expect(fakeAssets.signed).toEqual([]);
  });

  it("gives the author draft narration but never the student it is addressed to", async () => {
    const { note } = await seedNote({
      teacherId: narT.id,
      studentId: narS.id,
      status: "draft",
    });
    await seedClips(note.id, ["overview"]);

    const author = await get(note.id, narT.token);
    expect(author.status).toBe(200);
    expect(author.body.clips.length).toBe(1);

    const student = await get(note.id, narS.token);
    expect(student.status).toBe(404);
  });

  it("stops serving a retracted note the student had already read", async () => {
    const { note } = await seedNote({
      teacherId: narT.id,
      studentId: narS.id,
      status: "retracted",
      sentAt: daysAgo(2),
      readAt: daysAgo(1),
      retractedAt: new Date(),
    });
    await seedClips(note.id, ["overview"]);

    expect((await get(note.id, narS.token)).status).toBe(404);
  });

  it("keeps delivered narration after the link is removed, and grants nothing new", async () => {
    const dropS = await makeUser({ oid: "nar-dropped-student", name: "Dropped Student", role: "student" });
    const link = await linkActive(narT.id, dropS.id);
    const delivered = await seedNote({
      teacherId: narT.id,
      studentId: dropS.id,
      status: "sent",
      sentAt: daysAgo(1),
      annotations: [],
    });
    await seedClips(delivered.note.id, ["overview"]);
    await db.orm
      .update(teacherStudentLinks)
      .set({ status: "removed", removedAt: new Date() })
      .where(eq(teacherStudentLinks.id, link.id));

    // Parity with the note text: what was delivered stays readable.
    expect((await get(delivered.note.id, dropS.token)).status).toBe(200);

    // The removed link is not a key to anything else the teacher holds.
    const forOther = await seedNote({
      teacherId: narT.id,
      studentId: narS.id,
      status: "sent",
      sentAt: new Date(),
      annotations: [],
    });
    await seedClips(forOther.note.id, ["overview"]);
    expect((await get(forOther.note.id, dropS.token)).status).toBe(404);

    // And the teacher can no longer send them a new one.
    const fresh = await seedNote({ teacherId: narT.id, status: "draft", pieceId: "seed_piece" });
    const send = await request(makeApp())
      .post(`/v1/notes/${fresh.note.id}/send`)
      .set("Authorization", `Bearer ${narT.token}`)
      .send({ studentId: dropS.id });
    expect(send.status).toBe(400);
    expect(send.body.error).toBe("not_your_student");
  });

  it("locks narration behind the same paywall as the note body", async () => {
    const lapS = await makeUser({ oid: "nar-lapsed", name: "Lapsed Listener", role: "student" });
    await linkActive(narT.id, lapS.id);
    await db.orm.update(users).set({ trialStartedAt: daysAgo(90) }).where(eq(users.id, lapS.id));
    await setMonetization(daysAgo(90).toISOString());
    try {
      const { note } = await seedNote({
        teacherId: narT.id,
        studentId: lapS.id,
        status: "sent",
        sentAt: new Date(),
        annotations: [],
      });
      await seedClips(note.id, ["overview"]);
      const res = await get(note.id, lapS.token);
      expect(res.status).toBe(402);
      expect(res.body.error).toBe("subscription_required");
      expect(fakeAssets.signed).toEqual([]);
    } finally {
      await setMonetization(null);
    }
  });

  it("send enqueues one regeneration job per note and survives a queue outage", async () => {
    const first = await seedNote({ teacherId: narT.id, status: "draft", pieceId: "seed_piece" });
    const ok = await request(makeApp())
      .post(`/v1/notes/${first.note.id}/send`)
      .set("Authorization", `Bearer ${narT.token}`)
      .send({ studentId: narS.id });
    expect(ok.status).toBe(200);
    // ONE message, on the narration lane, in the golden's shape — the worker refuses a
    // body it cannot read rather than guessing which voices to bill for.
    expect(fakeQueue.narrationSent).toEqual([
      { noteId: first.note.id, voices: ["jessica", "george"], reqId: expect.any(String) },
    ]);
    expect(Object.keys(fakeQueue.narrationSent[0]!).sort()).toEqual(
      Object.keys(GOLDEN.wire.message).sort(),
    );
    expect(fakeQueue.sent.filter((m) => m.noteId)).toEqual([]);
    const [audited] = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "note.send"), eq(auditEvents.subjectId, first.note.id)));
    expect((audited!.detail as { narrationQueued: boolean }).narrationQueued).toBe(true);

    fakeQueue.throwNext = true;
    const second = await seedNote({ teacherId: narT.id, status: "draft", pieceId: "seed_piece" });
    const degraded = await request(makeApp())
      .post(`/v1/notes/${second.note.id}/send`)
      .set("Authorization", `Bearer ${narT.token}`)
      .send({ studentId: narS.id });
    expect(degraded.status).toBe(200);
    expect(degraded.body.status).toBe("sent");
    const [failAudit] = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "note.send"), eq(auditEvents.subjectId, second.note.id)));
    expect((failAudit!.detail as { narrationQueued: boolean }).narrationQueued).toBe(false);
  });

  it("purges narration when a solo note is deleted", async () => {
    const solo = await makeUser({ oid: "nar-solo", name: "Solo Player", role: "student" });
    const [lesson] = await db.orm
      .insert(lessonSessions)
      .values({ teacherId: solo.id, studentId: solo.id, ownerRole: "student" })
      .returning();
    const [note] = await db.orm
      .insert(notes)
      .values({
        lessonSessionId: lesson!.id,
        teacherId: solo.id,
        studentId: solo.id,
        origin: "self",
        status: "sent",
        sentAt: new Date(),
        contentOriginal: {},
        content: {},
      })
      .returning();
    await seedClips(note!.id, ["overview"]);
    fakeAssets.put(narrationClipPath(note!.id, "george", "overview"));

    const res = await request(makeApp())
      .delete(`/v1/me/notes/${note!.id}`)
      .set("Authorization", `Bearer ${solo.token}`);
    expect(res.status).toBe(200);
    expect(fakeAssets.deletedPrefixes).toContain(narrationPrefix(note!.id));
    expect(fakeAssets.deleted).toContain(narrationClipPath(note!.id, "jessica", "overview"));
    expect(fakeAssets.deleted).toContain(narrationClipPath(note!.id, "george", "overview"));
    expect([...fakeAssets.blobs.keys()]).toEqual([]);
  });

  it("account deletion purges narration for destroyed notes and keeps it for delivered ones", async () => {
    const leaver = await makeUser({ oid: "nar-leaver", name: "Leaving Teacher", role: "teacher" });
    const kept = await makeUser({ oid: "nar-kept-student", name: "Kept Student", role: "student" });
    await linkActive(leaver.id, kept.id);
    const draft = await seedNote({ teacherId: leaver.id, status: "draft", annotations: [] });
    const sent = await seedNote({
      teacherId: leaver.id,
      studentId: kept.id,
      status: "sent",
      sentAt: daysAgo(1),
      annotations: [],
    });
    await seedClips(draft.note.id, ["overview"]);
    await seedClips(sent.note.id, ["overview"]);

    const res = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${leaver.token}`);
    expect(res.status).toBe(200);
    expect(fakeAssets.deletedPrefixes).toContain(narrationPrefix(draft.note.id));
    expect(fakeAssets.deletedPrefixes).not.toContain(narrationPrefix(sent.note.id));
    // The student's copy is still playable.
    expect((await get(sent.note.id, kept.token)).status).toBe(200);
  });

  it("account deletion purges narration for the notes a student received", async () => {
    const quitter = await makeUser({ oid: "nar-quitting-student", name: "Quitting Student", role: "student" });
    await linkActive(narT.id, quitter.id);
    const { note } = await seedNote({
      teacherId: narT.id,
      studentId: quitter.id,
      status: "sent",
      sentAt: daysAgo(1),
      annotations: [],
    });
    await seedClips(note.id, ["overview"]);

    const res = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${quitter.token}`);
    expect(res.status).toBe(200);
    expect(fakeAssets.deletedPrefixes).toContain(narrationPrefix(note.id));
    expect(fakeAssets.deleted).toContain(narrationClipPath(note.id, "jessica", "overview"));
  });

  it("mints a read-only, single-blob, minutes-long SAS", () => {
    const store = createBlobNotesAssetsStore(
      "DefaultEndpointsProtocol=https;AccountName=stkaraoappdev;AccountKey=" +
        Buffer.from("not-a-real-key").toString("base64") +
        ";EndpointSuffix=core.windows.net",
    );
    const path = narrationClipPath("11111111-2222-3333-4444-555555555555", "jessica", "overview");
    const url = new URL(store.readUrl(path));
    expect(url.pathname).toBe(`/notes-assets/${path}`);
    const q = url.searchParams;
    expect(q.get("sp")).toBe("r"); // read only — no write, no delete, no list
    expect(q.get("sr")).toBe("b"); // one blob, never the container
    expect(q.get("spr")).toBe("https");
    const expiry = new Date(q.get("se")!).getTime();
    expect(expiry).toBeGreaterThan(Date.now());
    expect(expiry).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 1000);
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

describe("account deletion", () => {
  it("scrubs the deleting user, ends links, deletes their private data, and purges audio", async () => {
    // Fresh users so this test doesn't collide with the shared fixtures' links.
    const dt = await makeUser({ oid: "del-teacher", name: "Del Teacher", email: "dt@k.com", role: "teacher" });
    const ds = await makeUser({ oid: "del-student", name: "Del Student", email: "dsx@k.com", role: "student" });
    await sync(ds.token, { notesConsent: true, consentKind: "solo" });
    await sync(ds.token, { notesConsent: true, consentKind: "teacher" });
    await linkActive(dt.id, ds.id);
    const sent = await seedNote({
      teacherId: dt.id, studentId: ds.id, status: "sent", sentAt: new Date(), pieceId: "seed_piece",
    });
    const lessonRes = await request(makeApp())
      .post("/v1/lessons").set("Authorization", `Bearer ${dt.token}`).send({ studentId: ds.id });
    const audioPath = lessonRes.body.lesson.audioPath as string;

    // The STUDENT deletes their account.
    const del = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${ds.token}`);
    expect(del.status).toBe(200);

    const [srow] = await db.orm.select().from(users).where(eq(users.id, ds.id));
    expect(srow!.status).toBe("deleted");
    expect(srow!.email).toBeNull();
    expect(srow!.displayName).toBeNull();
    expect(srow!.entraOid).toBeNull();
    expect(srow!.soloConsentAt).toBeNull();
    expect(srow!.teacherConsentAt).toBeNull();

    // Received note gone; link removed.
    const remaining = await db.orm.select().from(notes).where(eq(notes.id, sent.note.id));
    expect(remaining.length).toBe(0);
    const [link] = await db.orm.select().from(teacherStudentLinks)
      .where(and(eq(teacherStudentLinks.teacherId, dt.id), eq(teacherStudentLinks.studentId, ds.id)));
    expect(link!.status).toBe("removed");

    // The deleted user's token no longer resolves to an active account.
    const reuse = await request(makeApp()).get("/v1/notes").set("Authorization", `Bearer ${ds.token}`);
    expect(reuse.status).toBe(403);

    // TEACHER deletes: lesson + audio purged.
    const delT = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${dt.token}`);
    expect(delT.status).toBe(200);
    expect(fakeLessons.deleted).toContain(audioPath);
    const lessons = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.teacherId, dt.id));
    expect(lessons.length).toBe(0);
  });

  it("delete requires a synced user", async () => {
    const token = await mkToken("never-synced-del", "Ghost");
    const res = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

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

describe("users/sync profile preservation", () => {
  it("a token without email or name claims does not wipe a stored profile", async () => {
    const full = await mkToken("sync-keep-profile", "Ada", "ada@example.com");
    const first = await sync(full, { role: "student" });
    expect(first.status).toBe(200);
    expect(first.body.email).toBe("ada@example.com");
    expect(first.body.displayName).toBe("Ada");

    const bare = await mkToken("sync-keep-profile");
    const second = await sync(bare);
    expect(second.status).toBe(200);
    expect(second.body.email).toBe("ada@example.com");
    expect(second.body.displayName).toBe("Ada");
  });

  it("a later token that carries a changed profile still updates it", async () => {
    const first = await mkToken("sync-update-profile", "Old", "old@example.com");
    await sync(first, { role: "student" });

    const renamed = await mkToken("sync-update-profile", "New", "new@example.com");
    const res = await sync(renamed);
    expect(res.body.email).toBe("new@example.com");
    expect(res.body.displayName).toBe("New");
  });
});
