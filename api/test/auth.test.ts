import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
  type JWK,
} from "jose";
import { createServer } from "../src/server";
import { createJoseVerifier, requireAuth, type AuthVerifier } from "../src/auth";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let privateKey: CryptoKey;
let verifier: AuthVerifier;

async function sign(claims: Record<string, unknown>, opts: { exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  verifier = createJoseVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks });
});

describe("requireAuth fail-closed", () => {
  it("returns 503 auth_not_configured on a protected route when auth is unconfigured", async () => {
    const res = await request(createServer({})).post("/v1/users/sync");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "auth_not_configured", message: "KaraOrchee is having trouble right now." });
  });

  it("returns 401 when the token is missing", async () => {
    const res = await request(createServer({ auth: verifier })).post("/v1/users/sync");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized", message: "Sign in again to continue." });
  });

  it("returns 401 on a garbage token", async () => {
    const res = await request(createServer({ auth: verifier }))
      .post("/v1/users/sync")
      .set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized", message: "Sign in again to continue." });
  });

  it("returns 401 on an expired token", async () => {
    const token = await sign({ oid: "abc" }, { exp: "-1m" });
    const res = await request(createServer({ auth: verifier }))
      .post("/v1/users/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe("requireAuth accepts a valid locally-signed token", () => {
  function protectedApp(v: AuthVerifier) {
    const app = express();
    app.get("/protected", requireAuth(v), (req, res) => {
      res.json({ user: req.user });
    });
    return app;
  }

  it("passes and populates req.user from claims", async () => {
    const token = await sign({
      oid: "oid-123",
      email: "player@example.com",
      name: "Ada Lovelace",
    });
    const res = await request(protectedApp(verifier))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      oid: "oid-123",
      email: "player@example.com",
      name: "Ada Lovelace",
    });
  });

  it("falls back to preferred_username when email is absent", async () => {
    const token = await sign({
      oid: "oid-456",
      preferred_username: "fallback@example.com",
      name: "Grace Hopper",
    });
    const res = await request(protectedApp(verifier))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("fallback@example.com");
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await new SignJWT({ oid: "oid-789" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience("api://someone-else")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const res = await request(protectedApp(verifier))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

// Every authenticated body is per-identity. Without these two headers, "account B never
// sees account A's inbox" holds only because no cache happens to sit between them.
describe("authenticated responses are not cacheable and key on the bearer", () => {
  function protectedApp(v: AuthVerifier) {
    const app = express();
    app.get("/protected", requireAuth(v), (req, res) => {
      res.json({ user: req.user });
    });
    return app;
  }

  it("a 200 carries Cache-Control: no-store and Vary: Authorization", async () => {
    const token = await sign({ oid: "oid-cache" });
    const res = await request(protectedApp(verifier))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["vary"]?.toLowerCase().split(/\s*,\s*/)).toContain("authorization");
  });

  it("a 401 carries them too — a cached rejection is as wrong as a cached inbox", async () => {
    const res = await request(protectedApp(verifier)).get("/protected");
    expect(res.status).toBe(401);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["vary"]?.toLowerCase().split(/\s*,\s*/)).toContain("authorization");
  });

  it("Vary: Origin from cors survives alongside it", async () => {
    const token = await sign({ oid: "oid-cors" });
    const res = await request(createServer({ auth: verifier, corsOrigins: ["https://admin.test"] }))
      .post("/v1/users/sync")
      .set("Origin", "https://admin.test")
      .set("Authorization", `Bearer ${token}`);
    const vary = res.headers["vary"]?.toLowerCase().split(/\s*,\s*/) ?? [];
    expect(vary).toContain("origin");
    expect(vary).toContain("authorization");
  });

  it("the PUBLIC catalog is left cacheable", async () => {
    const res = await request(createServer({ auth: verifier })).get("/v1/catalog");
    expect(res.headers["cache-control"]).toBeUndefined();
  });
});
