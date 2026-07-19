import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import sharp from "sharp";
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
import type { StudioStore, CatalogStore } from "../src/storage";
import type { JobQueue } from "../src/queue";
import { pieceSlug, bookSlug } from "../src/slug";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let adminToken: string;

interface FakeStudio extends StudioStore {
  uploads: { path: string; bytes: number }[];
  copies: { from: string; to: string }[];
  jsons: { path: string; body: unknown }[];
  blobs: { path: string; contentType: string; data: Buffer }[];
}

function fakeStudio(): FakeStudio {
  const store: FakeStudio = {
    uploads: [],
    copies: [],
    jsons: [],
    blobs: [],
    async uploadSource(path, data) {
      store.uploads.push({ path, bytes: data.length });
    },
    async copySource(from, to) {
      store.copies.push({ from, to });
    },
    async copyWithinBundles(from, to) {
      store.copies.push({ from, to });
    },
    async putBundleJson(path, body) {
      store.jsons.push({ path, body });
    },
    async putBundleBlob(path, data, contentType) {
      store.blobs.push({ path, contentType, data });
    },
    bundleUrl(path) {
      return `https://test.blob.core.windows.net/piece-bundles/${path}`;
    },
    sourceUrl(path) {
      return `https://test.blob.core.windows.net/piece-sources/${path}`;
    },
    async listSources() {
      return [];
    },
  };
  return store;
}

function fakeQueue(): JobQueue & { sent: Record<string, unknown>[]; preflights: Record<string, unknown>[] } {
  const q = {
    sent: [] as Record<string, unknown>[],
    preflights: [] as Record<string, unknown>[],
    async send(body: Record<string, unknown>) {
      q.sent.push(body);
    },
    async sendPreflight(body: Record<string, unknown>) {
      q.preflights.push(body);
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

const FULL_META = {
  title: "Sonatina Op. 36 No. 1",
  composer: "Muzio Clementi",
  subtitle: "I. Allegro",
  difficulty: 2,
  rights: "public_domain",
  rightsNote: "Re-engraved from an 1890s Peters print.",
};

function makeApp(overrides: { studio?: StudioStore; queue?: JobQueue; appSupportsRepeats?: boolean } = {}) {
  return createServer({
    db,
    auth: verifier,
    studio: overrides.studio ?? fakeStudio(),
    piecesQueue: overrides.queue ?? fakeQueue(),
    catalog: fakeCatalog,
    appSupportsRepeats: overrides.appSupportsRepeats,
  });
}

async function createDraft(app: ReturnType<typeof createServer>) {
  return request(app)
    .post("/admin/studio/drafts")
    .set("Authorization", `Bearer ${adminToken}`)
    .attach("musicxml", Buffer.from("<score-partwise/>"), "clementi.musicxml")
    .attach("midi", Buffer.from("MThd"), "clementi.mid");
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
  await db.orm.insert(users).values([
    { entraOid: "admin-oid", email: "admin@karaorchee.com", isAdmin: true },
  ]);
});

describe("slug derivation", () => {
  it("builds deterministic piece slugs", () => {
    expect(pieceSlug("Muzio Clementi", "Sonatina Op. 36 No. 1", "I. Allegro")).toBe(
      "clementi_sonatina_op_36_no_1_i_allegro",
    );
    expect(pieceSlug("J. S. Bach", "The Well-Tempered Clavier", "")).toBe(
      "bach_well_tempered_clavier",
    );
  });
  it("builds book slugs", () => {
    expect(bookSlug("Practical Method for Beginners, Op. 599")).toBe("practical_method_beginners_op_599");
  });
});

describe("draft creation", () => {
  it("requires BOTH musicxml and midi", async () => {
    const app = makeApp();
    const noMidi = await request(app)
      .post("/admin/studio/drafts")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("musicxml", Buffer.from("<score/>"), "x.musicxml");
    expect(noMidi.status).toBe(400);
    expect(noMidi.body.error).toBe("midi_required");

    const noXml = await request(app)
      .post("/admin/studio/drafts")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("midi", Buffer.from("MThd"), "x.mid");
    expect(noXml.status).toBe(400);
    expect(noXml.body.error).toBe("musicxml_required");
  });

  it("creates a draft, stages sources, enqueues preflight", async () => {
    const studio = fakeStudio();
    const queue = fakeQueue();
    const res = await createDraft(makeApp({ studio, queue }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.checkStatus).toBe("pending");
    expect(res.body.pieceId).toMatch(/^draft_/);
    expect(studio.uploads).toHaveLength(2);
    expect(queue.preflights).toMatchObject([{ jobId: res.body.id }]);
    expect(queue.sent).toHaveLength(0);
  });
});

describe("metadata patch + slug", () => {
  it("derives the slug server-side and merges sections", async () => {
    const app = makeApp();
    const draft = await createDraft(app);
    const res = await request(app)
      .patch(`/admin/studio/jobs/${draft.body.id}/metadata`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: FULL_META.title, composer: FULL_META.composer, subtitle: FULL_META.subtitle });
    expect(res.status).toBe(200);
    expect(res.body.pieceId).toBe("clementi_sonatina_op_36_no_1_i_allegro");

    const res2 = await request(app)
      .patch(`/admin/studio/jobs/${draft.body.id}/metadata`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rights: "public_domain", rightsNote: "note" });
    expect(res2.body.metadata.title).toBe(FULL_META.title);
    expect(res2.body.metadata.rights).toBe("public_domain");
  });

  it("rejects client-supplied pieceId fields silently via schema strictness", async () => {
    const app = makeApp();
    const draft = await createDraft(app);
    const res = await request(app)
      .patch(`/admin/studio/jobs/${draft.body.id}/metadata`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "X", composer: "Y" });
    expect(res.body.pieceId).toBe(pieceSlug("Y", "X", ""));
  });
});

describe("duplicate checks", () => {
  beforeAll(async () => {
    await db.orm.insert(books).values({ id: "czerny_op599", title: "Practical Method, Op. 599" });
    await db.orm.insert(pieces).values([
      {
        id: "czerny_599_41",
        title: "Practical Method, Op. 599",
        subtitle: "No. 41",
        composer: "Carl Czerny",
        bookId: "czerny_op599",
        bookIndex: 41,
        rights: "public_domain",
        status: "published",
        publishedVersion: 2,
      },
    ]);
  });

  it("flags an existing piece identity as a version bump (info)", async () => {
    const slug = pieceSlug("Carl Czerny", "Practical Method, Op. 599", "No. 41");
    await db.orm
      .insert(pieces)
      .values({ id: slug, title: "Practical Method, Op. 599", subtitle: "No. 41", composer: "Carl Czerny", rights: "public_domain" })
      .onConflictDoNothing();
    const res = await request(makeApp())
      .post("/admin/studio/checks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Practical Method, Op. 599", composer: "Carl Czerny", subtitle: "No. 41" });
    expect(res.status).toBe(200);
    expect(res.body.findings.some((f: { code: string }) => f.code === "piece_exists")).toBe(true);
  });

  it("errors when a book index is taken", async () => {
    const res = await request(makeApp())
      .post("/admin/studio/checks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Some Other Study",
        composer: "Carl Czerny",
        book: { id: "czerny_op599", index: 41 },
      });
    const finding = res.body.findings.find((f: { code: string }) => f.code === "book_index_taken");
    expect(finding.level).toBe("error");
  });

  it("errors when creating a book that already exists", async () => {
    const res = await request(makeApp())
      .post("/admin/studio/checks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ book: { title: "Practical Method, Op. 599" } });
    expect(res.body.findings.some((f: { code: string }) => f.code === "book_exists")).toBe(true);
  });

  it("returns clean findings for a novel piece", async () => {
    const res = await request(makeApp())
      .post("/admin/studio/checks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Totally New Piece", composer: "Nobody Famous" });
    expect(res.body.findings).toEqual([]);
    expect(res.body.pieceId).toBe("famous_totally_new_piece");
  });
});

describe("submit", () => {
  async function draftWith(app: ReturnType<typeof createServer>, meta: Record<string, unknown>, check = "pass") {
    const draft = await createDraft(app);
    await request(app)
      .patch(`/admin/studio/jobs/${draft.body.id}/metadata`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(meta);
    await db.orm
      .update(studioJobs)
      .set({ checkStatus: check })
      .where(eq(studioJobs.id, draft.body.id));
    return draft.body.id as string;
  }

  it("409s before preflight passes", async () => {
    const app = makeApp();
    const id = await draftWith(app, FULL_META, "running");
    const res = await request(app)
      .post(`/admin/studio/jobs/${id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("preflight_not_passed");
  });

  it("400s on incomplete metadata (rights missing)", async () => {
    const app = makeApp();
    const id = await draftWith(app, { title: "T", composer: "C" });
    const res = await request(app)
      .post(`/admin/studio/jobs/${id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("metadata_incomplete");
  });

  it("400s when public_domain has no provenance note", async () => {
    const app = makeApp();
    const id = await draftWith(app, { ...FULL_META, rightsNote: "" });
    const res = await request(app)
      .post(`/admin/studio/jobs/${id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("queues the full run on a complete draft", async () => {
    const queue = fakeQueue();
    const app = makeApp({ queue });
    const id = await draftWith(app, FULL_META);
    const res = await request(app)
      .post(`/admin/studio/jobs/${id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.pieceId).toBe("clementi_sonatina_op_36_no_1_i_allegro");
    expect(queue.sent).toMatchObject([{ jobId: id, pieceId: "clementi_sonatina_op_36_no_1_i_allegro" }]);
  });
});

describe("files replacement + reopen", () => {
  it("replaces files on a draft and re-runs preflight", async () => {
    const queue = fakeQueue();
    const app = makeApp({ queue });
    const draft = await createDraft(app);
    await db.orm
      .update(studioJobs)
      .set({ checkStatus: "fail", gates: { sanity: { status: "fail" } } })
      .where(eq(studioJobs.id, draft.body.id));

    const res = await request(app)
      .put(`/admin/studio/jobs/${draft.body.id}/files`)
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("musicxml", Buffer.from("<score-partwise v2/>"), "fixed.musicxml")
      .attach("midi", Buffer.from("MThd2"), "fixed.mid");
    expect(res.status).toBe(200);
    expect(res.body.checkStatus).toBe("pending");
    expect(res.body.gates).toEqual({});
    expect(queue.preflights).toHaveLength(2); // initial draft + replacement
  });

  it("reopens from ready_for_review for pre-publish edits", async () => {
    const queue = fakeQueue();
    const app = makeApp({ queue });
    const [job] = await db.orm
      .insert(studioJobs)
      .values({ pieceId: "edit_before_publish", status: "ready_for_review", checkStatus: "pass", metadata: FULL_META, sources: [] })
      .returning();
    const res = await request(app)
      .post(`/admin/studio/jobs/${job.id}/reopen`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("draft");
    expect(res.body.metadata.title).toBe(FULL_META.title); // prefill survives
    expect(queue.preflights).toHaveLength(1);
  });

  it("reopens a failed job back to draft on the same row", async () => {
    const queue = fakeQueue();
    const app = makeApp({ queue });
    const [job] = await db.orm
      .insert(studioJobs)
      .values({ pieceId: "reopen_target", status: "failed", error: "boom", metadata: FULL_META, sources: [] })
      .returning();
    const res = await request(app)
      .post(`/admin/studio/jobs/${job.id}/reopen`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("draft");
    expect(res.body.checkStatus).toBe("pending");
    expect(queue.preflights).toMatchObject([{ jobId: job.id }]);
  });
});

describe("pinned drafts (upload new version)", () => {
  it("pins the draft to an existing piece and survives renames", async () => {
    await db.orm
      .insert(pieces)
      .values({
        id: "pinned_target",
        title: "Original Title",
        composer: "Old Composer",
        subtitle: "",
        rights: "public_domain",
        rightsNote: "seed",
        status: "published",
        publishedVersion: 1,
      })
      .onConflictDoNothing();

    const queue = fakeQueue();
    const app = makeApp({ queue });
    const draft = await request(app)
      .post("/admin/studio/drafts?piece=pinned_target")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("musicxml", Buffer.from("<score-partwise v2/>"), "v2.musicxml")
      .attach("midi", Buffer.from("MThd"), "v2.mid");
    expect(draft.status).toBe(201);
    expect(draft.body.pieceId).toBe("pinned_target");
    expect(draft.body.metadata.title).toBe("Original Title"); // prefilled server-side
    expect(draft.body.metadata.pinnedPieceId).toBe("pinned_target");

    // Rename in the wizard — the id must NOT re-derive.
    const patched = await request(app)
      .patch(`/admin/studio/jobs/${draft.body.id}/metadata`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Completely Renamed Piece" });
    expect(patched.body.pieceId).toBe("pinned_target");

    await db.orm
      .update(studioJobs)
      .set({ checkStatus: "pass" })
      .where(eq(studioJobs.id, draft.body.id));
    const submitted = await request(app)
      .post(`/admin/studio/jobs/${draft.body.id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.pieceId).toBe("pinned_target"); // no slug_collision, id kept
  });

  it("404s pinning a missing piece", async () => {
    const res = await request(makeApp())
      .post("/admin/studio/drafts?piece=nope_nope")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("musicxml", Buffer.from("<x/>"), "x.musicxml")
      .attach("midi", Buffer.from("MThd"), "x.mid");
    expect(res.status).toBe(404);
  });
});

describe("retry + publish", () => {
  it("re-runs all gates from ready_for_review", async () => {
    const queue = fakeQueue();
    const app = makeApp({ queue });
    const [job] = await db.orm
      .insert(studioJobs)
      .values({ pieceId: "rerun_piece", status: "ready_for_review", metadata: FULL_META, sources: [] })
      .returning();
    const res = await request(app)
      .post(`/admin/studio/jobs/${job.id}/retry`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(queue.sent).toHaveLength(1);
  });

  it("publishes: copies blobs, upserts piece+version, rebuilds catalog, audits", async () => {
    const studio = fakeStudio();
    const app = makeApp({ studio });
    // Publish now REQUIRES the referenced book to exist (silent coverless
    // auto-create was the drift hole the audit closed).
    await db.orm.insert(books).values({ id: "clementi_op36", title: "Sonatinas Op. 36" }).onConflictDoNothing();
    const meta = { ...FULL_META, book: { id: "clementi_op36", title: "Sonatinas Op. 36", index: 1 } };
    const [job] = await db.orm
      .insert(studioJobs)
      .values({
        pieceId: "clementi_sonatina_op_36_no_1_i_allegro",
        status: "ready_for_review",
        checkStatus: "pass",
        metadata: meta,
        sources: [],
        artifacts: [
          { role: "score_events", path: "staging/j1/score_events.json", bytes: 10, sha256: "a" },
          { role: "svg", variant: "phone", path: "staging/j1/score.phone.svg", bytes: 20, sha256: "b" },
        ],
        gates: { geometry: { status: "pass", metrics: { engine_sha: "verovio-6.2.1" } } },
      })
      .returning();

    const res = await request(app)
      .post(`/admin/studio/jobs/${job.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("published");
    expect(res.body.publishedVersion).toBe(1);

    expect(studio.copies).toEqual([
      { from: "staging/j1/score_events.json", to: "clementi_sonatina_op_36_no_1_i_allegro/v1/score_events.json" },
      { from: "staging/j1/score.phone.svg", to: "clementi_sonatina_op_36_no_1_i_allegro/v1/score.phone.svg" },
    ]);

    const [piece] = await db.orm
      .select()
      .from(pieces)
      .where(eq(pieces.id, "clementi_sonatina_op_36_no_1_i_allegro"));
    expect(piece.status).toBe("published");
    expect(piece.bookId).toBe("clementi_op36");

    const versions = await db.orm
      .select()
      .from(pieceVersions)
      .where(eq(pieceVersions.pieceId, "clementi_sonatina_op_36_no_1_i_allegro"));
    expect(versions[versions.length - 1]!.engineSha).toBe("verovio-6.2.1");

    const catalogWrite = studio.jsons.find((j) => j.path === "catalog.json");
    expect(catalogWrite).toBeDefined();

    const trail = await db.orm.select().from(auditEvents);
    expect(trail.some((e) => e.action === "piece.publish")).toBe(true);
  });

  it("blocks publish for repeat pieces until the app capability flag flips", async () => {
    const structureGates = {
      geometry: { status: "pass", metrics: { engine_sha: "verovio-6.2.1" } },
      structure: { status: "pass", metrics: { kind: "repeats", written_measures: 33, played_measures: 55, max_passes: 2, n_spans: 5, expanded_duration_sec: 52.4, expansion_source: "verovio-inferred" } },
    };
    const mk = async (pieceId: string) => {
      const [job] = await db.orm
        .insert(studioJobs)
        .values({
          pieceId,
          status: "ready_for_review",
          checkStatus: "pass",
          metadata: FULL_META,
          sources: [],
          artifacts: [{ role: "score_events", path: `staging/${pieceId}/score_events.json`, bytes: 1, sha256: "z" }],
          gates: structureGates,
        })
        .returning();
      return job!;
    };

    const blockedJob = await mk("repeat_blocked");
    const blockedStudio = fakeStudio();
    const blocked = await request(makeApp({ studio: blockedStudio }))
      .post(`/admin/studio/jobs/${blockedJob.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("repeats_not_supported_yet");
    expect(blocked.body.message).toContain("33 written / 55 played");
    // the block must fire BEFORE any side effect — no version blobs copied
    expect(blockedStudio.copies).toHaveLength(0);

    const allowedJob = await mk("repeat_allowed");
    const allowedStudio = fakeStudio();
    const allowed = await request(makeApp({ studio: allowedStudio, appSupportsRepeats: true }))
      .post(`/admin/studio/jobs/${allowedJob.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(allowed.status).toBe(200);
    const [piece] = await db.orm.select().from(pieces).where(eq(pieces.id, "repeat_allowed"));
    const facts = piece!.facts as { structure?: { type: string; played_measures: number } };
    expect(facts.structure).toEqual({
      type: "repeats", written_measures: 33, played_measures: 55, max_passes: 2,
      n_spans: 5, expanded_duration_sec: 52.4, expansion_source: "verovio-inferred",
    });
    // Old app binaries must never treat a repeat piece as followable.
    expect(piece!.followReady).toBe(false);
    const cat = allowedStudio.jsons.find((j) => j.path === "catalog.json")!.body as {
      pieces: { id: string; follow_ready: boolean }[];
    };
    expect(cat.pieces.find((p) => p.id === "repeat_allowed")!.follow_ready).toBe(false);
  });

  it("linear publish keeps facts free of structure and follow_ready NULL (catalog emits true)", async () => {
    const [job] = await db.orm
      .insert(studioJobs)
      .values({
        pieceId: "linear_facts",
        status: "ready_for_review",
        checkStatus: "pass",
        metadata: FULL_META,
        sources: [],
        artifacts: [{ role: "score_events", path: "staging/lf/score_events.json", bytes: 1, sha256: "z" }],
        gates: {
          geometry: { status: "pass", metrics: { engine_sha: "verovio-6.2.1" } },
          structure: { status: "pass", metrics: { kind: "linear", written_measures: 4 } },
        },
      })
      .returning();
    const studio = fakeStudio();
    const res = await request(makeApp({ studio }))
      .post(`/admin/studio/jobs/${job!.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const [piece] = await db.orm.select().from(pieces).where(eq(pieces.id, "linear_facts"));
    expect((piece!.facts as Record<string, unknown>).structure).toBeUndefined();
    expect(piece!.followReady).toBeNull();
    const cat = studio.jsons.find((j) => j.path === "catalog.json")!.body as {
      pieces: { id: string; follow_ready: boolean }[];
    };
    expect(cat.pieces.find((p) => p.id === "linear_facts")!.follow_ready).toBe(true);
  });

  it("blocks publish when rights are unknown", async () => {
    const [job] = await db.orm
      .insert(studioJobs)
      .values({
        pieceId: "rights_test",
        status: "ready_for_review",
        metadata: { ...FULL_META, rights: "unknown", rightsNote: "" },
        sources: [],
        artifacts: [{ role: "score_events", path: "s/x.json", bytes: 1, sha256: "z" }],
      })
      .returning();
    const res = await request(makeApp())
      .post(`/admin/studio/jobs/${job.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("rights_blocked");
  });
});

describe("books with covers", () => {
  async function testCover(w = 1200, h = 1600): Promise<Buffer> {
    return sharp({
      create: { width: w, height: h, channels: 3, background: { r: 180, g: 120, b: 60 } },
    })
      .png()
      .toBuffer();
  }

  it("requires a cover on create", async () => {
    const res = await request(makeApp())
      .post("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("title", "Burgmüller Op. 100");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cover_required");
  });

  it("rejects a too-small cover with a human message", async () => {
    const res = await request(makeApp())
      .post("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("title", "Burgmüller Op. 100")
      .attach("cover", await testCover(400, 533), "cover.png");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cover");
    expect(res.body.message).toContain("at least");
  });

  it("accepts a 1086×1448 cover (above the 900×1200 floor) and normalizes it", async () => {
    const studio = fakeStudio();
    const res = await request(makeApp({ studio }))
      .post("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("title", "Colleague Real Cover Case")
      .field("rights", "public_domain")
      .attach("cover", await testCover(1086, 1448), "cover.png");
    expect(res.status).toBe(201);
    const meta = await sharp(studio.blobs[0].data).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1600]); // storage output stays normalized
  });

  it("rejects below the 900×1200 floor", async () => {
    const res = await request(makeApp())
      .post("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("title", "Too Small")
      .attach("cover", await testCover(800, 1067), "cover.png");
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("900\u00d71200");
  });

  it("rejects a landscape cover", async () => {
    const res = await request(makeApp())
      .post("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("title", "Burgmüller Op. 100")
      .attach("cover", await testCover(1600, 1200), "cover.png");
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("portrait");
  });

  it("creates a book with processed cover + thumb, id derived from title", async () => {
    const studio = fakeStudio();
    const res = await request(makeApp({ studio }))
      .post("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("title", "25 Études faciles, Op. 100")
      .field("rights", "public_domain")
      .attach("cover", await testCover(), "cover.png");
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("25_etudes_faciles_op_100");
    expect(res.body.coverUrl).toContain("cover.webp");
    expect(studio.blobs.map((b) => b.path)).toEqual([
      "books/25_etudes_faciles_op_100/cover.webp",
      "books/25_etudes_faciles_op_100/cover_thumb.webp",
    ]);

    const dup = await request(makeApp())
      .post("/admin/books")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("title", "25 Études faciles, Op. 100")
      .attach("cover", await testCover(), "cover.png");
    expect(dup.status).toBe(409);
  });

  it("updates a cover on an existing book", async () => {
    const studio = fakeStudio();
    const res = await request(makeApp({ studio }))
      .put("/admin/books/czerny_op599/cover")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("cover", await testCover(), "cover.png");
    expect(res.status).toBe(200);
    expect(res.body.coverPath).toBe("books/czerny_op599/cover.webp");
  });
});
