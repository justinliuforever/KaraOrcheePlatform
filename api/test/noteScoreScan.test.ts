import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
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
  lessonSessions,
  noteJobs,
  notes,
  noteAnnotations,
  platformConfig,
  scoreScans,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { ScanStore } from "../src/notes/scans_store";
import type { LessonStore } from "../src/notes/lessons_store";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

const STUDENT_NOTE_WIRE_KEYS = [
  "content", "contentOriginal", "createdAt", "editedAt", "hasScorePhotos", "id", "lessonSessionId",
  "noteJobId", "origin", "pieceId", "pieceLabel", "pieceVersion", "readAt", "retractedAt",
  "scoreGone", "scorePageCount", "sentAt", "status", "studentId", "supersededBy", "teacherId",
  "updatedAt",
];

const NOTES_API_NOTE_NON_OPTIONALS = [
  "id", "noteJobId", "lessonSessionId", "teacherId", "status", "content", "createdAt",
];

const INBOX_NOTE_WIRE_KEYS = [
  "annotationCount", "doneCount", "id", "locked", "origin", "pieceId", "pieceLabel", "pieceVersion",
  "readAt", "sentAt", "status", "teacherId", "teacherName",
];

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt8(0xff, 0);
  header.writeUInt8(marker, 1);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

const JPEG_HEAD = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  segment(
    0xe0,
    Buffer.concat([Buffer.from("JFIF\0"), Buffer.from([0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])]),
  ),
  Buffer.from([0xff, 0xda, 0x00, 0x0c]),
]);

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;
let logged: string[];

interface FakeScans extends ScanStore {
  deletedPrefixes: string[];
}

function makeFakeScans(): FakeScans {
  const incomingPrefix = (ownerId: string, scanId: string) => `incoming/${ownerId}/${scanId}/`;
  const blobPrefix = (ownerId: string, scanId: string) => `${ownerId}/${scanId}/`;
  const f: FakeScans = {
    deletedPrefixes: [],
    incomingPrefix,
    blobPrefix,
    incomingPath: (o, s, n) => `${incomingPrefix(o, s)}${n}.jpg`,
    blobPath: (o, s, n) => `${blobPrefix(o, s)}${n}.jpg`,
    uploadUrl: (p) => `https://fake/score-scans/${p}?write`,
    async pageProps(path) {
      return { bytes: 1024, etag: `etag:${path}` };
    },
    async readHead() {
      return JPEG_HEAD;
    },
    async promote() {},
    readUrl: (p) => `https://fake/score-scans/${p}?read`,
    async deletePrefix(prefix) {
      if (!prefix.endsWith("/")) throw new Error("deletePrefix requires a trailing slash");
      f.deletedPrefixes.push(prefix);
    },
  };
  return f;
}

let scans: FakeScans;

function makeFakeLessons(): LessonStore {
  return {
    blobPath: (t, l) => `${t}/${l}.m4a`,
    uploadUrl: (p) => `https://fake/lesson-audio/${p}?write`,
    async audioProps() {
      return { bytes: 1000 };
    },
    async deleteAudio() {},
  };
}

function makeApp() {
  return createServer({ db, auth: verifier, scans, lessons: makeFakeLessons() });
}

function makeAppWithoutScans() {
  return createServer({ db, auth: verifier });
}

const keys = (o: unknown) => Object.keys(o as object).sort();

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

interface TestUser {
  token: string;
  id: string;
}

async function makeUser(oid: string, role: "teacher" | "student"): Promise<TestUser> {
  const token = await new SignJWT({ oid, name: oid })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  const res = await request(makeApp())
    .post("/v1/users/sync")
    .set("Authorization", `Bearer ${token}`)
    .send({ role });
  expect(res.status).toBe(200);
  return { token, id: res.body.id as string };
}

async function linkActive(teacherId: string, studentId: string) {
  await db.orm
    .insert(teacherStudentLinks)
    .values({ teacherId, studentId, status: "active", consentAt: new Date() })
    .onConflictDoUpdate({
      target: [teacherStudentLinks.teacherId, teacherStudentLinks.studentId],
      set: { status: "active", removedAt: null },
    });
}

async function setMonetization(iso: string | null) {
  await db.orm.delete(platformConfig).where(eq(platformConfig.key, "monetization_live_at"));
  if (iso) await db.orm.insert(platformConfig).values({ key: "monetization_live_at", value: iso });
}

async function lapse(userId: string) {
  await db.orm.update(users).set({ trialStartedAt: daysAgo(200) }).where(eq(users.id, userId));
  await setMonetization(daysAgo(200).toISOString());
}

async function seedScan(opts: {
  ownerId: string;
  pageCount?: number;
  status?: "created" | "ready" | "taken_down";
  blobPath?: string | null;
}) {
  const status = opts.status ?? "ready";
  const [row] = await db.orm
    .insert(scoreScans)
    .values({
      ownerId: opts.ownerId,
      title: "Czerny 599",
      pageCount: opts.pageCount ?? 3,
      status,
      blobPath: null,
      bytes: status === "ready" ? 4096 : null,
    })
    .returning();
  const blobPath = "blobPath" in opts
    ? opts.blobPath
    : status === "ready"
      ? `${opts.ownerId}/${row!.id}/`
      : null;
  const [updated] = await db.orm
    .update(scoreScans)
    .set({ blobPath })
    .where(eq(scoreScans.id, row!.id))
    .returning();
  return updated!;
}

async function seedNote(opts: {
  teacherId: string;
  studentId?: string | null;
  origin?: "teacher" | "self";
  status?: "draft" | "sent" | "retracted";
  scoreScanId?: string | null;
  scoreScanDetachedAt?: Date | null;
  pieceId?: string | null;
  pieceLabel?: string | null;
  sentAt?: Date | null;
  readAt?: Date | null;
  retractedAt?: Date | null;
}) {
  const [lesson] = await db.orm
    .insert(lessonSessions)
    .values({ teacherId: opts.teacherId, studentId: opts.studentId ?? null })
    .returning();
  const [job] = await db.orm
    .insert(noteJobs)
    .values({ lessonSessionId: lesson!.id, status: "ready_for_review", createdBy: opts.teacherId })
    .returning();
  const content = {
    lessonSummary: "Nice sense of line today.",
    practicePlan: ["Hands separate at 60bpm"],
  };
  const status = opts.status ?? "draft";
  const [note] = await db.orm
    .insert(notes)
    .values({
      noteJobId: job!.id,
      lessonSessionId: lesson!.id,
      teacherId: opts.teacherId,
      studentId: opts.studentId ?? null,
      origin: opts.origin ?? "teacher",
      status,
      pieceId: opts.pieceId ?? null,
      pieceLabel: opts.pieceLabel ?? "Minuet in G",
      scoreScanId: opts.scoreScanId ?? null,
      scoreScanDetachedAt: opts.scoreScanDetachedAt ?? null,
      contentOriginal: content,
      content,
      sentAt: opts.sentAt ?? (status === "draft" ? null : new Date()),
      readAt: opts.readAt ?? null,
      retractedAt: opts.retractedAt ?? null,
    })
    .returning();
  await db.orm.insert(noteAnnotations).values({
    noteId: note!.id,
    idx: 0,
    category: "rhythm",
    instruction: "Even out the right-hand sixteenths",
    quote: "these two bars are rushing",
    location: { type: "absolute", measureStart: 3, measureEnd: 4, grounded: true },
  });
  return note!;
}

async function refs(noteId: string) {
  const [row] = await db.orm
    .select({
      scanId: notes.scoreScanId,
      detachedAt: notes.scoreScanDetachedAt,
      pieceId: notes.pieceId,
      status: notes.status,
      studentId: notes.studentId,
      readAt: notes.readAt,
      content: notes.content,
    })
    .from(notes)
    .where(eq(notes.id, noteId));
  return row!;
}

async function refusalMessageChain(op: () => Promise<unknown>): Promise<string> {
  try {
    await op();
    return "";
  } catch (err) {
    const parts: string[] = [];
    let cur: unknown = err;
    for (let i = 0; i < 5 && cur; i++) {
      const e = cur as { message?: string; cause?: unknown };
      if (e.message) parts.push(e.message);
      cur = e.cause;
    }
    return parts.join(" | ");
  }
}

async function ownerOfAttachedScan(noteId: string) {
  const [row] = await db.orm
    .select({ scanOwnerId: scoreScans.ownerId, noteTeacherId: notes.teacherId })
    .from(notes)
    .innerJoin(scoreScans, eq(notes.scoreScanId, scoreScans.id))
    .where(eq(notes.id, noteId));
  return row;
}

const attach = (noteId: string, token: string, body: Record<string, unknown>) =>
  request(makeApp()).patch(`/v1/notes/${noteId}`).set("Authorization", `Bearer ${token}`).send(body);

const patchSelf = (noteId: string, token: string, body: Record<string, unknown>) =>
  request(makeApp()).patch(`/v1/me/notes/${noteId}`).set("Authorization", `Bearer ${token}`).send(body);

const getScoreScan = (noteId: string, token: string) =>
  request(makeApp()).get(`/v1/notes/${noteId}/score-scan`).set("Authorization", `Bearer ${token}`);

const getDetail = (noteId: string, token: string) =>
  request(makeApp()).get(`/v1/me/notes/${noteId}`).set("Authorization", `Bearer ${token}`);

let teacher: TestUser;
let student: TestUser;
let otherTeacher: TestUser;
let stranger: TestUser;

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
  scans = makeFakeScans();
  await db.orm.insert(pieces).values({
    id: "seed_piece",
    title: "Practical Method, Op. 599",
    composer: "Carl Czerny",
    rights: "public_domain",
    status: "published",
    publishedVersion: 3,
  });
  teacher = await makeUser("nss-teacher", "teacher");
  student = await makeUser("nss-student", "student");
  otherTeacher = await makeUser("nss-other-teacher", "teacher");
  stranger = await makeUser("nss-stranger", "student");
  await linkActive(teacher.id, student.id);
});

const realLog = console.log;

beforeEach(() => {
  scans = makeFakeScans();
  logged = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
});

describe("PATCH /v1/notes/:id — attaching a scan to a teacher note", () => {
  it("attaches the author's own scan to their own draft", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id });

    const res = await attach(note.id, teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(200);
    expect(res.body.note.scoreScanId).toBe(scan.id);
    expect((await refs(note.id)).scanId).toBe(scan.id);
  });

  it("leaves score_scans.owner_id equal to notes.teacher_id on the note it just wrote", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id });

    await attach(note.id, teacher.token, { scoreScanId: scan.id });

    const joined = await ownerOfAttachedScan(note.id);
    expect(joined).toBeDefined();
    expect(joined!.scanOwnerId).toBe(joined!.noteTeacherId);
  });

  it("answers a bare 404 for a scan another teacher owns", async () => {
    const mine = await seedScan({ ownerId: teacher.id });
    const theirs = await seedScan({ ownerId: otherTeacher.id });
    const note = await seedNote({ teacherId: teacher.id, scoreScanId: mine.id });

    const res = await attach(note.id, teacher.token, { scoreScanId: theirs.id });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect((await refs(note.id)).scanId).toBe(mine.id);
  });

  it("answers 404 for a scan owned by the student the note is addressed to", async () => {
    const theirs = await seedScan({ ownerId: student.id });
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id });

    const res = await attach(note.id, teacher.token, { scoreScanId: theirs.id });

    expect(res.status).toBe(404);
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("answers 404 for the author's own scan once it has been taken down", async () => {
    const scan = await seedScan({ ownerId: teacher.id, status: "taken_down", blobPath: null });
    const note = await seedNote({ teacherId: teacher.id });

    const res = await attach(note.id, teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("attaches a scan whose pages are still uploading", async () => {
    const scan = await seedScan({ ownerId: teacher.id, status: "created", blobPath: null });
    const note = await seedNote({ teacherId: teacher.id });

    const res = await attach(note.id, teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(200);
    expect((await refs(note.id)).scanId).toBe(scan.id);
  });

  it("answers 404 for a scoreScanId that is not a uuid", async () => {
    const note = await seedNote({ teacherId: teacher.id });

    const res = await attach(note.id, teacher.token, { scoreScanId: "../../etc/passwd" });

    expect(res.status).toBe(404);
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("answers 404 for another teacher's draft", async () => {
    const scan = await seedScan({ ownerId: otherTeacher.id });
    const note = await seedNote({ teacherId: teacher.id });

    const res = await attach(note.id, otherTeacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(404);
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("detaches on null and leaves the scan row and its bytes untouched", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, scoreScanId: scan.id });

    const res = await attach(note.id, teacher.token, { scoreScanId: null });

    expect(res.status).toBe(200);
    expect((await refs(note.id)).scanId).toBeNull();
    const [row] = await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scan.id));
    expect(row!.status).toBe("ready");
    expect(row!.blobPath).not.toBeNull();
    expect(scans.deletedPrefixes).toEqual([]);
  });

  it("answers 409 not_editable when the note has already been sent", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
    });

    const res = await attach(note.id, teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_editable");
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("answers 409 not_editable when the note has been retracted", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "retracted",
      sentAt: daysAgo(2), readAt: daysAgo(2), retractedAt: daysAgo(1),
    });

    const res = await attach(note.id, teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_editable");
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("accepts a scan whose pages are still uploading", async () => {
    const scan = await seedScan({ ownerId: teacher.id, status: "created" });
    const note = await seedNote({ teacherId: teacher.id });

    const res = await attach(note.id, teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(200);
    expect((await refs(note.id)).scanId).toBe(scan.id);
  });

  it("leaves the reference alone when the body names no scoreScanId", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, scoreScanId: scan.id });

    const res = await attach(note.id, teacher.token, { pieceLabel: "Für Elise" });

    expect(res.status).toBe(200);
    expect((await refs(note.id)).scanId).toBe(scan.id);
  });

  it("refuses a student reaching the teacher route", async () => {
    const scan = await seedScan({ ownerId: student.id });
    const note = await seedNote({ teacherId: teacher.id });

    const res = await attach(note.id, student.token, { scoreScanId: scan.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("teacher_only");
    expect((await refs(note.id)).scanId).toBeNull();
  });
});

describe("PATCH /v1/me/notes/:id — the student's own note", () => {
  let solo: TestUser;
  let otherSolo: TestUser;

  beforeAll(async () => {
    solo = await makeUser("nss-solo", "student");
    otherSolo = await makeUser("nss-other-solo", "student");
    await linkActive(teacher.id, solo.id);
  });

  const selfNote = (opts: { scoreScanId?: string | null; scoreScanDetachedAt?: Date | null } = {}) =>
    seedNote({
      teacherId: solo.id,
      studentId: solo.id,
      origin: "self",
      status: "sent",
      sentAt: new Date(),
      readAt: new Date(),
      ...opts,
    });

  it("attaches a scan to a born-sent self note, which the draft-only rule would have refused", async () => {
    const scan = await seedScan({ ownerId: solo.id, pageCount: 5 });
    const note = await selfNote();

    const res = await patchSelf(note.id, solo.token, { scoreScanId: scan.id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasScorePhotos: true, scorePageCount: 5, scoreGone: false });
    const after = await refs(note.id);
    expect(after.scanId).toBe(scan.id);
    expect(after.status).toBe("sent");
  });

  it("leaves score_scans.owner_id equal to notes.teacher_id on the self note it just wrote", async () => {
    const scan = await seedScan({ ownerId: solo.id });
    const note = await selfNote();

    await patchSelf(note.id, solo.token, { scoreScanId: scan.id });

    const joined = await ownerOfAttachedScan(note.id);
    expect(joined!.scanOwnerId).toBe(joined!.noteTeacherId);
  });

  it("detaches on null", async () => {
    const scan = await seedScan({ ownerId: solo.id });
    const note = await selfNote({ scoreScanId: scan.id });

    const res = await patchSelf(note.id, solo.token, { scoreScanId: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasScorePhotos: false, scorePageCount: null, scoreGone: false });
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("answers 403 self_note_only for a note the teacher authored", async () => {
    const scan = await seedScan({ ownerId: solo.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: solo.id, status: "sent", sentAt: new Date(),
    });

    const res = await patchSelf(note.id, solo.token, { scoreScanId: scan.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("self_note_only");
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("answers 404 for a scan another user owns", async () => {
    const theirs = await seedScan({ ownerId: otherSolo.id });
    const note = await selfNote();

    const res = await patchSelf(note.id, solo.token, { scoreScanId: theirs.id });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("answers 404 for someone else's self note", async () => {
    const scan = await seedScan({ ownerId: otherSolo.id });
    const note = await selfNote();

    const res = await patchSelf(note.id, otherSolo.token, { scoreScanId: scan.id });

    expect(res.status).toBe(404);
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("answers 404 for a malformed note id", async () => {
    const res = await patchSelf("not-a-uuid", solo.token, { scoreScanId: null });

    expect(res.status).toBe(404);
  });

  it("answers 400 score_scan_id_required when the body names no scoreScanId", async () => {
    const note = await selfNote();

    const res = await patchSelf(note.id, solo.token, { content: { lessonSummary: "rewritten" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("score_scan_id_required");
  });

  it("writes the scan and ignores every other field travelling in the same body", async () => {
    const scan = await seedScan({ ownerId: solo.id });
    const note = await selfNote();
    const before = await refs(note.id);

    const res = await patchSelf(note.id, solo.token, {
      scoreScanId: scan.id,
      content: { lessonSummary: "rewritten", practicePlan: [] },
      contentOriginal: { lessonSummary: "rewritten too" },
      status: "draft",
      studentId: otherSolo.id,
      readAt: null,
      teacherId: teacher.id,
    });

    expect(res.status).toBe(200);
    const after = await refs(note.id);
    expect(after.scanId).toBe(scan.id);
    expect(after.status).toBe("sent");
    expect(after.studentId).toBe(solo.id);
    expect(after.readAt).not.toBeNull();
    expect((after.content as { lessonSummary: string }).lessonSummary)
      .toBe((before.content as { lessonSummary: string }).lessonSummary);
  });

  it("clears the gone marker when a replacement scan is attached", async () => {
    const replacement = await seedScan({ ownerId: solo.id });
    const note = await selfNote({ scoreScanId: null, scoreScanDetachedAt: daysAgo(1) });
    expect((await getDetail(note.id, solo.token)).body.note.scoreGone).toBe(true);

    const attached = await patchSelf(note.id, solo.token, { scoreScanId: replacement.id });

    expect(attached.body.scoreGone).toBe(false);
    expect((await refs(note.id)).detachedAt).toBeNull();
    const detached = await patchSelf(note.id, solo.token, { scoreScanId: null });
    expect(detached.body.scoreGone).toBe(false);
    expect((await getDetail(note.id, solo.token)).body.note.scoreGone).toBe(false);
  });
});

describe("POST /v1/notes/:id/duplicate — which score columns travel", () => {
  it("copies score_scan_id from a draft", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, scoreScanId: scan.id });

    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/duplicate`)
      .set("Authorization", `Bearer ${teacher.token}`);

    expect(res.status).toBe(201);
    expect(res.body.scoreScanId).toBe(scan.id);
    expect((await refs(res.body.id)).scanId).toBe(scan.id);
  });

  it("copies score_scan_id from a retracted note, so retract-and-resend keeps the score", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "retracted", scoreScanId: scan.id,
      sentAt: daysAgo(2), readAt: daysAgo(2), retractedAt: daysAgo(1),
    });

    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/duplicate`)
      .set("Authorization", `Bearer ${teacher.token}`);

    expect(res.status).toBe(201);
    expect(res.body.scoreScanId).toBe(scan.id);
  });

  it("never copies score_scan_detached_at onto a note that never had a score", async () => {
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "retracted",
      scoreScanId: null, scoreScanDetachedAt: daysAgo(1),
      sentAt: daysAgo(3), readAt: daysAgo(3), retractedAt: daysAgo(2),
    });

    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/duplicate`)
      .set("Authorization", `Bearer ${teacher.token}`);

    expect(res.status).toBe(201);
    expect(res.body.scoreScanDetachedAt).toBeNull();
    expect(res.body.scoreScanId).toBeNull();
    expect((await refs(res.body.id)).detachedAt).toBeNull();
  });

  it("carries the scan forward and leaves the marker behind when the original has both", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "retracted", scoreScanId: scan.id,
      scoreScanDetachedAt: daysAgo(1),
      sentAt: daysAgo(3), readAt: daysAgo(3), retractedAt: daysAgo(2),
    });

    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/duplicate`)
      .set("Authorization", `Bearer ${teacher.token}`);

    const copy = await refs(res.body.id);
    expect(copy.scanId).toBe(scan.id);
    expect(copy.detachedAt).toBeNull();
  });
});

describe("naming a piece detaches the scan — the invariant at every writer of notes.piece_id", () => {
  let soloAuthor: TestUser;

  beforeAll(async () => {
    soloAuthor = await makeUser("nss-piece-solo", "student");
  });

  const patchLesson = (lessonId: string, token: string, body: Record<string, unknown>) =>
    request(makeApp()).patch(`/v1/lessons/${lessonId}`).set("Authorization", `Bearer ${token}`).send(body);

  async function libraryRow(scanId: string) {
    const [row] = await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scanId));
    return row;
  }

  it("detaches when PATCH /v1/notes/:id names a catalog piece, and leaves the pages in the library", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, scoreScanId: scan.id });

    const res = await attach(note.id, teacher.token, { pieceId: "seed_piece" });

    expect(res.status).toBe(200);
    expect(res.body.note.scoreScanId).toBeNull();
    const after = await refs(note.id);
    expect(after.pieceId).toBe("seed_piece");
    expect(after.scanId).toBeNull();
    expect(after.detachedAt).toBeNull();
    const row = await libraryRow(scan.id);
    expect(row!.status).toBe("ready");
    expect(row!.blobPath).not.toBeNull();
    expect(scans.deletedPrefixes).toEqual([]);
  });

  it("keeps the piece and no scan when one body carries both", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id });

    const res = await attach(note.id, teacher.token, { pieceId: "seed_piece", scoreScanId: scan.id });

    expect(res.status).toBe(200);
    const after = await refs(note.id);
    expect(after.pieceId).toBe("seed_piece");
    expect(after.scanId).toBeNull();
  });

  it("leaves the scan attached when PATCH /v1/notes/:id clears the piece instead of naming one", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, scoreScanId: scan.id });

    const res = await attach(note.id, teacher.token, { pieceId: null });

    expect(res.status).toBe(200);
    const after = await refs(note.id);
    expect(after.pieceId).toBeNull();
    expect(after.scanId).toBe(scan.id);
  });

  it("attaches the scan when one body clears the piece and names a scan", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, pieceId: "seed_piece" });

    const res = await attach(note.id, teacher.token, { pieceId: null, scoreScanId: scan.id });

    expect(res.status).toBe(200);
    const after = await refs(note.id);
    expect(after.pieceId).toBeNull();
    expect(after.scanId).toBe(scan.id);
  });

  it("detaches when the piece-suggestion chip is confirmed", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, scoreScanId: scan.id });
    await db.orm
      .update(noteJobs)
      .set({ pieceMentions: ["Practical Method, Op. 599"] })
      .where(eq(noteJobs.id, note.noteJobId!));

    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/piece-suggestion`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ action: "confirm", pieceId: "seed_piece" });

    expect(res.status).toBe(200);
    const after = await refs(note.id);
    expect(after.pieceId).toBe("seed_piece");
    expect(after.scanId).toBeNull();
    expect(after.detachedAt).toBeNull();
    expect((await libraryRow(scan.id))!.status).toBe("ready");
  });

  it("detaches the lesson too when the piece-suggestion chip is confirmed", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, scoreScanId: scan.id });
    await db.orm
      .update(lessonSessions)
      .set({ scoreScanId: scan.id })
      .where(eq(lessonSessions.id, note.lessonSessionId!));
    await db.orm
      .update(noteJobs)
      .set({ pieceMentions: ["Practical Method, Op. 599"] })
      .where(eq(noteJobs.id, note.noteJobId!));

    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/piece-suggestion`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ action: "confirm", pieceId: "seed_piece" });

    expect(res.status).toBe(200);
    const [lesson] = await db.orm
      .select()
      .from(lessonSessions)
      .where(eq(lessonSessions.id, note.lessonSessionId!));
    expect(lesson!.pieceId).toBe("seed_piece");
    expect(lesson!.scoreScanId).toBeNull();
  });

  it("detaches when the lesson's piece cascades onto the draft", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id, scoreScanId: scan.id });

    const res = await patchLesson(note.lessonSessionId!, teacher.token, { pieceId: "seed_piece" });

    expect(res.status).toBe(200);
    const after = await refs(note.id);
    expect(after.pieceId).toBe("seed_piece");
    expect(after.scanId).toBeNull();
    expect(after.detachedAt).toBeNull();
    expect((await libraryRow(scan.id))!.status).toBe("ready");
  });

  it("leaves the scan attached when the lesson clears its piece", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, scoreScanId: scan.id,
    });
    await db.orm
      .update(lessonSessions)
      .set({ pieceId: "seed_piece" })
      .where(eq(lessonSessions.id, note.lessonSessionId!));

    const res = await patchLesson(note.lessonSessionId!, teacher.token, { pieceId: null });

    expect(res.status).toBe(200);
    const after = await refs(note.id);
    expect(after.pieceId).toBeNull();
    expect(after.scanId).toBe(scan.id);
  });

  it("detaches on a born-sent self note without telling its author the score is gone", async () => {
    const scan = await seedScan({ ownerId: soloAuthor.id });
    const note = await seedNote({
      teacherId: soloAuthor.id, studentId: soloAuthor.id, origin: "self", status: "sent",
      sentAt: new Date(), readAt: new Date(), scoreScanId: scan.id,
    });

    const res = await patchLesson(note.lessonSessionId!, soloAuthor.token, { pieceId: "seed_piece" });

    expect(res.status).toBe(200);
    const after = await refs(note.id);
    expect(after.pieceId).toBe("seed_piece");
    expect(after.scanId).toBeNull();
    expect(after.detachedAt).toBeNull();
    const detail = await getDetail(note.id, soloAuthor.token);
    expect(detail.body.note).toMatchObject({ hasScorePhotos: false, scorePageCount: null, scoreGone: false });
    expect((await libraryRow(scan.id))!.status).toBe("ready");
  });

  it("never invents a scan on the duplicate of a note that names a piece", async () => {
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "retracted",
      pieceId: "seed_piece",
      sentAt: daysAgo(3), readAt: daysAgo(3), retractedAt: daysAgo(2),
    });

    const res = await request(makeApp())
      .post(`/v1/notes/${note.id}/duplicate`)
      .set("Authorization", `Bearer ${teacher.token}`);

    expect(res.status).toBe(201);
    expect(res.body.pieceId).toBe("seed_piece");
    expect(res.body.scoreScanId).toBeNull();
    const copy = await refs(res.body.id);
    expect(copy.scanId).toBeNull();
    expect(copy.detachedAt).toBeNull();
  });
});

describe("attaching a scan onto a note that already names a piece — the invariant read off the row", () => {
  let soloAuthor: TestUser;

  beforeAll(async () => {
    soloAuthor = await makeUser("nss-row-solo", "student");
  });

  it("refuses the scan on PATCH /v1/notes/:id when the row names a piece the body never mentions", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id, pieceId: "seed_piece" });

    const res = await attach(note.id, teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("note_names_piece");
    expect(res.body.message).toContain("can't carry score photos");
    const after = await refs(note.id);
    expect(after.pieceId).toBe("seed_piece");
    expect(after.scanId).toBeNull();
    expect(after.detachedAt).toBeNull();
  });

  it("refuses the scan on PATCH /v1/me/notes/:id when the self note names a piece", async () => {
    const scan = await seedScan({ ownerId: soloAuthor.id });
    const note = await seedNote({
      teacherId: soloAuthor.id, studentId: soloAuthor.id, origin: "self", status: "sent",
      sentAt: new Date(), pieceId: "seed_piece",
    });

    const res = await patchSelf(note.id, soloAuthor.token, { scoreScanId: scan.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("note_names_piece");
    const after = await refs(note.id);
    expect(after.pieceId).toBe("seed_piece");
    expect(after.scanId).toBeNull();
  });

  it("writes nothing else in the refused body", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id, pieceId: "seed_piece" });

    const res = await attach(note.id, teacher.token, {
      scoreScanId: scan.id,
      content: { lessonSummary: "Rewritten by the refused body", practicePlan: [] },
    });

    expect(res.status).toBe(409);
    const after = await refs(note.id);
    expect((after.content as { lessonSummary: string }).lessonSummary).toBe("Nice sense of line today.");
  });

  it("answers 404 for an unknown scan before it ever reaches the piece check", async () => {
    const otherScan = await seedScan({ ownerId: otherTeacher.id });
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id, pieceId: "seed_piece" });

    const res = await attach(note.id, teacher.token, { scoreScanId: otherScan.id });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("still attaches to a note with no piece", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id });

    const res = await attach(note.id, teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(200);
    expect((await refs(note.id)).scanId).toBe(scan.id);
  });

  it("still attaches to a self note with no piece", async () => {
    const scan = await seedScan({ ownerId: soloAuthor.id });
    const note = await seedNote({
      teacherId: soloAuthor.id, studentId: soloAuthor.id, origin: "self", status: "sent",
      sentAt: new Date(),
    });

    const res = await patchSelf(note.id, soloAuthor.token, { scoreScanId: scan.id });

    expect(res.status).toBe(200);
    expect((await refs(note.id)).scanId).toBe(scan.id);
  });

  it("lets a row holding a scan keep taking edits that touch neither column", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, scoreScanId: scan.id,
    });

    const res = await attach(note.id, teacher.token, {
      content: { lessonSummary: "Still editable", practicePlan: [] },
    });

    expect(res.status).toBe(200);
    const after = await refs(note.id);
    expect((after.content as { lessonSummary: string }).lessonSummary).toBe("Still editable");
    expect(after.pieceId).toBeNull();
    expect(after.scanId).toBe(scan.id);
  });

  it("lets a row holding a scan detach it on either route", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, scoreScanId: scan.id,
    });

    const res = await attach(note.id, teacher.token, { scoreScanId: null });

    expect(res.status).toBe(200);
    expect((await refs(note.id)).scanId).toBeNull();

    const selfScan = await seedScan({ ownerId: soloAuthor.id });
    const selfNote = await seedNote({
      teacherId: soloAuthor.id, studentId: soloAuthor.id, origin: "self", status: "sent",
      sentAt: new Date(), scoreScanId: selfScan.id,
    });

    const selfRes = await patchSelf(selfNote.id, soloAuthor.token, { scoreScanId: null });

    expect(selfRes.status).toBe(200);
    expect((await refs(selfNote.id)).scanId).toBeNull();
  });

  it("refuses a replacement scan on a row that names a piece, rather than swapping one refusal for another", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const replacement = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, pieceId: "seed_piece",
    });

    expect((await attach(note.id, teacher.token, { scoreScanId: scan.id })).status).toBe(409);
    const res = await attach(note.id, teacher.token, { scoreScanId: replacement.id });

    expect(res.status).toBe(409);
    expect((await refs(note.id)).scanId).toBeNull();
  });

  it("never sends a note whose row was minted through the attach route while it named a piece", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id, pieceId: "seed_piece" });

    expect((await attach(note.id, teacher.token, { scoreScanId: scan.id })).status).toBe(409);

    const send = await request(makeApp())
      .post(`/v1/notes/${note.id}/send`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});

    expect(send.status).toBe(200);
    expect((await refs(note.id)).scanId).toBeNull();

    const detail = await request(makeApp())
      .get(`/v1/score-scans/${scan.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);

    expect(detail.status).toBe(200);
    expect(detail.body.usedBy).toEqual([]);
  });
});

describe("ck_note_piece_excludes_scan — the strap under both check-then-write guards", () => {
  let author: TestUser;

  beforeAll(async () => {
    author = await makeUser("nss-ck-solo", "student");
  });

  it("refuses a row that names a piece while holding a scan", async () => {
    const scan = await seedScan({ ownerId: author.id });

    const refusal = await refusalMessageChain(() =>
      seedNote({ teacherId: author.id, origin: "self", pieceId: "seed_piece", scoreScanId: scan.id }));

    expect(refusal).toMatch(/ck_note_piece_excludes_scan/);
  });

  it("refuses a row that reaches the forbidden pair by UPDATE, not by INSERT", async () => {
    const scan = await seedScan({ ownerId: author.id });
    const note = await seedNote({ teacherId: author.id, origin: "self", scoreScanId: scan.id });

    const refusal = await refusalMessageChain(() =>
      db.orm.update(notes).set({ pieceId: "seed_piece" }).where(eq(notes.id, note.id)));

    expect(refusal).toMatch(/ck_note_piece_excludes_scan/);
    expect((await refs(note.id)).scanId).toBe(scan.id);
  });

  it("admits a piece alone, a scan alone, and neither", async () => {
    const scan = await seedScan({ ownerId: author.id });
    const withPiece = await seedNote({ teacherId: author.id, origin: "self", pieceId: "seed_piece" });
    const withScan = await seedNote({ teacherId: author.id, origin: "self", scoreScanId: scan.id });
    const withNeither = await seedNote({ teacherId: author.id, origin: "self" });

    expect(withPiece.pieceId).toBe("seed_piece");
    expect(withPiece.scoreScanId).toBeNull();
    expect(withScan.scoreScanId).toBe(scan.id);
    expect(withScan.pieceId).toBeNull();
    expect(withNeither.pieceId).toBeNull();
    expect(withNeither.scoreScanId).toBeNull();
  });
});

describe("GET /v1/notes/:id/score-scan — who may read the pages", () => {
  it("serves the paired recipient every page, signed under the owner's prefix", async () => {
    const scan = await seedScan({ ownerId: teacher.id, pageCount: 3 });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await getScoreScan(note.id, student.token);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.noteId).toBe(note.id);
    expect(res.body.pages.map((p: { page: number }) => p.page)).toEqual([1, 2, 3]);
    for (const p of res.body.pages as { page: number; url: string }[]) {
      expect(p.url).toContain(`/${teacher.id}/${scan.id}/${p.page}.jpg`);
      expect(p.url).not.toContain(student.id);
    }
  });

  it("sends exactly noteId, pages and expiresAt, and each page exactly page and url", async () => {
    const scan = await seedScan({ ownerId: teacher.id, pageCount: 2 });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await getScoreScan(note.id, student.token);

    expect(keys(res.body)).toEqual(["expiresAt", "noteId", "pages"]);
    for (const p of res.body.pages) expect(keys(p)).toEqual(["page", "url"]);
  });

  it("expires the read URLs fifteen minutes out", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await getScoreScan(note.id, student.token);

    const minutes = (Date.parse(res.body.expiresAt) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it("still serves a student whose teacher ended the link after the note was sent", async () => {
    const exStudent = await makeUser("nss-ex-student", "student");
    await linkActive(teacher.id, exStudent.id);
    const scan = await seedScan({ ownerId: teacher.id, pageCount: 2 });
    const note = await seedNote({
      teacherId: teacher.id, studentId: exStudent.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const ended = await request(makeApp())
      .delete(`/v1/me/students/${exStudent.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(ended.status).toBe(200);
    const [link] = await db.orm
      .select()
      .from(teacherStudentLinks)
      .where(and(
        eq(teacherStudentLinks.teacherId, teacher.id),
        eq(teacherStudentLinks.studentId, exStudent.id),
      ));
    expect(link!.status).toBe("removed");

    const res = await getScoreScan(note.id, exStudent.token);

    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(2);
    expect((await getDetail(note.id, exStudent.token)).status).toBe(200);
  });

  it("serves the author their own draft's scan", async () => {
    const scan = await seedScan({ ownerId: teacher.id, pageCount: 2 });
    const note = await seedNote({ teacherId: teacher.id, scoreScanId: scan.id });

    const res = await getScoreScan(note.id, teacher.token);

    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(2);
  });

  it("answers 404 to a stranger who is neither recipient nor author", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await getScoreScan(note.id, stranger.token);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("answers 404 to a teacher who did not author the note", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await getScoreScan(note.id, otherTeacher.token);

    expect(res.status).toBe(404);
  });

  it("answers 404 to the named recipient while the note is still a draft", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id, scoreScanId: scan.id });

    const res = await getScoreScan(note.id, student.token);

    expect(res.status).toBe(404);
  });

  it("answers 404 for a read-then-retracted note whose detail route still serves a stub", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "retracted", scoreScanId: scan.id,
      sentAt: daysAgo(2), readAt: daysAgo(2), retractedAt: daysAgo(1),
    });

    const stub = await getDetail(note.id, student.token);
    expect(stub.status).toBe(200);

    const res = await getScoreScan(note.id, student.token);

    expect(res.status).toBe(404);
  });

  it("answers 404 for a malformed note id", async () => {
    const res = await getScoreScan("not-a-uuid", student.token);

    expect(res.status).toBe(404);
  });

  it("answers 503 when scan storage is unconfigured", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await request(makeAppWithoutScans())
      .get(`/v1/notes/${note.id}/score-scan`)
      .set("Authorization", `Bearer ${student.token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("storage_not_configured");
  });
});

describe("GET /v1/notes/:id/score-scan — the entitlement boundary", () => {
  afterEach(async () => {
    await setMonetization(null);
  });

  it("serves a lapsed owner their own self note's scan the detail route locks", async () => {
    const owner = await makeUser("nss-lapsed-owner", "student");
    await lapse(owner.id);
    const scan = await seedScan({ ownerId: owner.id, pageCount: 2 });
    const note = await seedNote({
      teacherId: owner.id, studentId: owner.id, origin: "self", status: "sent",
      sentAt: new Date(), scoreScanId: scan.id,
    });

    expect((await getDetail(note.id, owner.token)).status).toBe(402);

    const res = await getScoreScan(note.id, owner.token);

    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(2);
  });

  it("answers 402 to a lapsed recipient of a teacher's note", async () => {
    const lapsed = await makeUser("nss-lapsed-recipient", "student");
    await linkActive(teacher.id, lapsed.id);
    await lapse(lapsed.id);
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: lapsed.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await getScoreScan(note.id, lapsed.token);

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("subscription_required");
    expect(res.body.access.status).toBe("lapsed");
  });

  it("locks a lapsed recipient before telling them a score was ever destroyed", async () => {
    const lapsed = await makeUser("nss-lapsed-gone", "student");
    await linkActive(teacher.id, lapsed.id);
    await lapse(lapsed.id);
    const note = await seedNote({
      teacherId: teacher.id, studentId: lapsed.id, status: "sent", sentAt: new Date(),
      readAt: new Date(), scoreScanId: null, scoreScanDetachedAt: daysAgo(1),
    });

    const res = await getScoreScan(note.id, lapsed.token);

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("subscription_required");
  });

  it("locks a lapsed recipient before telling them the scan is still uploading", async () => {
    const lapsed = await makeUser("nss-lapsed-created", "student");
    await linkActive(teacher.id, lapsed.id);
    await lapse(lapsed.id);
    const scan = await seedScan({ ownerId: teacher.id, status: "created" });
    const note = await seedNote({
      teacherId: teacher.id, studentId: lapsed.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await getScoreScan(note.id, lapsed.token);

    expect(res.status).toBe(402);
  });
});

describe("GET /v1/notes/:id/score-scan — the status ladder, one rung at a time", () => {
  const ladder = async (opts: {
    status?: "created" | "ready" | "taken_down";
    blobPath?: string | null;
    scoreScanId?: string | null;
    scoreScanDetachedAt?: Date | null;
  }) => {
    const scanId = "scoreScanId" in opts
      ? opts.scoreScanId
      : (await seedScan({ ownerId: teacher.id, status: opts.status, ...("blobPath" in opts ? { blobPath: opts.blobPath } : {}) })).id;
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
      readAt: new Date(), scoreScanId: scanId, scoreScanDetachedAt: opts.scoreScanDetachedAt ?? null,
    });
    return getScoreScan(note.id, student.token);
  };

  it("answers 409 scan_not_ready while the pages are still uploading", async () => {
    const res = await ladder({ status: "created" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("scan_not_ready");
  });

  it("answers 410 scan_taken_down for a taken-down scan", async () => {
    const res = await ladder({ status: "taken_down", blobPath: null });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("scan_taken_down");
  });

  it("answers 410 scan_purged when a ready row lost its bytes", async () => {
    const res = await ladder({ status: "ready", blobPath: null });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("scan_purged");
  });

  it("answers 410 scan_gone when the reference is null and the marker is stamped", async () => {
    const res = await ladder({ scoreScanId: null, scoreScanDetachedAt: daysAgo(1) });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("scan_gone");
  });

  it("answers 404 when the note never carried a score at all", async () => {
    const res = await ladder({ scoreScanId: null });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});

describe("the student note payload — the allow list the shipped app decodes", () => {
  it("sends exactly the keys the shipped decoder expects", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await getDetail(note.id, student.token);

    expect(res.status).toBe(200);
    expect(keys(res.body)).toEqual(["annotations", "note", "teacher"]);
    expect(keys(res.body.note)).toEqual([...STUDENT_NOTE_WIRE_KEYS].sort());
  });

  it("carries every field NotesAPI.Note decodes as non-optional", async () => {
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
    });

    const res = await getDetail(note.id, student.token);

    for (const key of NOTES_API_NOTE_NON_OPTIONALS) {
      expect(res.body.note[key]).not.toBeNull();
      expect(res.body.note[key]).not.toBeUndefined();
    }
  });

  it("never carries the raw scan columns on a note that has both of them set", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
      readAt: new Date(), scoreScanId: scan.id, scoreScanDetachedAt: daysAgo(1),
    });

    const res = await getDetail(note.id, student.token);

    expect(res.body.note).not.toHaveProperty("scoreScanId");
    expect(res.body.note).not.toHaveProperty("scoreScanDetachedAt");
    expect(JSON.stringify(res.body.note)).not.toContain(scan.id);
  });

  it("never carries the teacher-only columns", async () => {
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(),
    });

    const res = await getDetail(note.id, student.token);

    expect(res.body.note).not.toHaveProperty("customPieceId");
    expect(res.body.note).not.toHaveProperty("pieceSuggestionDismissed");
  });

  it("sends the retracted stub with exactly id, status and retractedAt", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "retracted", scoreScanId: scan.id,
      sentAt: daysAgo(2), readAt: daysAgo(2), retractedAt: daysAgo(1),
    });

    const res = await getDetail(note.id, student.token);

    expect(res.status).toBe(200);
    expect(keys(res.body)).toEqual(["note"]);
    expect(keys(res.body.note)).toEqual(["id", "retractedAt", "status"]);
  });

  it("carries no scan fields on any row of the inbox list", async () => {
    const listStudent = await makeUser("nss-list-student", "student");
    await linkActive(teacher.id, listStudent.id);
    const scan = await seedScan({ ownerId: teacher.id });
    await seedNote({
      teacherId: teacher.id, studentId: listStudent.id, status: "sent", sentAt: new Date(),
      scoreScanId: scan.id,
    });

    const res = await request(makeApp())
      .get("/v1/me/notes")
      .set("Authorization", `Bearer ${listStudent.token}`);

    expect(res.body.items).toHaveLength(1);
    for (const item of res.body.items) expect(keys(item)).toEqual([...INBOX_NOTE_WIRE_KEYS].sort());
  });
});

describe("the derived score fields", () => {
  const detail = async (opts: {
    scoreScanId?: string | null;
    scoreScanDetachedAt?: Date | null;
  }) => {
    const note = await seedNote({
      teacherId: teacher.id, studentId: student.id, status: "sent", sentAt: new Date(), ...opts,
    });
    const res = await getDetail(note.id, student.token);
    expect(res.status).toBe(200);
    return res.body.note;
  };

  it("reports the page count only when the scan is ready with bytes behind it", async () => {
    const scan = await seedScan({ ownerId: teacher.id, pageCount: 7 });

    expect(await detail({ scoreScanId: scan.id })).toMatchObject({
      hasScorePhotos: true, scorePageCount: 7, scoreGone: false,
    });
  });

  it("reports no score while the scan is still uploading", async () => {
    const scan = await seedScan({ ownerId: teacher.id, status: "created", pageCount: 5 });

    expect(await detail({ scoreScanId: scan.id })).toMatchObject({
      hasScorePhotos: false, scorePageCount: null, scoreGone: false,
    });
  });

  it("tells the reader a taken-down scan is gone rather than letting the pane vanish", async () => {
    const scan = await seedScan({ ownerId: teacher.id, status: "taken_down", blobPath: null });

    expect(await detail({ scoreScanId: scan.id })).toMatchObject({
      hasScorePhotos: false, scorePageCount: null, scoreGone: true,
    });
  });

  it("tells the reader a ready row that lost its bytes is gone", async () => {
    const scan = await seedScan({ ownerId: teacher.id, status: "ready", blobPath: null });

    expect(await detail({ scoreScanId: scan.id })).toMatchObject({
      hasScorePhotos: false, scorePageCount: null, scoreGone: true,
    });
  });

  it("leaves a scan still uploading absent rather than gone", async () => {
    const scan = await seedScan({ ownerId: teacher.id, status: "created" });

    expect(await detail({ scoreScanId: scan.id })).toMatchObject({
      hasScorePhotos: false, scorePageCount: null, scoreGone: false,
    });
  });

  it("reports scoreGone only when the reference is null and the marker is stamped", async () => {
    expect(await detail({ scoreScanId: null, scoreScanDetachedAt: daysAgo(1) })).toMatchObject({
      hasScorePhotos: false, scorePageCount: null, scoreGone: true,
    });
  });

  it("never reports scoreGone over a live reference carrying a stale marker", async () => {
    const scan = await seedScan({ ownerId: teacher.id, pageCount: 3 });

    expect(await detail({ scoreScanId: scan.id, scoreScanDetachedAt: daysAgo(1) })).toMatchObject({
      hasScorePhotos: true, scorePageCount: 3, scoreGone: false,
    });
  });

  it("reports all three empty on a note that never had a score", async () => {
    expect(await detail({})).toMatchObject({
      hasScorePhotos: false, scorePageCount: null, scoreGone: false,
    });
  });
});

describe("attach, send, read, delete — the whole chain through the shipped routes", () => {
  it("turns a read recipient's score into a gone score on both read paths", async () => {
    const chainStudent = await makeUser("nss-chain-student", "student");
    await linkActive(teacher.id, chainStudent.id);
    const created = await request(makeApp())
      .post("/v1/score-scans")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ title: "Czerny 599", pageCount: 2 });
    expect(created.status).toBe(201);
    const scanId = created.body.scan.id as string;
    const committed = await request(makeApp())
      .post(`/v1/score-scans/${scanId}/commit`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(committed.status).toBe(200);
    expect(committed.body.scan.status).toBe("ready");

    const note = await seedNote({ teacherId: teacher.id, studentId: chainStudent.id });
    const attached = await attach(note.id, teacher.token, { scoreScanId: scanId });
    expect(attached.status).toBe(200);
    const sent = await request(makeApp())
      .post(`/v1/notes/${note.id}/send`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});
    expect(sent.status).toBe(200);
    const read = await request(makeApp())
      .post(`/v1/me/notes/${note.id}/read`)
      .set("Authorization", `Bearer ${chainStudent.token}`);
    expect(read.status).toBe(200);

    const before = await getDetail(note.id, chainStudent.token);
    expect(before.body.note).toMatchObject({ hasScorePhotos: true, scorePageCount: 2, scoreGone: false });
    expect((await getScoreScan(note.id, chainStudent.token)).status).toBe(200);

    const deleted = await request(makeApp())
      .delete(`/v1/score-scans/${scanId}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(deleted.status).toBe(200);

    const after = await getDetail(note.id, chainStudent.token);
    expect(after.body.note).toMatchObject({ hasScorePhotos: false, scorePageCount: null, scoreGone: true });
    const pages = await getScoreScan(note.id, chainStudent.token);
    expect(pages.status).toBe(410);
    expect(pages.body.error).toBe("scan_gone");
    expect(scans.deletedPrefixes).toEqual([
      `incoming/${teacher.id}/${scanId}/`,
      `${teacher.id}/${scanId}/`,
      `incoming/${teacher.id}/${scanId}/`,
    ]);
  });

  it("leaves an unread recipient with no score and no sentence claiming one was destroyed", async () => {
    const quietStudent = await makeUser("nss-quiet-student", "student");
    await linkActive(teacher.id, quietStudent.id);
    const created = await request(makeApp())
      .post("/v1/score-scans")
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ title: "Czerny 599", pageCount: 2 });
    const scanId = created.body.scan.id as string;
    const committed = await request(makeApp())
      .post(`/v1/score-scans/${scanId}/commit`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(committed.status).toBe(200);

    const note = await seedNote({ teacherId: teacher.id, studentId: quietStudent.id });
    await attach(note.id, teacher.token, { scoreScanId: scanId });
    await request(makeApp())
      .post(`/v1/notes/${note.id}/send`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({});

    await request(makeApp())
      .delete(`/v1/score-scans/${scanId}`)
      .set("Authorization", `Bearer ${teacher.token}`);

    const after = await getDetail(note.id, quietStudent.token);
    expect(after.body.note).toMatchObject({ hasScorePhotos: false, scorePageCount: null, scoreGone: false });
    const pages = await getScoreScan(note.id, quietStudent.token);
    expect(pages.status).toBe(404);
  });
});

describe("POST /v1/lessons — the score photographed at the start of the lesson", () => {
  const createLesson = (token: string, body: Record<string, unknown>) =>
    request(makeApp()).post("/v1/lessons").set("Authorization", `Bearer ${token}`).send(body);

  const patchLesson = (id: string, token: string, body: Record<string, unknown>) =>
    request(makeApp()).patch(`/v1/lessons/${id}`).set("Authorization", `Bearer ${token}`).send(body);

  async function lessonRow(id: string) {
    const [row] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, id));
    return row ?? null;
  }

  it("stores the scan on the lesson and returns it on the wire", async () => {
    const scan = await seedScan({ ownerId: teacher.id });

    const res = await createLesson(teacher.token, { scoreScanId: scan.id, studentId: student.id });

    expect(res.status).toBe(201);
    expect(res.body.lesson.scoreScanId).toBe(scan.id);
    expect((await lessonRow(res.body.lesson.id))!.scoreScanId).toBe(scan.id);
  });

  it("keeps the recording and drops a scan another account owns", async () => {
    const scan = await seedScan({ ownerId: otherTeacher.id });

    const res = await createLesson(teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(201);
    expect(res.body.lesson.scoreScanId).toBeNull();
    expect((await lessonRow(res.body.lesson.id))!.scoreScanId).toBeNull();
  });

  it("keeps the recording when the id names no scan at all", async () => {
    const res = await createLesson(teacher.token, {
      scoreScanId: "00000000-0000-4000-8000-000000000000",
    });

    expect(res.status).toBe(201);
    expect(res.body.lesson.scoreScanId).toBeNull();
  });

  it("keeps the recording when the scan was deleted between the lesson and its upload", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    await db.orm.delete(scoreScans).where(eq(scoreScans.id, scan.id));

    const res = await createLesson(teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(201);
    expect(res.body.lesson.scoreScanId).toBeNull();
  });

  it("reports the detach when naming a piece takes the photographs off a note", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id,
                                  scoreScanId: scan.id });

    const res = await request(makeApp()).patch(`/v1/lessons/${note.lessonSessionId}`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ pieceId: "seed_piece", pieceLabel: "Seed", pieceSource: "catalog" });

    expect(res.status).toBe(200);
    const touched = res.body.notes.find((n: { id: string }) => n.id === note.id);
    expect(touched.scoreDetached).toBe(true);
  });

  it("does not claim a detach when there were no photographs to take off", async () => {
    const note = await seedNote({ teacherId: teacher.id, studentId: student.id });

    const res = await request(makeApp()).patch(`/v1/lessons/${note.lessonSessionId}`)
      .set("Authorization", `Bearer ${teacher.token}`)
      .send({ pieceId: "seed_piece", pieceLabel: "Seed", pieceSource: "catalog" });

    expect(res.status).toBe(200);
    const touched = res.body.notes.find((n: { id: string }) => n.id === note.id);
    expect(touched.scoreDetached).toBe(false);
  });

  it("takes a scan whose pages are still uploading, as the note patch does", async () => {
    const scan = await seedScan({ ownerId: teacher.id, status: "created" });

    const res = await createLesson(teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(201);
    expect(res.body.lesson.scoreScanId).toBe(scan.id);
  });

  it("keeps the recording and drops a scan that was taken down", async () => {
    const scan = await seedScan({ ownerId: teacher.id, status: "taken_down" });

    const res = await createLesson(teacher.token, { scoreScanId: scan.id });

    expect(res.status).toBe(201);
    expect(res.body.lesson.scoreScanId).toBeNull();
  });

  it("refuses a lesson that names a library piece and photographed pages at once", async () => {
    const scan = await seedScan({ ownerId: teacher.id });

    const res = await createLesson(teacher.token, { scoreScanId: scan.id, pieceId: "seed_piece" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("note_names_piece");
    expect(res.body.message).toBe("A note that names a piece from the library can't carry score photos.");
  });

  it("carries a student's own photographed score onto their solo recording", async () => {
    const scan = await seedScan({ ownerId: student.id });

    const res = await createLesson(student.token, { scoreScanId: scan.id, attested: true });

    expect(res.status).toBe(201);
    expect(res.body.lesson.ownerRole).toBe("student");
    expect(res.body.lesson.scoreScanId).toBe(scan.id);
  });

  it("leaves a lesson created without a scan carrying none", async () => {
    const res = await createLesson(teacher.token, { pieceId: "seed_piece", studentId: student.id });

    expect(res.status).toBe(201);
    expect(res.body.lesson.scoreScanId).toBeNull();
    expect((await lessonRow(res.body.lesson.id))!.scoreScanId).toBeNull();
  });

  it("leaves the lesson alive carrying nothing once the scan is deleted", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const created = await createLesson(teacher.token, { scoreScanId: scan.id });
    const lessonId = created.body.lesson.id as string;

    const deleted = await request(makeApp())
      .delete(`/v1/score-scans/${scan.id}`)
      .set("Authorization", `Bearer ${teacher.token}`);

    expect(deleted.status).toBe(200);
    const row = await lessonRow(lessonId);
    expect(row).not.toBeNull();
    expect(row!.scoreScanId).toBeNull();
    expect(row!.status).toBe("created");
  });

  it("refuses a library piece named onto a lesson that carries photographed pages", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const created = await createLesson(teacher.token, { scoreScanId: scan.id });

    const res = await patchLesson(created.body.lesson.id, teacher.token, { pieceId: "seed_piece" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("note_names_piece");
    expect(res.body.message).toBe("A note that names a piece from the library can't carry score photos.");
    expect((await lessonRow(created.body.lesson.id))!.scoreScanId).toBe(scan.id);
  });

  it("names a piece on a lesson that carries no scan", async () => {
    const created = await createLesson(teacher.token, {});

    const res = await patchLesson(created.body.lesson.id, teacher.token, { pieceId: "seed_piece" });

    expect(res.status).toBe(200);
    expect(res.body.lesson.pieceId).toBe("seed_piece");
  });

  it("clears the scan a typed label leaves behind without touching it", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const created = await createLesson(teacher.token, { scoreScanId: scan.id });

    const res = await patchLesson(created.body.lesson.id, teacher.token, {
      pieceLabel: "Book 2, page 14",
      pieceSource: "typed",
    });

    expect(res.status).toBe(200);
    expect(res.body.lesson.scoreScanId).toBe(scan.id);
  });
});

describe("ck_lesson_piece_excludes_scan — the strap under the lesson's check-then-write guards", () => {
  it("refuses a row that names a piece while holding a scan", async () => {
    const scan = await seedScan({ ownerId: teacher.id });

    const refusal = await refusalMessageChain(() =>
      db.orm.insert(lessonSessions).values({
        teacherId: teacher.id,
        pieceId: "seed_piece",
        scoreScanId: scan.id,
      }));

    expect(refusal).toMatch(/ck_lesson_piece_excludes_scan/);
  });

  it("refuses a row that reaches the forbidden pair by UPDATE, not by INSERT", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const [row] = await db.orm
      .insert(lessonSessions)
      .values({ teacherId: teacher.id, scoreScanId: scan.id })
      .returning();

    const refusal = await refusalMessageChain(() =>
      db.orm.update(lessonSessions).set({ pieceId: "seed_piece" }).where(eq(lessonSessions.id, row!.id)));

    expect(refusal).toMatch(/ck_lesson_piece_excludes_scan/);
  });

  it("admits a piece alone, a scan alone, and neither", async () => {
    const scan = await seedScan({ ownerId: teacher.id });
    const [withPiece] = await db.orm
      .insert(lessonSessions)
      .values({ teacherId: teacher.id, pieceId: "seed_piece" })
      .returning();
    const [withScan] = await db.orm
      .insert(lessonSessions)
      .values({ teacherId: teacher.id, scoreScanId: scan.id })
      .returning();
    const [withNeither] = await db.orm
      .insert(lessonSessions)
      .values({ teacherId: teacher.id })
      .returning();

    expect(withPiece!.pieceId).toBe("seed_piece");
    expect(withPiece!.scoreScanId).toBeNull();
    expect(withScan!.scoreScanId).toBe(scan.id);
    expect(withScan!.pieceId).toBeNull();
    expect(withNeither!.pieceId).toBeNull();
    expect(withNeither!.scoreScanId).toBeNull();
  });
});
