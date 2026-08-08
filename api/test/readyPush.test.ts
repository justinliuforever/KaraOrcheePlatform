import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createTestDb } from "./testdb";
import { internalPushRouter } from "../src/routes/push";
import {
  NOTES_READY_SOLO_ALERT,
  NOTES_READY_TEACHER_ALERT,
  notePushPayload,
  type PushAlert,
  type PushSender,
} from "../src/notes/push";
import { devices, lessonSessions, noteJobs, notes, users } from "../src/db/schema";
import type { Db } from "../src/db/client";

const KEY = "internal-key-of-exactly-this-length";

interface FakePush extends PushSender {
  calls: { tokens: string[]; noteId: string; alert: PushAlert }[];
  gone: Set<string>;
}
function makeFakePush(): FakePush {
  const p: FakePush = {
    calls: [],
    gone: new Set(),
    async sendNoteArrived(tokens, noteId, alert) {
      p.calls.push({ tokens: [...tokens], noteId, alert: alert! });
      return tokens.map((token) => ({ token, ok: !p.gone.has(token), gone: p.gone.has(token) }));
    },
  };
  return p;
}

let db: Db;
let fakePush: FakePush;

function makeApp() {
  return mount(KEY);
}

function makeAppWithoutKey() {
  return mount(undefined);
}

function mount(key: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use(internalPushRouter({ db, push: fakePush }, key));
  return app;
}

beforeAll(async () => {
  process.env.PUSH_ENABLED = "true";
  db = await createTestDb();
});

afterAll(() => {
  delete process.env.PUSH_ENABLED;
});

beforeEach(async () => {
  fakePush = makeFakePush();
  const orm = db.orm;
  await orm.delete(devices);
  await orm.delete(notes);
  await orm.delete(noteJobs);
  await orm.delete(lessonSessions);
  await orm.delete(users);
});

interface Built {
  jobId: string;
  noteId: string;
  ownerId: string;
}

async function buildReadyJob(opts: {
  ownerRole: "teacher" | "student";
  status?: string;
  token?: string;
  withNote?: boolean;
}): Promise<Built> {
  const orm = db.orm;
  const [owner] = await orm
    .insert(users)
    .values({ ciamOid: `oid-${opts.ownerRole}-${Math.random()}`, displayName: "Owner" })
    .returning();
  const [student] = await orm
    .insert(users)
    .values({ ciamOid: `oid-student-${Math.random()}`, displayName: "Pupil" })
    .returning();
  const [lesson] = await orm
    .insert(lessonSessions)
    .values({
      teacherId: owner!.id,
      ownerRole: opts.ownerRole,
      studentId: opts.ownerRole === "teacher" ? student!.id : null,
      pieceLabel: "Burgmüller Op. 100 No. 2",
    })
    .returning();
  const [job] = await orm
    .insert(noteJobs)
    .values({ lessonSessionId: lesson!.id, status: opts.status ?? "ready_for_review" })
    .returning();
  let noteId = "";
  if (opts.withNote !== false) {
    const [note] = await orm
      .insert(notes)
      .values({
        noteJobId: job!.id,
        lessonSessionId: lesson!.id,
        teacherId: owner!.id,
        studentId: opts.ownerRole === "teacher" ? student!.id : owner!.id,
        origin: opts.ownerRole === "teacher" ? "teacher" : "self",
        pieceLabel: "Burgmüller Op. 100 No. 2",
        status: opts.ownerRole === "teacher" ? "draft" : "sent",
        contentOriginal: {},
        content: { lesson_summary: "Keep the left hand quiet in bars 9-12." },
      })
      .returning();
    noteId = note!.id;
  }
  if (opts.token) {
    await orm.insert(devices).values({ userId: owner!.id, token: opts.token });
  }
  return { jobId: job!.id, noteId, ownerId: owner!.id };
}

describe("B6-2 internal ready-push route", () => {
  it("401s without the key and with a wrong key, and never sends", async () => {
    const built = await buildReadyJob({ ownerRole: "teacher", token: "tok-t" });
    const app = makeApp();

    const bare = await request(app).post(`/internal/notes/${built.jobId}/ready-push`);
    expect(bare.status).toBe(401);

    const wrong = await request(app)
      .post(`/internal/notes/${built.jobId}/ready-push`)
      .set("X-Internal-Key", "not-the-key-but-same-length-xxxxxxx");
    expect(wrong.status).toBe(401);

    expect(fakePush.calls).toEqual([]);
  });

  it("503s when the key is unset on this container", async () => {
    const built = await buildReadyJob({ ownerRole: "teacher", token: "tok-t" });
    const res = await request(makeAppWithoutKey())
      .post(`/internal/notes/${built.jobId}/ready-push`)
      .set("X-Internal-Key", KEY);
    expect(res.status).toBe(503);
    expect(fakePush.calls).toEqual([]);
  });

  it("409s unless the job is ready_for_review", async () => {
    const built = await buildReadyJob({ ownerRole: "teacher", status: "processing", token: "tok-t" });
    const res = await request(makeApp())
      .post(`/internal/notes/${built.jobId}/ready-push`)
      .set("X-Internal-Key", KEY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_ready");
    expect(fakePush.calls).toEqual([]);
  });

  it("sends the review alert to the teacher-owner's devices only", async () => {
    const built = await buildReadyJob({ ownerRole: "teacher", token: "tok-owner" });
    const orm = db.orm;
    const [stranger] = await orm
      .insert(users)
      .values({ ciamOid: `oid-stranger-${Math.random()}`, displayName: "Stranger" })
      .returning();
    await orm.insert(devices).values({ userId: stranger!.id, token: "tok-stranger" });

    const res = await request(makeApp())
      .post(`/internal/notes/${built.jobId}/ready-push`)
      .set("X-Internal-Key", KEY);

    expect(res.status).toBe(200);
    expect(res.body.push).toEqual({ attempted: 1, delivered: 1, pruned: 0 });
    expect(fakePush.calls.length).toBe(1);
    expect(fakePush.calls[0]!.tokens).toEqual(["tok-owner"]);
    expect(fakePush.calls[0]!.noteId).toBe(built.noteId);
    expect(fakePush.calls[0]!.alert).toEqual(NOTES_READY_TEACHER_ALERT);
  });

  it("sends the read alert on a solo lesson", async () => {
    const built = await buildReadyJob({ ownerRole: "student", token: "tok-solo" });
    const res = await request(makeApp())
      .post(`/internal/notes/${built.jobId}/ready-push`)
      .set("X-Internal-Key", KEY);

    expect(res.status).toBe(200);
    expect(fakePush.calls[0]!.tokens).toEqual(["tok-solo"]);
    expect(fakePush.calls[0]!.alert).toEqual(NOTES_READY_SOLO_ALERT);
  });

  it("carries no piece, student or note content in the payload", async () => {
    const built = await buildReadyJob({ ownerRole: "teacher", token: "tok-owner" });
    await request(makeApp())
      .post(`/internal/notes/${built.jobId}/ready-push`)
      .set("X-Internal-Key", KEY);

    const wire = JSON.stringify(notePushPayload(built.noteId, fakePush.calls[0]!.alert));
    for (const forbidden of ["Burgmüller", "Op. 100", "Pupil", "left hand", "bars 9-12"]) {
      expect(wire).not.toContain(forbidden);
    }
    expect(JSON.parse(wire)).toEqual({
      aps: {
        alert: { ...NOTES_READY_TEACHER_ALERT },
        sound: "default",
        "thread-id": "notes",
      },
      noteId: built.noteId,
    });
    expect(JSON.parse(wire).aps.badge).toBeUndefined();
  });

  it("prunes a dead token and still reports the outcome", async () => {
    const built = await buildReadyJob({ ownerRole: "teacher", token: "tok-dead" });
    fakePush.gone.add("tok-dead");
    const res = await request(makeApp())
      .post(`/internal/notes/${built.jobId}/ready-push`)
      .set("X-Internal-Key", KEY);

    expect(res.body.push).toEqual({ attempted: 1, delivered: 0, pruned: 1 });
    const left = await db.orm.select().from(devices);
    expect(left).toEqual([]);
  });

  it("404s on an unknown job and on a ready job whose note is gone", async () => {
    const app = makeApp();
    const unknown = await request(app)
      .post("/internal/notes/00000000-0000-0000-0000-000000000000/ready-push")
      .set("X-Internal-Key", KEY);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("unknown_job");

    const built = await buildReadyJob({ ownerRole: "teacher", withNote: false, token: "tok-t" });
    const gone = await request(app)
      .post(`/internal/notes/${built.jobId}/ready-push`)
      .set("X-Internal-Key", KEY);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe("note_missing");
    expect(fakePush.calls).toEqual([]);
  });
});
