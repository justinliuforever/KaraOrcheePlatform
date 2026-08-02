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
  pieces,
  platformConfig,
  entitlements,
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

// ── v0.9: the roster carries the caption's subject ──────────────────────────────

describe("roster payload v2", () => {
  // linkedDaysAgo matters: a pair that started today outranks every note inside it,
  // by design — a new student belongs at the top of the roster on the day they join.
  async function linked(prefix: string, linkedDaysAgo = 0): Promise<{ t: TestUser; s: TestUser }> {
    const t = await makeUser({ oid: `nr-${prefix}-t`, name: `${prefix} Teacher`, role: "teacher" });
    const s = await makeUser({ oid: `nr-${prefix}-s`, name: `${prefix} Student`, role: "student" });
    await db.orm.insert(teacherStudentLinks).values({
      teacherId: t.id,
      studentId: s.id,
      consentAt: new Date(),
      createdAt: daysAgo(linkedDaysAgo),
    });
    return { t, s };
  }

  // seedNote leaves its lesson row undated, and lastLessonAt falls back to the row's
  // created_at — i.e. now. Any test about ordering has to put the lesson in the past
  // too, or "the lesson happened" drowns out the signal under test.
  async function backdateLessons(teacherId: string, at: Date) {
    await db.orm
      .update(lessonSessions)
      .set({ startedAt: at, createdAt: at })
      .where(eq(lessonSessions.teacherId, teacherId));
  }

  function roster(u: TestUser) {
    return request(makeApp()).get("/v1/me/students").set("Authorization", auth(u));
  }

  async function rowFor(t: TestUser, studentId: string) {
    const res = await roster(t);
    expect(res.status).toBe(200);
    return res.body.items.find((i: { studentId: string }) => i.studentId === studentId);
  }

  it("a standing note wins over a newer retracted one", async () => {
    const { t, s } = await linked("v2-standing");
    await seedNote({
      teacherId: t.id, studentId: s.id, status: "sent",
      pieceLabel: "Fur Elise", sentAt: daysAgo(3),
    });
    const later = await seedNote({
      teacherId: t.id, studentId: s.id, status: "retracted",
      pieceLabel: "Minuet in G", sentAt: daysAgo(1),
    });
    await db.orm.update(notes).set({ retractedAt: daysAgo(1) }).where(eq(notes.id, later.note.id));

    const row = await rowFor(t, s.id);
    expect(row.latestNote.pieceTitle).toBe("Fur Elise");
    expect(row.latestNote.status).toBe("sent");
  });

  it("with nothing standing, the retracted note is the subject", async () => {
    const { t, s } = await linked("v2-retracted");
    const only = await seedNote({
      teacherId: t.id, studentId: s.id, status: "retracted",
      pieceLabel: "Arabesque", sentAt: daysAgo(2),
    });
    await db.orm.update(notes).set({ retractedAt: daysAgo(1) }).where(eq(notes.id, only.note.id));

    const row = await rowFor(t, s.id);
    expect(row.latestNote.status).toBe("retracted");
    expect(row.latestNote.retractedAt).not.toBeNull();
  });

  it("a catalog note names its piece even though piece_label is null", async () => {
    const { t, s } = await linked("v2-catalog");
    await db.orm.insert(pieces).values({
      id: "nr-v2-bwv846",
      title: "Prelude in C",
      composer: "J. S. Bach",
    });
    const seeded = await seedNote({
      teacherId: t.id, studentId: s.id, status: "sent",
      pieceLabel: null, sentAt: daysAgo(1),
    });
    await db.orm.update(notes).set({ pieceId: "nr-v2-bwv846" }).where(eq(notes.id, seeded.note.id));

    const row = await rowFor(t, s.id);
    expect(row.latestNote.pieceTitle).toBe("Prelude in C");
  });

  it("the step count describes the latest note, not a lifetime", async () => {
    const { t, s } = await linked("v2-steps");
    const old = await seedNote({
      teacherId: t.id, studentId: s.id, status: "sent",
      pieceLabel: "Old Piece", sentAt: daysAgo(9),
    });
    const oldSteps = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, old.note.id));
    for (const a of oldSteps) {
      await db.orm.update(noteAnnotations).set({ doneAt: daysAgo(8) }).where(eq(noteAnnotations.id, a.id));
    }
    const fresh = await seedNote({
      teacherId: t.id, studentId: s.id, status: "sent",
      pieceLabel: "New Piece", sentAt: daysAgo(1),
    });
    const freshSteps = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, fresh.note.id));
    await db.orm.update(noteAnnotations).set({ doneAt: daysAgo(0) }).where(eq(noteAnnotations.id, freshSteps[0]!.id));

    const row = await rowFor(t, s.id);
    expect(row.latestNote.pieceTitle).toBe("New Piece");
    expect(row.latestNote.stepCount).toBe(2);
    expect(row.latestNote.doneCount).toBe(1);
    // The lifetime pair still ships one more release, and still counts everything.
    expect(row.practicedTotal).toBe(4);
    expect(row.practicedDone).toBe(3);
  });

  it("ticking a step on an OLDER note still moves the student up the roster", async () => {
    const { t, s } = await linked("v2-tick", 60);
    const newestSend = daysAgo(10);
    const tickedAt = daysAgo(1);
    const old = await seedNote({
      teacherId: t.id, studentId: s.id, status: "sent",
      pieceLabel: "Older", sentAt: daysAgo(20),
    });
    await seedNote({
      teacherId: t.id, studentId: s.id, status: "sent",
      pieceLabel: "Newer", sentAt: newestSend,
    });
    await backdateLessons(t.id, daysAgo(20));
    const before = await rowFor(t, s.id);
    expect(new Date(before.lastActivityAt).getTime()).toBe(newestSend.getTime());

    const oldSteps = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, old.note.id));
    await db.orm.update(noteAnnotations).set({ doneAt: tickedAt }).where(eq(noteAnnotations.id, oldSteps[0]!.id));

    const after = await rowFor(t, s.id);
    expect(new Date(after.lastActivityAt).getTime()).toBe(tickedAt.getTime());
    // The caption still belongs to the newest note — only the ordering moved.
    expect(after.latestNote.pieceTitle).toBe("Newer");
  });

  it("a read receipt moves the roster order without a new note", async () => {
    const { t, s } = await linked("v2-read", 60);
    const openedAt = daysAgo(2);
    const seeded = await seedNote({
      teacherId: t.id, studentId: s.id, status: "sent",
      pieceLabel: "Opened", sentAt: daysAgo(6),
    });
    await db.orm.update(notes).set({ readAt: openedAt }).where(eq(notes.id, seeded.note.id));
    await backdateLessons(t.id, daysAgo(6));
    const row = await rowFor(t, s.id);
    expect(new Date(row.lastActivityAt).getTime()).toBe(openedAt.getTime());
    expect(new Date(row.latestNote.readAt).getTime()).toBe(openedAt.getTime());
  });

  // Enforced by the teacher scoping, not by an origin filter: a solo note is authored
  // by the student, so it can never match this teacher's id.
  it("a student's own solo recording stays out of their teacher's roster", async () => {
    const { t, s } = await linked("v2-solo");
    await seedSelfNote(s.id);
    const row = await rowFor(t, s.id);
    expect(row.latestNote).toBeNull();
  });

  it("a brand-new pair reports no note and still sorts by when it started", async () => {
    const { t, s } = await linked("v2-fresh");
    const row = await rowFor(t, s.id);
    expect(row.latestNote).toBeNull();
    expect(row.lastNoteAt).toBeNull();
    expect(row.lastActivityAt).not.toBeNull();
  });
});

describe("a resumed relationship tells the truth about when it started", () => {
  it("linkedAt reports the rejoin and firstLinkedAt keeps the original spell", async () => {
    const t = await makeUser({ oid: "nr-rejoin-t", name: "Rejoin Teacher", role: "teacher" });
    const s = await makeUser({ oid: "nr-rejoin-s", name: "Rejoin Student", role: "student" });
    const firstSpell = daysAgo(400);
    const [link] = await db.orm
      .insert(teacherStudentLinks)
      .values({
        teacherId: t.id,
        studentId: s.id,
        status: "removed",
        removedAt: daysAgo(30),
        createdAt: firstSpell,
        consentAt: firstSpell,
      })
      .returning();

    const made = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", auth(t))
      .send({ rejoinUserId: s.id, intendedLabel: "Rejoin Student" });
    expect(made.status).toBe(201);
    const back = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(s))
      .send({ code: made.body.code, consent: true });
    expect(back.status).toBe(201);

    const detail = await request(makeApp())
      .get(`/v1/me/students/${s.id}`)
      .set("Authorization", auth(t));
    expect(detail.status).toBe(200);
    expect(new Date(detail.body.firstLinkedAt).getTime()).toBe(firstSpell.getTime());
    expect(new Date(detail.body.linkedAt).getTime()).toBeGreaterThan(daysAgo(1).getTime());

    const list = await request(makeApp()).get("/v1/me/students").set("Authorization", auth(t));
    const row = list.body.items.find((i: { studentId: string }) => i.studentId === s.id);
    expect(new Date(row.linkedAt).getTime()).toBeGreaterThan(daysAgo(1).getTime());
    expect(link!.id).toBeTruthy();
  });

  it("a first-time pair has no firstLinkedAt to report", async () => {
    const t = await makeUser({ oid: "nr-firstlink-t", name: "First Teacher", role: "teacher" });
    const s = await makeUser({ oid: "nr-firstlink-s", name: "First Student", role: "student" });
    const made = await request(makeApp()).post("/v1/invites").set("Authorization", auth(t)).send({});
    await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(s))
      .send({ code: made.body.code, consent: true });
    const detail = await request(makeApp())
      .get(`/v1/me/students/${s.id}`)
      .set("Authorization", auth(t));
    expect(detail.body.firstLinkedAt).toBeNull();
  });
});

describe("student detail carries the lessons the history interleaves", () => {
  it("a lesson whose note was never sent still appears", async () => {
    const t = await makeUser({ oid: "nr-hist-t", name: "History Teacher", role: "teacher" });
    const s = await makeUser({ oid: "nr-hist-s", name: "History Student", role: "student" });
    await db.orm.insert(teacherStudentLinks).values({
      teacherId: t.id, studentId: s.id, consentAt: new Date(),
    });
    await seedNote({
      teacherId: t.id, studentId: s.id, status: "sent",
      pieceLabel: "Sonatina", sentAt: daysAgo(4),
    });
    await db.orm.insert(lessonSessions).values({
      teacherId: t.id, studentId: s.id, status: "submitted",
      pieceLabel: "Nothing came of it", startedAt: daysAgo(2), durationSec: 2400,
    });
    await db.orm.insert(lessonSessions).values({
      teacherId: t.id, studentId: s.id, status: "canceled",
      pieceLabel: "Abandoned", startedAt: daysAgo(3),
    });

    const detail = await request(makeApp())
      .get(`/v1/me/students/${s.id}`)
      .set("Authorization", auth(t));
    expect(detail.status).toBe(200);
    const titles = detail.body.lessons.map((l: { pieceTitle: string }) => l.pieceTitle);
    expect(titles).toContain("Nothing came of it");
    expect(titles).not.toContain("Abandoned");
    const orphan = detail.body.lessons.find((l: { pieceTitle: string }) => l.pieceTitle === "Nothing came of it");
    expect(orphan.durationSec).toBe(2400);
    expect(detail.body.notes[0].stepCount).toBe(2);
    expect(detail.body.notes[0].doneCount).toBe(0);
    expect(detail.body.notes[0].pieceTitle).toBe("Sonatina");
  });
});

// ── v0.9: the batched entitlement read, and the wire invariant ──────────────────

describe("canReceiveNotes after the paywall goes live", () => {
  // The batch path (notesAccessMany) and the per-student path must agree. Until
  // monetization_live_at is set every student is beta_free, so this branch — the one
  // that decides whether a teacher can still serve a family — runs for the first
  // time on the day it matters most.
  it("distinguishes an active subscriber, a fresh trial and a lapsed family in one roster", async () => {
    const t = await makeUser({ oid: "nr-money-t", name: "Money Teacher", role: "teacher" });
    const paid = await makeUser({ oid: "nr-money-paid", name: "Paid Pupil", role: "student" });
    const trialing = await makeUser({ oid: "nr-money-trial", name: "Trial Pupil", role: "student" });
    const lapsed = await makeUser({ oid: "nr-money-lapsed", name: "Lapsed Pupil", role: "student" });
    for (const s of [paid, trialing, lapsed]) {
      await db.orm.insert(teacherStudentLinks).values({
        teacherId: t.id, studentId: s.id, consentAt: new Date(),
      });
    }
    await db.orm.update(users).set({ trialStartedAt: daysAgo(400) }).where(eq(users.id, lapsed.id));
    await db.orm.update(users).set({ trialStartedAt: daysAgo(1) }).where(eq(users.id, trialing.id));
    await db.orm.update(users).set({ trialStartedAt: daysAgo(400) }).where(eq(users.id, paid.id));
    await db.orm.insert(entitlements).values({
      userId: paid.id, source: "apple_iap", status: "active", expiresAt: daysAgo(-30),
    });

    await db.orm.delete(platformConfig).where(eq(platformConfig.key, "monetization_live_at"));
    await db.orm
      .insert(platformConfig)
      .values({ key: "monetization_live_at", value: daysAgo(200).toISOString() });
    try {
      const res = await request(makeApp()).get("/v1/me/students").set("Authorization", auth(t));
      expect(res.status).toBe(200);
      const by = new Map(
        res.body.items.map((i: { studentId: string; canReceiveNotes: boolean }) => [i.studentId, i.canReceiveNotes]),
      );
      expect(by.get(paid.id)).toBe(true);
      expect(by.get(trialing.id)).toBe(true);
      expect(by.get(lapsed.id)).toBe(false);
      // Nobody may fall out of the batch and land on the `?? null` default, which
      // would read as "locked" for a student who is perfectly fine.
      expect(by.size).toBe(3);
    } finally {
      await db.orm.delete(platformConfig).where(eq(platformConfig.key, "monetization_live_at"));
    }
  });
});

describe("every new timestamp reaches the wire as ISO-8601", () => {
  // A bare sql<Date> without mapWith ships the Postgres driver's own text, which the
  // app's ISO8601DateFormatter rejects — taking the whole screen down, not one field.
  it("roster and detail timestamps all parse", async () => {
    const t = await makeUser({ oid: "nr-iso-t", name: "Iso Teacher", role: "teacher" });
    const s = await makeUser({ oid: "nr-iso-s", name: "Iso Student", role: "student" });
    await db.orm.insert(teacherStudentLinks).values({
      teacherId: t.id, studentId: s.id, consentAt: new Date(),
    });
    const seeded = await seedNote({
      teacherId: t.id, studentId: s.id, status: "sent",
      pieceLabel: "Iso Piece", sentAt: daysAgo(3),
    });
    await db.orm.update(notes).set({ readAt: daysAgo(2) }).where(eq(notes.id, seeded.note.id));
    await db.orm
      .update(lessonSessions)
      .set({ startedAt: daysAgo(3) })
      .where(eq(lessonSessions.teacherId, t.id));

    const list = await request(makeApp()).get("/v1/me/students").set("Authorization", auth(t));
    const row = list.body.items.find((i: { studentId: string }) => i.studentId === s.id);
    for (const v of [row.lastActivityAt, row.lastNoteAt, row.lastLessonAt, row.linkedAt,
                     row.latestNote.sentAt, row.latestNote.readAt]) {
      expect(v).toMatch(ISO_UTC);
    }

    const detail = await request(makeApp())
      .get(`/v1/me/students/${s.id}`)
      .set("Authorization", auth(t));
    expect(detail.body.lessons[0].startedAt).toMatch(ISO_UTC);
    expect(detail.body.notes[0].sentAt).toMatch(ISO_UTC);
    expect(detail.body.notes[0].readAt).toMatch(ISO_UTC);
    expect(detail.body.linkedAt).toMatch(ISO_UTC);
  });
});

describe("lesson history states a time only when one was recorded", () => {
  it("an undated lesson keeps its place in the order but claims no start time", async () => {
    const t = await makeUser({ oid: "nr-undated-t", name: "Undated Teacher", role: "teacher" });
    const s = await makeUser({ oid: "nr-undated-s", name: "Undated Student", role: "student" });
    await db.orm.insert(teacherStudentLinks).values({
      teacherId: t.id, studentId: s.id, consentAt: new Date(),
    });
    // Never started: the row was born when the upload began, so created_at is when we
    // heard about it. It is still a lesson the teacher recorded — deliberate, present.
    await db.orm.insert(lessonSessions).values({
      teacherId: t.id, studentId: s.id, status: "created",
      pieceLabel: "Never started", createdAt: daysAgo(9),
    });
    await db.orm.insert(lessonSessions).values({
      teacherId: t.id, studentId: s.id, status: "submitted",
      pieceLabel: "Properly dated", startedAt: daysAgo(2), createdAt: daysAgo(2),
    });

    const detail = await request(makeApp())
      .get(`/v1/me/students/${s.id}`)
      .set("Authorization", auth(t));
    const titles = detail.body.lessons.map((l: { pieceTitle: string }) => l.pieceTitle);
    expect(titles).toEqual(["Properly dated", "Never started"]);
    const undated = detail.body.lessons[1];
    expect(undated.startedAt).toBeNull();
  });
});

describe("the join date and the way it happened describe the same event", () => {
  it("a pair that first formed on the teacher's code and re-formed on the student's says so", async () => {
    const t = await makeUser({ oid: "nr-mixed-t", name: "Mixed Teacher", role: "teacher" });
    const s = await makeUser({ oid: "nr-mixed-s", name: "Mixed Student", role: "student" });

    const forward = await request(makeApp()).post("/v1/invites").set("Authorization", auth(t)).send({});
    await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(s))
      .send({ code: forward.body.code, consent: true });
    const first = await request(makeApp()).get(`/v1/me/students/${s.id}`).set("Authorization", auth(t));
    expect(first.body.createdVia).toBe("invite_code");

    await request(makeApp()).delete(`/v1/me/students/${s.id}`).set("Authorization", auth(t));

    // This time the student invites the teacher back in.
    const reverse = await request(makeApp())
      .post("/v1/invites")
      .set("Authorization", auth(s))
      .send({ direction: "student_to_teacher", consent: true });
    const back = await request(makeApp())
      .post("/v1/invites/redeem")
      .set("Authorization", auth(t))
      .send({ code: reverse.body.code, acceptTeacherRole: true });
    expect(back.status).toBe(201);

    const again = await request(makeApp()).get(`/v1/me/students/${s.id}`).set("Authorization", auth(t));
    expect(again.body.status).toBe("active");
    expect(again.body.createdVia).toBe("student_invite");
    expect(again.body.firstLinkedAt).not.toBeNull();
  });
});
