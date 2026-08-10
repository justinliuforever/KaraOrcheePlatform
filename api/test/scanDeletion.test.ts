import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
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
import { notes, scoreScans } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { ScanStore } from "../src/notes/scans_store";
import { stampAndDeleteScans } from "../src/notes/scan_delete";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;
let logged: string[];

interface FakeScans extends ScanStore {
  deletedPrefixes: string[];
  failPrefixes: Set<string>;
}

function makeFakeScans(): FakeScans {
  const incomingPrefix = (ownerId: string, scanId: string) => `incoming/${ownerId}/${scanId}/`;
  const blobPrefix = (ownerId: string, scanId: string) => `${ownerId}/${scanId}/`;
  const f: FakeScans = {
    deletedPrefixes: [],
    failPrefixes: new Set(),
    incomingPrefix,
    blobPrefix,
    incomingPath: (o, s, n) => `${incomingPrefix(o, s)}${n}.jpg`,
    blobPath: (o, s, n) => `${blobPrefix(o, s)}${n}.jpg`,
    uploadUrl: (p) => `https://fake/score-scans/${p}?sas`,
    async pageProps(path) {
      return { bytes: 1024, etag: `etag:${path}` };
    },
    async readHead() {
      return Buffer.from([0xff, 0xd8, 0xff]);
    },
    async promote() {},
    readUrl: (p) => `https://fake/score-scans/${p}?read`,
    async deletePrefix(prefix) {
      if (!prefix.endsWith("/")) throw new Error("deletePrefix requires a trailing slash");
      if (f.failPrefixes.has(prefix)) throw new Error("blob service unavailable");
      f.deletedPrefixes.push(prefix);
    },
  };
  return f;
}

let fakeScans: FakeScans;

function makeApp(deps: { scans?: FakeScans } = {}) {
  return createServer({ db, auth: verifier, scans: "scans" in deps ? deps.scans : fakeScans });
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
});

const realLog = console.log;

beforeEach(() => {
  fakeScans = makeFakeScans();
  logged = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
});

async function makeUser(oid: string, role: "teacher" | "student" = "teacher") {
  const token = await new SignJWT({ oid, name: "Test Person" })
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

async function seedScan(
  ownerId: string,
  status: "created" | "ready" | "taken_down",
): Promise<string> {
  const [row] = await db.orm
    .insert(scoreScans)
    .values({
      ownerId,
      title: "Czerny 599",
      pageCount: 2,
      status,
      blobPath: status === "ready" ? `${ownerId}/placeholder/` : null,
      bytes: status === "ready" ? 2048 : null,
    })
    .returning({ id: scoreScans.id });
  return row!.id;
}

async function seedNote(args: {
  teacherId: string;
  studentId?: string;
  status: "draft" | "sent" | "retracted";
  readAt?: Date | null;
  scanId: string;
}): Promise<string> {
  const [row] = await db.orm
    .insert(notes)
    .values({
      teacherId: args.teacherId,
      studentId: args.studentId ?? null,
      status: args.status,
      sentAt: args.status === "draft" ? null : new Date(),
      readAt: args.readAt ?? null,
      scoreScanId: args.scanId,
      contentOriginal: {},
      content: {},
    })
    .returning({ id: notes.id });
  return row!.id;
}

async function noteRow(id: string) {
  const [row] = await db.orm
    .select({ scoreScanId: notes.scoreScanId, detachedAt: notes.scoreScanDetachedAt })
    .from(notes)
    .where(eq(notes.id, id));
  return row!;
}

function events(kind: string): string[] {
  return logged.filter((line) => line.includes(`"kind":"${kind}"`));
}

describe("deleting a scan clears every note that references it", () => {
  it("stamps the marker on a read note and nulls the reference in the same statement", async () => {
    const teacher = await makeUser("scan-del-read");
    const student = await makeUser("scan-del-read-s", "student");
    const scanId = await seedScan(teacher.id, "ready");
    const noteId = await seedNote({
      teacherId: teacher.id,
      studentId: student.id,
      status: "sent",
      readAt: new Date(),
      scanId,
    });

    const deleted = await db.orm.transaction((tx) =>
      stampAndDeleteScans(tx, { ownerId: teacher.id, scanId }),
    );

    expect(deleted.map((d) => d.id)).toEqual([scanId]);
    const row = await noteRow(noteId);
    expect(row.scoreScanId).toBeNull();
    expect(row.detachedAt).not.toBeNull();
  });

  it("leaves an unread sent note unmarked", async () => {
    const teacher = await makeUser("scan-del-unread");
    const student = await makeUser("scan-del-unread-s", "student");
    const scanId = await seedScan(teacher.id, "ready");
    const noteId = await seedNote({
      teacherId: teacher.id,
      studentId: student.id,
      status: "sent",
      readAt: null,
      scanId,
    });

    await db.orm.transaction((tx) => stampAndDeleteScans(tx, { ownerId: teacher.id, scanId }));

    const row = await noteRow(noteId);
    expect(row.scoreScanId).toBeNull();
    expect(row.detachedAt).toBeNull();
  });

  it("marks a read retracted note and leaves the author's own draft unmarked", async () => {
    const teacher = await makeUser("scan-del-mixed");
    const student = await makeUser("scan-del-mixed-s", "student");
    const scanId = await seedScan(teacher.id, "ready");
    const retracted = await seedNote({
      teacherId: teacher.id,
      studentId: student.id,
      status: "retracted",
      readAt: new Date(),
      scanId,
    });
    const draft = await seedNote({ teacherId: teacher.id, status: "draft", scanId });

    await db.orm.transaction((tx) => stampAndDeleteScans(tx, { ownerId: teacher.id, scanId }));

    expect((await noteRow(retracted)).detachedAt).not.toBeNull();
    expect((await noteRow(draft)).detachedAt).toBeNull();
    expect((await noteRow(draft)).scoreScanId).toBeNull();
  });

  it("a non-owner deletes nothing and marks nothing", async () => {
    const owner = await makeUser("scan-del-owner");
    const stranger = await makeUser("scan-del-stranger");
    const student = await makeUser("scan-del-owner-s", "student");
    const scanId = await seedScan(owner.id, "ready");
    const noteId = await seedNote({
      teacherId: owner.id,
      studentId: student.id,
      status: "sent",
      readAt: new Date(),
      scanId,
    });

    const deleted = await db.orm.transaction((tx) =>
      stampAndDeleteScans(tx, { ownerId: stranger.id, scanId }),
    );

    expect(deleted).toEqual([]);
    const row = await noteRow(noteId);
    expect(row.scoreScanId).toBe(scanId);
    expect(row.detachedAt).toBeNull();
    const survivors = await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scanId));
    expect(survivors.length).toBe(1);
  });
});

describe("every path that deletes a score_scans row goes through stampAndDeleteScans", () => {
  const SRC = join(__dirname, "..", "src");
  const OWNER = join("notes", "scan_delete.ts");

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sources(full);
      return full.endsWith(".ts") ? [full] : [];
    });
  }

  it("no other source file issues a delete against score_scans", () => {
    const offenders = sources(SRC).filter((file) => {
      if (relative(SRC, file) === OWNER) return false;
      const text = readFileSync(file, "utf8");
      return /\.delete\(\s*scoreScans\s*\)/.test(text) || /DELETE\s+FROM\s+\$\{scoreScans\}/i.test(text)
        || /delete\s+from\s+["']?score_scans/i.test(text);
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});

describe("account deletion purges the owner's scans", () => {
  it("deletes the rows, marks the read notes it leaves behind, and purges the durable prefix", async () => {
    const teacher = await makeUser("scan-acct-ready");
    const student = await makeUser("scan-acct-ready-s", "student");
    const scanId = await seedScan(teacher.id, "ready");
    const noteId = await seedNote({
      teacherId: teacher.id,
      studentId: student.id,
      status: "sent",
      readAt: new Date(),
      scanId,
    });

    const res = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${teacher.token}`);
    expect(res.status).toBe(200);

    expect((await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scanId))).length).toBe(0);
    const row = await noteRow(noteId);
    expect(row.scoreScanId).toBeNull();
    expect(row.detachedAt).not.toBeNull();
    expect(fakeScans.deletedPrefixes).toEqual([
      `${teacher.id}/${scanId}/`,
      `incoming/${teacher.id}/${scanId}/`,
    ]);
  });

  it("purges the derived incoming prefix of a scan whose commit never ran", async () => {
    const teacher = await makeUser("scan-acct-created");
    const scanId = await seedScan(teacher.id, "created");

    const res = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${teacher.token}`);
    expect(res.status).toBe(200);

    expect(fakeScans.deletedPrefixes).toEqual([
      `${teacher.id}/${scanId}/`,
      `incoming/${teacher.id}/${scanId}/`,
    ]);
    expect((await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scanId))).length).toBe(0);
  });

  it("sweeps both prefixes for a taken-down scan and still deletes its row", async () => {
    const teacher = await makeUser("scan-acct-takendown");
    const scanId = await seedScan(teacher.id, "taken_down");

    const res = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${teacher.token}`);
    expect(res.status).toBe(200);

    expect(fakeScans.deletedPrefixes).toEqual([
      `${teacher.id}/${scanId}/`,
      `incoming/${teacher.id}/${scanId}/`,
    ]);
    expect((await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scanId))).length).toBe(0);
  });

  it("names the prefix under label scan when the purge exhausts its retries", async () => {
    const teacher = await makeUser("scan-acct-fail");
    const scanId = await seedScan(teacher.id, "ready");
    fakeScans.failPrefixes.add(`${teacher.id}/${scanId}/`);

    const res = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${teacher.token}`);
    expect(res.status).toBe(200);

    const failures = events("purge_failed");
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain(`"label":"scan"`);
    expect(failures[0]).toContain(`"key":"${teacher.id}/${scanId}/"`);
  });

  it("names every abandoned scan when there is no store to purge it with", async () => {
    const teacher = await makeUser("scan-acct-nostore");
    const scanId = await seedScan(teacher.id, "ready");

    const res = await request(makeApp({ scans: undefined }))
      .delete("/v1/me")
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(res.status).toBe(200);

    const failures = events("purge_failed");
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain(`"label":"scan"`);
    expect(failures[0]).toContain(`"key":"${scanId}"`);
    expect((await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scanId))).length).toBe(0);
  });

  it("leaves another owner's scan untouched", async () => {
    const leaver = await makeUser("scan-acct-leaver");
    const stayer = await makeUser("scan-acct-stayer");
    const mine = await seedScan(leaver.id, "ready");
    const theirs = await seedScan(stayer.id, "ready");

    const res = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${leaver.token}`);
    expect(res.status).toBe(200);

    expect((await db.orm.select().from(scoreScans).where(eq(scoreScans.id, mine))).length).toBe(0);
    expect((await db.orm.select().from(scoreScans).where(eq(scoreScans.id, theirs))).length).toBe(1);
    expect(fakeScans.deletedPrefixes).toEqual([
      `${leaver.id}/${mine}/`,
      `incoming/${leaver.id}/${mine}/`,
    ]);
  });
});
