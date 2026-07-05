import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server";
import type { Db } from "../src/db/client";

function fakeDb(ping: () => Promise<void>): Db {
  return { orm: {} as Db["orm"], ping };
}

describe("GET /healthz", () => {
  it("reports db:unconfigured when no db is injected", async () => {
    const res = await request(createServer({})).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: "unconfigured" });
  });

  it("reports db:ok when ping succeeds", async () => {
    const app = createServer({ db: fakeDb(async () => {}) });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: "ok" });
  });

  it("reports db:error (still HTTP 200) when ping throws", async () => {
    const app = createServer({
      db: fakeDb(async () => {
        throw new Error("down");
      }),
    });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: "error" });
  });
});
