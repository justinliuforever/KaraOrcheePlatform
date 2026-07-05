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
});
