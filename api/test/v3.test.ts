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
import { users, pieces, studioJobs, works } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { StudioStore, CatalogStore } from "../src/storage";
import type { JobQueue } from "../src/queue";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let adminToken: string;

function fakeStudio(): StudioStore & { jsons: { path: string; body: unknown }[]; copies: { from: string; to: string }[] } {
  const s = {
    jsons: [] as { path: string; body: unknown }[],
    copies: [] as { from: string; to: string }[],
    async uploadSource() {},
    async copySource() {},
    async copyWithinBundles(from: string, to: string) {
      s.copies.push({ from, to });
    },
    async putBundleJson(path: string, body: unknown) {
      s.jsons.push({ path, body });
    },
    async putBundleBlob() {},
    bundleUrl: (p: string) => `https://test.blob.core.windows.net/piece-bundles/${p}`,
    sourceUrl: (p: string) => `https://test.blob.core.windows.net/piece-sources/${p}`,
    async listSources() {
      return [];
    },
  };
  return s;
}

function fakeQueue(): JobQueue & { preflights: unknown[]; sent: unknown[] } {
  const q = {
    preflights: [] as unknown[],
    sent: [] as unknown[],
    async send(b: Record<string, unknown>) {
      q.sent.push(b);
    },
    async sendPreflight(b: Record<string, unknown>) {
      q.preflights.push(b);
    },
  };
  return q;
}

const fakeCatalog: CatalogStore = {
  async readCatalog() {
    return {};
  },
  signReadUrl: (u) => `${u}?sig=t`,
};

function makeApp(over: { studio?: StudioStore; queue?: JobQueue } = {}) {
  return createServer({
    db,
    auth: verifier,
    studio: over.studio ?? fakeStudio(),
    piecesQueue: over.queue ?? fakeQueue(),
    catalog: fakeCatalog,
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  verifier = createJoseVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet({ keys: [jwk] }) });
  adminToken = await new SignJWT({ oid: "admin-oid" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  db = await createTestDb();
  await db.orm.insert(users).values({ entraOid: "admin-oid", email: "admin@k.com", isAdmin: true });
});

describe("works lifecycle", () => {
  it("creates a work with grammar slug and dedupes by normalized catalogue", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/admin/works")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Piano Sonata No. 13 in C major", composer: "W. A. Mozart", catalogue: "K. 330", workType: "sonata" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("mozart_k330");

    const dup = await request(app)
      .post("/admin/works")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Sonata in C K330", composer: "Wolfgang Amadeus Mozart", catalogue: "K330" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("work_exists");
    expect(dup.body.work.id).toBe("mozart_k330");
  });

  it("RESTRICTs deleting a work with pieces attached", async () => {
    await db.orm.insert(pieces).values({
      id: "mozart_k330_mvt1",
      title: "Piano Sonata No. 13",
      composer: "W. A. Mozart",
      subtitle: "I. Allegro moderato",
      rights: "public_domain",
      rightsNote: "seed",
      workId: "mozart_k330",
      workIndex: 1,
      status: "published",
      publishedVersion: 1,
    });
    const res = await request(makeApp())
      .delete("/admin/works/mozart_k330")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("work_has_pieces");
  });

  it("searches works", async () => {
    const res = await request(makeApp())
      .get("/admin/works?q=k. 330")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].id).toBe("mozart_k330");
    expect(res.body.items[0].pieceCount).toBe(1);
  });
});

describe("checks: work-aware findings", () => {
  it("errors on duplicate new-work catalogue, warns on same movement+instrument", async () => {
    const res = await request(makeApp())
      .post("/admin/studio/checks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ composer: "W. A. Mozart", work: { catalogue: "k.330" } });
    expect(res.body.findings.some((f: { code: string }) => f.code === "work_exists")).toBe(true);

    const res2 = await request(makeApp())
      .post("/admin/studio/checks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ composer: "W. A. Mozart", instrument: "piano", work: { id: "mozart_k330", index: 1 } });
    expect(res2.body.findings.some((f: { code: string }) => f.code === "movement_taken")).toBe(true);

    const res3 = await request(makeApp())
      .post("/admin/studio/checks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ composer: "W. A. Mozart", instrument: "violin", work: { id: "mozart_k330", index: 1 } });
    expect(res3.body.findings.some((f: { code: string }) => f.code === "movement_other_instrument")).toBe(true);
  });
});

describe("solo-part change resets preflight", () => {
  it("PATCH soloPart clears gates and re-queues preflight", async () => {
    const queue = fakeQueue();
    const app = makeApp({ queue });
    const draft = await request(app)
      .post("/admin/studio/drafts")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("musicxml", Buffer.from("<score/>"), "x.musicxml")
      .attach("midi", Buffer.from("MThd"), "x.mid");
    expect(draft.status).toBe(201);
    await db.orm
      .update(studioJobs)
      .set({ checkStatus: "pass", gates: { sanity: { status: "pass", metrics: { solo_part: "P1" } } } })
      .where(eq(studioJobs.id, draft.body.id));

    const res = await request(app)
      .patch(`/admin/studio/jobs/${draft.body.id}/metadata`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ soloPart: "P2" });
    expect(res.status).toBe(200);
    expect(res.body.checkStatus).toBe("pending");
    expect(res.body.gates).toEqual({});
    expect(queue.preflights).toHaveLength(2); // initial + reset

    // Title-only patch must NOT reset.
    await db.orm.update(studioJobs).set({ checkStatus: "pass" }).where(eq(studioJobs.id, draft.body.id));
    const res2 = await request(app)
      .patch(`/admin/studio/jobs/${draft.body.id}/metadata`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Renamed" });
    expect(res2.body.checkStatus).toBe("pass");
    expect(queue.preflights).toHaveLength(2);
  });
});

describe("instrument at draft creation + change resets preflight", () => {
  it("POST drafts seeds metadata.instrument; invalid value is rejected", async () => {
    const app = makeApp();
    const draft = await request(app)
      .post("/admin/studio/drafts")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("instrument", "violin")
      .attach("musicxml", Buffer.from("<score/>"), "x.musicxml")
      .attach("midi", Buffer.from("MThd"), "x.mid");
    expect(draft.status).toBe(201);
    expect((draft.body.metadata as { instrument: string }).instrument).toBe("violin");

    const bad = await request(app)
      .post("/admin/studio/drafts")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("instrument", "kazoo")
      .attach("musicxml", Buffer.from("<score/>"), "x.musicxml")
      .attach("midi", Buffer.from("MThd"), "x.mid");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_instrument");

    const defaulted = await request(app)
      .post("/admin/studio/drafts")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("musicxml", Buffer.from("<score/>"), "x.musicxml")
      .attach("midi", Buffer.from("MThd"), "x.mid");
    expect((defaulted.body.metadata as { instrument: string }).instrument).toBe("piano");
  });

  it("PATCH instrument clears gates and re-queues preflight; same value does not", async () => {
    const queue = fakeQueue();
    const app = makeApp({ queue });
    const draft = await request(app)
      .post("/admin/studio/drafts")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("instrument", "violin")
      .attach("musicxml", Buffer.from("<score/>"), "x.musicxml")
      .attach("midi", Buffer.from("MThd"), "x.mid");
    await db.orm
      .update(studioJobs)
      .set({ checkStatus: "pass", gates: { sanity: { status: "pass", metrics: {} } } })
      .where(eq(studioJobs.id, draft.body.id));

    const res = await request(app)
      .patch(`/admin/studio/jobs/${draft.body.id}/metadata`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ instrument: "guitar" });
    expect(res.status).toBe(200);
    expect(res.body.checkStatus).toBe("pending");
    expect(res.body.gates).toEqual({});
    expect(queue.preflights).toHaveLength(2); // initial + reset

    await db.orm.update(studioJobs).set({ checkStatus: "pass" }).where(eq(studioJobs.id, draft.body.id));
    const same = await request(app)
      .patch(`/admin/studio/jobs/${draft.body.id}/metadata`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ instrument: "guitar" });
    expect(same.body.checkStatus).toBe("pass");
    expect(queue.preflights).toHaveLength(2);
  });
});

describe("publish v3", () => {
  it("filters preview audio via role allowlist, persists work/instrumentation/facts, emits works[] in catalog", async () => {
    const studio = fakeStudio();
    const app = makeApp({ studio });
    const [job] = await db.orm
      .insert(studioJobs)
      .values({
        pieceId: "mozart_k330_mvt2",
        status: "ready_for_review",
        checkStatus: "pass",
        metadata: {
          title: "Piano Sonata No. 13",
          composer: "W. A. Mozart",
          subtitle: "II. Andante cantabile",
          rights: "public_domain",
          rightsNote: "seed",
          instrument: "piano",
          soloPart: "P1",
          work: { id: "mozart_k330", index: 2 },
          book: null,
        },
        sources: [],
        gates: {
          sanity: { status: "pass", metrics: { solo_part: "P1", xml_meta: { key: { fifths: -1 }, time: "3/4", measures: 64, tempo_bpm: 60, tempo_source: "xml", n_parts: 1, parts: [] } } },
          alignment: { status: "pass", metrics: { duration_sec: 240 } },
          geometry: { status: "pass", metrics: { engine_sha: "verovio-6.2.1" } },
        },
        artifacts: [
          { role: "score_events", path: "staging/j/score_events.json", bytes: 1, sha256: "a" },
          { role: "svg", variant: "phone", path: "staging/j/score.phone.svg", bytes: 2, sha256: "b" },
          { role: "preview_audio", path: "staging/j/preview.m4a", bytes: 3, sha256: "c" },
        ],
      })
      .returning();

    const res = await request(app)
      .post(`/admin/studio/jobs/${job.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    // preview never copied into the bundle
    expect(studio.copies.map((c) => c.to)).toEqual([
      "mozart_k330_mvt2/v1/score_events.json",
      "mozart_k330_mvt2/v1/score.phone.svg",
    ]);

    const [p] = await db.orm.select().from(pieces).where(eq(pieces.id, "mozart_k330_mvt2"));
    expect(p.workId).toBe("mozart_k330");
    expect(p.workIndex).toBe(2);
    expect((p.instrumentation as { solo: string }).solo).toBe("piano");
    expect((p.facts as { measures: number }).measures).toBe(64);

    const cat = studio.jsons.find((j) => j.path === "catalog.json")!.body as {
      pieces: { id: string; work_id?: string; work_title?: string; facts?: { measures: number } }[];
      works: { id: string; catalogue: string }[];
    };
    const entry = cat.pieces.find((x) => x.id === "mozart_k330_mvt2")!;
    expect(entry.work_id).toBe("mozart_k330");
    expect(entry.work_title).toContain("Sonata");
    expect(entry.facts!.measures).toBe(64);
    expect(cat.works.some((w) => w.id === "mozart_k330" && w.catalogue === "K. 330")).toBe(true);
  });

  it("409s publish when the part stamp mismatches the metadata", async () => {
    const [job] = await db.orm
      .insert(studioJobs)
      .values({
        pieceId: "stamp_test",
        status: "ready_for_review",
        checkStatus: "pass",
        metadata: { title: "T", composer: "C", rights: "licensed", rightsNote: "", instrument: "piano", soloPart: "P2", work: null, book: null },
        sources: [],
        gates: { sanity: { status: "pass", metrics: { solo_part: "P1" } } },
        artifacts: [{ role: "score_events", path: "s/x.json", bytes: 1, sha256: "z" }],
      })
      .returning();
    const res = await request(makeApp())
      .post(`/admin/studio/jobs/${job.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("stale_artifacts");
  });
});

describe("one open draft per piece", () => {
  it("409s a second pinned draft while one is open", async () => {
    const app = makeApp();
    const first = await request(app)
      .post("/admin/studio/drafts?piece=mozart_k330_mvt1")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("musicxml", Buffer.from("<s/>"), "a.musicxml")
      .attach("midi", Buffer.from("MThd"), "a.mid");
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/admin/studio/drafts?piece=mozart_k330_mvt1")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("musicxml", Buffer.from("<s/>"), "b.musicxml")
      .attach("midi", Buffer.from("MThd"), "b.mid");
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("piece_has_open_draft");
  });
});

describe("capability filter", () => {
  it("hides non-piano pieces from default /v1/catalog, shows with ?caps=instruments", async () => {
    const catalogDoc = {
      catalog_version: 1,
      pieces: [
        { id: "piano_piece", files: [] },
        { id: "violin_piece", instrumentation: { solo: "violin", parts: ["violin"] }, work_id: "w_v", files: [] },
      ],
      works: [{ id: "w_v" }],
    };
    const store: CatalogStore = {
      async readCatalog() {
        return catalogDoc;
      },
      signReadUrl: (u) => u,
    };
    const app = createServer({ db, auth: verifier, catalog: store });

    const plain = await request(app).get("/v1/catalog");
    expect(plain.status).toBe(200);
    expect(plain.body.pieces.map((p: { id: string }) => p.id)).toEqual(["piano_piece"]);
    expect(plain.body.works).toEqual([]);

    const caps = await request(app).get("/v1/catalog?caps=instruments");
    expect(caps.body.pieces).toHaveLength(2);
    expect(caps.body.works).toHaveLength(1);
  });
});

describe("library work membership editing", () => {
  it("PATCH edits membership with clash-confirm; list/detail expose work context", async () => {
    const app = makeApp();
    await db.orm.insert(pieces).values({
      id: "mozart_k330_alt",
      title: "Sonata facile alt",
      composer: "W. A. Mozart",
      rights: "public_domain",
      rightsNote: "seed",
      status: "published",
      publishedVersion: 1,
    });

    // same work + same movement + same (default piano) instrument → must confirm
    const clash = await request(app)
      .patch("/admin/pieces/mozart_k330_alt")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ workId: "mozart_k330", workIndex: 1 });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe("movement_taken");

    const ok = await request(app)
      .patch("/admin/pieces/mozart_k330_alt")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ workId: "mozart_k330", workIndex: 1, confirmMovementClash: true });
    expect(ok.status).toBe(200);
    expect(ok.body.workId).toBe("mozart_k330");
    expect(ok.body.workIndex).toBe(1);

    // moving to a free number needs no confirm
    const move = await request(app)
      .patch("/admin/pieces/mozart_k330_alt")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ workIndex: 3 });
    expect(move.status).toBe(200);
    expect(move.body.workIndex).toBe(3);

    // a movement number without a work is meaningless
    await db.orm.insert(pieces).values({
      id: "loner", title: "Loner", composer: "X", rights: "licensed",
      status: "published", publishedVersion: 1,
    });
    const bad = await request(app)
      .patch("/admin/pieces/loner")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ workIndex: 2 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("work_index_without_work");

    const missing = await request(app)
      .patch("/admin/pieces/loner")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ workId: "nonexistent_work" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("work_missing");

    // list joins work title + catalogue for search/columns
    const list = await request(app).get("/admin/pieces").set("Authorization", `Bearer ${adminToken}`);
    const row = list.body.items.find((p: { id: string }) => p.id === "mozart_k330_alt");
    expect(row.workTitle).toContain("Sonata");
    expect(row.workCatalogue).toBe("K. 330");

    // detail carries the work row + every sibling in the composition
    const det = await request(app).get("/admin/pieces/mozart_k330_alt").set("Authorization", `Bearer ${adminToken}`);
    expect(det.body.work.id).toBe("mozart_k330");
    expect(det.body.workSiblings.some((s: { id: string }) => s.id === "mozart_k330_mvt1")).toBe(true);

    // detaching from the work clears the movement number with it
    const clear = await request(app)
      .patch("/admin/pieces/mozart_k330_alt")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ workId: null });
    expect(clear.status).toBe(200);
    expect(clear.body.workId).toBeNull();
    expect(clear.body.workIndex).toBeNull();
  });
});
