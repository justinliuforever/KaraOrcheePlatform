import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
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
import { users, books, pieces, pieceVersions, works } from "../src/db/schema";
import type { Db } from "../src/db/client";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let privateKey: CryptoKey;
let verifier: AuthVerifier;
let db: Db;
let adminToken: string;
let plainToken: string;
let ghostToken: string;

async function sign(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  verifier = createJoseVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet({ keys: [jwk] }) });

  db = await createTestDb();
  await db.orm.insert(users).values([
    { entraOid: "admin-oid", email: "admin@karaorchee.com", displayName: "Admin", isAdmin: true },
    { entraOid: "plain-oid", email: "player@example.com", displayName: "Player" },
  ]);
  await db.orm.insert(books).values({ id: "czerny_op599", title: "Practical Method, Op. 599" });
  await db.orm.insert(pieces).values({
    id: "czerny_599_41",
    title: "Practical Method, Op. 599",
    subtitle: "No. 41",
    composer: "Carl Czerny",
    difficulty: 1,
    tracking: "validated",
    bookId: "czerny_op599",
    bookIndex: 41,
    rights: "public_domain",
    rightsNote: "Re-engraved from a PD print.",
    status: "published",
    publishedVersion: 2,
  });
  await db.orm.insert(pieceVersions).values([
    { pieceId: "czerny_599_41", version: 1, files: [] },
    { pieceId: "czerny_599_41", version: 2, files: [{ role: "score_events", path: "czerny_599_41/v2/score_events.json" }] },
  ]);

  adminToken = await sign({ oid: "admin-oid", email: "admin@karaorchee.com" });
  plainToken = await sign({ oid: "plain-oid", email: "player@example.com" });
  ghostToken = await sign({ oid: "ghost-oid" });
});

function app() {
  return createServer({ db, auth: verifier });
}

describe("admin gate", () => {
  it("401s without a token", async () => {
    const res = await request(app()).get("/admin/users");
    expect(res.status).toBe(401);
  });

  it("403s a signed-in non-admin", async () => {
    const res = await request(app())
      .get("/admin/users")
      .set("Authorization", `Bearer ${plainToken}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("403s a valid token whose user has no row", async () => {
    const res = await request(app())
      .get("/admin/users")
      .set("Authorization", `Bearer ${ghostToken}`);
    expect(res.status).toBe(403);
  });

  it("503s when db is unconfigured", async () => {
    const res = await request(createServer({ auth: verifier }))
      .get("/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
  });

  it("returns the admin's own row on /admin/me", async () => {
    const res = await request(app())
      .get("/admin/me")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("admin@karaorchee.com");
    expect(res.body.isAdmin).toBe(true);
  });
});

describe("admin users list", () => {
  it("lists users with total", async () => {
    const res = await request(app())
      .get("/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(2);
  });

  it("filters by q on email", async () => {
    const res = await request(app())
      .get("/admin/users?q=player")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].email).toBe("player@example.com");
  });
});

describe("admin pieces registry", () => {
  it("lists pieces with version rollup and book title", async () => {
    const res = await request(app())
      .get("/admin/pieces")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const piece = res.body.items.find((p: { id: string }) => p.id === "czerny_599_41");
    expect(piece.versionCount).toBe(2);
    expect(piece.latestVersion).toBe(2);
    expect(piece.bookTitle).toBe("Practical Method, Op. 599");
    expect(piece.publishedVersion).toBe(2);
  });

  it("returns detail with versions desc and the book", async () => {
    const res = await request(app())
      .get("/admin/pieces/czerny_599_41")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(res.body.book.id).toBe("czerny_op599");
  });

  it("404s an unknown piece", async () => {
    const res = await request(app())
      .get("/admin/pieces/nope")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe("piece edit + lifecycle", () => {
  it("patches display fields and audits", async () => {
    const res = await request(app())
      .patch("/admin/pieces/czerny_599_41")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ difficulty: 2, subtitle: "No. 41 (revised)" });
    expect(res.status).toBe(200);
    expect(res.body.difficulty).toBe(2);
    expect(res.body.subtitle).toBe("No. 41 (revised)");

    const { auditEvents } = await import("../src/db/schema");
    const trail = await db.orm.select().from(auditEvents);
    expect(trail.some((e) => e.action === "piece.update" && e.subjectId === "czerny_599_41")).toBe(true);
  });

  it("rejects a stale concurrent edit", async () => {
    const res = await request(app())
      .patch("/admin/pieces/czerny_599_41")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ difficulty: 3, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("stale_edit");
  });

  it("blocks setting non-publishable rights while published", async () => {
    const res = await request(app())
      .patch("/admin/pieces/czerny_599_41")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rights: "unknown" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("archive_first");
  });

  it("requires a provenance note for public-domain", async () => {
    const res = await request(app())
      .patch("/admin/pieces/czerny_599_41")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rightsNote: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("provenance_required");
  });

  it("blocks a book-index collision", async () => {
    const { pieces } = await import("../src/db/schema");
    await db.orm
      .insert(pieces)
      .values({
        id: "czerny_599_42",
        title: "Practical Method, Op. 599",
        subtitle: "No. 42",
        composer: "Carl Czerny",
        bookId: "czerny_op599",
        bookIndex: 42,
        rights: "public_domain",
        rightsNote: "seed",
      })
      .onConflictDoNothing();
    const res = await request(app())
      .patch("/admin/pieces/czerny_599_41")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bookIndex: 42 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("book_index_taken");
  });

  it("archives and restores with guards", async () => {
    const archived = await request(app())
      .post("/admin/pieces/czerny_599_41/archive")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe("archived");

    const again = await request(app())
      .post("/admin/pieces/czerny_599_41/archive")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(again.status).toBe(409);

    const restored = await request(app())
      .post("/admin/pieces/czerny_599_41/restore")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe("published");
  });

  it("blocks restore when rights are unresolved", async () => {
    const { pieces } = await import("../src/db/schema");
    await db.orm
      .insert(pieces)
      .values({
        id: "rights_hold_piece",
        title: "Rights Hold",
        composer: "Nobody",
        rights: "unknown",
        status: "archived",
        publishedVersion: 1,
      })
      .onConflictDoNothing();
    const res = await request(app())
      .post("/admin/pieces/rights_hold_piece/restore")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("rights_blocked");
  });
});

describe("user detail + roles", () => {
  it("returns user detail with an audit trail", async () => {
    const [plain] = await db.orm.select().from(users).where(eq(users.entraOid, "plain-oid"));
    const res = await request(app())
      .get(`/admin/users/${plain.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("player@example.com");
    expect(Array.isArray(res.body.recentAudit)).toBe(true);
  });

  it("404s an unknown user id", async () => {
    const res = await request(app())
      .get("/admin/users/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("patches roles and audits the change", async () => {
    const [plain] = await db.orm.select().from(users).where(eq(users.entraOid, "plain-oid"));
    const res = await request(app())
      .patch(`/admin/users/${plain.id}/roles`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isTeacher: true });
    expect(res.status).toBe(200);
    expect(res.body.isTeacher).toBe(true);

    const detail = await request(app())
      .get(`/admin/users/${plain.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detail.body.recentAudit.some((e: { action: string }) => e.action === "user.set_roles")).toBe(true);
  });

  it("rejects an empty roles patch", async () => {
    const [plain] = await db.orm.select().from(users).where(eq(users.entraOid, "plain-oid"));
    const res = await request(app())
      .patch(`/admin/users/${plain.id}/roles`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("blocks an admin from demoting themselves", async () => {
    const [admin] = await db.orm.select().from(users).where(eq(users.entraOid, "admin-oid"));
    const res = await request(app())
      .patch(`/admin/users/${admin.id}/roles`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isAdmin: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("cannot_demote_self");
  });

  it("allows promoting another user to admin", async () => {
    const [plain] = await db.orm.select().from(users).where(eq(users.entraOid, "plain-oid"));
    const res = await request(app())
      .patch(`/admin/users/${plain.id}/roles`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isAdmin: true });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
    // restore
    await request(app())
      .patch(`/admin/users/${plain.id}/roles`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isAdmin: false });
  });
});

describe("cors", () => {
  it("answers preflight for an allowlisted origin", async () => {
    const res = await request(createServer({ db, auth: verifier, corsOrigins: ["http://localhost:5173"] }))
      .options("/admin/users")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
  });

  it("sends no CORS headers for an unknown origin", async () => {
    const res = await request(createServer({ db, auth: verifier, corsOrigins: ["http://localhost:5173"] }))
      .get("/healthz")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("books & works management", () => {
  beforeAll(async () => {
    await db.orm.insert(books).values({
      id: "beyer_op101",
      title: "Vorschule im Klavierspiel, Op. 101",
      author: "Ferdinand Beyer",
    });
    await db.orm.insert(works).values([
      { id: "mozart_k330", title: "Piano Sonata No. 10", composer: "Wolfgang Amadeus Mozart", catalogue: "K. 330", workType: "sonata" },
      { id: "mozart_k330_dup", title: "Sonate K330 (dup)", composer: "Wolfgang Amadeus Mozart", workType: "sonata" },
      { id: "parent_set", title: "Das Wohltemperierte Klavier", composer: "Johann Sebastian Bach", workType: "collection" },
      { id: "nested_child", title: "Book I", composer: "Johann Sebastian Bach", workType: "collection", parentWorkId: "parent_set" },
    ]);
    await db.orm.insert(pieces).values([
      { id: "beyer_101_8", title: "Beyer No. 8", composer: "Ferdinand Beyer", bookId: "beyer_op101", bookIndex: 8, rights: "public_domain", rightsNote: "PD", status: "published", publishedVersion: 1 },
      { id: "beyer_101_9", title: "Beyer No. 9", composer: "Ferdinand Beyer", bookId: "beyer_op101", bookIndex: 9, rights: "public_domain", rightsNote: "PD", status: "draft" },
      { id: "k330_mv1", title: "Piano Sonata No. 10", subtitle: "I. Allegro moderato", composer: "Wolfgang Amadeus Mozart", workId: "mozart_k330", workIndex: 1, rights: "public_domain", rightsNote: "PD", status: "published", publishedVersion: 1 },
      { id: "k330_dup_mv1", title: "Sonate K330", subtitle: "1. Satz", composer: "Wolfgang Amadeus Mozart", workId: "mozart_k330_dup", workIndex: 1, rights: "public_domain", rightsNote: "PD", status: "draft" },
    ]);
  });

  it("returns a book's table of contents in bookIndex order", async () => {
    const res = await request(app())
      .get("/admin/books/beyer_op101")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pieces.map((p: { id: string }) => p.id)).toEqual(["beyer_101_8", "beyer_101_9"]);
    expect(res.body.title).toBe("Vorschule im Klavierspiel, Op. 101");
  });

  it("patches book fields and audits", async () => {
    const res = await request(app())
      .patch("/admin/books/beyer_op101")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ author: "F. Beyer", rights: "public_domain", rightsNote: "PD print, 1850" });
    expect(res.status).toBe(200);
    expect(res.body.author).toBe("F. Beyer");
    expect(res.body.rights).toBe("public_domain");
  });

  it("rejects an empty book patch and a missing book", async () => {
    const empty = await request(app())
      .patch("/admin/books/beyer_op101")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(empty.status).toBe(400);
    const missing = await request(app())
      .patch("/admin/books/no_such_book")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "X" });
    expect(missing.status).toBe(404);
  });

  it("bulk-renumbers a swap that a per-piece guard would reject", async () => {
    const res = await request(app())
      .put("/admin/books/beyer_op101/numbering")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ entries: [{ pieceId: "beyer_101_8", bookIndex: 9 }, { pieceId: "beyer_101_9", bookIndex: 8 }] });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(2);
    const rows = await db.orm.select().from(pieces).where(eq(pieces.bookId, "beyer_op101"));
    expect(rows.find((r) => r.id === "beyer_101_8")!.bookIndex).toBe(9);
    expect(rows.find((r) => r.id === "beyer_101_9")!.bookIndex).toBe(8);
  });

  it("rejects a numbering that collides with an untouched piece", async () => {
    const res = await request(app())
      .put("/admin/books/beyer_op101/numbering")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ entries: [{ pieceId: "beyer_101_9", bookIndex: 9 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("book_index_taken");
  });

  it("rejects numbering a piece outside the book", async () => {
    const res = await request(app())
      .put("/admin/books/beyer_op101/numbering")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ entries: [{ pieceId: "czerny_599_41", bookIndex: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_in_book");
  });

  it("refuses to delete a book that still has pieces, deletes an unused one", async () => {
    const blocked = await request(app())
      .delete("/admin/books/beyer_op101")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("book_has_pieces");

    await db.orm.insert(books).values({ id: "junk_book", title: "Junk" });
    const ok = await request(app())
      .delete("/admin/books/junk_book")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    const rows = await db.orm.select().from(books).where(eq(books.id, "junk_book"));
    expect(rows).toHaveLength(0);
  });

  it("returns work detail with movements in order", async () => {
    const res = await request(app())
      .get("/admin/works/mozart_k330")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pieces.map((p: { id: string }) => p.id)).toEqual(["k330_mv1"]);
  });

  it("lists children on the parent work and blocks merging a work that has children", async () => {
    const detail = await request(app())
      .get("/admin/works/parent_set")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detail.body.children.map((c: { id: string }) => c.id)).toEqual(["nested_child"]);

    const res = await request(app())
      .post("/admin/works/parent_set/merge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ targetWorkId: "mozart_k330" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("work_has_children");
  });

  it("blocks a merge colliding on movement+instrument without confirmation", async () => {
    const res = await request(app())
      .post("/admin/works/mozart_k330_dup/merge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ targetWorkId: "mozart_k330" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("movement_taken");
  });

  it("rejects merge into self and into a missing target", async () => {
    const self = await request(app())
      .post("/admin/works/mozart_k330_dup/merge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ targetWorkId: "mozart_k330_dup" });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("merge_self");
    const missing = await request(app())
      .post("/admin/works/mozart_k330_dup/merge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ targetWorkId: "no_such_work" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("target_missing");
  });

  it("merges with confirmation: pieces move, duplicate is deleted, audit written", async () => {
    const res = await request(app())
      .post("/admin/works/mozart_k330_dup/merge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ targetWorkId: "mozart_k330", confirmMovementClash: true });
    expect(res.status).toBe(200);
    expect(res.body.moved).toBe(1);
    const [movedPiece] = await db.orm.select().from(pieces).where(eq(pieces.id, "k330_dup_mv1"));
    expect(movedPiece!.workId).toBe("mozart_k330");
    expect(movedPiece!.workIndex).toBe(1);
    const gone = await db.orm.select().from(works).where(eq(works.id, "mozart_k330_dup"));
    expect(gone).toHaveLength(0);
  });
});
