import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWK } from "jose";
import { createServer } from "../src/server";
import { createJoseVerifier, type AuthVerifier } from "../src/auth";
import { createTestDb } from "./testdb";
import { users, pieces, lessonSessions, noteJobs, notes, notedPieces, noteAnnotations, scoreScans } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { ScanStore } from "../src/notes/scans_store";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let teacherToken: string;
let teacherId: string;

function fakeScans(): ScanStore {
  const inc = (o: string, s: string) => `incoming/${o}/${s}/`;
  const blob = (o: string, s: string) => `${o}/${s}/`;
  return {
    incomingPrefix: inc, blobPrefix: blob,
    incomingPath: (o, s, n) => `${inc(o, s)}${n}.jpg`,
    blobPath: (o, s, n) => `${blob(o, s)}${n}.jpg`,
    uploadUrl: (p) => `https://fake/${p}`,
    async pageProps() { return { bytes: 1, etag: "e" }; },
    async readHead() { return Buffer.from([0xff, 0xd8, 0xff]); },
    async promote() {},
    readUrl: (p) => `https://fake/${p}`,
    async deletePrefix() {},
  };
}

function app() {
  return createServer({
    db, auth: verifier, scans: fakeScans(),
    lessons: {
      blobPath: (t, l) => `${t}/${l}.m4a`, uploadUrl: (p) => `https://fake/${p}`,
      async audioProps() { return { bytes: 1 }; }, async deleteAudio() {},
    },
    notesQueue: { async send() {}, async sendNarration() {} },
  });
}

const GROUNDED = { type: "measure", raw: "bar 14", grounded: true, measureStart: 14, measureEnd: 14, pinnedBy: "teacher" };

async function seed() {
  const [lesson] = await db.orm.insert(lessonSessions).values({ teacherId }).returning();
  const [job] = await db.orm.insert(noteJobs)
    .values({ lessonSessionId: lesson!.id, status: "ready_for_review", createdBy: teacherId }).returning();
  const [note] = await db.orm.insert(notes).values({
    noteJobId: job!.id, lessonSessionId: lesson!.id, teacherId, pieceId: "move_a",
    status: "draft", contentOriginal: {}, content: { lessonSummary: "before" },
  }).returning();
  const [a] = await db.orm.insert(notedPieces)
    .values({ noteId: note!.id, sortIndex: 0, pieceId: "move_a" }).returning();
  const [b] = await db.orm.insert(notedPieces)
    .values({ noteId: note!.id, sortIndex: 1000, pieceId: "move_b" }).returning();
  const [item] = await db.orm.insert(noteAnnotations).values({
    noteId: note!.id, idx: 0, category: "rhythm", instruction: "Even it out",
    quote: "those bars", notePieceId: a!.id, groundedPieceId: a!.id, location: GROUNDED,
  }).returning();
  return { note: note!, a: a!, b: b!, item: item! };
}

function payload(item: { id: string; noteId: string }, extra: Record<string, unknown>) {
  return {
    content: { lessonSummary: "after", practicePlan: [] },
    annotations: [{
      id: item.id, noteId: item.noteId, idx: 0, category: "rhythm",
      instruction: "Even it out", quote: "those bars", location: GROUNDED, ...extra,
    }],
  };
}

async function reload(id: string) {
  const [row] = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, id));
  return row!;
}

beforeEach(async () => {
  const pair = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  verifier = createJoseVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet({ keys: [jwk] }) });
  db = await createTestDb();
  await db.orm.insert(pieces).values([
    { id: "move_a", title: "Op. 599", composer: "Czerny", rights: "public_domain", status: "published" },
    { id: "move_b", title: "Arabesque", composer: "Burgmüller", rights: "public_domain", status: "published" },
  ]);
  teacherToken = await new SignJWT({ oid: "move-teacher", name: "T", email: "t@move.test" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("10m")
    .sign(pair.privateKey);
  const synced = await request(app())
    .post("/v1/users/sync").set("Authorization", `Bearer ${teacherToken}`)
    .send({ role: "teacher", notesConsent: true });
  teacherId = synced.body.id;
});

describe("moving a marked spot to another piece", () => {
  it("puts it under the piece the teacher chose", async () => {
    const { note, b, item } = await seed();

    const res = await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send(payload(item, { notePieceId: b.id }));

    expect(res.status).toBe(200);
    expect((await reload(item.id)).notePieceId).toBe(b.id);
  });

  it("drops bar numbers that were written against the piece it left", async () => {
    const { note, b, item } = await seed();

    await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send(payload(item, { notePieceId: b.id }));

    const loc = (await reload(item.id)).location as Record<string, unknown>;
    expect(loc.grounded).toBe(false);
    expect(loc.measureStart).toBeUndefined();
    expect((await reload(item.id)).groundedPieceId).toBeNull();
  });

  it("keeps bar numbers the teacher placed in the same edit", async () => {
    const { note, b, item } = await seed();
    const placed = { ...GROUNDED, raw: "bar 3", measureStart: 3, measureEnd: 3 };

    await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send(payload(item, { notePieceId: b.id, location: placed }));

    const after = await reload(item.id);
    expect((after.location as Record<string, unknown>).measureStart).toBe(3);
    expect(after.groundedPieceId).toBe(b.id);
  });

  it("returns it to General when the piece is cleared", async () => {
    const { note, item } = await seed();

    await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send(payload(item, { notePieceId: null }));

    expect((await reload(item.id)).notePieceId).toBeNull();
  });

  it("leaves it where it is when an older app says nothing about pieces", async () => {
    const { note, a, item } = await seed();

    await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send(payload(item, {}));

    const after = await reload(item.id);
    expect(after.notePieceId).toBe(a.id);
    expect((after.location as Record<string, unknown>).measureStart).toBe(14);
  });

  it("changing the note's own score leaves every other piece's bars alone", async () => {
    const { note, a, b, item } = await seed();
    const [neighbour] = await db.orm.insert(noteAnnotations).values({
      noteId: note.id, idx: 1, category: "rhythm", instruction: "Elsewhere", quote: "there",
      notePieceId: b.id, groundedPieceId: b.id, location: GROUNDED,
    }).returning();

    // The note's singular piece changes, which can only mean the slot it mirrors into.
    const res = await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceId: "move_b" });

    expect(res.status).toBe(200);
    const [mine] = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, item.id));
    expect((mine!.location as Record<string, unknown>).grounded).toBe(false);
    const [other] = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, neighbour!.id));
    expect((other!.location as Record<string, unknown>).grounded)
      .toBe(true);
    expect(a.id).toBeTruthy();
  });

  it("attaching photographs does not wipe the bars of a piece it never touched", async () => {
    const { note, b, item } = await seed();
    await db.orm.update(notes).set({ pieceId: null, pieceLabel: "Typed only" }).where(eq(notes.id, note.id));
    const [neighbour] = await db.orm.insert(noteAnnotations).values({
      noteId: note.id, idx: 1, category: "rhythm", instruction: "Elsewhere", quote: "there",
      notePieceId: b.id, groundedPieceId: b.id, location: GROUNDED,
    }).returning();
    const [scan] = await db.orm.insert(scoreScans)
      .values({ ownerId: teacherId, title: "Pages", pageCount: 1, status: "ready", bytes: 10 })
      .returning();
    await db.orm.update(scoreScans).set({ blobPath: `${teacherId}/${scan!.id}/` })
      .where(eq(scoreScans.id, scan!.id));

    const res = await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send({ scoreScanId: scan!.id });

    expect(res.status).toBe(200);
    const [other] = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, neighbour!.id));
    expect((other!.location as Record<string, unknown>).grounded).toBe(true);
    expect(item.id).toBeTruthy();
  });

  it("refuses a bar the piece does not have, however many times a stale client posts it", async () => {
    const { note, a, item } = await seed();
    await db.orm.update(pieces).set({ facts: { measures: 24 } }).where(eq(pieces.id, "move_a"));
    const past = { ...GROUNDED, raw: "bar 30", measureStart: 30, measureEnd: 30 };

    const res = await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send(payload(item, { notePieceId: a.id, location: past }));

    expect(res.status).toBe(200);
    const stored = await reload(item.id);
    expect((stored.location as Record<string, unknown>).grounded).toBe(false);
    expect(stored.groundedPieceId).toBeNull();
  });

  it("keeps a bar the piece does have", async () => {
    const { note, a, item } = await seed();
    await db.orm.update(pieces).set({ facts: { measures: 24 } }).where(eq(pieces.id, "move_a"));
    const inside = { ...GROUNDED, raw: "bar 6", measureStart: 6, measureEnd: 6 };

    await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send(payload(item, { notePieceId: a.id, location: inside }));

    const stored = await reload(item.id);
    expect((stored.location as Record<string, unknown>).grounded).toBe(true);
    expect((stored.location as Record<string, unknown>).measureStart).toBe(6);
  });

  it("refuses a piece from another note and lands none of the edit", async () => {
    const { note, item } = await seed();
    const other = await seed();

    const res = await request(app())
      .patch(`/v1/notes/${note.id}`).set("Authorization", `Bearer ${teacherToken}`)
      .send(payload(item, { notePieceId: other.b.id }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_note_piece");
    const [after] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect((after!.content as { lessonSummary?: string }).lessonSummary).toBe("before");
  });
});
