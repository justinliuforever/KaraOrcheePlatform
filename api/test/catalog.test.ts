import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server";
import { CatalogNotFoundError, type CatalogStore } from "../src/storage";

const sampleCatalog = () => ({
  pieces: [
    {
      id: "bach_bwv_846",
      files: [{ role: "score", url: "https://acct.blob.core.windows.net/piece-bundles/bach/score.mid" }],
      stems: [
        { name: "piano", url: "https://acct.blob.core.windows.net/piece-bundles/bach/stem1.wav" },
        { name: "strings", url: "https://acct.blob.core.windows.net/piece-bundles/bach/stem2.wav" },
      ],
    },
  ],
});

function fakeStore(overrides: Partial<CatalogStore> = {}): CatalogStore {
  return {
    async readCatalog() {
      return sampleCatalog();
    },
    signReadUrl(url) {
      return `${url}?sig=fake`;
    },
    ...overrides,
  };
}

describe("GET /v1/catalog", () => {
  it("suffixes every files[].url and stems[].url with a read SAS", async () => {
    const app = createServer({ catalog: fakeStore() });
    const res = await request(app).get("/v1/catalog");
    expect(res.status).toBe(200);
    const piece = res.body.pieces[0];
    expect(piece.files[0].url).toBe(
      "https://acct.blob.core.windows.net/piece-bundles/bach/score.mid?sig=fake",
    );
    for (const stem of piece.stems) {
      expect(stem.url.endsWith("?sig=fake")).toBe(true);
    }
  });

  it("returns 404 when the catalog blob is missing", async () => {
    const app = createServer({
      catalog: fakeStore({
        async readCatalog() {
          throw new CatalogNotFoundError();
        },
      }),
    });
    const res = await request(app).get("/v1/catalog");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "catalog_not_published" });
  });

  it("returns 503 when storage is not configured", async () => {
    const res = await request(createServer({})).get("/v1/catalog");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "storage_not_configured" });
  });

  it("serves the catalog from cache without re-reading the blob", async () => {
    let reads = 0;
    const app = createServer({
      catalog: fakeStore({
        async readCatalog() {
          reads += 1;
          return sampleCatalog();
        },
      }),
    });
    await request(app).get("/v1/catalog");
    await request(app).get("/v1/catalog");
    expect(reads).toBe(1);
  });
});

describe("GET /v1/pieces/:id/download", () => {
  it("returns the single piece with signed urls", async () => {
    const app = createServer({ catalog: fakeStore() });
    const res = await request(app).get("/v1/pieces/bach_bwv_846/download");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("bach_bwv_846");
    expect(res.body.files[0].url.endsWith("?sig=fake")).toBe(true);
  });

  it("returns 404 for a piece not in the catalog", async () => {
    const app = createServer({ catalog: fakeStore() });
    const res = await request(app).get("/v1/pieces/nope/download");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "piece_not_found" });
  });

  it("does not mutate the cached catalog when signing", async () => {
    const app = createServer({ catalog: fakeStore() });
    await request(app).get("/v1/pieces/bach_bwv_846/download");
    const res = await request(app).get("/v1/pieces/bach_bwv_846/download");
    expect(res.body.files[0].url.match(/sig=fake/g)?.length).toBe(1);
  });
});
