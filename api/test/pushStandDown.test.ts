import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testdb";
import { notifyNoteSent, notifyNotesReady, pushEnabled, type PushSender } from "../src/notes/push";
import { devices, users } from "../src/db/schema";
import type { Db } from "../src/db/client";

let db: Db;
let sent: string[];
let sender: PushSender;
let userId: string;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  delete process.env.PUSH_ENABLED;
  sent = [];
  sender = {
    async sendNoteArrived(tokens, noteId) {
      sent.push(noteId);
      return tokens.map((token) => ({ token, ok: true, gone: false }));
    },
  };
  await db.orm.delete(devices);
  await db.orm.delete(users);
  const [row] = await db.orm.insert(users).values({ displayName: "Recipient" }).returning();
  userId = row!.id;
  await db.orm.insert(devices).values({ userId, token: "tok-live" });
});

describe("notifications are deliberately off", () => {
  it("defaults to off, and only the literal string \"true\" turns it on", () => {
    expect(pushEnabled({})).toBe(false);
    expect(pushEnabled({ PUSH_ENABLED: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(pushEnabled({ PUSH_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(pushEnabled({ PUSH_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(pushEnabled({ PUSH_ENABLED: "yes" } as NodeJS.ProcessEnv)).toBe(false);
    expect(pushEnabled({ PUSH_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("sends nothing on a note send, with a live sender and a registered device", async () => {
    const outcome = await notifyNoteSent({ db, push: sender }, {
      studentId: userId,
      noteId: "note-off-1",
    });
    expect(sent).toEqual([]);
    expect(outcome).toBeNull();
    expect((await db.orm.select().from(devices).where(eq(devices.userId, userId))).length).toBe(1);
  });

  it("sends nothing when notes become ready, for either owner role", async () => {
    for (const ownerRole of ["teacher", "student"]) {
      const outcome = await notifyNotesReady({ db, push: sender }, {
        userId,
        noteId: `note-off-${ownerRole}`,
        ownerRole,
      });
      expect(outcome).toBeNull();
    }
    expect(sent).toEqual([]);
  });

  it("the same calls DO send once the switch is on — the gate is the only thing stopping them", async () => {
    process.env.PUSH_ENABLED = "true";
    await notifyNoteSent({ db, push: sender }, { studentId: userId, noteId: "note-on-1" });
    await notifyNotesReady({ db, push: sender }, { userId, noteId: "note-on-2", ownerRole: "teacher" });
    expect(sent).toEqual(["note-on-1", "note-on-2"]);
  });
});
