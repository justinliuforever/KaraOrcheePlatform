import { connect, constants } from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import { inArray, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { devices } from "../db/schema";

// PAYLOAD RULE, BINDING: no note content ever crosses APNs. The alert is a fixed
// string and the only variable carried is the note id, which the app exchanges for
// the note over an authenticated request. Two reasons, and both outrank convenience:
// a lock screen is readable by whoever is nearby and this is a minor's lesson record,
// and the server stays the source of truth so a dropped push loses nothing.
//
// v0.9 NOTIFICATION POLICY, BINDING on every notification added after this line:
// a push announces the completion of a job the RECIPIENT personally started, and
// nothing else. Never the other party's reading or practising — those are
// surveillance signals, not news. Never an app-icon badge. Fixed strings plus an
// id: no piece title, no names, no content. Adding a notification means clearing
// these bars again, here, in writing.

// Notifications are DELIBERATELY OFF for this release (founder, 2026-08-07): the feature
// is built and waits for a later one. This is the single switch, and it is the reason
// nothing sends — not the absence of an APNs key, which is a separate accident.
export function pushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PUSH_ENABLED === "true";
}

export interface PushAlert {
  title: string;
  body: string;
}

export const NOTE_ARRIVED_ALERT: PushAlert = {
  title: "New practice note",
  body: "Your teacher sent you a note. Open the app to read it.",
};

// The recorder is waiting on their own job either way; only the next action differs.
export const NOTES_READY_TEACHER_ALERT: PushAlert = {
  title: "Notes ready to review",
  body: "A lesson you recorded has notes ready to review.",
};

export const NOTES_READY_SOLO_ALERT: PushAlert = {
  title: "Your practice notes are ready",
  body: "Open KaraOrchee to read them.",
};

export function notesReadyAlert(ownerRole: string): PushAlert {
  return ownerRole === "student" ? NOTES_READY_SOLO_ALERT : NOTES_READY_TEACHER_ALERT;
}

export function notePushPayload(noteId: string, alert: PushAlert): Record<string, unknown> {
  return {
    aps: {
      alert: { ...alert },
      sound: "default",
      "thread-id": "notes",
    },
    noteId,
  };
}

export function noteArrivedPayload(noteId: string): Record<string, unknown> {
  return notePushPayload(noteId, NOTE_ARRIVED_ALERT);
}

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string; // .p8 PKCS#8 PEM
  bundleId: string;
  environment: "sandbox" | "production";
}

export interface PushDelivery {
  token: string;
  ok: boolean;
  // APNs says this token is dead for this topic; the row is garbage and must go.
  gone: boolean;
}

export interface PushSender {
  /// One fixed alert about one note, to one user's device tokens. `alert` is the
  /// whole variable surface — the payload builder refuses everything else.
  sendNoteArrived(
    tokens: string[],
    noteId: string,
    alert?: PushAlert,
  ): Promise<PushDelivery[]>;
}

export const APNS_HOSTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;

// Apple rejects a provider token refreshed more often than every 20 minutes and
// expires one older than 60; 50 sits clear of both edges.
const TOKEN_TTL_MS = 50 * 60 * 1000;
// The teacher is waiting on the send response, so the whole best-effort delivery is
// bounded well under any human's patience. Exceeding it is a failed push, never a
// failed send.
const DEADLINE_MS = 4000;

// A token APNs will never accept again. Everything else (503, timeouts, a closed
// session) is transient and leaves the row alone — pruning on a transient fault
// would silently unsubscribe a working device.
const DEAD_TOKEN_REASONS = new Set(["Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic"]);

// `origin` exists so the wire contract — headers, path, payload bytes, and what each APNs reason
// code does to a device row — can be asserted against a real HTTP/2 server instead of a stub.
export function createApnsSender(
  config: ApnsConfig,
  origin: string = APNS_HOSTS[config.environment],
): PushSender {
  let cached: { jwt: string; madeAt: number } | null = null;

  async function providerToken(): Promise<string> {
    if (cached && Date.now() - cached.madeAt < TOKEN_TTL_MS) return cached.jwt;
    const key = await importPKCS8(config.privateKey, "ES256");
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.keyId })
      .setIssuer(config.teamId)
      .setIssuedAt()
      .sign(key);
    cached = { jwt, madeAt: Date.now() };
    return jwt;
  }

  return {
    async sendNoteArrived(tokens, noteId, alert = NOTE_ARRIVED_ALERT) {
      if (tokens.length === 0) return [];
      const jwt = await providerToken();
      const body = Buffer.from(JSON.stringify(notePushPayload(noteId, alert)));
      const session = connect(origin);
      // MANDATORY: an http2 session with no 'error' listener turns a DNS or TLS failure into an
      // uncaught exception, which takes the process down mid-send. Every stream settles anyway —
      // destroying a session errors its streams — so this only has to exist, not to do anything.
      session.on("error", () => {});
      const deadline = setTimeout(() => session.destroy(), DEADLINE_MS);
      try {
        return await Promise.all(
          tokens.map((token) => deliver(session, token, jwt, body, config, noteId)),
        );
      } finally {
        clearTimeout(deadline);
        session.close();
      }
    },
  };
}

function deliver(
  session: ReturnType<typeof connect>,
  token: string,
  jwt: string,
  body: Buffer,
  config: ApnsConfig,
  noteId: string,
): Promise<PushDelivery> {
  return new Promise((resolve) => {
    const settle = (ok: boolean, gone: boolean) => resolve({ token, ok, gone });
    let stream;
    try {
      stream = session.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        // One banner per note however many times a send is retried.
        "apns-collapse-id": noteId,
      });
    } catch {
      settle(false, false);
      return;
    }
    let status = 0;
    const chunks: Buffer[] = [];
    stream.on("response", (headers) => {
      status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", () => settle(false, false));
    stream.on("end", () => {
      if (status === 200) {
        settle(true, false);
        return;
      }
      let reason: string | undefined;
      try {
        reason = (JSON.parse(Buffer.concat(chunks).toString()) as { reason?: string }).reason;
      } catch {
        reason = undefined;
      }
      settle(false, reason !== undefined && DEAD_TOKEN_REASONS.has(reason));
    });
    stream.end(body);
  });
}

export interface NotifyOutcome {
  attempted: number;
  delivered: number;
  pruned: number;
}

// Best-effort by contract: the thing being announced is already committed before this
// runs, and every failure here — an unconfigured key, a dead APNs, a rejected token —
// is swallowed into the returned counters. Never throws.
async function notify(
  deps: Deps,
  args: { userId: string; noteId: string; alert: PushAlert; label: string },
): Promise<NotifyOutcome | null> {
  if (!pushEnabled() || !deps.push || !deps.db) return null;
  const db = deps.db.orm;
  try {
    const rows = await db
      .select({ token: devices.token })
      .from(devices)
      .where(eq(devices.userId, args.userId));
    if (rows.length === 0) return { attempted: 0, delivered: 0, pruned: 0 };
    const results = await deps.push.sendNoteArrived(
      rows.map((r) => r.token),
      args.noteId,
      args.alert,
    );
    const dead = results.filter((r) => r.gone).map((r) => r.token);
    if (dead.length > 0) {
      await db.delete(devices).where(inArray(devices.token, dead));
    }
    return {
      attempted: results.length,
      delivered: results.filter((r) => r.ok).length,
      pruned: dead.length,
    };
  } catch (err) {
    console.error(`${args.label}: push failed`, args.noteId, err);
    return null;
  }
}

export async function notifyNoteSent(
  deps: Deps,
  args: { studentId: string; noteId: string },
): Promise<NotifyOutcome | null> {
  return notify(deps, {
    userId: args.studentId,
    noteId: args.noteId,
    alert: NOTE_ARRIVED_ALERT,
    label: "note.send",
  });
}

// The recipient is the RECORDER (lesson_sessions.teacher_id, which is the student
// themselves on a solo lesson); owner_role only picks which of the two fixed alerts
// describes what they can do next.
export async function notifyNotesReady(
  deps: Deps,
  args: { userId: string; noteId: string; ownerRole: string },
): Promise<NotifyOutcome | null> {
  return notify(deps, {
    userId: args.userId,
    noteId: args.noteId,
    alert: notesReadyAlert(args.ownerRole),
    label: "notes.ready",
  });
}
