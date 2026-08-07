import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
  type JWK,
} from "jose";
import { createServer } from "../src/server";
import { createJoseVerifier, type AuthVerifier } from "../src/auth";
import {
  createGraphClient,
  graphConfigFrom,
  graphFromEnv,
  unresolvedGraphLog,
  type GraphDeleteResult,
  type GraphIdentityClient,
} from "../src/graph";
import { createTestDb } from "./testdb";
import { auditEvents, users } from "../src/db/schema";
import type { Db } from "../src/db/client";

// W7: the account delete removes the CIAM identity, and a token from a deleted account
// can never re-create the row (B2); the age question is answered once, beside the role
// grant (B3). Own PGlite instance, oids prefixed "ai-".
const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;

interface FakeGraph extends GraphIdentityClient {
  calls: string[];
  /// What the users row looked like at the moment Graph was called — the only way to
  /// prove the platform purge ran first.
  rowsAtCall: { entraOid: string | null; status: string; ciamOidAtDelete: string | null }[];
  answer: GraphDeleteResult;
}

function makeFakeGraph(answer: GraphDeleteResult = { ok: true, status: 204 }): FakeGraph {
  const g: FakeGraph = {
    calls: [],
    rowsAtCall: [],
    answer,
    async deleteUser(oid: string) {
      g.calls.push(oid);
      const [row] = await db.orm
        .select({
          entraOid: users.entraOid,
          status: users.status,
          ciamOidAtDelete: users.ciamOidAtDelete,
        })
        .from(users)
        .where(eq(users.ciamOidAtDelete, oid));
      if (row) g.rowsAtCall.push(row);
      return g.answer;
    },
  };
  return g;
}

const fakeLessons = {
  blobPath: (t: string, l: string) => `${t}/${l}.m4a`,
  uploadUrl: (p: string) => `https://fake/${p}?sas`,
  async audioProps() {
    return { bytes: 1000 };
  },
  async deleteAudio() {},
};

let graph: FakeGraph;
let logged: string[];

function makeApp(withGraph = true) {
  return createServer({
    db,
    auth: verifier,
    lessons: fakeLessons,
    ...(withGraph ? { graph } : {}),
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  verifier = createJoseVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
  db = await createTestDb();
});

const realLog = console.log;

beforeEach(() => {
  graph = makeFakeGraph();
  logged = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
});

async function mkToken(oid: string, name?: string): Promise<string> {
  const claims: Record<string, unknown> = { oid };
  if (name) claims.name = name;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

async function sync(token: string, body: Record<string, unknown> = {}, withGraph = true) {
  return request(makeApp(withGraph)).post("/v1/users/sync").set("Authorization", `Bearer ${token}`).send(body);
}

async function makeUser(oid: string, role: "teacher" | "student" = "teacher") {
  const token = await mkToken(oid, "Test Person");
  const res = await sync(token, { role });
  expect(res.status).toBe(200);
  return { token, id: res.body.id as string, oid };
}

function events(kind: string): string[] {
  return logged.filter((line) => line.includes(`"kind":"${kind}"`));
}

// ── B2: the delete removes the directory identity ───────────────────────────────

describe("account delete removes the CIAM identity", () => {
  it("purges the platform row BEFORE calling Graph, and hands it the released oid", async () => {
    const u = await makeUser("ai-order");

    const del = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${u.token}`);
    expect(del.status).toBe(200);
    expect(del.body.identityDeleted).toBe(true);

    expect(graph.calls).toEqual([u.oid]);
    // Graph saw an already-scrubbed row: the purge is not waiting on the directory.
    expect(graph.rowsAtCall.length).toBe(1);
    expect(graph.rowsAtCall[0]!.status).toBe("deleted");
    expect(graph.rowsAtCall[0]!.entraOid).toBeNull();
    expect(graph.rowsAtCall[0]!.ciamOidAtDelete).toBe(u.oid);

    const [row] = await db.orm.select().from(users).where(eq(users.id, u.id));
    expect(row!.ciamDeletedAt).not.toBeNull();
    // Retained forever: it is what recognises a token from this deleted account.
    expect(row!.ciamOidAtDelete).toBe(u.oid);
  });

  it("Graph failure keeps ok:true, reports identityDeleted:false, and logs one pending event", async () => {
    const u = await makeUser("ai-graphfail");
    graph.answer = { ok: false, reason: "graph_http_500" };

    const del = await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${u.token}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    expect(del.body.identityDeleted).toBe(false);
    expect(events("ciam_delete_pending").length).toBe(1);

    const [row] = await db.orm.select().from(users).where(eq(users.id, u.id));
    expect(row!.ciamOidAtDelete).toBe(u.oid);
    expect(row!.ciamDeletedAt).toBeNull();
  });

  it("an unconfigured Graph credential never claims the identity was removed", async () => {
    const u = await makeUser("ai-nocreds");

    const del = await request(makeApp(false)).delete("/v1/me").set("Authorization", `Bearer ${u.token}`);
    expect(del.status).toBe(200);
    expect(del.body.identityDeleted).toBe(false);
    expect(events("ciam_delete_skipped").length).toBe(1);

    const [row] = await db.orm.select().from(users).where(eq(users.id, u.id));
    expect(row!.ciamOidAtDelete).toBe(u.oid);
    expect(row!.ciamDeletedAt).toBeNull();
  });

  it("a stamp that fails after Graph confirmed still answers 200 and identityDeleted:true", async () => {
    const u = await makeUser("ai-stampfail");
    let answered = false;
    const g: GraphIdentityClient = {
      async deleteUser() {
        answered = true;
        return { ok: true, status: 204 };
      },
    };
    const brittle: Db = {
      ping: db.ping,
      orm: new Proxy(db.orm, {
        get(target, prop) {
          if (prop === "update" && answered) {
            return () => {
              throw new Error("db_unavailable");
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as Db["orm"],
    };

    const del = await request(createServer({ db: brittle, auth: verifier, lessons: fakeLessons, graph: g }))
      .delete("/v1/me")
      .set("Authorization", `Bearer ${u.token}`);
    expect(del.status).toBe(200);
    expect(del.body.identityDeleted).toBe(true);
    expect(events("ciam_delete_stamp_failed").length).toBe(1);

    // The runbook query finds the unstamped row, and any retry answers 404 = removed.
    const [row] = await db.orm.select().from(users).where(eq(users.id, u.id));
    expect(row!.ciamOidAtDelete).toBe(u.oid);
    expect(row!.ciamDeletedAt).toBeNull();
  });

  it("the delete is audited before the identity step, so a Graph failure still leaves a record", async () => {
    const u = await makeUser("ai-audit");
    graph.answer = { ok: false, reason: "graph_http_503" };
    await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${u.token}`);
    const rows = await db.orm.select().from(auditEvents).where(eq(auditEvents.actorUserId, u.id));
    expect(rows.some((r) => r.action === "account.delete")).toBe(true);
  });
});

// ── B2: resurrection guard, both states ─────────────────────────────────────────

describe("a token from a deleted account can never re-create it", () => {
  it("pending state: 410, exactly one Graph retry, no new row", async () => {
    const u = await makeUser("ai-res-pending");
    graph.answer = { ok: false, reason: "graph_http_500" };
    await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${u.token}`);
    graph.calls = [];
    graph.answer = { ok: true, status: 204 };

    const before = await db.orm.select({ n: sql<number>`count(*)::int` }).from(users);
    const res = await sync(u.token);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("account_deleted");
    expect(res.body.message).toBe("This account was deleted.");
    expect(graph.calls).toEqual([u.oid]);
    const after = await db.orm.select({ n: sql<number>`count(*)::int` }).from(users);
    expect(after[0]!.n).toBe(before[0]!.n);

    // The retry that succeeded is recorded, so the next sync does not repeat it.
    const [row] = await db.orm.select().from(users).where(eq(users.id, u.id));
    expect(row!.ciamDeletedAt).not.toBeNull();
  });

  it("completed state: 410, NO Graph call, no new row", async () => {
    const u = await makeUser("ai-res-done");
    await request(makeApp()).delete("/v1/me").set("Authorization", `Bearer ${u.token}`);
    graph.calls = [];

    const before = await db.orm.select({ n: sql<number>`count(*)::int` }).from(users);
    const res = await sync(u.token);
    expect(res.status).toBe(410);
    expect(graph.calls).toEqual([]);
    const after = await db.orm.select({ n: sql<number>`count(*)::int` }).from(users);
    expect(after[0]!.n).toBe(before[0]!.n);
    expect((await db.orm.select().from(users).where(eq(users.entraOid, u.oid))).length).toBe(0);
  });

  it("a live account with the same shape still syncs — the guard reads the tombstone, not the oid", async () => {
    const live = await makeUser("ai-live");
    const res = await sync(live.token);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(live.id);
  });
});

// ── B2: the Graph client's own contract ─────────────────────────────────────────

describe("Graph client", () => {
  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      return handler(String(url), init);
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const token = () => new Response(JSON.stringify({ access_token: "t" }), { status: 200 });

  it("treats 204 and 404 as removed, and nothing else", async () => {
    for (const status of [204, 404]) {
      const { impl } = stubFetch((url) => (url.includes("/oauth2/") ? token() : new Response(null, { status })));
      const client = createGraphClient(
        { tenantId: "t", clientId: "c", clientSecret: "s" },
        { fetchImpl: impl, sleep: async () => {} },
      );
      expect((await client.deleteUser("oid-1")).ok).toBe(true);
    }
    const { impl } = stubFetch((url) => (url.includes("/oauth2/") ? token() : new Response(null, { status: 403 })));
    const client = createGraphClient(
      { tenantId: "t", clientId: "c", clientSecret: "s" },
      { fetchImpl: impl, sleep: async () => {} },
    );
    const res = await client.deleteUser("oid-1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("graph_http_403");
  });

  it("tries three times and never throws when the network is gone", async () => {
    const attempts: string[] = [];
    const impl = (async (url: string | URL) => {
      attempts.push(String(url));
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = createGraphClient(
      { tenantId: "t", clientId: "c", clientSecret: "s" },
      { fetchImpl: impl, sleep: async () => {} },
    );
    const res = await client.deleteUser("oid-1");
    expect(res.ok).toBe(false);
    expect(attempts.length).toBe(3);
  });

  it("a half-set credential trio is a deployment mistake, not an off switch", () => {
    expect(graphConfigFrom({})).toEqual({ ok: true, config: null });
    const partial = graphConfigFrom({ GRAPH_TENANT_ID: "t" } as NodeJS.ProcessEnv);
    expect(partial.ok).toBe(false);
    expect(partial.ok === false && partial.missing).toEqual(["GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET"]);
  });

  it("logs a half-set trio as pending work, and only a wholly unset one as skipped", () => {
    const unset = unresolvedGraphLog(graphFromEnv({} as NodeJS.ProcessEnv));
    expect(unset).toEqual({ kind: "ciam_delete_skipped", reason: "graph_not_configured" });

    const half = unresolvedGraphLog(graphFromEnv({ GRAPH_TENANT_ID: "t" } as NodeJS.ProcessEnv));
    expect(half).toEqual({ kind: "ciam_delete_pending", reason: "graph_config_incomplete" });
    // The alert fires on ciam_delete_pending; before FG-7 the runbook tells operators that
    // ciam_delete_skipped is noise, so a dropped secret may not arrive wearing that label.
    expect(half.kind).not.toBe(unset.kind);
  });
});

// ── B3: age attestation ─────────────────────────────────────────────────────────

describe("age attestation", () => {
  it("stamps only alongside a role grant, once, and ignores junk", async () => {
    const token = await mkToken("ai-age-1", "Age One");
    const first = await sync(token, { role: "student", ageBracket: "under_13" });
    expect(first.status).toBe(200);
    const [row] = await db.orm.select().from(users).where(eq(users.id, first.body.id));
    expect(row!.ageBracket).toBe("under_13");
    expect(row!.ageAttestedAt).not.toBeNull();

    // A second sync carrying a different answer changes nothing: the role is already
    // granted, so there is no grant for the answer to ride on.
    const second = await sync(token, { role: "student", ageBracket: "over_13" });
    expect(second.status).toBe(200);
    const [after] = await db.orm.select().from(users).where(eq(users.id, first.body.id));
    expect(after!.ageBracket).toBe("under_13");

    const audits = await db.orm.select().from(auditEvents).where(eq(auditEvents.actorUserId, first.body.id));
    const grant = audits.find((a) => a.action === "user.role_set");
    expect((grant!.detail as Record<string, unknown>).ageBracket).toBe("under_13");
  });

  it("an answer with no role grant is not recorded", async () => {
    const token = await mkToken("ai-age-2", "Age Two");
    const created = await sync(token, { ageBracket: "over_13" });
    expect(created.status).toBe(200);
    const [row] = await db.orm.select().from(users).where(eq(users.id, created.body.id));
    expect(row!.ageBracket).toBeNull();
    expect(row!.ageAttestedAt).toBeNull();
  });

  it("an unrecognized bracket is ignored, and never blocks the role grant", async () => {
    const token = await mkToken("ai-age-3", "Age Three");
    const res = await sync(token, { role: "teacher", ageBracket: "probably_ancient" });
    expect(res.status).toBe(200);
    expect(res.body.isTeacher).toBe(true);
    const [row] = await db.orm.select().from(users).where(eq(users.id, res.body.id));
    expect(row!.ageBracket).toBeNull();
  });
});

// ── Migrations 0026/0027, proved against the database the routes run on ─────────

describe("probe_schema (0026, 0027)", () => {
  it("every column the routes write exists on users", async () => {
    const rows = await db.orm.execute(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'users'
        AND column_name IN ('age_bracket', 'age_attested_at', 'ciam_oid_at_delete', 'ciam_deleted_at')
      ORDER BY column_name
    `);
    const found = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
    expect((found as { column_name: string }[]).map((r) => r.column_name)).toEqual([
      "age_attested_at",
      "age_bracket",
      "ciam_deleted_at",
      "ciam_oid_at_delete",
    ]);
  });

  it("the tombstone lookup index exists and is partial", async () => {
    const rows = await db.orm.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'users' AND indexname = 'ix_users_ciam_oid_at_delete'
    `);
    const found = ((rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[])) as {
      indexdef: string;
    }[];
    expect(found.length).toBe(1);
    expect(found[0]!.indexdef).toContain("WHERE");
  });
});
