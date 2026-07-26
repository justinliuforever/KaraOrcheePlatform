import { describe, it, expect, beforeAll } from "vitest";
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
  lessonSessions,
  noteJobs,
  notes,
  noteAnnotations,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { LessonStore } from "../src/notes/lessons_store";
import type { NotesQueue } from "../src/queue";

// B1.5 Wave 2 roster/history contracts: students + teachers roster lists, student
// detail, invite code history states, write-once organization, admin trust watch.
// Own PGlite instance (per-file), oids all prefixed "nr-".
const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

// Every timestamp on the wire is ISO-8601 UTC. The iOS client parses dates with
// ISO8601DateFormatter, which rejects Postgres's own text form
// ("2026-07-25 13:38:26.463294+00"); JS `new Date(...)` accepts both, so an
// assertion that only round-trips through Date cannot see the difference.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

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
}
function makeFakeQueue(): FakeQueue {
  const q: FakeQueue = {
    sent: [],
    async send(body) {
      q.sent.push(body);
    },
    async sendNarration(body) {
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
  body?: Record<string, unknown>;
}): Promise<TestUser> {
  const token = await mkToken(opts.oid, opts.name, opts.email);
  const body: Record<string, unknown> = { ...(opts.body ?? {}) };
  if (opts.role) body.role = opts.role;
  const res = await sync(token, body);
  if (res.status !== 200) throw new Error(`sync failed for ${opts.oid}: ${res.status} ${JSON.stringify(res.body)}`);
  return { token, id: res.body.id as string, oid: opts.oid };
}

function auth(u: TestUser) {
  return `Bearer ${u.token}`;
}

// Teacher-origin note the classic way: lesson + job + note (+2 annotations).
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
  await db.orm.insert(noteAnnotations).values([
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
  ]);
  return { note: note!, job: job!, lesson: lesson! };
}

// The worker's born-sent solo output: teacher_id = student_id = owner.
async function seedSelfNote(ownerId: string) {
  const content = { lessonSummary: "Solo practice reflections.", practicePlan: ["Slow left hand first"] };
  const [note] = await db.orm
    .insert(notes)
    .values({
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
  return note!;
}

// Lessons are seeded straight to submitted — the trust watch reads rows, not the
// upload flow.
async function seedSubmittedLesson(
  teacherId: string,
  over: Partial<typeof lessonSessions.$inferInsert> = {},
) {
  const [row] = await db.orm
    .insert(lessonSessions)
    .values({ teacherId, ownerRole: "teacher", status: "submitted", ...over })
    .returning();
  return row!;
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

// ── 1+2. Students roster: list + detail ─────────────────────────────────────────

describe("students roster (teacher side)", () => {
  let t1: TestUser;
  let s1: TestUser; // active link, note + lesson activity
  let s2: TestUser; // removed link, account alive
  let s3: TestUser; // active link, then deletes their account
  const consentDate = new Date("2026-06-01T10:00:00Z");
  let sentAt: Date;

  beforeAll(async () => {
    t1 = await makeUser({ oid: "nr-ros-teacher", name: "Roster Teacher", email: "nr-ros-t@k.com", role: "teacher" });
    s1 = await makeUser({ oid: "nr-ros-active", name: "Active Amy", email: "nr-ros-amy@k.com", role: "student" });
    s2 = await makeUser({ oid: "nr-ros-removed", name: "Removed Rob", email: "nr-ros-rob@k.com", role: "student" });
    s3 = await makeUser({ oid: "nr-ros-deleter", name: "Deleting Dee", email: "nr-ros-dee@k.com", role: "student" });
    await db.orm.insert(teacherStudentLinks).values([
      { teacherId: t1.id, studentId: s1.id, status: "active", consentAt: consentDate },
      { teacherId: t1.id, studentId: s2.id, status: "removed", removedAt: new Date(), consentAt: new Date() },
      { teacherId: t1.id, studentId: s3.id, status: "active", consentAt: new Date() },
    ]);
    sentAt = new Date();
    const { note } = await seedNote({
      teacherId: t1.id,
      studentId: s1.id,
      status: "sent",
      sentAt,
      pieceLabel: "Arabesque",
    });
    await db.orm
      .update(noteAnnotations)
      .set({ doneAt: new Date() })
      .where(and(eq(noteAnnotations.noteId, note.id), eq(noteAnnotations.idx, 0)));
    await seedSubmittedLesson(t1.id, { studentId: s1.id, startedAt: new Date() });
  });

  it("default list: active links only, consent + activity + practice aggregates, never email", async () => {
    const res = await request(makeApp()).get("/v1/me/students").set("Authorization", auth(t1));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { studentId: string }) => i.studentId);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s3.id);
    expect(ids).not.toContain(s2.id);

    const row = res.body.items.find((i: { studentId: string }) => i.studentId === s1.id);
    expect(row.status).toBe("active");
    expect(row.removedAt).toBeNull();
    expect(new Date(row.consentAt).getTime()).toBe(consentDate.getTime());
    expect(row.counterpartDeleted).toBe(false);
    expect(Math.abs(new Date(row.lastNoteAt).getTime() - sentAt.getTime())).toBeLessThan(2000);
    expect(row.lastNoteAt).toMatch(ISO_UTC);
    expect(row.lastLessonAt).toBeTruthy();
    expect(Number.isNaN(new Date(row.lastLessonAt).getTime())).toBe(false);
    expect(row.lastLessonAt).toMatch(ISO_UTC);
    expect(row.linkedAt).toMatch(ISO_UTC);
    expect(row.consentAt).toMatch(ISO_UTC);
    expect(row.practicedTotal).toBe(2);
    expect(row.practicedDone).toBe(1);
    expect(row.canReceiveNotes).toBe(true);

    for (const item of res.body.items) {
      expect(item).not.toHaveProperty("email");
    }
  });

  it("include=removed adds the ended link with status + removedAt", async () => {
    const res = await request(makeApp())
      .get("/v1/me/students")
      .query({ include: "removed" })
      .set("Authorization", auth(t1));
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { studentId: string }) => i.studentId === s2.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe("removed");
    expect(row.removedAt).not.toBeNull();
    expect(row.counterpartDeleted).toBe(false);
    expect(row).not.toHaveProperty("email");
  });

  it("student account deletion: dropped from default, tombstoned under include=removed", async () => {
    const del = await request(makeApp()).delete("/v1/me").set("Authorization", auth(s3));
    expect(del.status).toBe(200);

    const dflt = await request(makeApp()).get("/v1/me/students").set("Authorization", auth(t1));
    expect(dflt.status).toBe(200);
    expect(dflt.body.items.map((i: { studentId: string }) => i.studentId)).not.toContain(s3.id);

    const res = await request(makeApp())
      .get("/v1/me/students")
      .query({ include: "removed" })
      .set("Authorization", auth(t1));
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { studentId: string }) => i.studentId === s3.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe("removed");
    expect(row.counterpartDeleted).toBe(true);
    expect(row.displayName).toBeNull();
    expect(row.canReceiveNotes).toBe(false);
  });

  it("detail: active link carries email + createdVia + consentAt + note timeline", async () => {
    const res = await request(makeApp()).get(`/v1/me/students/${s1.id}`).set("Authorization", auth(t1));
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("nr-ros-amy@k.com");
    expect(res.body.createdVia).toBe("invite_code");
    expect(new Date(res.body.consentAt).getTime()).toBe(consentDate.getTime());
    expect(res.body.status).toBe("active");
    expect(res.body.counterpartDeleted).toBe(false);
    expect(res.body.canReceiveNotes).toBe(true);
    expect(res.body.notes.length).toBe(1);
    expect(res.body.notes[0].status).toBe("sent");
  });

  // A student who leaves withdraws their address with them; the history stays
  // readable so "Invite again" still works.
  it("detail: a removed link is still served, but the email is withdrawn", async () => {
    const res = await request(makeApp()).get(`/v1/me/students/${s2.id}`).set("Authorization", auth(t1));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("removed");
    expect(res.body.removedAt).not.toBeNull();
    expect(res.body.displayName).not.toBeNull();
    expect(res.body.email).toBeNull();
    expect(res.body.counterpartDeleted).toBe(false);
  });

  it("detail: deleted counterpart → email null + counterpartDeleted", async () => {
    const res = await request(makeApp()).get(`/v1/me/students/${s3.id}`).set("Authorization", auth(t1));
    expect(res.status).toBe(200);
    expect(res.body.email).toBeNull();
    expect(res.body.displayName).toBeNull();
    expect(res.body.counterpartDeleted).toBe(true);
    expect(res.body.canReceiveNotes).toBe(false);
  });
});

// ── 3. Teachers roster (student side) ───────────────────────────────────────────

describe("teachers roster (student side)", () => {
  let st: TestUser;
  let ta: TestUser; // active link with note history
  let tb: TestUser; // removed link (past teacher)
  let tc: TestUser; // active link, then deletes their account
  const consentA = new Date("2026-06-05T09:00:00Z");
  let taSentAt: Date;

  beforeAll(async () => {
    st = await makeUser({ oid: "nr-tl-student", name: "Roster Student", email: "nr-tl-s@k.com", role: "student" });
    ta = await makeUser({ oid: "nr-tl-teacher-a", name: "Teacher Ada", email: "nr-tl-a@k.com", role: "teacher" });
    tb = await makeUser({ oid: "nr-tl-teacher-b", name: "Teacher Bea", email: "nr-tl-b@k.com", role: "teacher" });
    tc = await makeUser({ oid: "nr-tl-teacher-c", name: "Teacher Cal", email: "nr-tl-c@k.com", role: "teacher" });
    await db.orm.insert(teacherStudentLinks).values([
      { teacherId: ta.id, studentId: st.id, status: "active", consentAt: consentA },
      { teacherId: tb.id, studentId: st.id, status: "removed", removedAt: new Date(), consentAt: new Date() },
      { teacherId: tc.id, studentId: st.id, status: "active", consentAt: new Date() },
    ]);
    taSentAt = new Date();
    await seedNote({ teacherId: ta.id, studentId: st.id, status: "sent", sentAt: taSentAt });
    await seedNote({ teacherId: ta.id, studentId: st.id, status: "draft" }); // drafts never count
    await seedSelfNote(st.id); // origin='self' must count for no teacher
  });

  it("lists noteCount/lastNoteAt/consentAt; self-notes and drafts don't count; no organization/email", async () => {
    const res = await request(makeApp()).get("/v1/me/teachers").set("Authorization", auth(st));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { teacherId: string }) => i.teacherId);
    expect(ids).toContain(ta.id);
    expect(ids).toContain(tc.id);
    expect(ids).not.toContain(tb.id);
    // The self-note (teacherId = the student) creates no phantom roster row.
    expect(ids).not.toContain(st.id);

    const rowA = res.body.items.find((i: { teacherId: string }) => i.teacherId === ta.id);
    expect(rowA.noteCount).toBe(1); // sent+teacher only: draft and self-note excluded
    expect(Math.abs(new Date(rowA.lastNoteAt).getTime() - taSentAt.getTime())).toBeLessThan(2000);
    expect(rowA.lastNoteAt).toMatch(ISO_UTC);
    expect(rowA.linkedAt).toMatch(ISO_UTC);
    expect(new Date(rowA.consentAt).getTime()).toBe(consentA.getTime());
    expect(rowA.counterpartDeleted).toBe(false);

    const rowC = res.body.items.find((i: { teacherId: string }) => i.teacherId === tc.id);
    expect(rowC.noteCount).toBe(0);
    expect(rowC.lastNoteAt).toBeNull();

    for (const item of res.body.items) {
      expect(item).not.toHaveProperty("organization");
      expect(item).not.toHaveProperty("email");
    }
  });

  it("include=removed brings past teachers", async () => {
    const res = await request(makeApp())
      .get("/v1/me/teachers")
      .query({ include: "removed" })
      .set("Authorization", auth(st));
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { teacherId: string }) => i.teacherId === tb.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe("removed");
    expect(row.removedAt).not.toBeNull();
  });

  it("counterpartDeleted after the teacher deletes their account", async () => {
    const del = await request(makeApp()).delete("/v1/me").set("Authorization", auth(tc));
    expect(del.status).toBe(200);

    // Account delete ends the link, so the tombstone lives under include=removed.
    const dflt = await request(makeApp()).get("/v1/me/teachers").set("Authorization", auth(st));
    expect(dflt.body.items.map((i: { teacherId: string }) => i.teacherId)).not.toContain(tc.id);

    const res = await request(makeApp())
      .get("/v1/me/teachers")
      .query({ include: "removed" })
      .set("Authorization", auth(st));
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { teacherId: string }) => i.teacherId === tc.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe("removed");
    expect(row.counterpartDeleted).toBe(true);
    expect(row.displayName).toBeNull();
  });
});

// ── 4. Invite code history ──────────────────────────────────────────────────────

describe("invite code history", () => {
  let ti: TestUser;
  let sr: TestUser; // living redeemer
  let sd: TestUser; // redeemer who then deletes their account
  let liveInv: { id: string; code: string };
  let revokedInv: { id: string };
  let usedInv: { id: string };
  let delInv: { id: string };
  let expiredInv: { id: string };

  async function mint(): Promise<{ id: string; code: string }> {
    const res = await request(makeApp()).post("/v1/invites").set("Authorization", auth(ti)).send({});
    if (res.status !== 201) throw new Error(`mint failed: ${res.status}`);
    return { id: res.body.id, code: res.body.code };
  }
  async function redeem(u: TestUser, code: string) {
    const res = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(u))
      .send({ code, consent: true });
    if (res.status !== 201) throw new Error(`redeem failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  beforeAll(async () => {
    ti = await makeUser({ oid: "nr-inv-teacher", name: "Invite Teacher", email: "nr-inv-t@k.com", role: "teacher" });
    sr = await makeUser({ oid: "nr-inv-redeemer", name: "Redeemer Renee", role: "student" });
    sd = await makeUser({ oid: "nr-inv-redeemer-del", name: "Redeemer Dana", role: "student" });

    // One live code per issuer per direction, so each code must leave the live set
    // (revoked / spent / expired) before the next mint. The live one comes last.
    revokedInv = await mint();
    const rev = await request(makeApp()).delete(`/v1/invites/${revokedInv.id}`).set("Authorization", auth(ti));
    if (rev.status !== 200) throw new Error(`revoke failed: ${rev.status}`);
    const used = await mint();
    usedInv = used;
    await redeem(sr, used.code);
    const del = await mint();
    delInv = del;
    await redeem(sd, del.code);
    const gone = await request(makeApp()).delete("/v1/me").set("Authorization", auth(sd));
    if (gone.status !== 200) throw new Error(`account delete failed: ${gone.status}`);
    expiredInv = await mint();
    await db.orm.update(invites).set({ expiresAt: daysAgo(1) }).where(eq(invites.id, expiredInv.id));
    liveInv = await mint();
  });

  it("default GET /v1/invites is unchanged: live only, raw B1 rows with no state key", async () => {
    const res = await request(makeApp()).get("/v1/invites").set("Authorization", auth(ti));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(liveInv.id);
    expect(res.body[0].code).toBe(liveInv.code);
    expect(res.body[0]).not.toHaveProperty("state");
    expect(res.body[0]).not.toHaveProperty("redeemers");
  });

  it("include=history derives revoked/used/expired/active states", async () => {
    const res = await request(makeApp())
      .get("/v1/invites")
      .query({ include: "history" })
      .set("Authorization", auth(ti));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(5);
    const byId = new Map(res.body.map((r: { id: string }) => [r.id, r])) as Map<
      string,
      { state: string; redeemers: { userId: string; displayName: string | null; deleted: boolean }[] }
    >;
    expect(byId.get(liveInv.id)!.state).toBe("active");
    expect(byId.get(revokedInv.id)!.state).toBe("revoked");
    expect(byId.get(usedInv.id)!.state).toBe("used");
    expect(byId.get(delInv.id)!.state).toBe("used");
    expect(byId.get(expiredInv.id)!.state).toBe("expired");
    expect(byId.get(liveInv.id)!.redeemers).toEqual([]);
  });

  it("redeemers resolve to displayName; a deleted redeemer reads deleted:true with null name", async () => {
    const res = await request(makeApp())
      .get("/v1/invites")
      .query({ include: "history" })
      .set("Authorization", auth(ti));
    const rows = res.body as { id: string; redeemers: { userId: string; displayName: string | null; deleted: boolean }[] }[];

    const used = rows.find((r) => r.id === usedInv.id)!;
    expect(used.redeemers).toEqual([{ userId: sr.id, displayName: "Redeemer Renee", deleted: false }]);

    const del = rows.find((r) => r.id === delInv.id)!;
    expect(del.redeemers.length).toBe(1);
    expect(del.redeemers[0]!.userId).toBe(sd.id);
    expect(del.redeemers[0]!.displayName).toBeNull();
    expect(del.redeemers[0]!.deleted).toBe(true);
  });
});

// ── 5. Organization (write-once, admin-only surface) ────────────────────────────

describe("organization", () => {
  let orgT: TestUser;
  let orgS: TestUser;

  beforeAll(async () => {
    orgT = await makeUser({
      oid: "nr-org-teacher",
      name: "Org Olga",
      email: "nr-org-t@k.com",
      role: "teacher",
      body: { organization: "Riverside Piano Studio" },
    });
    orgS = await makeUser({ oid: "nr-org-student", name: "Org Student", role: "student" });
    await db.orm
      .insert(teacherStudentLinks)
      .values({ teacherId: orgT.id, studentId: orgS.id, status: "active", consentAt: new Date() });
  });

  it("sign-up sync sets it once; a later different value never overwrites", async () => {
    const [row] = await db.orm.select().from(users).where(eq(users.id, orgT.id));
    expect(row!.organization).toBe("Riverside Piano Studio");

    const again = await sync(orgT.token, { organization: "Hostile Takeover Conservatory" });
    expect(again.status).toBe(200);
    expect(again.body.organization).toBe("Riverside Piano Studio");
    const [after] = await db.orm.select().from(users).where(eq(users.id, orgT.id));
    expect(after!.organization).toBe("Riverside Piano Studio");
  });

  it("non-string and blank values are ignored; the first real value still lands later", async () => {
    const u = await makeUser({ oid: "nr-org-junk", name: "Junk Org", role: "teacher", body: { organization: 42 } });
    let [row] = await db.orm.select().from(users).where(eq(users.id, u.id));
    expect(row!.organization).toBeNull();

    await sync(u.token, { organization: "   " });
    [row] = await db.orm.select().from(users).where(eq(users.id, u.id));
    expect(row!.organization).toBeNull();

    await sync(u.token, { organization: "Real Studio" });
    [row] = await db.orm.select().from(users).where(eq(users.id, u.id));
    expect(row!.organization).toBe("Real Studio");
  });

  it("appears nowhere in /v1/me/teachers payloads", async () => {
    const res = await request(makeApp()).get("/v1/me/teachers").set("Authorization", auth(orgS));
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { teacherId: string }) => i.teacherId === orgT.id);
    expect(row).toBeTruthy();
    for (const item of res.body.items) {
      expect(item).not.toHaveProperty("organization");
      expect(item).not.toHaveProperty("email");
    }
  });

  it("account delete scrubs it to null", async () => {
    const del = await request(makeApp()).delete("/v1/me").set("Authorization", auth(orgT));
    expect(del.status).toBe(200);
    const [row] = await db.orm.select().from(users).where(eq(users.id, orgT.id));
    expect(row!.status).toBe("deleted");
    expect(row!.organization).toBeNull();
  });
});

// ── 6. Admin trust watch ────────────────────────────────────────────────────────

describe("admin trust watch", () => {
  let adminToken: string;
  let tw1: TestUser; // qualifies: submitted teacher lessons, zero reach
  let tw2: TestUser; // excluded: active link
  let tw3: TestUser; // excluded: one lifetime sent note
  let tw4: TestUser; // excluded: minted a teacher_to_student code in-window
  let sw: TestUser; // student — solo submitted lesson never qualifies

  beforeAll(async () => {
    await db.orm
      .insert(users)
      .values({ entraOid: "nr-admin-oid", email: "nr-admin@k.com", displayName: "NR Admin", isAdmin: true });
    adminToken = await mkToken("nr-admin-oid");

    tw1 = await makeUser({ oid: "nr-tw-flagged", name: "Watch Wanda", email: "nr-tw-1@k.com", role: "teacher" });
    tw2 = await makeUser({ oid: "nr-tw-linked", name: "Linked Lars", email: "nr-tw-2@k.com", role: "teacher" });
    tw3 = await makeUser({ oid: "nr-tw-sender", name: "Sender Sam", email: "nr-tw-3@k.com", role: "teacher" });
    tw4 = await makeUser({ oid: "nr-tw-inviter", name: "Inviter Ivy", email: "nr-tw-4@k.com", role: "teacher" });
    sw = await makeUser({ oid: "nr-tw-solo", name: "Solo Stu", email: "nr-tw-s@k.com", role: "student" });

    await seedSubmittedLesson(tw1.id);

    await seedSubmittedLesson(tw2.id);
    await db.orm
      .insert(teacherStudentLinks)
      .values({ teacherId: tw2.id, studentId: sw.id, status: "active", consentAt: new Date() });

    await seedSubmittedLesson(tw3.id);
    // Retracted counts as a lifetime send — "one send exits forever" survives a
    // later retraction (PLAT-1: status IN sent, retracted).
    await seedNote({ teacherId: tw3.id, studentId: sw.id, status: "retracted", sentAt: new Date() });

    await seedSubmittedLesson(tw4.id);
    const mint = await request(makeApp()).post("/v1/invites").set("Authorization", auth(tw4)).send({});
    if (mint.status !== 201) throw new Error(`invite mint failed: ${mint.status}`);

    await db.orm
      .insert(lessonSessions)
      .values({ teacherId: sw.id, ownerRole: "student", attested: true, status: "submitted" });
  });

  it("non-admin caller → 403", async () => {
    const res = await request(makeApp()).get("/admin/notes/trust/watch").set("Authorization", auth(tw1));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("lists the zero-reach teacher; link / lifetime send / invite mint / solo lesson each delist", async () => {
    const res = await request(makeApp())
      .get("/admin/notes/trust/watch")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(28);

    const ids = res.body.items.map((i: { userId: string }) => i.userId);
    expect(ids).toContain(tw1.id);
    expect(ids).not.toContain(tw2.id); // active link delists
    expect(ids).not.toContain(tw3.id); // ONE lifetime sent note delists
    expect(ids).not.toContain(tw4.id); // in-window teacher_to_student mint delists
    expect(ids).not.toContain(sw.id); // student-owned solo lesson never qualifies

    const row = res.body.items.find((i: { userId: string }) => i.userId === tw1.id);
    expect(row.email).toBe("nr-tw-1@k.com");
    expect(row.displayName).toBe("Watch Wanda");
    expect(row.lessons28d).toBe(1);
    expect(row.highVolume).toBe(false);
  });

  it("8 in-window submitted lessons: still listed; lessons28d counts in-window only, highVolume fires", async () => {
    for (let i = 0; i < 7; i++) await seedSubmittedLesson(tw1.id);
    await seedSubmittedLesson(tw1.id, { createdAt: daysAgo(35) }); // out-of-window, must never count

    const res = await request(makeApp())
      .get("/admin/notes/trust/watch")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { userId: string }) => i.userId === tw1.id);
    expect(row).toBeTruthy();
    expect(row.lessons28d).toBe(8);
    expect(row.highVolume).toBe(true);
  });
});
