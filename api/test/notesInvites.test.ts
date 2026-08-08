import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
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
import { auditEvents, invites, teacherStudentLinks, users } from "../src/db/schema";
import type { Db } from "../src/db/client";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;

function makeApp() {
  return createServer({ db, auth: verifier });
}

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

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

interface TestUser {
  token: string;
  id: string;
}
async function makeUser(oid: string, name: string, role?: "teacher" | "student"): Promise<TestUser> {
  const token = await mkToken(oid, name);
  const body: Record<string, unknown> = {};
  if (role) body.role = role;
  const res = await request(makeApp()).post("/v1/users/sync").set("Authorization", `Bearer ${token}`).send(body);
  if (res.status !== 200) throw new Error(`sync failed for ${oid}: ${res.status}`);
  return { token, id: res.body.id as string };
}

function auth(u: TestUser) {
  return `Bearer ${u.token}`;
}

function mint(u: TestUser, body: Record<string, unknown> = {}) {
  return request(makeApp()).post("/v1/invites").set("Authorization", auth(u)).send(body);
}

function redeem(u: TestUser, body: Record<string, unknown>) {
  return request(makeApp()).post("/v1/invites/redeem").set("Authorization", auth(u)).send(body);
}

function liveCodes(u: TestUser) {
  return request(makeApp()).get("/v1/invites").set("Authorization", auth(u));
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

describe("one live code per issuer per direction", () => {
  let t: TestUser;

  beforeAll(async () => {
    t = await makeUser("pi-cap-teacher", "Cap Teacher", "teacher");
  });

  it("a second mint returns the existing row with 200, not a new code", async () => {
    const first = await mint(t);
    expect(first.status).toBe(201);

    const second = await mint(t);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.code).toBe(first.body.code);

    const list = await liveCodes(t);
    expect(list.body.length).toBe(1);
  });

  it("a revoked code is not live: the next mint is fresh", async () => {
    const live = await liveCodes(t);
    const oldId = live.body[0].id as string;
    const del = await request(makeApp()).delete(`/v1/invites/${oldId}`).set("Authorization", auth(t));
    expect(del.status).toBe(200);

    const next = await mint(t);
    expect(next.status).toBe(201);
    expect(next.body.id).not.toBe(oldId);
  });

  it("a spent code is not live: serial onboarding still works", async () => {
    const s = await makeUser("pi-cap-student", "Cap Student");
    const code = (await liveCodes(t)).body[0].code as string;
    const done = await redeem(s, { code, consent: true });
    expect(done.status).toBe(201);

    const next = await mint(t);
    expect(next.status).toBe(201);
    expect(next.body.code).not.toBe(code);
  });

  it("an expired code is not live", async () => {
    const liveId = (await liveCodes(t)).body[0].id as string;
    await db.orm.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, liveId));

    const next = await mint(t);
    expect(next.status).toBe(201);
    expect(next.body.id).not.toBe(liveId);
  });

  it("the two directions are capped independently", async () => {
    const dual = await makeUser("pi-cap-dual", "Cap Dual", "student");
    await db.orm.update(users).set({ isTeacher: true }).where(eq(users.id, dual.id));

    const fwd = await mint(dual, { direction: "teacher_to_student" });
    expect(fwd.status).toBe(201);
    const rev = await mint(dual, { direction: "student_to_teacher", consent: true });
    expect(rev.status).toBe(201);
    expect(rev.body.id).not.toBe(fwd.body.id);

    expect((await mint(dual, { direction: "teacher_to_student" })).status).toBe(200);
    expect((await mint(dual, { direction: "student_to_teacher", consent: true })).status).toBe(200);
    expect((await liveCodes(dual)).body.length).toBe(2);
  });

  it("a double tap cannot mint two live codes", async () => {
    const race = await makeUser("pi-cap-race", "Race Teacher", "teacher");
    const [a, b] = await Promise.all([mint(race), mint(race)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect((await liveCodes(race)).body.length).toBe(1);
  });
});

describe("stated direction", () => {
  it("a dual-role account can mint student_to_teacher (the derivation could not)", async () => {
    const dual = await makeUser("pi-dir-dual", "Dir Dual", "teacher");
    await db.orm.update(users).set({ isStudent: true }).where(eq(users.id, dual.id));

    const derived = await mint(dual, {});
    expect(derived.status).toBe(201);
    expect(derived.body.direction).toBe("teacher_to_student");

    const reverse = await mint(dual, { direction: "student_to_teacher", consent: true });
    expect(reverse.status).toBe(201);
    expect(reverse.body.direction).toBe("student_to_teacher");
  });

  it("a student-only account cannot mint teacher_to_student", async () => {
    const s = await makeUser("pi-dir-student", "Dir Student", "student");
    const res = await mint(s, { direction: "teacher_to_student" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("teacher_only");
    expect(res.body.message).toBe("This account isn't set up as a teacher.");
  });

  it("a teacher-only account cannot mint student_to_teacher", async () => {
    const t = await makeUser("pi-dir-teacher", "Dir Teacher", "teacher");
    const res = await mint(t, { direction: "student_to_teacher", consent: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("student_only");
    expect(res.body.message).toBe("This account isn't set up as a student.");
  });

  it("an unknown direction is a 400 with a message, not a 500", async () => {
    const t = await makeUser("pi-dir-bogus", "Bogus", "teacher");
    const res = await mint(t, { direction: "sideways" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_direction");
    expect(typeof res.body.message).toBe("string");
  });

  it("a stated reverse direction still requires consent", async () => {
    const s = await makeUser("pi-dir-consent", "Consent Cara", "student");
    const res = await mint(s, { direction: "student_to_teacher" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("consent_required");
    expect(typeof res.body.message).toBe("string");
  });
});

describe("redeem is one transaction", () => {
  it("two codes for one pair race to one 201 and one clean 409 — never a 500", async () => {
    const t = await makeUser("pi-tx-teacher", "Tx Teacher", "teacher");
    const s = await makeUser("pi-tx-student", "Tx Student");
    const rows = await db.orm
      .insert(invites)
      .values([
        { code: "TXAAAA", teacherId: t.id, expiresAt: daysFromNow(7) },
        { code: "TXBBBB", teacherId: t.id, expiresAt: daysFromNow(7) },
      ])
      .returning();

    const [a, b] = await Promise.all([
      redeem(s, { code: "TXAAAA", consent: true }),
      redeem(s, { code: "TXBBBB", consent: true }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect([404, 409]).toContain(statuses[1]);
    expect(a.status).not.toBe(500);
    expect(b.status).not.toBe(500);

    const links = await db.orm
      .select()
      .from(teacherStudentLinks)
      .where(and(eq(teacherStudentLinks.teacherId, t.id), eq(teacherStudentLinks.studentId, s.id)));
    expect(links.length).toBe(1);

    const after = await db.orm.select().from(invites).where(eq(invites.teacherId, t.id));
    const spent = after.filter((r) => r.usedCount > 0);
    expect(spent.length).toBe(1);
    expect(rows.length).toBe(2);
  });
});

describe("ending a link", () => {
  it("a code minted before the removal cannot re-form the pair, and says so in its own words", async () => {
    const t = await makeUser("pi-rm-teacher", "Rm Teacher", "teacher");
    const s = await makeUser("pi-rm-student", "Rm Student");

    const r1 = await mint(t);
    const r2 = await db.orm
      .insert(invites)
      .values({ code: "RMOLD1", teacherId: t.id, expiresAt: daysFromNow(7) })
      .returning();
    expect(r2.length).toBe(1);

    expect((await redeem(s, { code: r1.body.code, consent: true })).status).toBe(201);
    expect((await request(makeApp()).delete(`/v1/me/teachers/${t.id}`).set("Authorization", auth(s))).status).toBe(200);

    const stale = await redeem(s, { code: "RMOLD1", consent: true });
    expect(stale.status).toBe(404);
    expect(stale.body.error).toBe("stale_code");
    expect(stale.body.message).toBe("That code was made before your connection ended. Ask for a new one.");
    expect(stale.body.message).not.toBe("That code is invalid or has expired — ask for a new one.");
    const [link] = await db.orm
      .select()
      .from(teacherStudentLinks)
      .where(and(eq(teacherStudentLinks.teacherId, t.id), eq(teacherStudentLinks.studentId, s.id)));
    expect(link!.status).toBe("removed");
  });

  it("stale refusals never count toward the redeem lock", async () => {
    const t = await makeUser("pi-stale-teacher", "Stale Teacher", "teacher");
    const s = await makeUser("pi-stale-student", "Stale Student");
    const first = (await mint(t)).body.code as string;
    await db.orm
      .insert(invites)
      .values({ code: "STALE1", teacherId: t.id, expiresAt: daysFromNow(7) })
      .returning();
    expect((await redeem(s, { code: first, consent: true })).status).toBe(201);
    expect((await request(makeApp()).delete(`/v1/me/teachers/${t.id}`).set("Authorization", auth(s))).status).toBe(200);

    for (let i = 0; i < 7; i++) {
      const res = await redeem(s, { code: "STALE1", consent: true });
      expect(res.status, `attempt ${i}`).toBe(404);
      expect(res.body.error, `attempt ${i}`).toBe("stale_code");
    }
    const rows = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorUserId, s.id), eq(auditEvents.action, "invite.redeem_failed")));
    expect(rows.length).toBe(7);
    expect(rows.every((r) => (r.detail as { reason: string }).reason === "stale_code")).toBe(true);

    const rejoin = await mint(t, { rejoinUserId: s.id });
    expect(rejoin.status).toBe(201);
    expect((await redeem(s, { code: rejoin.body.code, consent: true })).status).toBe(201);
  });

  it("ending one pair leaves the remover's unrelated pending invitation alive", async () => {
    const t = await makeUser("pi-rm2-teacher", "Rm2 Teacher", "teacher");
    const s = await makeUser("pi-rm2-student", "Rm2 Student");
    const code = (await mint(t)).body.code as string;
    expect((await redeem(s, { code, consent: true })).status).toBe(201);

    const pending = await mint(t);
    expect(pending.status).toBe(201);
    expect((await liveCodes(t)).body.length).toBe(1);

    const removed = await request(makeApp())
      .delete(`/v1/me/students/${s.id}`)
      .set("Authorization", auth(t));
    expect(removed.status).toBe(200);

    const live = await liveCodes(t);
    expect(live.body.length).toBe(1);
    expect(live.body[0].id).toBe(pending.body.id);

    const other = await makeUser("pi-rm2-other", "Rm2 Other");
    expect((await redeem(other, { code: pending.body.code, consent: true })).status).toBe(201);
  });

  it("the surviving code cannot re-form the pair that was ended", async () => {
    const t = await makeUser("pi-rm3-teacher", "Rm3 Teacher", "teacher");
    const s = await makeUser("pi-rm3-student", "Rm3 Student");
    const code = (await mint(t)).body.code as string;
    expect((await redeem(s, { code, consent: true })).status).toBe(201);
    const pending = await mint(t);
    expect(pending.status).toBe(201);

    expect((await request(makeApp()).delete(`/v1/me/teachers/${t.id}`).set("Authorization", auth(s))).status).toBe(200);
    expect((await liveCodes(t)).body.length).toBe(1);

    const back = await redeem(s, { code: pending.body.code, consent: true });
    expect(back.status).toBe(404);
    expect(back.body.error).toBe("stale_code");
  });

  it("a student leaving keeps their own pending reverse invitation alive", async () => {
    const s = await makeUser("pi-rm4-student", "Rm4 Student", "student");
    const t = await makeUser("pi-rm4-teacher", "Rm4 Teacher", "teacher");
    const forward = (await mint(t)).body.code as string;
    expect((await redeem(s, { code: forward, consent: true })).status).toBe(201);

    const reverse = await mint(s, { direction: "student_to_teacher", consent: true });
    expect(reverse.status).toBe(201);

    expect((await request(makeApp()).delete(`/v1/me/teachers/${t.id}`).set("Authorization", auth(s))).status).toBe(200);
    const live = await liveCodes(s);
    expect(live.body.map((r: { id: string }) => r.id)).toContain(reverse.body.id);

    const other = await makeUser("pi-rm4-other", "Rm4 Other");
    const accepted = await redeem(other, { code: reverse.body.code, acceptTeacherRole: true });
    expect(accepted.status).toBe(201);
  });

  it("a multi-use code the counterpart already redeemed IS retired with the pair", async () => {
    const t = await makeUser("pi-rm5-teacher", "Rm5 Teacher", "teacher");
    const s = await makeUser("pi-rm5-student", "Rm5 Student");
    const [multi] = await db.orm
      .insert(invites)
      .values({ code: "MULTI1", teacherId: t.id, maxUses: 3, expiresAt: daysFromNow(7) })
      .returning();
    expect((await redeem(s, { code: "MULTI1", consent: true })).status).toBe(201);
    expect((await liveCodes(t)).body.length).toBe(1);

    expect((await request(makeApp()).delete(`/v1/me/students/${s.id}`).set("Authorization", auth(t))).status).toBe(200);
    const [row] = await db.orm.select().from(invites).where(eq(invites.id, multi!.id));
    expect(row!.revokedAt).not.toBeNull();
  });
});

describe("rejoin mint", () => {
  async function endedPair(prefix: string): Promise<{ t: TestUser; s: TestUser; preRemoval: string }> {
    const t = await makeUser(`${prefix}-teacher`, "Rejoin Teacher", "teacher");
    const s = await makeUser(`${prefix}-student`, "Rejoin Student");
    const code = (await mint(t)).body.code as string;
    expect((await redeem(s, { code, consent: true })).status).toBe(201);
    const pre = await mint(t);
    expect(pre.status).toBe(201);
    expect((await request(makeApp()).delete(`/v1/me/teachers/${t.id}`).set("Authorization", auth(s))).status).toBe(200);
    return { t, s, preRemoval: pre.body.id as string };
  }

  it("a plain mint still hands back the pre-removal code, which redeem refuses", async () => {
    const { t, s, preRemoval } = await endedPair("pi-rj1");
    const again = await mint(t);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(preRemoval); // the loop PL-1 filed
    expect((await redeem(s, { code: again.body.code, consent: true })).body.error).toBe("stale_code");
  });

  it("naming the person retires that code and mints one the stale rule accepts", async () => {
    const { t, s, preRemoval } = await endedPair("pi-rj2");
    const fresh = await mint(t, { rejoinUserId: s.id });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(preRemoval);

    const [old] = await db.orm.select().from(invites).where(eq(invites.id, preRemoval));
    expect(old!.revokedAt).not.toBeNull();
    const live = await liveCodes(t);
    expect(live.body.length).toBe(1); // the one-live-code cap still holds
    expect(live.body[0].id).toBe(fresh.body.id);

    const back = await redeem(s, { code: fresh.body.code, consent: true });
    expect(back.status).toBe(201);
    expect(back.body.link.status).toBe("active");

    const revokes = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorUserId, t.id), eq(auditEvents.action, "invite.revoke")));
    expect(revokes.some((r) => r.subjectId === preRemoval)).toBe(true);
    expect(revokes.find((r) => r.subjectId === preRemoval)!.detail).toMatchObject({ reason: "rejoin" });
  });

  it("a second rejoin tap is idempotent — the fresh code is already good enough", async () => {
    const { t, s } = await endedPair("pi-rj3");
    const first = await mint(t, { rejoinUserId: s.id });
    expect(first.status).toBe(201);
    const second = await mint(t, { rejoinUserId: s.id });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect((await liveCodes(t)).body.length).toBe(1);
  });

  it("naming someone the caller has no ended pair with changes nothing", async () => {
    const { t, preRemoval } = await endedPair("pi-rj4");
    const stranger = await makeUser("pi-rj4-stranger", "Stranger");
    const res = await mint(t, { rejoinUserId: stranger.id });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(preRemoval); // no floor, so no churn
    const [old] = await db.orm.select().from(invites).where(eq(invites.id, preRemoval));
    expect(old!.revokedAt).toBeNull();
  });

  it("the floor comes from the link row, so naming an ACTIVE pair changes nothing", async () => {
    const t = await makeUser("pi-rj5-teacher", "Active Teacher", "teacher");
    const s = await makeUser("pi-rj5-student", "Active Student");
    const code = (await mint(t)).body.code as string;
    expect((await redeem(s, { code, consent: true })).status).toBe(201);
    const pending = await mint(t);
    expect(pending.status).toBe(201);

    const res = await mint(t, { rejoinUserId: s.id });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(pending.body.id);
  });

  it("a non-UUID rejoinUserId is a 400 with a message, not a 500", async () => {
    const t = await makeUser("pi-rj6-teacher", "Bad Rejoin", "teacher");
    const res = await mint(t, { rejoinUserId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_rejoin");
    expect(typeof res.body.message).toBe("string");
  });

  it("the reverse direction rejoins the same way", async () => {
    const s = await makeUser("pi-rj7-student", "Reverse Rejoin", "student");
    const t = await makeUser("pi-rj7-teacher", "Reverse Teacher");
    const code = (await mint(s, { direction: "student_to_teacher", consent: true })).body.code as string;
    expect((await redeem(t, { code, acceptTeacherRole: true })).status).toBe(201);
    const pre = await mint(s, { direction: "student_to_teacher", consent: true });
    expect(pre.status).toBe(201);

    expect((await request(makeApp()).delete(`/v1/me/students/${s.id}`).set("Authorization", auth(t))).status).toBe(200);
    const fresh = await mint(s, { direction: "student_to_teacher", consent: true, rejoinUserId: t.id });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(pre.body.id);
    expect((await redeem(t, { code: fresh.body.code, acceptTeacherRole: true })).status).toBe(201);
  });
});

describe("containment and hygiene", () => {
  it("five unknown codes lock the account with a message and a wait", async () => {
    const s = await makeUser("pi-bf-student", "Brute Bea", "student");
    for (const code of ["AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE"]) {
      const res = await redeem(s, { code, consent: true });
      expect(res.status, code).toBe(404);
    }
    const locked = await redeem(s, { code: "FFFFFF", consent: true });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe("too_many_attempts");
    expect(locked.body.message).toMatch(/^Too many incorrect codes\. Try again in \d+ minutes?\.$/);
    expect(locked.body.retryAfterSec).toBeGreaterThan(0);
    expect(locked.headers["retry-after"]).toBeTruthy();

    const t = await makeUser("pi-bf-teacher", "Brute Teacher", "teacher");
    const good = (await mint(t)).body.code as string;
    expect((await redeem(s, { code: good, consent: true })).status).toBe(429);

    const failures = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorUserId, s.id), eq(auditEvents.action, "invite.redeem_failed")));
    expect(failures.length).toBe(5);
    expect(failures[0]!.detail).toMatchObject({ reason: "invalid_code" });

    await db.orm
      .delete(auditEvents)
      .where(and(eq(auditEvents.actorUserId, s.id), eq(auditEvents.action, "invite.redeem_failed")));
    expect((await redeem(s, { code: good, consent: true })).status).toBe(201);
  });

  it("own-code and consent failures are audited but do not count toward the lock", async () => {
    const t = await makeUser("pi-nolock-teacher", "Nolock Teacher", "teacher");
    const code = (await mint(t)).body.code as string;
    for (let i = 0; i < 6; i++) {
      const res = await redeem(t, { code, consent: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("own_code");
    }
    const rows = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorUserId, t.id), eq(auditEvents.action, "invite.redeem_failed")));
    expect(rows.length).toBe(6);
    expect(rows.every((r) => (r.detail as { reason: string }).reason === "own_code")).toBe(true);
  });

  it("revoking a code is idempotent (one audit event) and refuses someone else's code with 404", async () => {
    const t = await makeUser("pi-audit-teacher", "Audit Teacher", "teacher");
    const id = (await mint(t)).body.id as string;
    expect((await request(makeApp()).delete(`/v1/invites/${id}`).set("Authorization", auth(t))).status).toBe(200);

    expect((await request(makeApp()).delete(`/v1/invites/${id}`).set("Authorization", auth(t))).status).toBe(200);
    const rows = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorUserId, t.id), eq(auditEvents.action, "invite.revoke")));
    expect(rows.length).toBe(1);
    expect(rows[0]!.subjectId).toBe(id);

    const other = await makeUser("pi-audit-other", "Audit Other", "teacher");
    const theirs = (await mint(other)).body.id as string;
    expect((await request(makeApp()).delete(`/v1/invites/${theirs}`).set("Authorization", auth(t))).status).toBe(404);
  });

  it("non-UUID path params 404 with a message instead of 500ing on Postgres", async () => {
    const t = await makeUser("pi-uuid-teacher", "Uuid Teacher", "teacher");
    const paths = ["/v1/invites/not-a-uuid", "/v1/me/students/not-a-uuid"];
    for (const p of paths) {
      const del = await request(makeApp()).delete(p).set("Authorization", auth(t));
      expect(del.status, p).toBe(404);
      expect(typeof del.body.message, p).toBe("string");
    }
    const get = await request(makeApp()).get("/v1/me/students/not-a-uuid").set("Authorization", auth(t));
    expect(get.status).toBe(404);
    const teachers = await request(makeApp()).delete("/v1/me/teachers/not-a-uuid").set("Authorization", auth(t));
    expect(teachers.status).toBe(404);
  });

  it("student detail and removal are teacher-gated like the list", async () => {
    const s = await makeUser("pi-gate-student", "Gate Student", "student");
    const other = await makeUser("pi-gate-other", "Gate Other", "student");
    for (const res of [
      await request(makeApp()).get(`/v1/me/students/${other.id}`).set("Authorization", auth(s)),
      await request(makeApp()).delete(`/v1/me/students/${other.id}`).set("Authorization", auth(s)),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("teacher_only");
      expect(res.body.message).toBe("This account isn't set up as a teacher.");
    }
  });

  it("a mint never records a delivery that did not happen", async () => {
    const t = await makeUser("pi-email-teacher", "Email Teacher", "teacher");
    const res = await mint(t, { email: "nobody@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.sentToEmail).toBeNull();

    const s = await makeUser("pi-email-student", "Email Student");
    const done = await redeem(s, { code: res.body.code, consent: true });
    expect(done.status).toBe(201);
    expect(done.body.link.createdVia).toBe("invite_code");
  });
});

describe("role-less account", () => {
  let none: TestUser;

  beforeAll(async () => {
    none = await makeUser("pi-none", "No Role Nora");
  });

  it("every role-gated write answers 403 WITH a message", async () => {
    const cases: [string, Promise<request.Response>, string][] = [
      ["POST /v1/invites", mint(none), "notes_role_required"],
      [
        "POST /v1/lessons",
        request(makeApp()).post("/v1/lessons").set("Authorization", auth(none)).send({}) as unknown as Promise<request.Response>,
        "notes_role_required",
      ],
      [
        "GET /v1/me/students",
        request(makeApp()).get("/v1/me/students").set("Authorization", auth(none)) as unknown as Promise<request.Response>,
        "teacher_only",
      ],
      [
        "GET /v1/notes",
        request(makeApp()).get("/v1/notes").set("Authorization", auth(none)) as unknown as Promise<request.Response>,
        "teacher_only",
      ],
    ];
    for (const [label, pending, code] of cases) {
      const res = await pending;
      expect(res.status, label).toBe(403);
      expect(res.body.error, label).toBe(code);
      expect(typeof res.body.message, label).toBe("string");
      expect(res.body.message.length, label).toBeGreaterThan(0);
    }
  });

  it("can still redeem, and afterwards holds exactly the counterpart role", async () => {
    const t = await makeUser("pi-none-teacher", "None Teacher", "teacher");
    const code = (await mint(t)).body.code as string;
    const res = await redeem(none, { code, consent: true });
    expect(res.status).toBe(201);

    const [row] = await db.orm.select().from(users).where(eq(users.id, none.id));
    expect(row!.isStudent).toBe(true);
    expect(row!.isTeacher).toBe(false);
    expect(row!.trialStartedAt).not.toBeNull();
  });

  it("accepting a reverse code grants isTeacher and starts no trial clock", async () => {
    const s = await makeUser("pi-none-issuer", "Issuer Ivy", "student");
    const bare = await makeUser("pi-none-redeemer", "Bare Ben");
    const code = (await mint(s, { direction: "student_to_teacher", consent: true })).body.code as string;

    const res = await redeem(bare, { code, acceptTeacherRole: true });
    expect(res.status).toBe(201);
    const [row] = await db.orm.select().from(users).where(eq(users.id, bare.id));
    expect(row!.isTeacher).toBe(true);
    expect(row!.isStudent).toBe(false);
    expect(row!.trialStartedAt).toBeNull();
  });
});

describe("every rejection carries a message", () => {
  const files = ["src/routes/links.ts", "src/routes/users.ts", "src/notes/user.ts"];

  it("every 4xx/5xx literal in the pairing files ships one", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const src = readFileSync(join(__dirname, "..", rel), "utf8");
      const re = /res\s*\n?\s*\.status\((\d{3})\)\s*\.json\(([\s\S]*?)\);/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const status = Number(m[1]);
        if (status < 400) continue;
        if (!/\bmessage:/.test(m[2]!)) offenders.push(`${rel} → ${status} ${m[2]!.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the four role gates carry the agreed strings", () => {
    const roleRequired = "This account isn't set up as a teacher or a student yet.";
    const teacherOnly = "This account isn't set up as a teacher.";
    const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
    expect(read("src/routes/links.ts")).toContain(roleRequired);
    expect(read("src/routes/lessons.ts")).toContain(roleRequired);
    expect(read("src/routes/links.ts")).toContain(teacherOnly);
    expect(read("src/routes/notes.ts")).toContain(teacherOnly);
  });
});

function seats(u: TestUser) {
  return request(makeApp()).get("/v1/invites?include=seats").set("Authorization", auth(u));
}

function dismiss(u: TestUser, id: string) {
  return request(makeApp()).post(`/v1/invites/${id}/dismiss`).set("Authorization", auth(u)).send({});
}

describe("labelled invite seats", () => {
  it("an unlabelled mint is still idempotent — the old one-live-code rule, untouched", async () => {
    const t = await makeUser("pi-lbl-plain", "Plain Teacher", "teacher");
    const a = await mint(t);
    const b = await mint(t);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.code).toBe(a.body.code);
    expect(a.body.intendedLabel).toBeNull();
  });

  it("two different labels hold two live codes at once", async () => {
    const t = await makeUser("pi-lbl-two", "Two Teacher", "teacher");
    const emma = await mint(t, { intendedLabel: "Emma" });
    const jack = await mint(t, { intendedLabel: "Jack" });
    expect(emma.status).toBe(201);
    expect(jack.status).toBe(201);
    expect(jack.body.code).not.toBe(emma.body.code);
    const open = await seats(t);
    expect(open.body.map((r: { intendedLabel: string }) => r.intendedLabel).sort()).toEqual(["Emma", "Jack"]);
  });

  it("minting the same label twice returns the same code and never relabels", async () => {
    const t = await makeUser("pi-lbl-same", "Same Teacher", "teacher");
    const first = await mint(t, { intendedLabel: "Emma" });
    const again = await mint(t, { intendedLabel: "Emma" });
    expect(again.status).toBe(200);
    expect(again.body.code).toBe(first.body.code);
    expect(again.body.intendedLabel).toBe("Emma");
  });

  it("a labelled code and an unlabelled code are different seats", async () => {
    const t = await makeUser("pi-lbl-slot", "Slot Teacher", "teacher");
    const plain = await mint(t);
    const named = await mint(t, { intendedLabel: "Emma" });
    expect(named.body.code).not.toBe(plain.body.code);
    const plainAgain = await mint(t, {});
    expect(plainAgain.body.code).toBe(plain.body.code);
  });

  it("a code for your teacher cannot be named", async () => {
    const s = await makeUser("pi-lbl-reverse", "Reverse Student", "student");
    const res = await mint(s, { direction: "student_to_teacher", consent: true, intendedLabel: "Mr Smith" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_label");
    expect(typeof res.body.message).toBe("string");
  });

  it("an over-long label is refused with a sentence, not a truncation", async () => {
    const t = await makeUser("pi-lbl-long", "Long Teacher", "teacher");
    const res = await mint(t, { intendedLabel: "x".repeat(41) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_label");
    expect(res.body.message).toMatch(/too long/i);
  });

  it("a whitespace-only label is stored as no label, not as a blank name", async () => {
    const t = await makeUser("pi-lbl-blank", "Blank Teacher", "teacher");
    const res = await mint(t, { intendedLabel: "   " });
    expect(res.status).toBe(201);
    expect(res.body.intendedLabel).toBeNull();
  });

  it("the tenth live code is the last one — the eleventh is refused, and nothing is minted", async () => {
    const t = await makeUser("pi-lbl-cap", "Cap Teacher", "teacher");
    for (let i = 0; i < 10; i++) {
      const res = await mint(t, { intendedLabel: `Student ${i}` });
      expect(res.status).toBe(201);
    }
    const over = await mint(t, { intendedLabel: "Eleventh" });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe("too_many_codes");
    expect(over.body.message).toMatch(/10 invite codes/);
    const open = await seats(t);
    expect(open.body.length).toBe(10);
  });

  it("an existing seat can still be re-fetched when the cap is full", async () => {
    const t = await makeUser("pi-lbl-cap2", "Cap2 Teacher", "teacher");
    let firstCode = "";
    for (let i = 0; i < 10; i++) {
      const res = await mint(t, { intendedLabel: `Pupil ${i}` });
      if (i === 0) firstCode = res.body.code;
    }
    const again = await mint(t, { intendedLabel: "Pupil 0" });
    expect(again.status).toBe(200);
    expect(again.body.code).toBe(firstCode);
  });

  it("redemption retires the label — a seat that became a person stops naming a child", async () => {
    const t = await makeUser("pi-lbl-redeem-t", "Redeem Teacher", "teacher");
    const s = await makeUser("pi-lbl-redeem-s", "Redeem Student");
    const code = (await mint(t, { intendedLabel: "Emma" })).body.code;
    const res = await redeem(s, { code, consent: true });
    expect(res.status).toBe(201);
    const [row] = await db.orm.select().from(invites).where(eq(invites.code, code));
    expect(row!.intendedLabel).toBeNull();
    expect(row!.usedCount).toBe(1);
  });

  it("revoking retires the label too", async () => {
    const t = await makeUser("pi-lbl-revoke", "Revoke Teacher", "teacher");
    const made = await mint(t, { intendedLabel: "Emma" });
    const del = await request(makeApp())
      .delete(`/v1/invites/${made.body.id}`)
      .set("Authorization", auth(t));
    expect(del.status).toBe(200);
    const [row] = await db.orm.select().from(invites).where(eq(invites.id, made.body.id));
    expect(row!.intendedLabel).toBeNull();
    expect(row!.revokedAt).not.toBeNull();
  });
});

describe("seats and dismissal", () => {
  it("seats carry live and expired codes, and drop the redeemed one", async () => {
    const t = await makeUser("pi-seat-mix", "Seat Teacher", "teacher");
    const s = await makeUser("pi-seat-student", "Seat Student");
    const liveOne = await mint(t, { intendedLabel: "Live" });
    const [expired] = await db.orm
      .insert(invites)
      .values({ code: "SEATEX", teacherId: t.id, intendedLabel: "Lapsed", expiresAt: daysFromNow(-1) })
      .returning();
    const used = await mint(t, { intendedLabel: "Joined" });
    await redeem(s, { code: used.body.code, consent: true });

    const res = await seats(t);
    expect(res.status).toBe(200);
    const byCode = new Map(res.body.map((r: { code: string; state: string }) => [r.code, r.state]));
    expect(byCode.get(liveOne.body.code)).toBe("active");
    expect(byCode.get("SEATEX")).toBe("expired");
    expect(byCode.has(used.body.code)).toBe(false);
    expect(expired!.id).toBeTruthy();
  });

  it("a live code cannot be dismissed — hiding a code that still works is the one surprise", async () => {
    const t = await makeUser("pi-seat-live", "Live Seat Teacher", "teacher");
    const made = await mint(t, { intendedLabel: "Emma" });
    const res = await dismiss(t, made.body.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("code_still_live");
    expect(typeof res.body.message).toBe("string");
  });

  it("dismissing an expired code hides the seat and leaves history reading expired", async () => {
    const t = await makeUser("pi-seat-dismiss", "Dismiss Teacher", "teacher");
    const [row] = await db.orm
      .insert(invites)
      .values({ code: "SEATDI", teacherId: t.id, intendedLabel: "Nobody", expiresAt: daysFromNow(-1) })
      .returning();
    const res = await dismiss(t, row!.id);
    expect(res.status).toBe(200);

    const after = await seats(t);
    expect(after.body.some((r: { code: string }) => r.code === "SEATDI")).toBe(false);

    const history = await request(makeApp())
      .get("/v1/invites?include=history")
      .set("Authorization", auth(t));
    const seen = history.body.find((r: { code: string }) => r.code === "SEATDI");
    expect(seen.state).toBe("expired");
    const [stored] = await db.orm.select().from(invites).where(eq(invites.code, "SEATDI"));
    expect(stored!.revokedAt).toBeNull();
    expect(stored!.intendedLabel).toBeNull();
  });

  it("dismiss is idempotent and refuses a code that is not yours", async () => {
    const t = await makeUser("pi-seat-mine", "Mine Teacher", "teacher");
    const other = await makeUser("pi-seat-other", "Other Teacher", "teacher");
    const [row] = await db.orm
      .insert(invites)
      .values({ code: "SEATMI", teacherId: t.id, expiresAt: daysFromNow(-1) })
      .returning();
    expect((await dismiss(t, row!.id)).status).toBe(200);
    expect((await dismiss(t, row!.id)).status).toBe(200);
    const stranger = await dismiss(other, row!.id);
    expect(stranger.status).toBe(404);
    expect(typeof stranger.body.message).toBe("string");
  });
});

describe("a refused redeem does not spend the code", () => {
  it("a throw rolls the use-count claim back; a plain return commits it", async () => {
    const t = await makeUser("pi-burn-teacher", "Burn Teacher", "teacher");
    const [thrown] = await db.orm
      .insert(invites)
      .values({ code: "BURNAA", teacherId: t.id, expiresAt: daysFromNow(7) })
      .returning();
    const [returned] = await db.orm
      .insert(invites)
      .values({ code: "BURNBB", teacherId: t.id, expiresAt: daysFromNow(7) })
      .returning();

    await expect(
      db.orm.transaction(async (tx) => {
        await tx
          .update(invites)
          .set({ usedCount: sql`${invites.usedCount} + 1` })
          .where(eq(invites.id, thrown!.id));
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");

    await db.orm.transaction(async (tx) => {
      await tx
        .update(invites)
        .set({ usedCount: sql`${invites.usedCount} + 1` })
        .where(eq(invites.id, returned!.id));
      return { refused: true };
    });

    const [a] = await db.orm.select().from(invites).where(eq(invites.id, thrown!.id));
    const [b] = await db.orm.select().from(invites).where(eq(invites.id, returned!.id));
    expect(a!.usedCount).toBe(0);
    expect(b!.usedCount).toBe(1);
  });

  it("every in-transaction refusal leaves the transaction by throwing", async () => {
    const src = readFileSync(join(__dirname, "..", "src", "routes", "links.ts"), "utf8");
    const start = src.indexOf("outcomeLink = await db.transaction");
    const body = src.slice(start, src.indexOf("} catch (err) {", start));
    expect(start).toBeGreaterThan(0);
    expect(body.match(/throw new RedeemRefusal/g)?.length).toBe(4);
    expect(body).not.toMatch(/return \{ kind:/);
  });
});

describe("a revoked code is never a seat", () => {
  it("revoking removes the seat outright — a screen must not offer a code that cannot be redeemed", async () => {
    const t = await makeUser("pi-seat-revoked", "Revoked Seat Teacher", "teacher");
    const made = await mint(t, { intendedLabel: "Emma" });
    const before = await seats(t);
    expect(before.body.some((r: { code: string }) => r.code === made.body.code)).toBe(true);

    await request(makeApp()).delete(`/v1/invites/${made.body.id}`).set("Authorization", auth(t));

    const after = await seats(t);
    expect(after.body.some((r: { code: string }) => r.code === made.body.code)).toBe(false);
  });

  it("a labelled seat stays out of the legacy live-codes list a shipped client reads", async () => {
    const t = await makeUser("pi-legacy-list", "Legacy Teacher", "teacher");
    const plain = await mint(t);
    const named = await mint(t, { intendedLabel: "Emma" });
    const legacy = await liveCodes(t);
    const codes = legacy.body.map((r: { code: string }) => r.code);
    expect(codes).toEqual([plain.body.code]);
    expect(codes).not.toContain(named.body.code);
    expect(Object.keys(legacy.body[0])).not.toContain("intendedLabel");
    expect(Object.keys(legacy.body[0])).not.toContain("dismissedAt");
  });
});
