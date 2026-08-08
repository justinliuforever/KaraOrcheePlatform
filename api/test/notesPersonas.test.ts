import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
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
  lessonSessions,
  noteJobs,
  notes,
  noteAnnotations,
  platformConfig,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { LessonStore } from "../src/notes/lessons_store";
import type { NotesQueue } from "../src/queue";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;

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
    async sendNarration(body) {
      if (q.throwNext) throw new Error("service bus unavailable");
      q.sent.push(body);
    },
  };
  return q;
}

let fakeLessons: FakeLessons;
let fakeQueue: FakeQueue;

const fakeAssets = {
  deleted: [] as string[],
  deletedPrefixes: [] as string[],
  async readJson() {
    return null;
  },
  readUrl(path: string) {
    return `https://fake.blob/notes-assets/${path}?sig=fake`;
  },
  async copyAsset() {},
  async deleteAsset(path: string) {
    fakeAssets.deleted.push(path);
  },
  async deletePrefix(prefix: string) {
    fakeAssets.deletedPrefixes.push(prefix);
  },
};

function makeApp() {
  return createServer({ db, auth: verifier, lessons: fakeLessons, notesQueue: fakeQueue, notesAssets: fakeAssets });
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
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
}): Promise<TestUser> {
  const token = await mkToken(opts.oid, opts.name, opts.email);
  const body: Record<string, unknown> = {};
  if (opts.role) body.role = opts.role;
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

async function grantRole(userId: string, patch: { isTeacher?: boolean; isStudent?: boolean }) {
  await db.orm.update(users).set(patch).where(eq(users.id, userId));
}

async function setMonetization(iso: string | null) {
  await db.orm.delete(platformConfig).where(eq(platformConfig.key, "monetization_live_at"));
  if (iso) await db.orm.insert(platformConfig).values({ key: "monetization_live_at", value: iso });
}

async function seedNote(opts: {
  teacherId: string;
  studentId?: string | null;
  status?: "draft" | "sent" | "retracted";
  pieceLabel?: string | null;
  sentAt?: Date | null;
}) {
  const [lesson] = await db.orm
    .insert(lessonSessions)
    .values({
      teacherId: opts.teacherId,
      studentId: opts.studentId ?? null,
      pieceLabel: opts.pieceLabel ?? null,
    })
    .returning();
  const [job] = await db.orm
    .insert(noteJobs)
    .values({ lessonSessionId: lesson!.id, status: "ready_for_review", createdBy: opts.teacherId })
    .returning();
  const content = {
    lessonSummary: "Nice sense of line today.",
    practicePlan: ["Hands separate at 60bpm"],
  };
  const [note] = await db.orm
    .insert(notes)
    .values({
      noteJobId: job!.id,
      lessonSessionId: lesson!.id,
      teacherId: opts.teacherId,
      studentId: opts.studentId ?? null,
      pieceLabel: opts.pieceLabel ?? null,
      status: opts.status ?? "draft",
      contentOriginal: content,
      content,
      sentAt: opts.sentAt ?? null,
    })
    .returning();
  const annotations = await db.orm
    .insert(noteAnnotations)
    .values([
      {
        noteId: note!.id,
        idx: 0,
        category: "rhythm",
        instruction: "Even out the right-hand sixteenths",
        quote: "these two bars are rushing",
        location: { type: "absolute", measureStart: 3, measureEnd: 4, grounded: true },
      },
      {
        noteId: note!.id,
        idx: 1,
        category: "dynamics",
        instruction: "Softer entrance",
        quote: "those two bars",
        location: { type: "deixis", raw: "those two bars", grounded: false },
      },
    ])
    .returning();
  return { note: note!, job: job!, lesson: lesson!, annotations };
}

async function seedSelfNote(
  ownerId: string,
  opts: { withAnnotation?: boolean; noteJobId?: string | null; lessonSessionId?: string | null } = {},
) {
  const content = { lessonSummary: "Solo practice reflections.", practicePlan: ["Slow left hand first"] };
  const [note] = await db.orm
    .insert(notes)
    .values({
      noteJobId: opts.noteJobId ?? null,
      lessonSessionId: opts.lessonSessionId ?? null,
      teacherId: ownerId,
      studentId: ownerId,
      origin: "self",
      status: "sent",
      sentAt: new Date(),
      pieceLabel: "Etude self-take",
      contentOriginal: content,
      content,
    })
    .returning();
  let annotation: typeof noteAnnotations.$inferSelect | null = null;
  if (opts.withAnnotation) {
    const [a] = await db.orm
      .insert(noteAnnotations)
      .values({
        noteId: note!.id,
        idx: 0,
        category: "rhythm",
        instruction: "Steady the pulse in bar 2",
        quote: "that bar keeps slipping",
        location: { type: "deixis", raw: "that bar", grounded: false },
      })
      .returning();
    annotation = a!;
  }
  return { note: note!, annotation };
}

function auth(u: TestUser) {
  return `Bearer ${u.token}`;
}

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
});

beforeEach(() => {
  fakeLessons.audio = { bytes: 1000 };
  fakeQueue.throwNext = false;
});

describe("solo lessons", () => {
  let soloS: TestUser;
  let soloT: TestUser;
  let noRole: TestUser;

  beforeAll(async () => {
    soloS = await makeUser({ oid: "np-solo-student", name: "Solo Sofia", role: "student" });
    soloT = await makeUser({ oid: "np-solo-teacher", name: "Solo Teacher Tom", role: "teacher" });
    noRole = await makeUser({ oid: "np-solo-norole", name: "Roleless Rae" });
  });

  it("student create (attested) → 201 with ownerRole student and an uploadUrl", async () => {
    const res = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(soloS))
      .send({ attested: true, pieceLabel: "Burgmüller Arabesque" });
    expect(res.status).toBe(201);
    expect(res.body.lesson.ownerRole).toBe("student");
    expect(res.body.lesson.teacherId).toBe(soloS.id);
    expect(res.body.lesson.studentId).toBeNull();
    expect(res.body.lesson.attested).toBe(true);
    const path = `${soloS.id}/${res.body.lesson.id}.m4a`;
    expect(res.body.lesson.audioPath).toBe(path);
    expect(res.body.uploadUrl).toBe(`https://fake/${path}?sas`);
  });

  it("unattested student create → 400 attestation_required", async () => {
    const res = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(soloS))
      .send({ pieceLabel: "Burgmüller Arabesque" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("attestation_required");
  });

  it("student create with a studentId → 400 solo_lesson_no_student", async () => {
    const res = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(soloS))
      .send({ attested: true, studentId: soloT.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("solo_lesson_no_student");
  });

  it("a user with no Notes role → 403 notes_role_required", async () => {
    const res = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(noRole))
      .send({ attested: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("notes_role_required");
  });

  it("teacher create keeps its shape, now with ownerRole teacher", async () => {
    const res = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(soloT))
      .send({ pieceLabel: "Minuet in G" });
    expect(res.status).toBe(201);
    expect(res.body.lesson.ownerRole).toBe("teacher");
    expect(res.body.lesson.teacherId).toBe(soloT.id);
    expect(res.body.lesson.attested).toBe(false);
    expect(res.body.uploadUrl).toBe(`https://fake/${soloT.id}/${res.body.lesson.id}.m4a?sas`);
  });

  it("GET /v1/lessons?ownerRole filters a dual-role account's lessons", async () => {
    const dual = await makeUser({ oid: "np-solo-dual", name: "Dual Dana", role: "student" });
    await grantRole(dual.id, { isTeacher: true });

    const created = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(dual))
      .send({ pieceLabel: "Teacher-side lesson" });
    expect(created.status).toBe(201);
    expect(created.body.lesson.ownerRole).toBe("teacher");

    const [seeded] = await db.orm
      .insert(lessonSessions)
      .values({ teacherId: dual.id, ownerRole: "student", attested: true, pieceLabel: "Solo take" })
      .returning();

    const studentSide = await request(makeApp())
      .get("/v1/lessons")
      .query({ ownerRole: "student" })
      .set("Authorization", auth(dual));
    expect(studentSide.status).toBe(200);
    expect(studentSide.body.items.length).toBe(1);
    expect(studentSide.body.items[0].lesson.id).toBe(seeded!.id);
    expect(studentSide.body.items[0].lesson.ownerRole).toBe("student");

    const teacherSide = await request(makeApp())
      .get("/v1/lessons")
      .query({ ownerRole: "teacher" })
      .set("Authorization", auth(dual));
    expect(teacherSide.body.items.length).toBe(1);
    expect(teacherSide.body.items[0].lesson.id).toBe(created.body.lesson.id);

    const unfiltered = await request(makeApp()).get("/v1/lessons").set("Authorization", auth(dual));
    expect(unfiltered.body.items.length).toBe(2);

    const bogus = await request(makeApp())
      .get("/v1/lessons")
      .query({ ownerRole: "banana" })
      .set("Authorization", auth(dual));
    expect(bogus.body.items.length).toBe(2);
  });
});

describe("entitlement gates on solo lessons", () => {
  let lapS: TestUser;
  let preLessonId: string;

  beforeAll(async () => {
    await setMonetization(null);
    lapS = await makeUser({ oid: "np-ent-lapsed", name: "Lapsed Lena", role: "student" });
    const pre = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(lapS))
      .send({ attested: true, pieceLabel: "Pre-lapse recording" });
    if (pre.status !== 201) throw new Error(`pre-seed lesson failed: ${pre.status}`);
    preLessonId = pre.body.lesson.id as string;

    await setMonetization(daysAgo(90).toISOString());
    await db.orm.update(users).set({ trialStartedAt: daysAgo(90) }).where(eq(users.id, lapS.id));
  });

  afterAll(async () => {
    await setMonetization(null);
  });

  it("lapsed student create → 402 entitlement_required with the access payload", async () => {
    const res = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(lapS))
      .send({ attested: true });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("entitlement_required");
    expect(res.body.access.status).toBe("lapsed");
    expect(typeof res.body.access.lockedAfter).toBe("string");
  });

  it("lapsed student submit on a pre-lapse lesson → 402 entitlement_required, and the lesson stays submittable", async () => {
    const res = await request(makeApp())
      .post(`/v1/lessons/${preLessonId}/submit`)
      .set("Authorization", auth(lapS))
      .send({});
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("entitlement_required");
    expect(res.body.access.status).toBe("lapsed");

    const [row] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, preLessonId));
    expect(row!.status).toBe("created");
  });

  it("gates are dormant in beta: after reset the same user creates and submits", async () => {
    await setMonetization(null);
    const create = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(lapS))
      .send({ attested: true });
    expect(create.status).toBe(201);
    expect(create.body.lesson.ownerRole).toBe("student");

    const submit = await request(makeApp())
      .post(`/v1/lessons/${preLessonId}/submit`)
      .set("Authorization", auth(lapS))
      .send({});
    expect(submit.status).toBe(200);
    expect(submit.body.lesson.status).toBe("submitted");
    expect(submit.body.job.status).toBe("queued");
  });
});

describe("reverse invites", () => {
  let rvS: TestUser; // solo student, issuer
  let rvT: TestUser; // fresh NO-ROLE redeemer (redeem has no role gate — asserted)
  let linkId: string;

  async function mintReverse(): Promise<{ id: string; code: string; createdAt: string }> {
    const live = await request(makeApp()).get("/v1/invites").set("Authorization", auth(rvS));
    for (const r of live.body as { id: string }[]) {
      await request(makeApp()).delete(`/v1/invites/${r.id}`).set("Authorization", auth(rvS));
    }
    const res = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", auth(rvS))
      .send({ consent: true });
    if (res.status !== 201) throw new Error(`reverse mint failed: ${res.status}`);
    return { id: res.body.id, code: res.body.code, createdAt: res.body.createdAt };
  }

  beforeAll(async () => {
    rvS = await makeUser({ oid: "np-rv-student", name: "Reverse Rhea", role: "student" });
    rvT = await makeUser({ oid: "np-rv-redeemer", name: "Redeemer Rick" });
  });

  it("student mint without consent → 400 consent_required", async () => {
    const res = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", auth(rvS))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("consent_required");
  });

  it("student mint with consent → 201 direction student_to_teacher", async () => {
    const res = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", auth(rvS))
      .send({ consent: true });
    expect(res.status).toBe(201);
    expect(res.body.direction).toBe("student_to_teacher");
    expect(typeof res.body.code).toBe("string");
    expect(res.body.teacherId).toBe(rvS.id); // teacherId = ISSUER on a reverse code
  });

  it("redeem without acceptTeacherRole → 400 teacher_confirm_required", async () => {
    const inv = await mintReverse();
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(rvT))
      .send({ code: inv.code });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("teacher_confirm_required");
  });

  it("redeem with acceptTeacherRole → 201, swapped link, mint-time consent, isTeacher with no trial clock", async () => {
    const [before] = await db.orm.select().from(users).where(eq(users.id, rvT.id));
    expect(before!.isTeacher).toBe(false);
    expect(before!.isStudent).toBe(false);
    expect(before!.trialStartedAt).toBeNull();

    const inv = await mintReverse();
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(rvT))
      .send({ code: inv.code, acceptTeacherRole: true });
    expect(res.status).toBe(201);
    expect(res.body.link.teacherId).toBe(rvT.id);
    expect(res.body.link.studentId).toBe(rvS.id);
    expect(res.body.link.createdVia).toBe("student_invite");
    expect(res.body.link.status).toBe("active");
    expect(res.body.student.id).toBe(rvS.id);
    expect(res.body.student.displayName).toBe("Reverse Rhea");
    expect(res.body.teacher).toBeUndefined();
    linkId = res.body.link.id;

    const [invRow] = await db.orm.select().from(invites).where(eq(invites.id, inv.id));
    expect(new Date(res.body.link.consentAt).getTime()).toBe(invRow!.createdAt.getTime());

    const [after] = await db.orm.select().from(users).where(eq(users.id, rvT.id));
    expect(after!.isTeacher).toBe(true);
    expect(after!.isStudent).toBe(false);
    expect(after!.trialStartedAt).toBeNull();
  });

  it("issuer redeeming their own reverse code → 400 own_code", async () => {
    const inv = await mintReverse();
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(rvS))
      .send({ code: inv.code, acceptTeacherRole: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("own_code");
  });

  it("second redeem for the same pair → 409 already_linked (swapped-key lookup)", async () => {
    const inv = await mintReverse();
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(rvT))
      .send({ code: inv.code, acceptTeacherRole: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_linked");
  });

  it("after removal, a fresh reverse code reactivates the same link row and re-consents at redemption time, never the old departure (MC-4)", async () => {
    const removed = await request(makeApp())
      .delete(`/v1/me/students/${rvS.id}`)
      .set("Authorization", auth(rvT));
    expect(removed.status).toBe(200);
    const [ended] = await db.orm.select().from(teacherStudentLinks).where(eq(teacherStudentLinks.id, linkId));
    const removedAt = ended!.removedAt!;

    const inv = await mintReverse();
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(rvT))
      .send({ code: inv.code, acceptTeacherRole: true });
    expect(res.status).toBe(201);
    expect(res.body.link.id).toBe(linkId); // same row, reactivated
    expect(res.body.link.status).toBe("active");
    expect(res.body.link.removedAt).toBeNull();
    expect(new Date(res.body.link.consentAt).getTime()).toBeGreaterThan(removedAt.getTime());
  });
});

describe("origin scoping (born-sent self-notes)", () => {
  let dual: TestUser; // holds BOTH roles — the hard case for teacher-side leakage
  let selfNoteId: string;

  beforeAll(async () => {
    dual = await makeUser({ oid: "np-origin-dual", name: "Origin Olive", role: "student" });
    await grantRole(dual.id, { isTeacher: true });
    const { note } = await seedSelfNote(dual.id, { withAnnotation: true });
    selfNoteId = note.id;
  });

  it("teacher-side list never shows the self-note, even for its dual-role owner", async () => {
    const res = await request(makeApp()).get("/v1/notes").set("Authorization", auth(dual));
    expect(res.status).toBe(200);
    expect(res.body.items.map((n: { id: string }) => n.id)).not.toContain(selfNoteId);
  });

  it("teacher-side detail/PATCH/duplicate 404 and retract 409 on the self-note", async () => {
    const detail = await request(makeApp())
      .get(`/v1/notes/${selfNoteId}`)
      .set("Authorization", auth(dual));
    expect(detail.status).toBe(404);

    const patch = await request(makeApp())
      .patch(`/v1/notes/${selfNoteId}`)
      .set("Authorization", auth(dual))
      .send({ content: { lessonSummary: "should never land" } });
    expect(patch.status).toBe(404);

    const dup = await request(makeApp())
      .post(`/v1/notes/${selfNoteId}/duplicate`)
      .set("Authorization", auth(dual))
      .send({});
    expect(dup.status).toBe(404);

    const retract = await request(makeApp())
      .post(`/v1/notes/${selfNoteId}/retract`)
      .set("Authorization", auth(dual))
      .send({});
    expect(retract.status).toBe(409);
    expect(retract.body.error).toBe("not_retractable");
  });

  it("student-side list shows it with origin self and teacherName null", async () => {
    const res = await request(makeApp()).get("/v1/me/notes").set("Authorization", auth(dual));
    expect(res.status).toBe(200);
    const item = res.body.items.find((n: { id: string }) => n.id === selfNoteId);
    expect(item).toBeTruthy();
    expect(item.origin).toBe("self");
    expect(item.teacherName).toBeNull();
    expect(item.teacherId).toBe(dual.id); // kept non-null for B1 decode compat
    expect(item.annotationCount).toBe(1);
  });

  it("student-side detail returns teacher.displayName null (MC-6)", async () => {
    const res = await request(makeApp())
      .get(`/v1/me/notes/${selfNoteId}`)
      .set("Authorization", auth(dual));
    expect(res.status).toBe(200);
    expect(res.body.note.origin).toBe("self");
    expect(res.body.teacher.id).toBe(dual.id);
    expect(res.body.teacher.displayName).toBeNull();
    expect(res.body.annotations.length).toBe(1);
  });

  it("read works on a self-note and clears the unread badge", async () => {
    const before = await sync(dual.token);
    expect(before.body.unreadNotes).toBe(1);

    const read = await request(makeApp())
      .post(`/v1/me/notes/${selfNoteId}/read`)
      .set("Authorization", auth(dual))
      .send({});
    expect(read.status).toBe(200);
    expect(read.body.readAt).not.toBeNull();

    const after = await sync(dual.token);
    expect(after.body.unreadNotes).toBe(0);
  });
});

describe("self-note delete", () => {
  let owner: TestUser;
  let other: TestUser;
  let teacherU: TestUser;

  beforeAll(async () => {
    owner = await makeUser({ oid: "np-selfdel-owner", name: "Deleter Dot", role: "student" });
    other = await makeUser({ oid: "np-selfdel-other", name: "Other Ola", role: "student" });
    teacherU = await makeUser({ oid: "np-selfdel-teacher", name: "Selfdel Teacher", role: "teacher" });
  });

  it("deletes an own self-note along with its annotations", async () => {
    const { note, annotation } = await seedSelfNote(owner.id, { withAnnotation: true });
    const res = await request(makeApp())
      .delete(`/v1/me/notes/${note.id}`)
      .set("Authorization", auth(owner));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const noteRows = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(noteRows.length).toBe(0);
    const annRows = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, annotation!.id));
    expect(annRows.length).toBe(0);
  });

  it("takes the model output of the run that wrote it, and leaves the transcript alone", async () => {
    const [lesson] = await db.orm
      .insert(lessonSessions)
      .values({ teacherId: owner.id, ownerRole: "student" })
      .returning();
    const [job] = await db.orm
      .insert(noteJobs)
      .values({
        lessonSessionId: lesson!.id,
        status: "ready_for_review",
        transcriptPath: `transcripts/${lesson!.id}.json`,
        modelOutputPath: `transcripts/model-output/${lesson!.id}.json`,
      })
      .returning();
    const { note } = await seedSelfNote(owner.id, { noteJobId: job!.id, lessonSessionId: lesson!.id });

    const res = await request(makeApp())
      .delete(`/v1/me/notes/${note.id}`)
      .set("Authorization", auth(owner));
    expect(res.status).toBe(200);

    expect(fakeAssets.deleted).toContain(`transcripts/model-output/${lesson!.id}.json`);
    const [row] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, job!.id));
    expect(row!.modelOutputPath).toBeNull();
    expect(fakeAssets.deleted).not.toContain(`transcripts/${lesson!.id}.json`);
    expect(row!.transcriptPath).toBe(`transcripts/${lesson!.id}.json`);
  });

  it("a teacher-origin sent note → 403 self_note_only and survives", async () => {
    const { note } = await seedNote({
      teacherId: teacherU.id,
      studentId: owner.id,
      status: "sent",
      sentAt: new Date(),
      pieceLabel: "Für Elise",
    });
    const res = await request(makeApp())
      .delete(`/v1/me/notes/${note.id}`)
      .set("Authorization", auth(owner));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("self_note_only");

    const rows = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(rows.length).toBe(1);
  });

  it("someone else's self-note → 404", async () => {
    const { note } = await seedSelfNote(other.id);
    const res = await request(makeApp())
      .delete(`/v1/me/notes/${note.id}`)
      .set("Authorization", auth(owner));
    expect(res.status).toBe(404);

    const rows = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(rows.length).toBe(1);
  });
});

describe("account delete (MC-1)", () => {
  it("teacher with a standing sent note deletes FIRST → 200; the student's copy survives with nulled refs", async () => {
    const delT = await makeUser({ oid: "np-macct-teacher", name: "Del Teacher", role: "teacher" });
    const delS = await makeUser({ oid: "np-macct-student", name: "Del Student", role: "student" });
    await linkActive(delT.id, delS.id);
    const sent = await seedNote({
      teacherId: delT.id,
      studentId: delS.id,
      status: "sent",
      sentAt: new Date(),
      pieceLabel: "Sonatina in C",
    });

    const transcriptPath = `transcripts/${sent.job.id}.json`;
    await db.orm.update(noteJobs).set({ transcriptPath }).where(eq(noteJobs.id, sent.job.id));

    const del = await request(makeApp()).delete("/v1/me").set("Authorization", auth(delT));
    expect(del.status).toBe(200);
    expect(fakeAssets.deleted).toContain(transcriptPath);

    const [survivor] = await db.orm.select().from(notes).where(eq(notes.id, sent.note.id));
    expect(survivor).toBeTruthy();
    expect(survivor!.status).toBe("sent");
    expect(survivor!.noteJobId).toBeNull();
    expect(survivor!.lessonSessionId).toBeNull();

    const jobs = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, sent.job.id));
    expect(jobs.length).toBe(0);
    const lessons = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.teacherId, delT.id));
    expect(lessons.length).toBe(0);

    const [trow] = await db.orm.select().from(users).where(eq(users.id, delT.id));
    expect(trow!.status).toBe("deleted");
    expect(trow!.displayName).toBeNull();

    const list = await request(makeApp()).get("/v1/me/notes").set("Authorization", auth(delS));
    const item = list.body.items.find((n: { id: string }) => n.id === sent.note.id);
    expect(item).toBeTruthy();
    expect(item.teacherName).toBeNull();
    const detail = await request(makeApp())
      .get(`/v1/me/notes/${sent.note.id}`)
      .set("Authorization", auth(delS));
    expect(detail.status).toBe(200);
    expect(detail.body.annotations.length).toBe(2);
    expect(detail.body.teacher.displayName).toBeNull();
    expect(detail.body.note.noteJobId).toBe("");
    expect(detail.body.note.lessonSessionId).toBe("");
  });

  it("solo user with self-notes + lessons + jobs deletes → 200, zero strands", async () => {
    const solo = await makeUser({ oid: "np-macct-solo", name: "Solo Sol", role: "student" });

    const created = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(solo))
      .send({ attested: true, pieceLabel: "Czerny 599 No. 12" });
    expect(created.status).toBe(201);
    const lessonId = created.body.lesson.id as string;
    const audioPath = created.body.lesson.audioPath as string;
    const submitted = await request(makeApp())
      .post(`/v1/lessons/${lessonId}/submit`)
      .set("Authorization", auth(solo))
      .send({});
    expect(submitted.status).toBe(200);
    const jobId = submitted.body.job.id as string;
    const { note, annotation } = await seedSelfNote(solo.id, {
      withAnnotation: true,
      noteJobId: jobId,
      lessonSessionId: lessonId,
    });
    const spare = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(solo))
      .send({ attested: true });
    expect(spare.status).toBe(201);

    const soloTranscript = `transcripts/${jobId}.json`;
    const soloModelOutput = `transcripts/model-output/${jobId}.json`;
    await db.orm
      .update(noteJobs)
      .set({ transcriptPath: soloTranscript, modelOutputPath: soloModelOutput })
      .where(eq(noteJobs.id, jobId));

    const del = await request(makeApp()).delete("/v1/me").set("Authorization", auth(solo));
    expect(del.status).toBe(200);
    expect(fakeAssets.deleted).toContain(soloTranscript);
    expect(fakeAssets.deleted).toContain(soloModelOutput);

    expect((await db.orm.select().from(notes).where(eq(notes.teacherId, solo.id))).length).toBe(0);
    expect((await db.orm.select().from(notes).where(eq(notes.studentId, solo.id))).length).toBe(0);
    expect((await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, annotation!.id))).length).toBe(0);
    expect((await db.orm.select().from(noteJobs).where(eq(noteJobs.id, jobId))).length).toBe(0);
    expect((await db.orm.select().from(lessonSessions).where(eq(lessonSessions.teacherId, solo.id))).length).toBe(0);
    expect(fakeLessons.deleted).toContain(audioPath);

    const [row] = await db.orm.select().from(users).where(eq(users.id, solo.id));
    expect(row!.status).toBe("deleted");
    expect(row!.entraOid).toBeNull();
    expect((await db.orm.select().from(notes).where(eq(notes.id, note.id))).length).toBe(0);
  });
});

describe("sync canRecord", () => {
  it("is true for a beta student and a teacher", async () => {
    const s = await makeUser({ oid: "np-sync-student", name: "Sync Sue", role: "student" });
    const sres = await sync(s.token);
    expect(sres.status).toBe(200);
    expect(sres.body.access.status).toBe("beta_free");
    expect(sres.body.canRecord).toBe(true);

    const t = await makeUser({ oid: "np-sync-teacher", name: "Sync Ted", role: "teacher" });
    const tres = await sync(t.token);
    expect(tres.body.access.status).toBe("teacher_free");
    expect(tres.body.canRecord).toBe(true);
  });

  it("is false for a lapsed student under live monetization", async () => {
    const u = await makeUser({ oid: "np-sync-lapsed", name: "Sync Lapsed", role: "student" });
    await db.orm.update(users).set({ trialStartedAt: daysAgo(90) }).where(eq(users.id, u.id));
    await setMonetization(daysAgo(90).toISOString());
    try {
      const res = await sync(u.token);
      expect(res.status).toBe(200);
      expect(res.body.access.status).toBe("lapsed");
      expect(res.body.canRecord).toBe(false);
    } finally {
      await setMonetization(null);
    }
  });
});

describe("review fixes: ownerRole declaration and canceled lessons", () => {
  it("declared student ownerRole beats teacher-wins for a dual-role account; mismatch 400s", async () => {
    const dual = await makeUser({ oid: "np-rf-dual", name: "Dual Dana", role: "teacher" });
    await grantRole(dual.id, { isStudent: true });

    const solo = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(dual))
      .send({ ownerRole: "student", attested: true, pieceLabel: "Hanon 1" });
    expect(solo.status).toBe(201);
    expect(solo.body.lesson.ownerRole).toBe("student");

    const pure = await makeUser({ oid: "np-rf-student", name: "Pure Pia", role: "student" });
    const mismatch = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(pure))
      .send({ ownerRole: "teacher" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe("role_mismatch");

    const derived = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(dual))
      .send({});
    expect(derived.status).toBe(201);
    expect(derived.body.lesson.ownerRole).toBe("teacher");
  });

  it("submit on a canceled lesson → 409 lesson_canceled, never already_submitted", async () => {
    const t = await makeUser({ oid: "np-rf-cancel-t", name: "Cancel Cal", role: "teacher" });
    const created = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(t))
      .send({ clientLessonId: "np-rf-c1" });
    expect(created.status).toBe(201);
    const id = created.body.lesson.id as string;
    const del = await request(makeApp()).delete(`/v1/lessons/${id}`).set("Authorization", auth(t));
    expect(del.status).toBe(200);

    const submit = await request(makeApp())
      .post(`/v1/lessons/${id}/submit`)
      .set("Authorization", auth(t))
      .send({});
    expect(submit.status).toBe(409);
    expect(submit.body.error).toBe("lesson_canceled");
  });

  it("cancel releases the clientLessonId — a re-record with the same local id gets a fresh row", async () => {
    const t = await makeUser({ oid: "np-rf-release-t", name: "Release Rae", role: "teacher" });
    const first = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(t))
      .send({ clientLessonId: "np-rf-r1" });
    expect(first.status).toBe(201);
    const firstId = first.body.lesson.id as string;
    await request(makeApp()).delete(`/v1/lessons/${firstId}`).set("Authorization", auth(t));

    const second = await request(makeApp())
      .post("/v1/lessons")
      .set("Authorization", auth(t))
      .send({ clientLessonId: "np-rf-r1" });
    expect(second.status).toBe(201);
    expect(second.body.lesson.id).not.toBe(firstId);
    expect(second.body.uploadUrl).toBeTruthy();
  });
});
