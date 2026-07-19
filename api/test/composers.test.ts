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
import { users, books, composers, pieces, pieceVersions, works } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { StudioStore, CatalogStore } from "../src/storage";
import { rebuildCatalog } from "../src/catalog_build";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let adminToken: string;

function fakeStudio(): StudioStore & {
  jsons: { path: string; body: unknown }[];
  blobs: { path: string; data: Buffer }[];
  deleted: string[];
} {
  const s = {
    jsons: [] as { path: string; body: unknown }[],
    blobs: [] as { path: string; data: Buffer }[],
    deleted: [] as string[],
    async uploadSource() {},
    async copySource() {},
    async copyWithinBundles() {},
    async putBundleJson(path: string, body: unknown) {
      s.jsons.push({ path, body });
    },
    async putBundleBlob(path: string, data: Buffer) {
      s.blobs.push({ path, data });
    },
    bundleUrl: (p: string) => `https://test.blob.core.windows.net/piece-bundles/${p}`,
    sourceUrl: (p: string) => `https://test.blob.core.windows.net/piece-sources/${p}`,
    async listSources() {
      return [];
    },
    async deleteBundleBlob(path: string) {
      s.deleted.push(path);
    },
  };
  return s;
}

const fakeCatalog: CatalogStore = {
  async readCatalog() {
    return {};
  },
  signReadUrl: (u) => `${u}?sig=t`,
};

function makeApp(studio: StudioStore = fakeStudio()) {
  return createServer({ db, auth: verifier, studio, catalog: fakeCatalog });
}

async function testPortrait(w = 512, h = 640): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 40, g: 60, b: 120 } },
  })
    .png()
    .toBuffer();
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  verifier = createJoseVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet({ keys: [jwk] }) });
  adminToken = await new SignJWT({ oid: "admin-oid", email: "admin@k.com" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  db = await createTestDb();
  await db.orm.insert(users).values({ entraOid: "admin-oid", email: "admin@k.com", isAdmin: true });

  await db.orm.insert(books).values({
    id: "czerny_op599",
    title: "Practical Method, Op. 599",
    pieceCount: 98,
    description: "Progressive elementary studies.",
  });
  await db.orm.insert(works).values({
    id: "burgmuller_op100",
    title: "25 Études faciles",
    composer: "Johann Friedrich Burgmüller",
    catalogue: "Op. 100",
    workType: "etude_set",
    movementCount: 25,
  });
  await db.orm.insert(pieces).values([
    {
      id: "czerny_599_3",
      title: "Practical Method, Op. 599",
      subtitle: "No. 3",
      composer: "Carl Czerny",
      bookId: "czerny_op599",
      bookIndex: 3,
      rights: "public_domain",
      rightsNote: "PD",
      status: "published",
      publishedVersion: 1,
    },
    {
      id: "burgmuller_100_2",
      title: "25 Études faciles",
      subtitle: "No. 2 Arabesque",
      // Alias form on purpose: registry must match it through aliases.
      composer: "J. F. Burgmüller",
      workId: "burgmuller_op100",
      workIndex: 2,
      rights: "public_domain",
      rightsNote: "PD",
      status: "published",
      publishedVersion: 1,
    },
    {
      id: "burgmuller_100_3",
      title: "25 Études faciles",
      subtitle: "No. 3 Pastorale",
      composer: "Johann Friedrich Burgmüller",
      workId: "burgmuller_op100",
      workIndex: 3,
      rights: "public_domain",
      rightsNote: "PD",
      status: "draft",
    },
    {
      id: "ghost_piece",
      title: "Unpublished Ghost",
      composer: "Nobody Registered",
      rights: "public_domain",
      rightsNote: "PD",
      status: "draft",
    },
  ]);
  await db.orm.insert(pieceVersions).values([
    { pieceId: "czerny_599_3", version: 1, files: [{ role: "score_events", path: "czerny_599_3/v1/score_events.json" }] },
    { pieceId: "burgmuller_100_2", version: 1, files: [{ role: "score_events", path: "burgmuller_100_2/v1/score_events.json" }] },
  ]);
});

describe("composers CRUD", () => {
  it("creates a composer with slug id and aliases", async () => {
    const res = await request(makeApp())
      .post("/admin/composers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Johann Friedrich Burgmüller",
        sortName: "Burgmüller, Johann Friedrich",
        aliases: ["J. F. Burgmüller", "Friedrich Burgmüller"],
        birthYear: 1806,
        deathYear: 1874,
        bio: "German pianist and composer of pedagogical études.",
        sourceUrl: "https://en.wikipedia.org/wiki/Friedrich_Burgm%C3%BCller",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("johann_friedrich_burgmuller");
    expect(res.body.aliases).toEqual(["J. F. Burgmüller", "Friedrich Burgmüller"]);
    expect(res.body.birthYear).toBe(1806);
    expect(res.body.deathYear).toBe(1874);
    expect(res.body.bio).toContain("pedagogical");
    expect(res.body.portraitUrl).toBeNull();
  });

  it("409s a duplicate name", async () => {
    const res = await request(makeApp())
      .post("/admin/composers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Johann Friedrich Burgmüller" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("composer_exists");
  });

  it("rejects an invalid source URL and an empty patch", async () => {
    const bad = await request(makeApp())
      .post("/admin/composers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "X Composer", sourceUrl: "not-a-url" });
    expect(bad.status).toBe(400);
    const empty = await request(makeApp())
      .patch("/admin/composers/johann_friedrich_burgmuller")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(empty.status).toBe(400);
  });

  it("patches fields and audits; 404s unknown ids", async () => {
    const res = await request(makeApp())
      .patch("/admin/composers/johann_friedrich_burgmuller")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ attribution: "Portrait: public domain, IMSLP scan", birthYear: 1806, bio: "Updated blurb." });
    expect(res.status).toBe(200);
    expect(res.body.attribution).toBe("Portrait: public domain, IMSLP scan");
    expect(res.body.birthYear).toBe(1806);
    expect(res.body.bio).toBe("Updated blurb.");

    const cleared = await request(makeApp())
      .patch("/admin/composers/johann_friedrich_burgmuller")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bio: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bio).toBeNull();

    const badYear = await request(makeApp())
      .patch("/admin/composers/johann_friedrich_burgmuller")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ birthYear: 180 });
    expect(badYear.status).toBe(400);

    await request(makeApp())
      .patch("/admin/composers/johann_friedrich_burgmuller")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bio: "German pianist and composer of pedagogical études." });

    const missing = await request(makeApp())
      .patch("/admin/composers/no_such_composer")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ attribution: "x" });
    expect(missing.status).toBe(404);
  });

  it("409s renaming onto another entry's name", async () => {
    await request(makeApp())
      .post("/admin/composers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Carl Czerny" });
    const res = await request(makeApp())
      .patch("/admin/composers/carl_czerny")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Johann Friedrich Burgmüller" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("composer_exists");
  });

  it("requires admin auth", async () => {
    const res = await request(makeApp()).get("/admin/composers");
    expect(res.status).toBe(401);
  });
});

describe("composers list: usage + unregistered", () => {
  it("counts usage across name AND aliases", async () => {
    const res = await request(makeApp())
      .get("/admin/composers")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const burgmuller = res.body.items.find(
      (c: { id: string }) => c.id === "johann_friedrich_burgmuller",
    );
    // 1 piece under the canonical name + 1 under the "J. F. Burgmüller" alias.
    expect(burgmuller.usageCount).toBe(2);
    const czerny = res.body.items.find((c: { id: string }) => c.id === "carl_czerny");
    expect(czerny.usageCount).toBe(1);
  });

  it("classifies every distinct string: name match, alias match, unregistered", async () => {
    const res = await request(makeApp())
      .get("/admin/composers")
      .set("Authorization", `Bearer ${adminToken}`);
    const byValue = new Map(
      res.body.strings.map((s: { value: string }) => [s.value, s]),
    ) as Map<string, { matched: string | null; composerId: string | null; pieceCount: number; workCount: number }>;

    expect(byValue.get("Carl Czerny")!.matched).toBe("name");
    expect(byValue.get("J. F. Burgmüller")!.matched).toBe("alias");
    expect(byValue.get("J. F. Burgmüller")!.composerId).toBe("johann_friedrich_burgmuller");
    expect(byValue.get("Nobody Registered")!.matched).toBeNull();
    // Works-side strings count too (the work row carries the canonical form).
    expect(byValue.get("Johann Friedrich Burgmüller")!.workCount).toBe(1);

    expect(
      res.body.unregistered.map((s: { value: string }) => s.value),
    ).toContain("Nobody Registered");
    expect(
      res.body.unregistered.map((s: { value: string }) => s.value),
    ).not.toContain("Carl Czerny");
  });
});

describe("composer portrait", () => {
  it("processes to a square webp under composers/<id>/ and signs the url", async () => {
    const studio = fakeStudio();
    const res = await request(makeApp(studio))
      .put("/admin/composers/johann_friedrich_burgmuller/portrait")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("portrait", await testPortrait(), "portrait.png");
    expect(res.status).toBe(200);
    expect(res.body.portraitPath).toBe("composers/johann_friedrich_burgmuller/portrait.webp");
    expect(res.body.portraitUrl).toContain("portrait.webp");
    expect(res.body.portraitUrl).toContain("?sig=t");
    const blob = studio.blobs.find((b) => b.path.endsWith("portrait.webp"))!;
    const meta = await sharp(blob.data).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([512, 512, "webp"]);
  });

  it("rejects a too-small portrait with a human message", async () => {
    const res = await request(makeApp())
      .put("/admin/composers/johann_friedrich_burgmuller/portrait")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("portrait", await testPortrait(100, 100), "portrait.png");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_portrait");
    expect(res.body.message).toContain("at least");
  });

  it("400s a missing file and 404s an unknown composer", async () => {
    const missing = await request(makeApp())
      .put("/admin/composers/johann_friedrich_burgmuller/portrait")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("portrait_required");
    const ghost = await request(makeApp())
      .put("/admin/composers/no_such/portrait")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("portrait", await testPortrait(), "portrait.png");
    expect(ghost.status).toBe(404);
  });
});

describe("catalog emission", () => {
  it("emits authored totals on books/works and live-filtered composers[]", async () => {
    const studio = fakeStudio();
    await rebuildCatalog(db.orm, studio);
    const cat = studio.jsons.find((j) => j.path === "catalog.json")!.body as {
      books: { id: string; piece_count: number | null; description: string | null }[];
      works: { id: string; movement_count: number | null }[];
      composers: {
        name: string;
        sort_name: string | null;
        aliases: string[];
        birth_year: number | null;
        death_year: number | null;
        bio: string | null;
        portrait_url?: string;
      }[];
    };

    const book = cat.books.find((b) => b.id === "czerny_op599")!;
    expect(book.piece_count).toBe(98);
    expect(book.description).toBe("Progressive elementary studies.");

    const work = cat.works.find((w) => w.id === "burgmuller_op100")!;
    expect(work.movement_count).toBe(25);

    // Burgmüller matches a published piece VIA ALIAS; Czerny via name. An entry
    // matching only drafts/nothing must not leak (live-values law).
    expect(cat.composers.map((c) => c.name).sort()).toEqual([
      "Carl Czerny",
      "Johann Friedrich Burgmüller",
    ]);
    const b = cat.composers.find((c) => c.name === "Johann Friedrich Burgmüller")!;
    expect(b.sort_name).toBe("Burgmüller, Johann Friedrich");
    expect(b.aliases).toContain("J. F. Burgmüller");
    expect(b.birth_year).toBe(1806);
    expect(b.death_year).toBe(1874);
    expect(b.bio).toContain("pedagogical");
    // Nullable passthrough: Czerny was registered without years/bio.
    const cz = cat.composers.find((c) => c.name === "Carl Czerny")!;
    expect(cz.birth_year).toBeNull();
    expect(cz.bio).toBeNull();
    expect(b.portrait_url).toBe(
      "https://test.blob.core.windows.net/piece-bundles/composers/johann_friedrich_burgmuller/portrait.webp",
    );
  });

  it("drops a composer from the catalog once no published piece matches it", async () => {
    await db.orm
      .update(pieces)
      .set({ status: "archived" })
      .where(eq(pieces.id, "czerny_599_3"));
    const studio = fakeStudio();
    await rebuildCatalog(db.orm, studio);
    const cat = studio.jsons.find((j) => j.path === "catalog.json")!.body as {
      composers: { name: string }[];
    };
    expect(cat.composers.map((c) => c.name)).toEqual(["Johann Friedrich Burgmüller"]);
    await db.orm
      .update(pieces)
      .set({ status: "published" })
      .where(eq(pieces.id, "czerny_599_3"));
  });

  it("/v1/catalog signs composers[].portrait_url like cover_url", async () => {
    const store: CatalogStore = {
      async readCatalog() {
        return {
          pieces: [{ id: "p1", book_id: "b1" }],
          books: [{ id: "b1", cover_url: "https://acct.blob.core.windows.net/piece-bundles/books/b1/cover.webp" }],
          composers: [
            {
              name: "Carl Czerny",
              sort_name: "Czerny, Carl",
              aliases: [],
              portrait_url: "https://acct.blob.core.windows.net/piece-bundles/composers/carl_czerny/portrait.webp",
            },
          ],
        };
      },
      signReadUrl: (u) => `${u}?sig=fake`,
    };
    const app = createServer({ catalog: store });
    const res = await request(app).get("/v1/catalog");
    expect(res.status).toBe(200);
    // composers[] is additive: the caps gate must pass it through untouched.
    expect(res.body.composers).toHaveLength(1);
    expect(res.body.composers[0].portrait_url.endsWith("?sig=fake")).toBe(true);
    expect(res.body.books[0].cover_url.endsWith("?sig=fake")).toBe(true);
  });
});

describe("book/work PATCH: authored totals", () => {
  it("book PATCH accepts pieceCount + description and passes them through", async () => {
    const res = await request(makeApp())
      .patch("/admin/books/czerny_op599")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pieceCount: 100, description: "Updated blurb." });
    expect(res.status).toBe(200);
    expect(res.body.pieceCount).toBe(100);
    expect(res.body.description).toBe("Updated blurb.");

    const cleared = await request(makeApp())
      .patch("/admin/books/czerny_op599")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pieceCount: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.pieceCount).toBeNull();

    const bad = await request(makeApp())
      .patch("/admin/books/czerny_op599")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pieceCount: 0 });
    expect(bad.status).toBe(400);

    await request(makeApp())
      .patch("/admin/books/czerny_op599")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pieceCount: 98 });
  });

  it("work PATCH accepts movementCount; create accepts it too", async () => {
    const res = await request(makeApp())
      .patch("/admin/works/burgmuller_op100")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ movementCount: 25 });
    expect(res.status).toBe(200);
    expect(res.body.movementCount).toBe(25);

    const created = await request(makeApp())
      .post("/admin/works")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "18 Études", composer: "J. F. Burgmüller", catalogue: "Op. 109", workType: "etude_set", movementCount: 18 });
    expect(created.status).toBe(201);
    expect(created.body.movementCount).toBe(18);
  });
});
