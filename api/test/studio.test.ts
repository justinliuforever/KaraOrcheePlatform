import { describe, it, expect, beforeAll } from "vitest";
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
import { users, pieces, pieceVersions, studioJobs, auditEvents, books } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { StudioStore } from "../src/storage";
import type { JobQueue } from "../src/queue";
import type { CatalogStore } from "../src/storage";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let adminToken: string;
let plainToken: string;

interface FakeStudio extends StudioStore {
  uploads: { path: string; bytes: number }[];
  copies: { from: string; to: string }[];
  jsons: { path: string; body: unknown }[];
}

function fakeStudio(): FakeStudio {
  const store: FakeStudio = {
    uploads: [],
    copies: [],
    jsons: [],
    async uploadSource(path, data) {
      store.uploads.push({ path, bytes: data.length });
    },
    async copyWithinBundles(from, to) {
      store.copies.push({ from, to });
    },
    async putBundleJson(path, body) {
      store.jsons.push({ path, body });
    },
    bundleUrl(path) {
      return `https://test.blob.core.windows.net/piece-bundles/${path}`;
    },
  };
  return store;
}

function fakeQueue(): JobQueue & { sent: Record<string, unknown>[] } {
  const q = {
    sent: [] as Record<string, unknown>[],
    async send(body: Record<string, unknown>) {
      q.sent.push(body);
    },
  };
  return q;
}

const fakeCatalog: CatalogStore = {
  async readCatalog() {
    return {};
  },
  signReadUrl(url) {
    return `${url}?sig=test`;
  },
};

const META = {
  pieceId: "clementi_op36_1",
  title: "Sonatina Op. 36 No. 1",
  composer: "Muzio Clementi",
  subtitle: "I. Allegro",
  rights: "public_domain",
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  verifier = createJoseVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet({ keys: [jwk] }) });
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey);

  db = await createTestDb();
  await db.orm.insert(users).values([
    { entraOid: "admin-oid", email: "admin@karaorchee.com", isAdmin: true },
    { entraOid: "plain-oid", email: "player@example.com" },
  ]);
  adminToken = await sign({ oid: "admin-oid" });
  plainToken = await sign({ oid: "plain-oid" });
});

describe("studio job creation", () => {
  it("403s a non-admin", async () => {
    const res = await request(createServer({ db, auth: verifier, studio: fakeStudio(), piecesQueue: fakeQueue() }))
      .post("/admin/studio/jobs")
      .set("Authorization", `Bearer ${plainToken}`)
      .field("metadata", JSON.stringify(META))
      .attach("musicxml", Buffer.from("<score/>"), "piece.musicxml");
    expect(res.status).toBe(403);
  });

  it("503s when studio deps are unconfigured", async () => {
    const res = await request(createServer({ db, auth: verifier }))
      .post("/admin/studio/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("metadata", JSON.stringify(META))
      .attach("musicxml", Buffer.from("<score/>"), "piece.musicxml");
    expect(res.status).toBe(503);
  });

  it("rejects a bad slug", async () => {
    const res = await request(createServer({ db, auth: verifier, studio: fakeStudio(), piecesQueue: fakeQueue() }))
      .post("/admin/studio/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("metadata", JSON.stringify({ ...META, pieceId: "Bad Slug!" }))
      .attach("musicxml", Buffer.from("<score/>"), "piece.musicxml");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_metadata");
  });

  it("requires a musicxml file", async () => {
    const res = await request(createServer({ db, auth: verifier, studio: fakeStudio(), piecesQueue: fakeQueue() }))
      .post("/admin/studio/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("metadata", JSON.stringify(META));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("musicxml_required");
  });

  it("creates a job: uploads sources, inserts row, enqueues, audits", async () => {
    const studio = fakeStudio();
    const queue = fakeQueue();
    const res = await request(createServer({ db, auth: verifier, studio, piecesQueue: queue }))
      .post("/admin/studio/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("metadata", JSON.stringify(META))
      .attach("musicxml", Buffer.from("<score-partwise/>"), "clementi.musicxml")
      .attach("midi", Buffer.from("MThd"), "clementi.mid");
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.pieceId).toBe(META.pieceId);
    expect(res.body.sources).toHaveLength(2);

    expect(studio.uploads.map((u) => u.path)).toEqual([
      `staging/${res.body.id}/clementi.musicxml`,
      `staging/${res.body.id}/clementi.mid`,
    ]);
    expect(queue.sent).toEqual([{ jobId: res.body.id, pieceId: META.pieceId }]);

    const trail = await db.orm.select().from(auditEvents);
    expect(trail.some((e) => e.action === "studio.job.create" && e.subjectId === res.body.id)).toBe(true);
  });
});

describe("studio retry", () => {
  it("re-enqueues a failed job and 409s otherwise", async () => {
    const queue = fakeQueue();
    const app = createServer({ db, auth: verifier, studio: fakeStudio(), piecesQueue: queue });
    const [job] = await db.orm
      .insert(studioJobs)
      .values({ pieceId: "retry_target", status: "failed", error: "boom", metadata: META, sources: [] })
      .returning();

    const ok = await request(app)
      .post(`/admin/studio/jobs/${job.id}/retry`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("queued");
    expect(ok.body.error).toBeNull();
    expect(queue.sent).toHaveLength(1);

    const again = await request(app)
      .post(`/admin/studio/jobs/${job.id}/retry`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(again.status).toBe(409);
  });
});

describe("studio publish", () => {
  async function seedReviewJob(meta: Record<string, unknown>) {
    const [job] = await db.orm
      .insert(studioJobs)
      .values({
        pieceId: String(meta.pieceId),
        status: "ready_for_review",
        metadata: meta,
        sources: [],
        artifacts: [
          { role: "score_events", path: "staging/j1/score_events.json", bytes: 10, sha256: "a" },
          { role: "staff_svg", variant: "phone", path: "staging/j1/staff_phone.svg", bytes: 20, sha256: "b" },
        ],
        gates: { geometry: { status: "pass", metrics: { engine_sha: "verovio-6.2.1" } } },
      })
      .returning();
    return job;
  }

  it("blocks publish when rights are unknown", async () => {
    const job = await seedReviewJob({ ...META, pieceId: "rights_test", rights: "unknown" });
    const res = await request(createServer({ db, auth: verifier, studio: fakeStudio(), piecesQueue: fakeQueue() }))
      .post(`/admin/studio/jobs/${job.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("rights_blocked");
  });

  it("publishes: copies blobs, upserts piece+version, rebuilds catalog, audits", async () => {
    const studio = fakeStudio();
    const meta = { ...META, difficulty: 2, book: { id: "clementi_op36", title: "Sonatinas Op. 36", index: 1 } };
    const job = await seedReviewJob(meta);
    const res = await request(createServer({ db, auth: verifier, studio, piecesQueue: fakeQueue(), catalog: fakeCatalog }))
      .post(`/admin/studio/jobs/${job.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("published");
    expect(res.body.publishedVersion).toBe(1);

    expect(studio.copies).toEqual([
      { from: "staging/j1/score_events.json", to: "clementi_op36_1/v1/score_events.json" },
      { from: "staging/j1/staff_phone.svg", to: "clementi_op36_1/v1/staff_phone.svg" },
    ]);

    const [piece] = await db.orm.select().from(pieces).where(eq(pieces.id, "clementi_op36_1"));
    expect(piece.status).toBe("published");
    expect(piece.publishedVersion).toBe(1);
    expect(piece.bookId).toBe("clementi_op36");

    const [book] = await db.orm.select().from(books).where(eq(books.id, "clementi_op36"));
    expect(book.title).toBe("Sonatinas Op. 36");

    const versions = await db.orm
      .select()
      .from(pieceVersions)
      .where(eq(pieceVersions.pieceId, "clementi_op36_1"));
    expect(versions).toHaveLength(1);
    expect(versions[0].engineSha).toBe("verovio-6.2.1");

    const catalogWrite = studio.jsons.find((j) => j.path === "catalog.json");
    expect(catalogWrite).toBeDefined();
    const cat = catalogWrite!.body as { pieces: { id: string; tier: string; bundle_version: number; files: { url: string }[] }[] };
    const entry = cat.pieces.find((p) => p.id === "clementi_op36_1")!;
    expect(entry.tier).toBe("experimental");
    expect(entry.bundle_version).toBe(1);
    expect(entry.files[0].url).toContain("clementi_op36_1/v1/");

    const trail = await db.orm.select().from(auditEvents);
    expect(trail.some((e) => e.action === "piece.publish" && e.subjectId === "clementi_op36_1")).toBe(true);
  });

  it("409s publish on a non-reviewed job", async () => {
    const [job] = await db.orm
      .insert(studioJobs)
      .values({ pieceId: "queued_piece", status: "queued", metadata: META, sources: [] })
      .returning();
    const res = await request(createServer({ db, auth: verifier, studio: fakeStudio(), piecesQueue: fakeQueue() }))
      .post(`/admin/studio/jobs/${job.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
  });
});

describe("books admin", () => {
  it("creates and lists books, rejects duplicates", async () => {
    const app = createServer({ db, auth: verifier });
    const create = await request(app)
      .post("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ id: "burgmuller_op100", title: "25 Études faciles, Op. 100", rights: "public_domain" });
    expect(create.status).toBe(201);

    const dup = await request(app)
      .post("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ id: "burgmuller_op100", title: "dup" });
    expect(dup.status).toBe(409);

    const list = await request(app)
      .get("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((b: { id: string }) => b.id === "burgmuller_op100")).toBe(true);
  });
});
