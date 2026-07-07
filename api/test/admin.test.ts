import { describe, it, expect, beforeAll } from "vitest";
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
import { users, books, pieces, pieceVersions } from "../src/db/schema";
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
