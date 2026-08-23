import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWK } from "jose";
import { createServer } from "../src/server";
import { createJoseVerifier, type AuthVerifier } from "../src/auth";
import { createTestDb } from "./testdb";
import {
  users, pieces, scoreScans, lessonSessions, noteJobs, notes, notedPieces, noteAnnotations,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { ScanStore } from "../src/notes/scans_store";
import { MAX_SLOTS } from "../src/notes/slot_crud";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;
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

async function seedDraft(opts: { pieceId?: string | null; scoreScanId?: string | null } = {}) {
  const [lesson] = await db.orm.insert(lessonSessions).values({ teacherId }).returning();
  const [job] = await db.orm
    .insert(noteJobs)
    .values({ lessonSessionId: lesson!.id, status: "ready_for_review", createdBy: teacherId })
    .returning();
  const [note] = await db.orm
    .insert(notes)
    .values({
      noteJobId: job!.id, lessonSessionId: lesson!.id, teacherId,
      status: "draft", contentOriginal: {}, content: {},
    })
    .returning();
  const [slot] = await db.orm
    .insert(notedPieces)
    .values({
      noteId: note!.id, sortIndex: 0,
      pieceId: opts.pieceId ?? null, scoreScanId: opts.scoreScanId ?? null,
    })
    .returning();
  return { note: note!, slot: slot! };
}

async function seedScan() {
  const [scan] = await db.orm
    .insert(scoreScans)
    .values({ ownerId: teacherId, title: "Czerny", pageCount: 2, status: "ready", bytes: 10 })
    .returning();
  await db.orm.update(scoreScans).set({ blobPath: `${teacherId}/${scan!.id}/` }).where(eq(scoreScans.id, scan!.id));
  return scan!;
}

beforeEach(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  verifier = createJoseVerifier({
    issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet({ keys: [jwk] }),
  });
  db = await createTestDb();
  await db.orm.insert(pieces).values([
    { id: "slot_piece", title: "Op. 599", composer: "Czerny", rights: "public_domain", status: "published" },
    { id: "other_piece", title: "Arabesque", composer: "Burgmüller", rights: "public_domain", status: "published" },
    { id: "eight_bar_piece", title: "Eight bars", composer: "Anon", rights: "public_domain",
      status: "published", facts: { measures: 8 } },
  ]);
  teacherToken = await new SignJWT({ oid: "slot-teacher", name: "T", email: "t@slot.test" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("10m")
    .sign(privateKey);
  const synced = await request(app())
    .post("/v1/users/sync").set("Authorization", `Bearer ${teacherToken}`)
    .send({ role: "teacher", notesConsent: true });
  teacherId = synced.body.id;
});

describe("a lesson's list of pieces", () => {
  it("adds a card and puts it after the ones already there", async () => {
    const { note } = await seedDraft({ pieceId: "slot_piece" });

    const res = await request(app())
      .post(`/v1/notes/${note.id}/pieces`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceId: "other_piece" });

    expect(res.status).toBe(201);
    expect(res.body.piece.kind).toBe("engraved");
    const slots = await db.orm.select().from(notedPieces).where(eq(notedPieces.noteId, note.id));
    expect(slots).toHaveLength(2);
    expect(Math.max(...slots.map((s) => s.sortIndex))).toBeGreaterThan(0);
  });

  it("refuses a card naming a piece and photographs at once", async () => {
    const { note } = await seedDraft();
    const scan = await seedScan();

    const res = await request(app())
      .post(`/v1/notes/${note.id}/pieces`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceId: "slot_piece", scoreScanId: scan.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("note_names_piece");
  });

  it("stops at the cap rather than growing without end", async () => {
    const { note } = await seedDraft({ pieceId: "slot_piece" });
    for (let i = 1; i < MAX_SLOTS; i++) {
      const r = await request(app())
        .post(`/v1/notes/${note.id}/pieces`)
        .set("Authorization", `Bearer ${teacherToken}`)
        .send({ pieceLabel: `Piece ${i}` });
      expect(r.status).toBe(201);
    }

    const over = await request(app())
      .post(`/v1/notes/${note.id}/pieces`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceLabel: "One too many" });

    expect(over.status).toBe(409);
    expect(over.body.error).toBe("too_many_pieces");
  });

  it("puts the photographs away when a card is given a piece, and says it did", async () => {
    const scan = await seedScan();
    const { note, slot } = await seedDraft({ scoreScanId: scan.id });

    const res = await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceId: "slot_piece" });

    expect(res.status).toBe(200);
    expect(res.body.scoreDetached).toBe(true);
    expect(res.body.piece.kind).toBe("engraved");
    const [after] = await db.orm.select().from(notedPieces).where(eq(notedPieces.id, slot.id));
    expect(after!.scoreScanId).toBeNull();
  });

  it("refuses photographs arriving onto a card that already names a piece", async () => {
    const scan = await seedScan();
    const { note, slot } = await seedDraft({ pieceId: "slot_piece" });

    const res = await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ scoreScanId: scan.id });

    expect(res.status).toBe(409);
    const [after] = await db.orm.select().from(notedPieces).where(eq(notedPieces.id, slot.id));
    expect(after!.pieceId).toBe("slot_piece");
  });

  it("reorders by moving one card, and the others keep their order", async () => {
    const { note, slot } = await seedDraft({ pieceId: "slot_piece" });
    const second = await request(app())
      .post(`/v1/notes/${note.id}/pieces`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceLabel: "Second" });

    await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${second.body.piece.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ sortIndex: -1000 });

    const slots = await db.orm
      .select()
      .from(notedPieces)
      .where(eq(notedPieces.noteId, note.id));
    const ordered = [...slots].sort((a, b) => a.sortIndex - b.sortIndex);
    expect(ordered[0]!.pieceLabel).toBe("Second");
    expect(ordered[1]!.id).toBe(slot.id);
  });

  it("leaves the teacher's words behind in General when a card is removed", async () => {
    const { note, slot } = await seedDraft({ pieceId: "slot_piece" });
    await db.orm.insert(noteAnnotations).values({
      noteId: note.id, idx: 0, category: "rhythm",
      instruction: "Even it out", quote: "those bars", notePieceId: slot.id,
    });

    const res = await request(app())
      .delete(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`);

    expect(res.status).toBe(200);
    const items = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.noteId, note.id));
    expect(items).toHaveLength(1);
    expect(items[0]!.notePieceId).toBeNull();
    expect(items[0]!.instruction).toBe("Even it out");
  });

  it("names the note itself, so the rest of the server can see the piece the teacher typed", async () => {
    const { note, slot } = await seedDraft();

    await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceLabel: "Czerny Op. 599 No. 23" });

    const [after] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(after!.pieceLabel).toBe("Czerny Op. 599 No. 23");
  });

  it("hands the note over to whichever piece is first once the first is taken out", async () => {
    const { note, slot } = await seedDraft({ pieceId: "slot_piece" });
    await request(app())
      .post(`/v1/notes/${note.id}/pieces`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceId: "other_piece" });

    await request(app())
      .delete(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`);

    const [after] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(after!.pieceId).toBe("other_piece");
  });

  it("leaves the note naming nothing once its last piece is taken out", async () => {
    const { note, slot } = await seedDraft();
    await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceId: "slot_piece" });
    const [named] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(named!.pieceId).toBe("slot_piece");

    await request(app())
      .delete(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`);

    const [after] = await db.orm.select().from(notes).where(eq(notes.id, note.id));
    expect(after!.pieceId).toBeNull();
    expect(after!.pieceLabel).toBeNull();
  });

  it("drops bar numbers written against the score a card just stopped showing", async () => {
    const { note, slot } = await seedDraft({ pieceId: "slot_piece" });
    const [kept] = await db.orm.insert(notedPieces)
      .values({ noteId: note.id, sortIndex: 1000, pieceLabel: "Another piece" }).returning();
    const grounded = { type: "measures", raw: "bar 3", grounded: true,
                       measureStart: 3, measureEnd: 3, pinnedBy: "teacher" };
    const [mine] = await db.orm.insert(noteAnnotations).values({
      noteId: note.id, idx: 0, category: "rhythm", instruction: "Here", quote: "there",
      notePieceId: slot.id, groundedPieceId: slot.id, location: grounded,
    }).returning();
    const [neighbour] = await db.orm.insert(noteAnnotations).values({
      noteId: note.id, idx: 1, category: "rhythm", instruction: "Elsewhere", quote: "there",
      notePieceId: kept!.id, groundedPieceId: kept!.id, location: grounded,
    }).returning();

    const res = await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceId: "other_piece" });

    expect(res.status).toBe(200);
    const [after] = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, mine!.id));
    expect((after!.location as Record<string, unknown>).grounded).toBe(false);
    const [untouched] = await db.orm.select().from(noteAnnotations)
      .where(eq(noteAnnotations.id, neighbour!.id));
    expect((untouched!.location as Record<string, unknown>).grounded)
      .toBe(true);
  });

  it("keeps a bar the piece it moved to still has, and drops one past its end", async () => {
    const { note, slot } = await seedDraft({ pieceId: "slot_piece" });
    const bar = (n: number) => ({ type: "measures", raw: `bar ${n}`, grounded: true,
                                  measureStart: n, measureEnd: n, pinnedBy: "teacher" });
    const [inside] = await db.orm.insert(noteAnnotations).values({
      noteId: note.id, idx: 0, category: "rhythm", instruction: "Early", quote: "there",
      notePieceId: slot.id, groundedPieceId: slot.id, location: bar(4),
    }).returning();
    const [past] = await db.orm.insert(noteAnnotations).values({
      noteId: note.id, idx: 1, category: "rhythm", instruction: "Late", quote: "there",
      notePieceId: slot.id, groundedPieceId: slot.id, location: bar(12),
    }).returning();

    const res = await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceId: "eight_bar_piece" });

    expect(res.status).toBe(200);
    const [kept] = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, inside!.id));
    expect((kept!.location as Record<string, unknown>).grounded).toBe(true);
    expect((kept!.location as Record<string, unknown>).measureStart).toBe(4);
    const [dropped] = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, past!.id));
    expect((dropped!.location as Record<string, unknown>).grounded).toBe(false);
  });

  it("drops a bar written against photographs even when the new piece is long enough for it", async () => {
    const scan = await seedScan();
    const { note, slot } = await seedDraft({ scoreScanId: scan.id });
    const [spot] = await db.orm.insert(noteAnnotations).values({
      noteId: note.id, idx: 0, category: "rhythm", instruction: "Here", quote: "there",
      notePieceId: slot.id, groundedPieceId: slot.id,
      location: { type: "measures", raw: "bar 4", grounded: true,
                  measureStart: 4, measureEnd: 4, pinnedBy: "teacher" },
    }).returning();

    const res = await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ pieceId: "eight_bar_piece" });

    expect(res.status).toBe(200);
    expect(res.body.scoreDetached).toBe(true);
    const [after] = await db.orm.select().from(noteAnnotations).where(eq(noteAnnotations.id, spot!.id));
    expect((after!.location as Record<string, unknown>).grounded).toBe(false);
  });

  it("a piece's own summary can be written, cleared, and reaches the wire", async () => {
    const { note, slot } = await seedDraft({ pieceId: "slot_piece" });
    let res = await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ summary: "  Even sixteenths arrived.  " });
    expect(res.status).toBe(200);
    expect(res.body.piece.summary).toBe("Even sixteenths arrived.");

    res = await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ summary: "   " });
    expect(res.status).toBe(200);
    expect(res.body.piece.summary).toBeNull();
  });

  it("refuses every edit once the note is sent", async () => {
    const { note, slot } = await seedDraft({ pieceId: "slot_piece" });
    await db.orm.update(notes).set({ status: "sent" }).where(eq(notes.id, note.id));

    const add = await request(app())
      .post(`/v1/notes/${note.id}/pieces`)
      .set("Authorization", `Bearer ${teacherToken}`).send({ pieceLabel: "Nope" });
    const edit = await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`).send({ pieceLabel: "Nope" });
    const remove = await request(app())
      .delete(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${teacherToken}`);

    for (const r of [add, edit, remove]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("not_editable");
    }
  });

  it("never touches another teacher's note", async () => {
    const { note, slot } = await seedDraft({ pieceId: "slot_piece" });
    const strangerToken = await new SignJWT({ oid: "slot-stranger", name: "S", email: "s@slot.test" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("10m")
      .sign(privateKey);
    await request(app())
      .post("/v1/users/sync").set("Authorization", `Bearer ${strangerToken}`)
      .send({ role: "teacher", notesConsent: true });

    const res = await request(app())
      .patch(`/v1/notes/${note.id}/pieces/${slot.id}`)
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ pieceLabel: "Mine now" });

    expect(res.status).toBe(404);
    const [after] = await db.orm
      .select()
      .from(notedPieces)
      .where(and(eq(notedPieces.id, slot.id), eq(notedPieces.noteId, note.id)));
    expect(after!.pieceLabel).toBeNull();
  });
});
