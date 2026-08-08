import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportPKCS8, jwtVerify, decodeProtectedHeader } from "jose";
import {
  APNS_HOSTS,
  createApnsSender,
  noteArrivedPayload,
  type ApnsConfig,
} from "../src/notes/push";

const KEY_ID = "ABC123DEFG";
const TEAM_ID = "BLTUYJ4NAD";
const BUNDLE_ID = "com.karaorchee.karaorcheeamt";

let config: ApnsConfig;
let publicKey: CryptoKey;
let server: Http2Server;
let origin: string;

interface Seen {
  headers: IncomingHttpHeaders;
  body: string;
}
const seen: Seen[] = [];

const replies = new Map<string, { status: number; reason?: string }>();

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  publicKey = pair.publicKey;
  config = {
    keyId: KEY_ID,
    teamId: TEAM_ID,
    privateKey: await exportPKCS8(pair.privateKey),
    bundleId: BUNDLE_ID,
    environment: "sandbox",
  };

  server = createServer();
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      seen.push({ headers, body: Buffer.concat(chunks).toString() });
      const token = String(headers[":path"] ?? "").replace("/3/device/", "");
      const reply = replies.get(token) ?? { status: 200 };
      stream.respond({ ":status": reply.status });
      stream.end(reply.reason ? JSON.stringify({ reason: reply.reason }) : "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("APNs sender wire contract", () => {
  it("posts to /3/device/<token> with the topic, an alert push, and the payload verbatim", async () => {
    seen.length = 0;
    const sender = createApnsSender(config, origin);
    const results = await sender.sendNoteArrived(["tok-alpha"], "note-1");

    expect(results).toEqual([{ token: "tok-alpha", ok: true, gone: false }]);
    expect(seen.length).toBe(1);
    const req = seen[0]!;
    expect(req.headers[":method"]).toBe("POST");
    expect(req.headers[":path"]).toBe("/3/device/tok-alpha");
    expect(req.headers["apns-topic"]).toBe(BUNDLE_ID);
    expect(req.headers["apns-push-type"]).toBe("alert");
    expect(req.headers["apns-priority"]).toBe("10");
    expect(req.headers["apns-collapse-id"]).toBe("note-1");
    expect(JSON.parse(req.body)).toEqual(noteArrivedPayload("note-1"));
  });

  it("authorizes with an ES256 provider token carrying the key id and team id", async () => {
    seen.length = 0;
    const sender = createApnsSender(config, origin);
    await sender.sendNoteArrived(["tok-jwt"], "note-2");

    const auth = String(seen[0]!.headers["authorization"]);
    expect(auth.startsWith("bearer ")).toBe(true);
    const jwt = auth.slice("bearer ".length);
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "ES256", kid: KEY_ID });
    const { payload } = await jwtVerify(jwt, publicKey, { issuer: TEAM_ID });
    expect(payload.iss).toBe(TEAM_ID);
    expect(typeof payload.iat).toBe("number");
  });

  it("reuses one provider token across sends — Apple rejects a faster refresh", async () => {
    seen.length = 0;
    const sender = createApnsSender(config, origin);
    await sender.sendNoteArrived(["tok-a"], "note-3");
    await sender.sendNoteArrived(["tok-b"], "note-4");
    expect(seen[0]!.headers["authorization"]).toBe(seen[1]!.headers["authorization"]);
  });

  it("410 Unregistered and 400 BadDeviceToken mark the token dead; 429 does not", async () => {
    seen.length = 0;
    replies.set("tok-unregistered", { status: 410, reason: "Unregistered" });
    replies.set("tok-bad", { status: 400, reason: "BadDeviceToken" });
    replies.set("tok-busy", { status: 429, reason: "TooManyRequests" });
    replies.set("tok-server", { status: 500, reason: "InternalServerError" });

    const sender = createApnsSender(config, origin);
    const results = await sender.sendNoteArrived(
      ["tok-live", "tok-unregistered", "tok-bad", "tok-busy", "tok-server"],
      "note-5",
    );
    const byToken = new Map(results.map((r) => [r.token, r]));

    expect(byToken.get("tok-live")).toEqual({ token: "tok-live", ok: true, gone: false });
    expect(byToken.get("tok-unregistered")!.gone).toBe(true);
    expect(byToken.get("tok-bad")!.gone).toBe(true);
    expect(byToken.get("tok-busy")).toEqual({ token: "tok-busy", ok: false, gone: false });
    expect(byToken.get("tok-server")).toEqual({ token: "tok-server", ok: false, gone: false });
    replies.clear();
  });

  it("an unreachable APNs resolves as undelivered — it never throws, and never prunes", async () => {
    const sender = createApnsSender(config, "http://127.0.0.1:1");
    const results = await sender.sendNoteArrived(["tok-x", "tok-y"], "note-6");
    expect(results).toEqual([
      { token: "tok-x", ok: false, gone: false },
      { token: "tok-y", ok: false, gone: false },
    ]);
  });

  it("sends nothing, and asks for no provider token, when there are no devices", async () => {
    seen.length = 0;
    const sender = createApnsSender({ ...config, privateKey: "not-a-key" }, origin);
    expect(await sender.sendNoteArrived([], "note-7")).toEqual([]);
    expect(seen.length).toBe(0);
  });

  it("picks the APNs host from the configured environment", () => {
    expect(APNS_HOSTS.sandbox).toBe("https://api.sandbox.push.apple.com");
    expect(APNS_HOSTS.production).toBe("https://api.push.apple.com");
  });
});
