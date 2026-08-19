import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWK } from "jose";
import { createServer } from "../src/server";
import { createJoseVerifier, type AuthVerifier } from "../src/auth";
import { createTestDb } from "./testdb";
import { pieces, lessonSessions, lessonPieces, scoreScans, teacherStudentLinks } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { ScanStore } from "../src/notes/scans_store";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;

function makeFakeScans(): ScanStore {
  const incomingPrefix = (o: string, s: string) => `incoming/${o}/${s}/`;
  const blobPrefix = (o: string, s: string) => `${o}/${s}/`;
  return {
    incomingPrefix,
    blobPrefix,
    incomingPath: (o, s, n) => `${incomingPrefix(o, s)}${n}.jpg`,
    blobPath: (o, s, n) => `${blobPrefix(o, s)}${n}.jpg`,
    uploadUrl: (p) => `https://fake/score-scans/${p}?write`,
    async pageProps(path) {
      return { bytes: 1024, etag: `etag:${path}` };
    },
    async readHead() {
      return Buffer.from([0xff, 0xd8, 0xff]);
    },
    async promote() {},
    readUrl: (p) => `https://fake/score-scans/${p}?read`,
    async deletePrefix() {},
  };
}

function makeApp() {
  return createServer({
    db,
    auth: verifier,
    lessons: {
      blobPath: (t, l) => `${t}/${l}.m4a`,
      uploadUrl: (p) => `https://fake/${p}?sas`,
      async audioProps() {
        return { bytes: 1000 };
      },
      async deleteAudio() {},
    },
    notesQueue: { async send() {}, async sendNarration() {} },
    scans: makeFakeScans(),
  });
}

async function mkToken(oid: string): Promise<string> {
  return new SignJWT({ oid, name: "Teacher Tess", email: `${oid}@replay.test` })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

interface TestUser {
  token: string;
  id: string;
}
async function makeUser(oid: string, role: "teacher" | "student"): Promise<TestUser> {
  const token = await mkToken(oid);
  const res = await request(makeApp())
    .post("/v1/users/sync")
    .set("Authorization", `Bearer ${token}`)
    .send({ role, notesConsent: true });
  if (res.status !== 200) throw new Error(`sync failed: ${res.status}`);
  return { token, id: res.body.id as string };
}

let teacher: TestUser;
let student: TestUser;

function post(token: string, body: Record<string, unknown>) {
  return request(makeApp()).post("/v1/lessons").set("Authorization", `Bearer ${token}`).send(body);
}

async function rowFor(clientLessonId: string) {
  const [row] = await db.orm
    .select()
    .from(lessonSessions)
    .where(and(
      eq(lessonSessions.teacherId, teacher.id),
      eq(lessonSessions.clientLessonId, clientLessonId),
    ))
    .limit(1);
  return row;
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
  await db.orm.insert(pieces).values({
    id: "replay_piece",
    title: "Practical Method, Op. 599",
    composer: "Carl Czerny",
    rights: "public_domain",
    status: "published",
    publishedVersion: 2,
  });
  teacher = await makeUser("replay-teacher", "teacher");
  student = await makeUser("replay-student", "student");
  await db.orm
    .insert(teacherStudentLinks)
    .values({ teacherId: teacher.id, studentId: student.id, status: "active", consentAt: new Date() });
});

describe("a create the client never heard the answer to", () => {
  it("adopts the piece the first attempt never persisted", async () => {
    const key = "retry-adopts-piece";
    const first = await post(teacher.token, { clientLessonId: key });
    expect(first.status).toBe(201);
    expect(first.body.lesson.pieceId).toBeNull();

    const retry = await post(teacher.token, { clientLessonId: key, pieceId: "replay_piece" });

    expect(retry.status).toBe(200);
    expect(retry.body.lesson.id).toBe(first.body.lesson.id);
    expect(retry.body.lesson.pieceId).toBe("replay_piece");
    expect((await rowFor(key))!.pieceId).toBe("replay_piece");
  });

  it("adopts the student and the typed label together, minting the custom piece", async () => {
    const key = "retry-adopts-student";
    await post(teacher.token, { clientLessonId: key });

    const retry = await post(teacher.token, {
      clientLessonId: key,
      studentId: student.id,
      pieceLabel: "A piece nobody catalogued",
      pieceSource: "typed",
    });

    expect(retry.status).toBe(200);
    expect(retry.body.lesson.studentId).toBe(student.id);
    expect(retry.body.lesson.pieceLabel).toBe("A piece nobody catalogued");
    expect(retry.body.lesson.customPieceId).not.toBeNull();
  });

  it("never overwrites a value the teacher set after the first attempt", async () => {
    const key = "retry-does-not-clobber";
    const first = await post(teacher.token, { clientLessonId: key, pieceLabel: "What they meant" });
    expect(first.body.lesson.pieceLabel).toBe("What they meant");

    const retry = await post(teacher.token, { clientLessonId: key, pieceLabel: "A stale retry" });

    expect(retry.body.lesson.pieceLabel).toBe("What they meant");
  });

  it("refuses to build the piece-plus-scan pair the CHECK forbids", async () => {
    const key = "retry-holds-exclusivity";
    const [scan] = await db.orm
      .insert(scoreScans)
      .values({ ownerId: teacher.id, title: "Photographed", pageCount: 1, status: "ready", bytes: 10 })
      .returning();
    await db.orm
      .update(scoreScans)
      .set({ blobPath: `${teacher.id}/${scan!.id}/` })
      .where(eq(scoreScans.id, scan!.id));
    await post(teacher.token, { clientLessonId: key, scoreScanId: scan!.id });

    const retry = await post(teacher.token, { clientLessonId: key, pieceId: "replay_piece" });

    expect(retry.status).toBe(200);
    expect(retry.body.lesson.scoreScanId).toBe(scan!.id);
    expect(retry.body.lesson.pieceId).toBeNull();
  });

  it("hands back the surviving row when the key collides with a discarded lesson", async () => {
    const key = "retry-after-discard";
    const first = await post(teacher.token, { clientLessonId: key });
    expect(first.status).toBe(201);
    await db.orm
      .update(lessonSessions)
      .set({ status: "canceled" })
      .where(eq(lessonSessions.id, first.body.lesson.id));

    const retry = await post(teacher.token, { clientLessonId: key });

    expect(retry.status).not.toBe(500);
    expect(retry.body.lesson.id).toBe(first.body.lesson.id);
    expect(retry.body.uploadUrl).toBeTruthy();
  });

  it("refuses a student the teacher is not linked to, exactly as a fresh create does", async () => {
    const stranger = await makeUser("replay-stranger", "student");
    const key = "retry-unlinked-student";
    await post(teacher.token, { clientLessonId: key });

    const retry = await post(teacher.token, { clientLessonId: key, studentId: stranger.id });

    expect(retry.status).toBe(400);
    expect(retry.body.error).toBe("not_your_student");
    expect((await rowFor(key))!.studentId).toBeNull();
  });

  it("refuses a piece that does not exist rather than 500ing on the foreign key", async () => {
    const key = "retry-unknown-piece";
    await post(teacher.token, { clientLessonId: key });

    const retry = await post(teacher.token, { clientLessonId: key, pieceId: "no_such_piece" });

    expect(retry.status).toBeLessThan(500);
    expect((await rowFor(key))!.pieceId).toBeNull();
  });

  it("never mints a custom piece from a label it did not adopt", async () => {
    const key = "retry-stale-label";
    await post(teacher.token, { clientLessonId: key, pieceLabel: "The real label" });

    await post(teacher.token, {
      clientLessonId: key,
      pieceLabel: "A stale label",
      pieceSource: "typed",
      studentId: student.id,
    });

    const row = (await rowFor(key))!;
    expect(row.pieceLabel).toBe("The real label");
    expect(row.customPieceId).toBeNull();
  });

  it("mirrors an adopted piece into the lesson's slot", async () => {
    const key = "retry-syncs-slot";
    await post(teacher.token, { clientLessonId: key });

    await post(teacher.token, { clientLessonId: key, pieceId: "replay_piece" });

    const row = (await rowFor(key))!;
    const slots = await db.orm
      .select()
      .from(lessonPieces)
      .where(eq(lessonPieces.lessonSessionId, row.id));
    expect(slots).toHaveLength(1);
    expect(slots[0]!.pieceId).toBe("replay_piece");
  });
});
