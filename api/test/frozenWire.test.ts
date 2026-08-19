import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWK } from "jose";
import { createServer } from "../src/server";
import { createJoseVerifier, type AuthVerifier } from "../src/auth";
import { createTestDb } from "./testdb";
import {
  users,
  pieces,
  teacherStudentLinks,
  lessonSessions,
  noteJobs,
  notes,
  noteAnnotations,
  scoreScans,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { ScanStore } from "../src/notes/scans_store";
import {
  assertFrozen,
  frozenAnnotation,
  frozenStudentNote,
  frozenTeacherNote,
  frozenRetractedStub,
  frozenScanDetail,
} from "./frozenWire.contract";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;

const REAL_CONTENT = {
  lessonSummary: "Good sense of line today; the left hand still leads the phrase.",
  practicePlan: [
    { focus: "Right-hand evenness", steps: ["Hands separate at 60", "Add the pedal last"], target: "Four clean runs" },
  ],
};

const REAL_ANNOTATIONS = [
  {
    instruction: "Even out the right-hand sixteenths",
    quote: "these two bars are rushing",
    category: "rhythm",
    location: { type: "absolute", measureStart: 3, measureEnd: 4, grounded: true },
  },
  {
    instruction: "Softer entrance",
    quote: "those two bars",
    category: "musicality",
    location: { type: "deixis", raw: "those two bars", grounded: false },
  },
];

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
    notesAssets: {
      async readJson() {
        return { text: "transcript" };
      },
      readUrl: (p) => `https://fake.blob/notes-assets/${p}?sp=r`,
      async copyAsset() {},
      async deleteAsset() {},
      async deletePrefix() {},
    },
    scans: makeFakeScans(),
  });
}

async function mkToken(oid: string, name: string, email: string): Promise<string> {
  return new SignJWT({ oid, name, email })
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
async function makeUser(oid: string, name: string, email: string, role: "teacher" | "student"): Promise<TestUser> {
  const token = await mkToken(oid, name, email);
  const res = await request(makeApp())
    .post("/v1/users/sync")
    .set("Authorization", `Bearer ${token}`)
    .send({ role, notesConsent: true });
  if (res.status !== 200) throw new Error(`sync failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token, id: res.body.id as string };
}

let teacher: TestUser;
let student: TestUser;

async function seedNote(opts: {
  status?: "draft" | "sent" | "retracted";
  scoreScanId?: string | null;
  pieceId?: string | null;
  pieceLabel?: string | null;
  sentAt?: Date | null;
  readAt?: Date | null;
  retractedAt?: Date | null;
}) {
  const [lesson] = await db.orm
    .insert(lessonSessions)
    .values({ teacherId: teacher.id, studentId: student.id, pieceId: opts.pieceId ?? null })
    .returning();
  const [job] = await db.orm
    .insert(noteJobs)
    .values({ lessonSessionId: lesson!.id, status: "ready_for_review", createdBy: teacher.id })
    .returning();
  const [note] = await db.orm
    .insert(notes)
    .values({
      noteJobId: job!.id,
      lessonSessionId: lesson!.id,
      teacherId: teacher.id,
      studentId: student.id,
      origin: "teacher",
      pieceId: opts.pieceId ?? null,
      pieceLabel: opts.pieceLabel ?? null,
      scoreScanId: opts.scoreScanId ?? null,
      status: opts.status ?? "draft",
      contentOriginal: REAL_CONTENT,
      content: REAL_CONTENT,
      sentAt: opts.sentAt ?? null,
      readAt: opts.readAt ?? null,
      retractedAt: opts.retractedAt ?? null,
    })
    .returning();
  await db.orm.insert(noteAnnotations).values(
    REAL_ANNOTATIONS.map((a, i) => ({
      noteId: note!.id,
      idx: i,
      category: a.category,
      instruction: a.instruction,
      quote: a.quote,
      location: a.location as Record<string, unknown>,
    })),
  );
  return note!;
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
    id: "frozen_piece",
    title: "Practical Method, Op. 599",
    composer: "Carl Czerny",
    rights: "public_domain",
    status: "published",
    publishedVersion: 3,
  });
  teacher = await makeUser("frozen-teacher", "Teacher Tessa", "tessa@frozen.test", "teacher");
  student = await makeUser("frozen-student", "Student Sam", "sam@frozen.test", "student");
  await db.orm
    .insert(teacherStudentLinks)
    .values({ teacherId: teacher.id, studentId: student.id, status: "active", consentAt: new Date() });
});

describe("the frozen wire an installed binary decodes", () => {
  it("holds on the teacher's list and detail", async () => {
    const note = await seedNote({ pieceId: "frozen_piece" });
    const app = makeApp();

    const list = await request(app).get("/v1/notes").set("Authorization", `Bearer ${teacher.token}`);
    expect(list.status).toBe(200);
    const listed = (list.body.items as unknown[]).find(
      (n) => (n as { id: string }).id === note.id,
    );
    assertFrozen(frozenTeacherNote, listed, "GET /v1/notes");

    const detail = await request(app)
      .get(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(detail.status).toBe(200);
    assertFrozen(frozenTeacherNote, detail.body.note, "GET /v1/notes/:id note");
    expect((detail.body.annotations as unknown[]).length).toBeGreaterThan(0);
    for (const [i, a] of (detail.body.annotations as unknown[]).entries()) {
      assertFrozen(frozenAnnotation, a, `GET /v1/notes/:id annotations[${i}]`);
    }
  });

  it("holds across a save, a send and a duplicate", async () => {
    const note = await seedNote({ pieceLabel: "Something typed" });
    const app = makeApp();

    const patched = await request(app)
      .patch(`/v1/notes/${note.id}`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ content: REAL_CONTENT });
    expect(patched.status).toBe(200);
    assertFrozen(frozenTeacherNote, patched.body.note, "PATCH /v1/notes/:id");

    const sent = await request(app)
      .post(`/v1/notes/${note.id}/send`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ studentId: student.id });
    expect(sent.status).toBe(200);
    assertFrozen(frozenTeacherNote, sent.body, "POST /v1/notes/:id/send");

    const copy = await request(app)
      .post(`/v1/notes/${note.id}/duplicate`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(copy.status).toBe(201);
    assertFrozen(frozenTeacherNote, copy.body, "POST /v1/notes/:id/duplicate");
  });

  it("holds on the student's list and detail", async () => {
    const note = await seedNote({ status: "sent", sentAt: new Date(), pieceId: "frozen_piece" });
    const app = makeApp();

    const list = await request(app)
      .get("/v1/me/notes")
      .set("Authorization", `Bearer ${student.token}`);
    expect(list.status).toBe(200);
    const listed = (list.body.items as unknown[]).find((n) => (n as { id: string }).id === note.id);
    expect(listed).toBeTruthy();

    const detail = await request(app)
      .get(`/v1/me/notes/${note.id}`)
      .set("Authorization", `Bearer ${student.token}`);
    expect(detail.status).toBe(200);
    assertFrozen(frozenStudentNote, detail.body.note, "GET /v1/me/notes/:id note");
    expect((detail.body.annotations as unknown[]).length).toBeGreaterThan(0);
    for (const [i, a] of (detail.body.annotations as unknown[]).entries()) {
      assertFrozen(frozenAnnotation, a, `GET /v1/me/notes/:id annotations[${i}]`);
    }
  });

  it("keeps the retracted stub decodable after the student has read the note", async () => {
    const note = await seedNote({
      status: "sent",
      sentAt: new Date(),
      readAt: new Date(),
      pieceId: "frozen_piece",
    });
    await db.orm
      .update(notes)
      .set({ status: "retracted", retractedAt: new Date() })
      .where(eq(notes.id, note.id));

    const res = await request(makeApp())
      .get(`/v1/me/notes/${note.id}`)
      .set("Authorization", `Bearer ${student.token}`);
    expect(res.status).toBe(200);
    assertFrozen(frozenRetractedStub, res.body.note, "GET /v1/me/notes/:id retracted stub");
  });

  it("keeps every field the scan delete dialog reads", async () => {
    const [scan] = await db.orm
      .insert(scoreScans)
      .values({
        ownerId: teacher.id,
        title: "Czerny 599",
        pageCount: 2,
        status: "ready",
        bytes: 4096,
      })
      .returning();
    await db.orm
      .update(scoreScans)
      .set({ blobPath: `${teacher.id}/${scan!.id}/` })
      .where(eq(scoreScans.id, scan!.id));
    const note = await seedNote({ scoreScanId: scan!.id });
    expect(note.scoreScanId).toBe(scan!.id);

    const res = await request(makeApp())
      .get(`/v1/score-scans/${scan!.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(res.status).toBe(200);
    const detail = assertFrozen(frozenScanDetail, res.body, "GET /v1/score-scans/:id");
    expect(detail.usedBy.length).toBeGreaterThan(0);
  });
});

describe("the contract itself", () => {
  it("fails when a frozen field is removed, and passes when an unknown one is added", () => {
    const good = {
      id: "n1",
      noteJobId: "j1",
      lessonSessionId: "l1",
      teacherId: "t1",
      createdAt: "2026-08-18T00:00:00.000Z",
      status: "draft",
      content: REAL_CONTENT,
      pieceId: null,
      pieceLabel: null,
      pieceVersion: null,
      scoreScanId: null,
    };
    expect(() => assertFrozen(frozenTeacherNote, good, "control")).not.toThrow();
    expect(() => assertFrozen(frozenTeacherNote, { ...good, somethingNew: 1 }, "addition")).not.toThrow();

    const { pieceLabel: _dropped, ...missing } = good;
    expect(() => assertFrozen(frozenTeacherNote, missing, "removal")).toThrow(/frozen wire broken/);
    expect(() =>
      assertFrozen(frozenTeacherNote, { ...good, content: { lessonSummary: null, practicePlan: [] } }, "nulled"),
    ).toThrow(/frozen wire broken/);
    expect(() =>
      assertFrozen(
        frozenTeacherNote,
        { ...good, content: { lessonSummary: "s", practicePlan: ["a string, not an item"] } },
        "narrowed",
      ),
    ).toThrow(/frozen wire broken/);
    expect(() => assertFrozen(frozenTeacherNote, { ...good, noteJobId: null }, "nulled id")).toThrow(
      /frozen wire broken/,
    );
  });
});
