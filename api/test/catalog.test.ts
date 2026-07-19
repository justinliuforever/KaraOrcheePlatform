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

describe("top-level url signing", () => {
  it("signs book cover_url and piece thumbnail_url (private container — unsigned = 403)", async () => {
    const app = createServer({
      catalog: fakeStore({
        async readCatalog() {
          return {
            pieces: [{
              id: "p1",
              book_id: "b1",
              thumbnail_url: "https://acct.blob.core.windows.net/piece-bundles/p1/thumb.webp",
              row_icon_url: "https://acct.blob.core.windows.net/piece-bundles/p1/row_icon.webp",
            }],
            books: [{ id: "b1", cover_url: "https://acct.blob.core.windows.net/piece-bundles/books/b1/cover.webp" }],
          };
        },
      }),
    });
    const res = await request(app).get("/v1/catalog");
    expect(res.status).toBe(200);
    expect(res.body.books[0].cover_url.endsWith("?sig=fake")).toBe(true);
    expect(res.body.pieces[0].thumbnail_url.endsWith("?sig=fake")).toBe(true);
    expect(res.body.pieces[0].row_icon_url.endsWith("?sig=fake")).toBe(true);
  });

  it("capability gate trims books whose pieces are all filtered", async () => {
    const app = createServer({
      catalog: fakeStore({
        async readCatalog() {
          return {
            pieces: [
              { id: "v1", instrumentation: { solo: "violin", parts: ["violin"] }, book_id: "vb" },
              { id: "p1", book_id: "pb" },
            ],
            books: [{ id: "vb" }, { id: "pb" }],
          };
        },
      }),
    });
    const res = await request(app).get("/v1/catalog");
    expect(res.body.pieces.map((p: { id: string }) => p.id)).toEqual(["p1"]);
    expect(res.body.books.map((b: { id: string }) => b.id)).toEqual(["pb"]);
    const caps = await request(app).get("/v1/catalog?caps=instruments");
    expect(caps.body.books).toHaveLength(2);
  });
});

describe("repeats capability gate", () => {
  const repeatsStore = () =>
    fakeStore({
      async readCatalog() {
        return {
          pieces: [
            { id: "linear_piece", book_id: "pb", work_id: "pw", files: [] },
            {
              id: "repeat_piece",
              facts: { structure: { type: "repeats", written_measures: 33, played_measures: 55 } },
              book_id: "rb",
              work_id: "rw",
              files: [],
            },
            {
              id: "violin_piece",
              instrumentation: { solo: "violin", parts: ["violin"] },
              book_id: "vb",
              work_id: "vw",
              files: [],
            },
          ],
          works: [{ id: "pw" }, { id: "rw" }, { id: "vw" }],
          books: [{ id: "pb" }, { id: "rb" }, { id: "vb" }],
        };
      },
    });

  it("hides repeat pieces from a no-caps client, shows them with ?caps=repeats", async () => {
    const app = createServer({ catalog: repeatsStore() });
    const plain = await request(app).get("/v1/catalog");
    expect(plain.status).toBe(200);
    expect(plain.body.pieces.map((p: { id: string }) => p.id)).toEqual(["linear_piece"]);
    const caps = await request(app).get("/v1/catalog?caps=repeats");
    expect(caps.body.pieces.map((p: { id: string }) => p.id)).toEqual([
      "linear_piece",
      "repeat_piece",
    ]);
  });

  it("composes with the instruments filter and trims works/books to the combined survivors", async () => {
    const app = createServer({ catalog: repeatsStore() });
    const plain = await request(app).get("/v1/catalog");
    expect(plain.body.works.map((w: { id: string }) => w.id)).toEqual(["pw"]);
    expect(plain.body.books.map((b: { id: string }) => b.id)).toEqual(["pb"]);

    const repeatsOnly = await request(app).get("/v1/catalog?caps=repeats");
    expect(repeatsOnly.body.works.map((w: { id: string }) => w.id)).toEqual(["pw", "rw"]);
    expect(repeatsOnly.body.books.map((b: { id: string }) => b.id)).toEqual(["pb", "rb"]);

    const instrumentsOnly = await request(app).get("/v1/catalog?caps=instruments");
    expect(instrumentsOnly.body.pieces.map((p: { id: string }) => p.id)).toEqual([
      "linear_piece",
      "violin_piece",
    ]);
    expect(instrumentsOnly.body.works.map((w: { id: string }) => w.id)).toEqual(["pw", "vw"]);

    const both = await request(app).get("/v1/catalog?caps=instruments,repeats");
    expect(both.body.pieces).toHaveLength(3);
    expect(both.body.works).toHaveLength(3);
    expect(both.body.books).toHaveLength(3);
  });

  it("blocks download of a repeat piece without caps=repeats, allows with it", async () => {
    const app = createServer({ catalog: repeatsStore() });
    const blocked = await request(app).get("/v1/pieces/repeat_piece/download");
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({
      error: "capability_required",
      piece: "repeat_piece",
      requires: "repeats",
    });
    const allowed = await request(app).get("/v1/pieces/repeat_piece/download?caps=repeats");
    expect(allowed.status).toBe(200);
    expect(allowed.body.id).toBe("repeat_piece");
    const linear = await request(app).get("/v1/pieces/linear_piece/download");
    expect(linear.status).toBe(200);
  });
});
