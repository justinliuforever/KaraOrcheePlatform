import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
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
import { notes, platformConfig, scoreScans, users } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { ScanStore } from "../src/notes/scans_store";
import { ScanChangedError } from "../src/notes/scans_store";
import { SCAN_HEAD_BYTES, jpegHeadVerdict } from "../src/notes/jpeg";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt8(0xff, 0);
  header.writeUInt8(marker, 1);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function irbResource(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write("8BIM", 0, "latin1");
  header.writeUInt16BE(id, 4);
  header.writeUInt32BE(data.length, 8);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

const SOI = Buffer.from([0xff, 0xd8]);
const SOS = Buffer.from([0xff, 0xda, 0x00, 0x0c]);
const APP0_JFIF = segment(
  0xe0,
  Buffer.concat([Buffer.from("JFIF\0"), Buffer.from([0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])]),
);
const APP1_EXIF_GPS = segment(
  0xe1,
  Buffer.concat([
    Buffer.from("Exif\0\0"),
    Buffer.from("MM\0*"),
    Buffer.from([0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01]),
  ]),
);
const APP13_IPTC_LOCATION = segment(
  0xed,
  Buffer.concat([
    Buffer.from("Photoshop 3.0\0"),
    irbResource(0x0404, Buffer.from("\x1c\x02\x5cSan Francisco")),
  ]),
);
const APP2_MPF_WITH_EXIF = segment(
  0xe2,
  Buffer.concat([Buffer.from("MPF\0"), SOI, APP1_EXIF_GPS, SOS]),
);
const APP2_ICC = segment(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.alloc(540)]));
const COM_COORDINATES = segment(0xfe, Buffer.from("37.7749,-122.4194"));

const JPEG = Buffer.concat([SOI, APP0_JFIF, SOS]);
const EXIF = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
const PDF = Buffer.from("%PDF-1.4\n");
const TRUNCATED = Buffer.from([0xff, 0xd8, 0xff, 0xe2, 0xff, 0xff]);
const CAMERA_WITH_GPS = Buffer.concat([SOI, APP0_JFIF, APP1_EXIF_GPS, SOS]);
const CAMERA_WITHOUT_APP1 = Buffer.concat([SOI, APP0_JFIF, SOS]);

const IOS_ENCODER_HEAD = Buffer.from(
  "/9j/4AAQSkZJRgABAQAA2ADYAAD/wAARCApQB4ADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBAMDAwQFBAQEBAUHBQUFBQUHCAcHBwcHBwgICAgICAgICgoKCgoKCwsLCwsNDQ0NDQ0NDQ0N/9sAQwECAgIDAwMGAwMGDQkHCQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0N/90ABAB4/9oADA==",
  "base64",
);
const IOS_ENCODER_HEAD_P3 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAA2ADYAAD/4gIoSUNDX1BST0ZJTEUAAQEAAAIYYXBwbAQAAABtbnRyUkdCIFhZWiAH5gABAAEAAAAAAABhY3NwQVBQTAAAAABBUFBMAAAAAAAAAAAAAAAAAAAAAAAA9tYAAQAAAADTLWFwcGwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApkZXNjAAAA/AAAADBjcHJ0AAABLAAAAFB3dHB0AAABfAAAABRyWFlaAAABkAAAABRnWFlaAAABpAAAABRiWFlaAAABuAAAABRyVFJDAAABzAAAACBjaGFkAAAB7AAAACxiVFJDAAABzAAAACBnVFJDAAABzAAAACBtbHVjAAAAAAAAAAEAAAAMZW5VUwAAABQAAAAcAEQAaQBzAHAAbABhAHkAIABQADNtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADQAAAAcAEMAbwBwAHkAcgBpAGcAaAB0ACAAQQBwAHAAbABlACAASQBuAGMALgAsACAAMgAwADIAMlhZWiAAAAAAAAD21QABAAAAANMsWFlaIAAAAAAAAIPfAAA9v////7tYWVogAAAAAAAASr8AALE3AAAKuVhZWiAAAAAAAAAoOAAAEQsAAMi5cGFyYQAAAAAAAwAAAAJmZgAA8qcAAA1ZAAAT0AAACltzZjMyAAAAAAABDEIAAAXe///zJgAAB5MAAP2Q///7ov///aMAAAPcAADAbv/AABEIClAHgAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2wBDAAICAgICAgMCAgMEAwMDBAUEBAQEBQcFBQUFBQcIBwcHBwcHCAgICAgICAgKCgoKCgoLCwsLCw0NDQ0NDQ0NDQ3/2wBDAQICAgMDAwYDAwYNCQcJDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ3/3QAEAHj/2gAM",
  "base64",
);

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;
let logged: string[];

interface FakeScans extends ScanStore {
  promoted: [string, string][];
  promotedIfMatch: (string | null | undefined)[];
  deletedPrefixes: string[];
  bytesByPath: Map<string, number>;
  headByPath: Map<string, Buffer>;
  headBytes: number[];
  defaultBytes: number | null;
  defaultHead: Buffer;
  failPrefixes: Set<string>;
  onPromote?: () => Promise<void>;
  onDeletePrefix?: (prefix: string) => Promise<void>;
}

function makeFakeScans(): FakeScans {
  const incomingPrefix = (ownerId: string, scanId: string) => `incoming/${ownerId}/${scanId}/`;
  const blobPrefix = (ownerId: string, scanId: string) => `${ownerId}/${scanId}/`;
  const f: FakeScans = {
    promoted: [],
    promotedIfMatch: [],
    deletedPrefixes: [],
    bytesByPath: new Map(),
    headByPath: new Map(),
    headBytes: [],
    defaultBytes: 1024,
    defaultHead: JPEG,
    failPrefixes: new Set(),
    incomingPrefix,
    blobPrefix,
    incomingPath: (o, s, n) => `${incomingPrefix(o, s)}${n}.jpg`,
    blobPath: (o, s, n) => `${blobPrefix(o, s)}${n}.jpg`,
    uploadUrl: (p) => {
      if (!p.startsWith("incoming/")) throw new Error("uploadUrl is scoped to incoming/");
      return `https://fake/score-scans/${p}?write`;
    },
    async pageProps(path) {
      const override = f.bytesByPath.get(path);
      const bytes = override ?? f.defaultBytes;
      return bytes === null ? null : { bytes, etag: `etag:${path}` };
    },
    async readHead(path, bytes) {
      f.headBytes.push(bytes);
      return f.headByPath.get(path) ?? f.defaultHead;
    },
    async promote(from, to, opts) {
      f.promoted.push([from, to]);
      f.promotedIfMatch.push(opts?.ifMatch);
      if (f.onPromote) await f.onPromote();
    },
    readUrl: (p) => `https://fake/score-scans/${p}?read`,
    async deletePrefix(prefix) {
      if (!prefix.endsWith("/")) throw new Error("deletePrefix requires a trailing slash");
      if (f.failPrefixes.has(prefix)) throw new Error("blob service unavailable");
      if (f.onDeletePrefix) await f.onDeletePrefix(prefix);
      f.deletedPrefixes.push(prefix);
    },
  };
  return f;
}

let scans: FakeScans;

function makeApp(deps: { scans?: FakeScans } = {}) {
  return createServer({ db, auth: verifier, scans: "scans" in deps ? deps.scans : scans });
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
  scans = makeFakeScans();
  logged = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
});

async function makeUser(oid: string, role: "teacher" | "student" = "teacher") {
  const token = await new SignJWT({ oid, name: "Test Person" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  const res = await request(makeApp())
    .post("/v1/users/sync")
    .set("Authorization", `Bearer ${token}`)
    .send({ role });
  expect(res.status).toBe(200);
  return { token, id: res.body.id as string };
}

async function createScan(token: string, body: Record<string, unknown> = {}) {
  return request(makeApp())
    .post("/v1/score-scans")
    .set("Authorization", `Bearer ${token}`)
    .send({ title: "Czerny 599", pageCount: 2, ...body });
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function setMonetization(iso: string | null) {
  await db.orm.delete(platformConfig).where(eq(platformConfig.key, "monetization_live_at"));
  if (iso) await db.orm.insert(platformConfig).values({ key: "monetization_live_at", value: iso });
}

async function accessStatus(token: string) {
  const res = await request(makeApp())
    .post("/v1/users/sync")
    .set("Authorization", `Bearer ${token}`)
    .send({});
  return res.body.access?.status as string;
}

async function scanRow(id: string) {
  const [row] = await db.orm.select().from(scoreScans).where(eq(scoreScans.id, id));
  return row!;
}

function plantOnFirstScanSelect(plant: () => Promise<void>): () => void {
  const orm = db.orm as any;
  const realSelect = orm.select.bind(orm);
  let fired = false;
  orm.select = (...args: any[]) => {
    const builder = realSelect(...args);
    const realFrom = builder.from.bind(builder);
    builder.from = (table: any) => {
      const q = realFrom(table);
      if (table !== scoreScans || fired) return q;
      fired = true;
      const realThen = q.then.bind(q);
      q.then = (ok: any, err: any) => realThen(async (rows: any) => {
        await plant();
        return ok ? ok(rows) : rows;
      }, err);
      return q;
    };
    return builder;
  };
  return () => {
    delete orm.select;
  };
}

describe("POST /v1/score-scans", () => {
  it("mints one write URL per page under incoming/", async () => {
    const me = await makeUser("scan-create");
    const res = await createScan(me.token, { pageCount: 3 });

    expect(res.status).toBe(201);
    expect(res.body.scan.status).toBe("created");
    expect(res.body.scan.pageCount).toBe(3);
    expect(res.body.uploadUrls.map((u: { page: number }) => u.page)).toEqual([1, 2, 3]);
    for (const u of res.body.uploadUrls) {
      expect(u.url).toContain(`incoming/${me.id}/${res.body.scan.id}/${u.page}.jpg`);
    }
  });

  it("never echoes the stored blob prefix back to the caller", async () => {
    const me = await makeUser("scan-create-noecho");
    const created = await createScan(me.token, { clientScanId: "noecho" });
    await db.orm
      .update(scoreScans)
      .set({ blobPath: `${me.id}/${created.body.scan.id}/` })
      .where(eq(scoreScans.id, created.body.scan.id));

    const res = await createScan(me.token, { clientScanId: "noecho" });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.scan)).not.toContain("blobPath");
    expect(Object.keys(res.body.scan)).not.toContain("blobPrefix");
    expect(Object.keys(res.body.scan)).not.toContain("ownerId");
  });

  it("returns the existing row on a retry whose role lapsed in between", async () => {
    const me = await makeUser("scan-create-idem");
    const first = await createScan(me.token, { clientScanId: "outbox-1" });
    expect(first.status).toBe(201);

    await db.orm.update(users).set({ isTeacher: false, isStudent: false }).where(eq(users.id, me.id));

    const retry = await createScan(me.token, { clientScanId: "outbox-1" });
    expect(retry.status).toBe(200);
    expect(retry.body.scan.id).toBe(first.body.scan.id);
    expect(retry.body.uploadUrls).toHaveLength(2);
    expect(await db.orm.select().from(scoreScans).where(eq(scoreScans.ownerId, me.id))).toHaveLength(1);
  });

  it("returns the existing row on a retry the page count and title gates would refuse", async () => {
    const me = await makeUser("scan-create-idem-gates");
    const first = await createScan(me.token, { clientScanId: "outbox-2", pageCount: 2 });
    expect(first.status).toBe(201);

    const retry = await createScan(me.token, {
      clientScanId: "outbox-2",
      pageCount: 99,
      title: "   ",
    });

    expect(retry.status).toBe(200);
    expect(retry.body.scan.id).toBe(first.body.scan.id);
    const row = await scanRow(first.body.scan.id);
    expect(row.pageCount).toBe(2);
    expect(row.title).toBe("Czerny 599");
  });

  it("keeps two keyless creates apart", async () => {
    const me = await makeUser("scan-create-keyless");
    const first = await createScan(me.token);
    const second = await createScan(me.token);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.scan.id).not.toBe(first.body.scan.id);
    expect(await db.orm.select().from(scoreScans).where(eq(scoreScans.ownerId, me.id))).toHaveLength(2);
  });

  it("hands back the winner when a twin create takes the key between the check and the insert", async () => {
    const me = await makeUser("scan-create-race");
    const key = "outbox-race";
    let plantedId: string | null = null;
    const unplug = plantOnFirstScanSelect(async () => {
      const [planted] = await db.orm
        .insert(scoreScans)
        .values({ ownerId: me.id, title: "Raced", clientScanId: key, pageCount: 2 })
        .returning();
      plantedId = planted!.id;
    });

    let res;
    try {
      res = await createScan(me.token, { clientScanId: key });
    } finally {
      unplug();
    }

    expect(res.status).toBe(200);
    expect(res.body.scan.id).toBe(plantedId);
    expect(res.body.scan.title).toBe("Raced");
    expect(res.body.uploadUrls).toHaveLength(2);
    const rows = await db.orm
      .select()
      .from(scoreScans)
      .where(and(eq(scoreScans.ownerId, me.id), eq(scoreScans.clientScanId, key)));
    expect(rows).toHaveLength(1);
  });

  it("still keeps the two creates apart when the twin takes a different key", async () => {
    const me = await makeUser("scan-create-race-otherkey");
    const unplug = plantOnFirstScanSelect(async () => {
      await db.orm
        .insert(scoreScans)
        .values({ ownerId: me.id, title: "Raced", clientScanId: "other-key", pageCount: 2 })
        .returning();
    });

    let res;
    try {
      res = await createScan(me.token, { clientScanId: "mine" });
    } finally {
      unplug();
    }

    expect(res.status).toBe(201);
    expect(res.body.scan.clientScanId).toBe("mine");
    expect(await db.orm.select().from(scoreScans).where(eq(scoreScans.ownerId, me.id))).toHaveLength(2);
  });

  it("treats an empty clientScanId as no key rather than as a colliding one", async () => {
    const me = await makeUser("scan-create-emptykey");
    const first = await createScan(me.token, { clientScanId: "" });
    expect(first.status).toBe(201);

    const second = await createScan(me.token, { clientScanId: "" });

    expect(second.status).toBe(201);
    expect(second.body.scan.id).not.toBe(first.body.scan.id);
  });

  it("hands a committed scan back with no fresh write grant", async () => {
    const me = await makeUser("scan-create-committed");
    const first = await createScan(me.token, { clientScanId: "outbox-1" });
    const scanId = first.body.scan.id as string;
    await request(makeApp())
      .post(`/v1/score-scans/${scanId}/commit`)
      .set("Authorization", `Bearer ${me.token}`);

    const again = await createScan(me.token, { clientScanId: "outbox-1" });

    expect(again.status).toBe(200);
    expect(again.body.scan.id).toBe(scanId);
    expect(again.body.scan.status).toBe("ready");
    expect(again.body.uploadUrls).toBeUndefined();
  });

  it("refuses an account with neither role", async () => {
    const me = await makeUser("scan-create-role");
    await db.orm.update(users).set({ isTeacher: false, isStudent: false }).where(eq(users.id, me.id));

    const res = await createScan(me.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("notes_role_required");
  });

  it("answers 503 when no store is configured", async () => {
    const me = await makeUser("scan-create-nostore");
    const res = await request(makeApp({ scans: undefined }))
      .post("/v1/score-scans")
      .set("Authorization", `Bearer ${me.token}`)
      .send({ title: "Czerny 599", pageCount: 2 });
    expect(res.status).toBe(503);
  });

  it("rejects a page count outside 1 to 20", async () => {
    const me = await makeUser("scan-create-pages");
    for (const pageCount of [0, 21, 2.5, "3", null]) {
      const res = await createScan(me.token, { pageCount });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("page_count_invalid");
    }
  });

  it("rejects an empty title", async () => {
    const me = await makeUser("scan-create-title");
    const res = await createScan(me.token, { title: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("title_required");
  });
});

describe("POST /v1/score-scans/:id/upload-url", () => {
  it("re-mints every page for a scan still awaiting its bytes", async () => {
    const me = await makeUser("scan-remint");
    const created = await createScan(me.token, { pageCount: 2 });
    const res = await request(makeApp())
      .post(`/v1/score-scans/${created.body.scan.id}/upload-url`)
      .set("Authorization", `Bearer ${me.token}`);
    expect(res.status).toBe(200);
    expect(res.body.uploadUrls).toHaveLength(2);
  });

  it("404s another owner's scan and a malformed id alike", async () => {
    const me = await makeUser("scan-remint-owner");
    const stranger = await makeUser("scan-remint-stranger");
    const created = await createScan(me.token);

    const foreign = await request(makeApp())
      .post(`/v1/score-scans/${created.body.scan.id}/upload-url`)
      .set("Authorization", `Bearer ${stranger.token}`);
    expect(foreign.status).toBe(404);

    const garbage = await request(makeApp())
      .post("/v1/score-scans/not-a-uuid/upload-url")
      .set("Authorization", `Bearer ${me.token}`);
    expect(garbage.status).toBe(404);
  });
});

describe("POST /v1/score-scans/:id/commit", () => {
  async function stagedScan(oid: string, pageCount = 2) {
    const me = await makeUser(oid);
    const created = await createScan(me.token, { pageCount });
    return { me, scanId: created.body.scan.id as string };
  }

  function commit(token: string, scanId: string) {
    return request(makeApp())
      .post(`/v1/score-scans/${scanId}/commit`)
      .set("Authorization", `Bearer ${token}`);
  }

  it("copies the exact bytes the size gate measured, not whatever is there at copy time", async () => {
    const { me, scanId } = await stagedScan("scan-commit-ifmatch", 2);

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(200);
    expect(scans.promotedIfMatch).toEqual([
      `etag:incoming/${me.id}/${scanId}/1.jpg`,
      `etag:incoming/${me.id}/${scanId}/2.jpg`,
    ]);
  });

  it("refuses a page swapped between the gate and the copy instead of storing it", async () => {
    const { me, scanId } = await stagedScan("scan-commit-changed", 1);
    scans.onPromote = async () => {
      throw new ScanChangedError();
    };

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("pages_changed");
  });

  it("promotes every page, counts them, and sweeps the stage last", async () => {
    const { me, scanId } = await stagedScan("scan-commit-ok", 3);
    scans.defaultBytes = 4096;

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(200);
    expect(res.body.scan.status).toBe("ready");
    expect(res.body.scan.pageCount).toBe(3);
    expect(res.body.scan.bytes).toBe(12288);
    expect(scans.promoted).toEqual([
      [`incoming/${me.id}/${scanId}/1.jpg`, `${me.id}/${scanId}/1.jpg`],
      [`incoming/${me.id}/${scanId}/2.jpg`, `${me.id}/${scanId}/2.jpg`],
      [`incoming/${me.id}/${scanId}/3.jpg`, `${me.id}/${scanId}/3.jpg`],
    ]);
    expect(scans.deletedPrefixes).toEqual([`incoming/${me.id}/${scanId}/`]);
    const row = await scanRow(scanId);
    expect(row.blobPath).toBe(`${me.id}/${scanId}/`);
    expect(row.bytes).toBe(12288);
  });

  it("asks each page for exactly the head the JPEG gate is sized for", async () => {
    const { me, scanId } = await stagedScan("scan-commit-headbytes", 3);

    expect((await commit(me.token, scanId)).status).toBe(200);

    expect(scans.headBytes).toEqual([SCAN_HEAD_BYTES, SCAN_HEAD_BYTES, SCAN_HEAD_BYTES]);
  });

  it("names the missing page and leaves the stage alone", async () => {
    const { me, scanId } = await stagedScan("scan-commit-missing");
    scans.bytesByPath.set(`incoming/${me.id}/${scanId}/2.jpg`, 0);

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "pages_missing", n: 2 });
    expect(scans.promoted).toEqual([]);
    expect(scans.deletedPrefixes).toEqual([]);
    expect((await scanRow(scanId)).status).toBe("created");
  });

  it("treats a page that was never uploaded as missing", async () => {
    const { me, scanId } = await stagedScan("scan-commit-absent");
    scans.defaultBytes = null;

    const res = await commit(me.token, scanId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "pages_missing", n: 1 });
  });

  it("rejects a set over 40 MiB and leaves the stage alone", async () => {
    const { me, scanId } = await stagedScan("scan-commit-large");
    scans.defaultBytes = 21 * 1024 * 1024;

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("scan_too_large");
    expect(scans.promoted).toEqual([]);
    expect(scans.deletedPrefixes).toEqual([]);
    expect((await scanRow(scanId)).status).toBe("created");
  });

  it("rejects a page carrying EXIF and leaves the stage alone", async () => {
    const { me, scanId } = await stagedScan("scan-commit-exif");
    scans.headByPath.set(`incoming/${me.id}/${scanId}/2.jpg`, EXIF);

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ error: "not_an_image", n: 2, reason: "exif" });
    expect(res.body.message).toContain("Page 2");
    expect(scans.promoted).toEqual([]);
    expect(scans.deletedPrefixes).toEqual([]);
    expect((await scanRow(scanId)).status).toBe("created");
  });

  it("never lets a row declared at five pages go ready on three", async () => {
    const { me, scanId } = await stagedScan("scan-commit-shortfall", 5);
    for (const page of [4, 5]) {
      scans.bytesByPath.set(`incoming/${me.id}/${scanId}/${page}.jpg`, 0);
    }

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "pages_missing", n: 4 });
    const row = await scanRow(scanId);
    expect(row.status).toBe("created");
    expect(row.blobPath).toBeNull();
    expect(scans.promoted).toEqual([]);
    expect(scans.deletedPrefixes).toEqual([]);
  });

  it("promotes exactly as many pages as the row ends up claiming", async () => {
    const { me, scanId } = await stagedScan("scan-commit-counted", 4);

    expect((await commit(me.token, scanId)).status).toBe(200);

    const row = await scanRow(scanId);
    expect(row.pageCount).toBe(scans.promoted.length);
    expect(row.status).toBe("ready");
  });

  it("names the page in a sentence the client can show verbatim", async () => {
    const { me, scanId } = await stagedScan("scan-commit-415message", 4);
    scans.headByPath.set(`incoming/${me.id}/${scanId}/3.jpg`, PDF);

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(415);
    expect(res.body.n).toBe(3);
    expect(res.body.message).toBe("Page 3 isn't a photo we can use.");
  });

  it("rejects a renamed non-JPEG and leaves the stage alone", async () => {
    const { me, scanId } = await stagedScan("scan-commit-pdf");
    scans.defaultHead = PDF;

    const res = await commit(me.token, scanId);
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ error: "not_an_image", n: 1, reason: "not_jpeg" });
    expect(scans.promoted).toEqual([]);
    expect(scans.deletedPrefixes).toEqual([]);
    expect((await scanRow(scanId)).status).toBe("created");
  });

  it("rejects a camera JPEG whose APP1 block carries a GPS tag", async () => {
    const { me, scanId } = await stagedScan("scan-commit-gps");
    scans.defaultHead = CAMERA_WITH_GPS;

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ error: "not_an_image", n: 1, reason: "exif" });
    expect(scans.promoted).toEqual([]);
    expect((await scanRow(scanId)).status).toBe("created");
  });

  it("accepts the same camera JPEG once its APP1 block is stripped", async () => {
    const { me, scanId } = await stagedScan("scan-commit-stripped");
    scans.defaultHead = CAMERA_WITHOUT_APP1;

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(200);
    expect(res.body.scan.status).toBe("ready");
  });

  it("rejects a head whose segments run past what it can read", async () => {
    const { me, scanId } = await stagedScan("scan-commit-truncated");
    scans.defaultHead = TRUNCATED;

    const res = await commit(me.token, scanId);
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ error: "not_an_image", n: 1, reason: "unreadable" });
  });

  it("hands a second commit the same ready scan without promoting or re-counting", async () => {
    const { me, scanId } = await stagedScan("scan-commit-twice");
    scans.defaultBytes = 4096;
    const first = await commit(me.token, scanId);
    expect(first.status).toBe(200);
    scans.promoted = [];
    scans.deletedPrefixes = [];
    scans.defaultBytes = 999999;

    const again = await commit(me.token, scanId);

    expect(again.status).toBe(200);
    expect(again.body.scan).toEqual(first.body.scan);
    expect(scans.promoted).toEqual([]);
    expect(scans.deletedPrefixes).toEqual([]);
    const row = await scanRow(scanId);
    expect(row.bytes).toBe(8192);
    expect(row.pageCount).toBe(2);
  });

  it("answers a commit whose upload-url twin still refuses the committed scan", async () => {
    const { me, scanId } = await stagedScan("scan-commit-mintafter");
    expect((await commit(me.token, scanId)).status).toBe(200);

    const minted = await request(makeApp())
      .post(`/v1/score-scans/${scanId}/upload-url`)
      .set("Authorization", `Bearer ${me.token}`);

    expect(minted.status).toBe(409);
    expect(minted.body.error).toBe("already_committed");
  });

  it("flips the row before it sweeps the stage", async () => {
    const { me, scanId } = await stagedScan("scan-commit-order", 2);
    let statusAtSweep: string | null = null;
    scans.onDeletePrefix = async () => {
      statusAtSweep = (await scanRow(scanId)).status;
    };

    expect((await commit(me.token, scanId)).status).toBe(200);

    expect(statusAtSweep).toBe("ready");
  });

  it("purges the pages it just promoted when the row was deleted under it", async () => {
    const { me, scanId } = await stagedScan("scan-commit-raced", 2);
    scans.onPromote = async () => {
      await db.orm.delete(scoreScans).where(eq(scoreScans.id, scanId));
      scans.onPromote = undefined;
    };

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(404);
    expect(scans.promoted).toHaveLength(2);
    expect(scans.deletedPrefixes).toEqual([
      `${me.id}/${scanId}/`,
      `incoming/${me.id}/${scanId}/`,
    ]);
  });

  it("keeps the winner's pages when a losing commit finds the row already ready", async () => {
    const { me, scanId } = await stagedScan("scan-commit-lost", 2);
    scans.onPromote = async () => {
      await db.orm
        .update(scoreScans)
        .set({ status: "ready", blobPath: `${me.id}/${scanId}/` })
        .where(eq(scoreScans.id, scanId));
      scans.onPromote = undefined;
    };

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(200);
    expect(res.body.scan.id).toBe(scanId);
    expect(res.body.scan.status).toBe("ready");
    expect(scans.deletedPrefixes).toEqual([]);
  });

  it("reports the winner's row when the swept stage breaks the loser's copy", async () => {
    const { me, scanId } = await stagedScan("scan-commit-sweptmidcopy", 2);
    scans.onPromote = async () => {
      await db.orm
        .update(scoreScans)
        .set({ status: "ready", bytes: 2048, blobPath: `${me.id}/${scanId}/` })
        .where(eq(scoreScans.id, scanId));
      scans.onPromote = async () => {
        throw new Error("CannotVerifyCopySource");
      };
    };

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(200);
    expect(res.body.scan.id).toBe(scanId);
    expect(res.body.scan.status).toBe("ready");
    expect(res.body.scan.bytes).toBe(2048);
    expect(scans.deletedPrefixes).toEqual([]);
  });

  it("says taken down when the loser's copy breaks on a scan pulled mid-commit", async () => {
    const { me, scanId } = await stagedScan("scan-commit-pulledmidcopy", 2);
    scans.onPromote = async () => {
      await db.orm.update(scoreScans).set({ status: "taken_down" }).where(eq(scoreScans.id, scanId));
      scans.onPromote = async () => {
        throw new Error("CannotVerifyCopySource");
      };
    };

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("scan_taken_down");
    expect(scans.deletedPrefixes).toEqual([]);
  });

  it("purges what it promoted when the copy breaks on a row deleted under it", async () => {
    const { me, scanId } = await stagedScan("scan-commit-deletedmidcopy", 2);
    scans.onPromote = async () => {
      await db.orm.delete(scoreScans).where(eq(scoreScans.id, scanId));
      scans.onPromote = async () => {
        throw new Error("CannotVerifyCopySource");
      };
    };

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(404);
    expect(scans.deletedPrefixes).toEqual([
      `${me.id}/${scanId}/`,
      `incoming/${me.id}/${scanId}/`,
    ]);
  });

  it("still fails a commit whose copy breaks while the row is untouched", async () => {
    const { me, scanId } = await stagedScan("scan-commit-copyfail", 2);
    scans.onPromote = async () => {
      throw new Error("blob service unavailable");
    };

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(500);
    expect((await scanRow(scanId)).status).toBe("created");
    expect(scans.deletedPrefixes).toEqual([]);
  });

  it("still reports the commit that succeeded when the stage refuses to sweep", async () => {
    const { me, scanId } = await stagedScan("scan-commit-sweepfail", 2);
    scans.failPrefixes.add(`incoming/${me.id}/${scanId}/`);

    const res = await commit(me.token, scanId);

    expect(res.status).toBe(200);
    expect((await scanRow(scanId)).status).toBe("ready");
    const failures = logged.filter((line) => line.includes(`"kind":"purge_failed"`));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`"op":"scan.commit"`);
    expect(failures[0]).toContain(`"key":"incoming/${me.id}/${scanId}/"`);
  });

  it("says taken down rather than already committed on a taken-down scan", async () => {
    const { me, scanId } = await stagedScan("scan-commit-takendown");
    await db.orm.update(scoreScans).set({ status: "taken_down" }).where(eq(scoreScans.id, scanId));

    const res = await commit(me.token, scanId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("scan_taken_down");

    const minted = await request(makeApp())
      .post(`/v1/score-scans/${scanId}/upload-url`)
      .set("Authorization", `Bearer ${me.token}`);
    expect(minted.status).toBe(409);
    expect(minted.body.error).toBe("scan_taken_down");
  });

  it("404s another owner's scan", async () => {
    const { scanId } = await stagedScan("scan-commit-owner");
    const stranger = await makeUser("scan-commit-stranger");
    const res = await commit(stranger.token, scanId);
    expect(res.status).toBe(404);
    expect(scans.promoted).toEqual([]);
  });
});

describe("the JPEG head verdict", () => {
  it("passes a JFIF header, rejects APP1, garbage and an unfinished segment", () => {
    expect(jpegHeadVerdict(JPEG)).toBe("ok");
    expect(jpegHeadVerdict(EXIF)).toBe("exif");
    expect(jpegHeadVerdict(PDF)).toBe("not_jpeg");
    expect(jpegHeadVerdict(TRUNCATED)).toBe("unreadable");
    expect(jpegHeadVerdict(null)).toBe("not_jpeg");
    expect(jpegHeadVerdict(Buffer.alloc(0))).toBe("not_jpeg");
  });

  it("separates the APP1 block from everything else the same camera head carries", () => {
    expect(jpegHeadVerdict(CAMERA_WITH_GPS)).toBe("exif");
    expect(jpegHeadVerdict(CAMERA_WITHOUT_APP1)).toBe("ok");
  });

  it("finds APP1 behind an earlier segment", () => {
    const head = Buffer.concat([SOI, APP0_JFIF, APP1_EXIF_GPS]);
    expect(jpegHeadVerdict(head)).toBe("exif");
  });

  it("rejects every other segment a location can travel in", () => {
    expect(jpegHeadVerdict(Buffer.concat([SOI, APP0_JFIF, APP13_IPTC_LOCATION, SOS]))).toBe("metadata");
    expect(jpegHeadVerdict(Buffer.concat([SOI, APP0_JFIF, APP2_MPF_WITH_EXIF, SOS]))).toBe("metadata");
    expect(jpegHeadVerdict(Buffer.concat([SOI, APP0_JFIF, COM_COORDINATES, SOS]))).toBe("metadata");
    expect(jpegHeadVerdict(Buffer.concat([SOI, segment(0xee, Buffer.from("Adobe")), SOS]))).toBe("metadata");
    expect(jpegHeadVerdict(Buffer.concat([SOI, segment(0xe0, Buffer.from("JFXX\0")), SOS]))).toBe("metadata");
  });

  it("accepts an ICC profile, which is the one large segment a real page carries", () => {
    expect(jpegHeadVerdict(Buffer.concat([SOI, APP0_JFIF, APP2_ICC, SOS]))).toBe("ok");
  });

  it("passes the bytes the shipping iOS encoder actually produces, sRGB and Display P3", () => {
    expect(jpegHeadVerdict(IOS_ENCODER_HEAD)).toBe("ok");
    expect(jpegHeadVerdict(IOS_ENCODER_HEAD_P3)).toBe("ok");
  });

  it("carries no Photoshop block, which is why the gate can refuse APP13 outright", () => {
    expect(IOS_ENCODER_HEAD.includes(Buffer.from("Photoshop 3.0"))).toBe(false);
    expect(IOS_ENCODER_HEAD_P3.includes(Buffer.from("Photoshop 3.0"))).toBe(false);
    expect(IOS_ENCODER_HEAD_P3.includes(Buffer.from("ICC_PROFILE"))).toBe(true);
  });

  it("separates a head too short to reach SOS from one this head size cannot hold", () => {
    const big = Buffer.concat([
      SOI,
      segment(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.alloc(60000)])),
      segment(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.alloc(60000)])),
    ]).subarray(0, 64 * 1024);
    expect(jpegHeadVerdict(big)).toBe("head_truncated");
    expect(jpegHeadVerdict(Buffer.concat([SOI, APP0_JFIF]))).toBe("unreadable");
  });
});

describe("GET /v1/score-scans", () => {
  it("lists the owner's scans newest first with a page-1 thumbnail only once ready", async () => {
    const me = await makeUser("scan-shelf");
    const stranger = await makeUser("scan-shelf-stranger");
    const older = await createScan(me.token, { title: "Older" });
    await request(makeApp())
      .post(`/v1/score-scans/${older.body.scan.id}/commit`)
      .set("Authorization", `Bearer ${me.token}`);
    await db.orm
      .update(scoreScans)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(scoreScans.id, older.body.scan.id));
    const newer = await createScan(me.token, { title: "Newer" });
    await createScan(stranger.token, { title: "Not mine" });

    const res = await request(makeApp())
      .get("/v1/score-scans")
      .set("Authorization", `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.scans.map((s: { title: string }) => s.title)).toEqual(["Newer", "Older"]);
    expect(res.body.scans[0].id).toBe(newer.body.scan.id);
    expect(res.body.scans[0].thumbnailUrl).toBeNull();
    expect(res.body.scans[1].thumbnailUrl).toContain(`${me.id}/${older.body.scan.id}/1.jpg`);
    expect(typeof res.body.expiresAt).toBe("string");
  });

  it("keeps a taken down scan on the shelf, without a thumbnail", async () => {
    const me = await makeUser("scan-shelf-takedown");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;
    await request(makeApp())
      .post(`/v1/score-scans/${scanId}/commit`)
      .set("Authorization", `Bearer ${me.token}`);
    await db.orm
      .update(scoreScans)
      .set({ status: "taken_down", blobPath: null, takenDownAt: new Date() })
      .where(eq(scoreScans.id, scanId));

    const res = await request(makeApp())
      .get("/v1/score-scans")
      .set("Authorization", `Bearer ${me.token}`);

    const row = res.body.scans.find((s: { id: string }) => s.id === scanId);
    expect(row).toBeDefined();
    expect(row.status).toBe("taken_down");
    expect(row.takenDownAt).not.toBeNull();
    expect(row.thumbnailUrl).toBeNull();
  });

  it("drops the thumbnail of a ready scan whose bytes were purged", async () => {
    const me = await makeUser("scan-shelf-purged");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;
    await request(makeApp())
      .post(`/v1/score-scans/${scanId}/commit`)
      .set("Authorization", `Bearer ${me.token}`);
    await db.orm.update(scoreScans).set({ blobPath: null }).where(eq(scoreScans.id, scanId));

    const res = await request(makeApp())
      .get("/v1/score-scans")
      .set("Authorization", `Bearer ${me.token}`);

    const row = res.body.scans.find((s: { id: string }) => s.id === scanId);
    expect(row.status).toBe("ready");
    expect(row.thumbnailUrl).toBeNull();
  });
});

describe("GET /v1/score-scans/:id", () => {
  async function readyScan(oid: string, pageCount = 2) {
    const me = await makeUser(oid);
    const created = await createScan(me.token, { pageCount });
    const scanId = created.body.scan.id as string;
    await request(makeApp())
      .post(`/v1/score-scans/${scanId}/commit`)
      .set("Authorization", `Bearer ${me.token}`);
    return { me, scanId };
  }

  function get(token: string, scanId: string) {
    return request(makeApp()).get(`/v1/score-scans/${scanId}`).set("Authorization", `Bearer ${token}`);
  }

  it("returns one read URL per page with an expiry", async () => {
    const { me, scanId } = await readyScan("scan-get-ok", 3);
    const res = await get(me.token, scanId);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.pages.map((p: { page: number }) => p.page)).toEqual([1, 2, 3]);
    expect(res.body.pages[2].url).toContain(`${me.id}/${scanId}/3.jpg`);
    expect(typeof res.body.expiresAt).toBe("string");
    expect(res.body.usedBy).toEqual([]);
  });

  it("answers a non-owner with 404, never 403", async () => {
    const { scanId } = await readyScan("scan-get-owner");
    const stranger = await makeUser("scan-get-stranger");
    const res = await get(stranger.token, scanId);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("walks the status ladder, takedown before purge", async () => {
    const me = await makeUser("scan-get-ladder");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;

    const notReady = await get(me.token, scanId);
    expect(notReady.status).toBe(409);
    expect(notReady.body.error).toBe("scan_not_ready");

    await request(makeApp())
      .post(`/v1/score-scans/${scanId}/commit`)
      .set("Authorization", `Bearer ${me.token}`);
    await db.orm
      .update(scoreScans)
      .set({ status: "taken_down", blobPath: null, takenDownAt: new Date() })
      .where(eq(scoreScans.id, scanId));

    const takenDown = await get(me.token, scanId);
    expect(takenDown.status).toBe(410);
    expect(takenDown.body.error).toBe("scan_taken_down");

    await db.orm.update(scoreScans).set({ status: "ready" }).where(eq(scoreScans.id, scanId));
    const purged = await get(me.token, scanId);
    expect(purged.status).toBe(410);
    expect(purged.body.error).toBe("scan_purged");
  });

  it("names drafts and sent notes in usedBy and leaves retracted ones out", async () => {
    const { me, scanId } = await readyScan("scan-get-usedby");
    const student = await makeUser("scan-get-usedby-s", "student");
    const unnamed = await makeUser("scan-get-usedby-unnamed", "student");
    await db.orm.update(users).set({ displayName: "Jordan" }).where(eq(users.id, student.id));
    await db.orm.update(users).set({ displayName: null }).where(eq(users.id, unnamed.id));

    const seed = async (status: string, studentId: string | null) => {
      const [row] = await db.orm
        .insert(notes)
        .values({
          teacherId: me.id,
          studentId,
          status,
          sentAt: status === "draft" ? null : new Date(),
          contentOriginal: {},
          content: {},
          scoreScanId: scanId,
        })
        .returning({ id: notes.id });
      return row!.id;
    };
    const draftId = await seed("draft", null);
    const sentId = await seed("sent", student.id);
    const unnamedId = await seed("sent", unnamed.id);
    const retractedId = await seed("retracted", student.id);

    const res = await get(me.token, scanId);

    const byId = new Map(
      res.body.usedBy.map((u: { noteId: string }) => [u.noteId, u as Record<string, unknown>]),
    );
    expect(byId.size).toBe(3);
    expect(byId.has(retractedId)).toBe(false);
    expect(byId.get(draftId)).toMatchObject({
      status: "draft", origin: "teacher", recipientName: null, sentAt: null, recipientDeleted: false,
    });
    expect(byId.get(sentId)).toMatchObject({ status: "sent", recipientName: "Jordan", recipientDeleted: false });
    expect(byId.get(unnamedId)).toMatchObject({ status: "sent", recipientName: null, recipientDeleted: false });
  });

  it("separates a student who skipped their name from one whose account is gone — a pair only direct SQL can build, because DELETE /v1/me takes the notes with it", async () => {
    const { me, scanId } = await readyScan("scan-get-usedby-flag");
    const unnamed = await makeUser("scan-get-flag-unnamed", "student");
    const tombstoned = await makeUser("scan-get-flag-gone", "student");
    await db.orm.update(users).set({ displayName: null }).where(eq(users.id, unnamed.id));
    await db.orm
      .update(users)
      .set({ displayName: null, status: "deleted", deletedAt: new Date() })
      .where(eq(users.id, tombstoned.id));

    const seed = async (studentId: string) => {
      const [row] = await db.orm
        .insert(notes)
        .values({
          teacherId: me.id,
          studentId,
          status: "sent",
          sentAt: new Date(),
          contentOriginal: {},
          content: {},
          scoreScanId: scanId,
        })
        .returning({ id: notes.id });
      return row!.id;
    };
    const liveId = await seed(unnamed.id);
    const goneId = await seed(tombstoned.id);

    const res = await get(me.token, scanId);
    const byId = new Map(
      res.body.usedBy.map((u: { noteId: string }) => [u.noteId, u as Record<string, unknown>]),
    );
    expect(byId.get(liveId)).toMatchObject({ recipientName: null, recipientDeleted: false });
    expect(byId.get(goneId)).toMatchObject({ recipientName: null, recipientDeleted: true });
  });
});

describe("a lapsed owner", () => {
  it("still creates, commits, lists and reads their own scan", async () => {
    const me = await makeUser("scan-lapsed", "student");
    await db.orm.update(users).set({ trialStartedAt: daysAgo(90) }).where(eq(users.id, me.id));
    await setMonetization(daysAgo(90).toISOString());
    try {
      expect(await accessStatus(me.token)).toBe("lapsed");

      const created = await createScan(me.token);
      expect(created.status).toBe(201);
      const scanId = created.body.scan.id as string;

      const committed = await request(makeApp())
        .post(`/v1/score-scans/${scanId}/commit`)
        .set("Authorization", `Bearer ${me.token}`);
      expect(committed.status).toBe(200);

      const shelf = await request(makeApp())
        .get("/v1/score-scans")
        .set("Authorization", `Bearer ${me.token}`);
      expect(shelf.status).toBe(200);
      expect(shelf.body.scans.map((s: { id: string }) => s.id)).toContain(scanId);

      const detail = await request(makeApp())
        .get(`/v1/score-scans/${scanId}`)
        .set("Authorization", `Bearer ${me.token}`);
      expect(detail.status).toBe(200);
      expect(detail.body.pages).toHaveLength(2);
    } finally {
      await setMonetization(null);
    }
  });
});

describe("a malformed scan id", () => {
  it("meets the same 404 as an id that never existed, on every route that takes one", async () => {
    const me = await makeUser("scan-badid");
    const app = makeApp();
    const bearer = `Bearer ${me.token}`;

    const responses = await Promise.all([
      request(app).get("/v1/score-scans/not-a-uuid").set("Authorization", bearer),
      request(app).patch("/v1/score-scans/not-a-uuid").set("Authorization", bearer).send({ title: "x" }),
      request(app).delete("/v1/score-scans/not-a-uuid").set("Authorization", bearer),
      request(app).post("/v1/score-scans/not-a-uuid/commit").set("Authorization", bearer),
      request(app).post("/v1/score-scans/not-a-uuid/upload-url").set("Authorization", bearer),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    }
  });
});

describe("PATCH /v1/score-scans/:id", () => {
  it("renames the owner's scan and nothing else", async () => {
    const me = await makeUser("scan-rename");
    const created = await createScan(me.token, { pageCount: 2 });
    const scanId = created.body.scan.id as string;

    const res = await request(makeApp())
      .patch(`/v1/score-scans/${scanId}`)
      .set("Authorization", `Bearer ${me.token}`)
      .send({ title: "  Burgmüller Op. 100  ", pageCount: 19, status: "ready" });

    expect(res.status).toBe(200);
    expect(res.body.scan.title).toBe("Burgmüller Op. 100");
    const row = await scanRow(scanId);
    expect(row.pageCount).toBe(2);
    expect(row.status).toBe("created");
  });

  it("rejects an empty title and a stranger alike", async () => {
    const me = await makeUser("scan-rename-guards");
    const stranger = await makeUser("scan-rename-stranger");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;

    const empty = await request(makeApp())
      .patch(`/v1/score-scans/${scanId}`)
      .set("Authorization", `Bearer ${me.token}`)
      .send({ title: "" });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("title_required");

    const foreign = await request(makeApp())
      .patch(`/v1/score-scans/${scanId}`)
      .set("Authorization", `Bearer ${stranger.token}`)
      .send({ title: "Mine now" });
    expect(foreign.status).toBe(404);
    expect((await scanRow(scanId)).title).toBe("Czerny 599");
  });
});

describe("DELETE /v1/score-scans/:id", () => {
  function del(token: string, scanId: string) {
    return request(makeApp()).delete(`/v1/score-scans/${scanId}`).set("Authorization", `Bearer ${token}`);
  }

  it("deletes the row, marks the read note it leaves behind, and purges the durable prefix", async () => {
    const me = await makeUser("scan-delete-ready");
    const student = await makeUser("scan-delete-ready-s", "student");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;
    await request(makeApp())
      .post(`/v1/score-scans/${scanId}/commit`)
      .set("Authorization", `Bearer ${me.token}`);
    scans.deletedPrefixes = [];
    const [note] = await db.orm
      .insert(notes)
      .values({
        teacherId: me.id,
        studentId: student.id,
        status: "sent",
        sentAt: new Date(),
        readAt: new Date(),
        scoreScanId: scanId,
        contentOriginal: {},
        content: {},
      })
      .returning({ id: notes.id });

    const res = await del(me.token, scanId);

    expect(res.status).toBe(200);
    expect(await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scanId))).toHaveLength(0);
    const [row] = await db.orm
      .select({ scanId: notes.scoreScanId, detachedAt: notes.scoreScanDetachedAt })
      .from(notes)
      .where(eq(notes.id, note!.id));
    expect(row!.scanId).toBeNull();
    expect(row!.detachedAt).not.toBeNull();
    expect(scans.deletedPrefixes).toEqual([
      `${me.id}/${scanId}/`,
      `incoming/${me.id}/${scanId}/`,
    ]);
  });

  it("leaves the author's own draft unmarked", async () => {
    const me = await makeUser("scan-delete-draft");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;
    const [note] = await db.orm
      .insert(notes)
      .values({
        teacherId: me.id,
        studentId: null,
        status: "draft",
        scoreScanId: scanId,
        contentOriginal: {},
        content: {},
      })
      .returning({ id: notes.id });

    expect((await del(me.token, scanId)).status).toBe(200);

    const [row] = await db.orm
      .select({ scanId: notes.scoreScanId, detachedAt: notes.scoreScanDetachedAt })
      .from(notes)
      .where(eq(notes.id, note!.id));
    expect(row!.scanId).toBeNull();
    expect(row!.detachedAt).toBeNull();
  });

  it("leaves a draft unmarked even when it carries a read timestamp", async () => {
    const me = await makeUser("scan-delete-draft-read");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;
    const [note] = await db.orm
      .insert(notes)
      .values({
        teacherId: me.id,
        studentId: null,
        status: "draft",
        readAt: new Date(),
        scoreScanId: scanId,
        contentOriginal: {},
        content: {},
      })
      .returning({ id: notes.id });

    expect((await del(me.token, scanId)).status).toBe(200);

    const [row] = await db.orm
      .select({ detachedAt: notes.scoreScanDetachedAt })
      .from(notes)
      .where(eq(notes.id, note!.id));
    expect(row!.detachedAt).toBeNull();
  });

  it("purges the derived incoming prefix of a scan whose commit never ran", async () => {
    const me = await makeUser("scan-delete-created");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;

    const res = await del(me.token, scanId);

    expect(res.status).toBe(200);
    expect(scans.deletedPrefixes).toEqual([
      `${me.id}/${scanId}/`,
      `incoming/${me.id}/${scanId}/`,
    ]);
  });

  it("names the prefix under label scan when the purge exhausts its retries", async () => {
    const me = await makeUser("scan-delete-purgefail");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;
    scans.failPrefixes.add(`incoming/${me.id}/${scanId}/`);

    const res = await del(me.token, scanId);

    expect(res.status).toBe(200);
    const failures = logged.filter((line) => line.includes(`"kind":"purge_failed"`));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`"op":"scan.delete"`);
    expect(failures[0]).toContain(`"label":"scan"`);
    expect(failures[0]).toContain(`"key":"incoming/${me.id}/${scanId}/"`);
  });

  it("404s a stranger and leaves the row and its bytes alone", async () => {
    const me = await makeUser("scan-delete-owner");
    const stranger = await makeUser("scan-delete-stranger");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;

    const res = await del(stranger.token, scanId);

    expect(res.status).toBe(404);
    expect(await db.orm.select().from(scoreScans).where(eq(scoreScans.id, scanId))).toHaveLength(1);
    expect(scans.deletedPrefixes).toEqual([]);
  });

  it("refuses before touching the row when no store is configured", async () => {
    const me = await makeUser("scan-delete-nostore");
    const created = await createScan(me.token);
    const scanId = created.body.scan.id as string;

    const res = await request(makeApp({ scans: undefined }))
      .delete(`/v1/score-scans/${scanId}`)
      .set("Authorization", `Bearer ${me.token}`);

    expect(res.status).toBe(503);
    expect(
      await db.orm
        .select()
        .from(scoreScans)
        .where(and(eq(scoreScans.id, scanId), eq(scoreScans.ownerId, me.id))),
    ).toHaveLength(1);
  });
});
