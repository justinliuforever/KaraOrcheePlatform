import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { and, eq, sql as sqlRaw } from "drizzle-orm";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWK } from "jose";
import { createServer } from "../src/server";
import { createJoseVerifier, type AuthVerifier } from "../src/auth";
import { createTestDb } from "./testdb";
import {
  users,
  pieces,
  teacherStudentLinks,
  lessonSessions,
  noteJobs,
  notes,
  noteAnnotations,
  customPieces,
  notedPieces,
  scoreScans,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { LessonStore } from "../src/notes/lessons_store";
import type { NotesQueue } from "../src/queue";
import { planBackfill, renderPlan, writeBackfill } from "../src/tools/backfillCustomPieces";
import { computeSuggestion, type CandidatePiece } from "../src/notes/piece_suggestion";

const ISSUER = "https://tenant-id.ciamlogin.com/tenant-id/v2.0";
const AUDIENCE = "api://karaorchee";
const KID = "test-key";

let verifier: AuthVerifier;
let db: Db;
let privateKey: CryptoKey;

const fakeLessons: LessonStore = {
  blobPath: (t, l) => `${t}/${l}.m4a`,
  uploadUrl: (p) => `https://fake/${p}?sas`,
  async audioProps() {
    return { bytes: 1000 };
  },
  async deleteAudio() {},
};

const fakeQueue: NotesQueue = {
  async send() {},
  async sendNarration() {},
};

function makeApp() {
  return createServer({ db, auth: verifier, lessons: fakeLessons, notesQueue: fakeQueue });
}

async function mkToken(oid: string): Promise<string> {
  return new SignJWT({ oid })
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
async function makeUser(oid: string, role: "teacher" | "student"): Promise<TestUser> {
  const token = await mkToken(oid);
  const res = await request(makeApp())
    .post("/v1/users/sync")
    .set("Authorization", `Bearer ${token}`)
    .send({ role });
  if (res.status !== 200) throw new Error(`sync failed: ${res.status}`);
  return { token, id: res.body.id as string };
}

let teacher: TestUser;
let otherTeacher: TestUser;
let student: TestUser;

function post(path: string, token: string) {
  return request(makeApp()).post(path).set("Authorization", `Bearer ${token}`);
}
function patch(path: string, token: string) {
  return request(makeApp()).patch(path).set("Authorization", `Bearer ${token}`);
}
function get(path: string, token: string) {
  return request(makeApp()).get(path).set("Authorization", `Bearer ${token}`);
}

async function createLesson(token: string, body: Record<string, unknown>) {
  const res = await post("/v1/lessons", token).send(body);
  return res;
}

async function lessonRow(id: string) {
  const [row] = await db.orm.select().from(lessonSessions).where(eq(lessonSessions.id, id)).limit(1);
  return row!;
}

async function customRows(teacherId: string) {
  return db.orm.select().from(customPieces).where(eq(customPieces.teacherId, teacherId));
}

async function seedDraft(opts: {
  teacherId: string;
  studentId?: string | null;
  lessonId?: string;
  pieceId?: string | null;
  pieceLabel?: string | null;
  customPieceId?: string | null;
  pieceMentions?: unknown[];
  status?: "draft" | "sent";
  annotations?: { instruction: string; quote: string | null; location?: unknown }[];
}) {
  let lessonId = opts.lessonId;
  if (!lessonId) {
    const [lesson] = await db.orm
      .insert(lessonSessions)
      .values({ teacherId: opts.teacherId, pieceId: opts.pieceId ?? null, pieceLabel: opts.pieceLabel ?? null })
      .returning();
    lessonId = lesson!.id;
  }
  const [job] = await db.orm
    .insert(noteJobs)
    .values({
      lessonSessionId: lessonId,
      status: "ready_for_review",
      createdBy: opts.teacherId,
      pieceMentions: (opts.pieceMentions ?? []) as unknown[],
    })
    .returning();
  const content = { lessonSummary: "Good work.", practicePlan: [] };
  const [note] = await db.orm
    .insert(notes)
    .values({
      noteJobId: job!.id,
      lessonSessionId: lessonId,
      teacherId: opts.teacherId,
      studentId: opts.studentId ?? null,
      pieceId: opts.pieceId ?? null,
      pieceLabel: opts.pieceLabel ?? null,
      customPieceId: opts.customPieceId ?? null,
      status: opts.status ?? "draft",
      contentOriginal: content,
      content,
    })
    .returning();
  const anns = opts.annotations ?? [];
  if (anns.length) {
    await db.orm.insert(noteAnnotations).values(
      anns.map((a, i) => ({
        noteId: note!.id,
        idx: i,
        category: "other",
        instruction: a.instruction,
        quote: a.quote,
        location: (a.location ?? {}) as Record<string, unknown>,
      })),
    );
  }
  return { note: note!, job: job!, lessonId: lessonId! };
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

  await db.orm.insert(pieces).values([
    {
      id: "clementi_op36_no1_i",
      title: "Sonatina Op. 36 No. 1 in C major",
      subtitle: "I. Allegro",
      composer: "Muzio Clementi",
      status: "published",
      publishedVersion: 2,
      facts: { measures: 38 },
    },
    {
      id: "burgmuller_op100_arabesque",
      title: "Arabesque",
      subtitle: "",
      composer: "Johann Friedrich Burgmüller",
      status: "published",
      publishedVersion: 1,
      facts: { measures: 32 },
    },
  ]);

  teacher = await makeUser("piece-teacher-oid", "teacher");
  otherTeacher = await makeUser("piece-other-teacher-oid", "teacher");
  student = await makeUser("piece-student-oid", "student");
  await db.orm
    .insert(teacherStudentLinks)
    .values({ teacherId: teacher.id, studentId: student.id, status: "active", consentAt: new Date() });
});

beforeEach(async () => {
  await db.orm.delete(noteAnnotations);
  await db.orm.delete(notes);
  await db.orm.delete(noteJobs);
  await db.orm.delete(lessonSessions);
  await db.orm.delete(customPieces);
});

describe("W4 piece_source", () => {
  it("persists the three known sources at create", async () => {
    for (const source of ["catalog", "vendored", "typed"] as const) {
      const res = await createLesson(teacher.token, {
        pieceLabel: `Label ${source}`,
        pieceSource: source,
        attested: true,
      });
      expect(res.status).toBe(201);
      expect((await lessonRow(res.body.lesson.id)).pieceSource).toBe(source);
    }
  });

  it("stores null for an unknown source word, and for a build that sends none", async () => {
    const junk = await createLesson(teacher.token, {
      pieceLabel: "Spinning Song",
      pieceSource: "scanned",
      attested: true,
    });
    expect(junk.status).toBe(201);
    expect((await lessonRow(junk.body.lesson.id)).pieceSource).toBeNull();

    const absent = await createLesson(teacher.token, { pieceLabel: "Spinning Song", attested: true });
    expect((await lessonRow(absent.body.lesson.id)).pieceSource).toBeNull();

    const wrongType = await createLesson(teacher.token, {
      pieceLabel: "Spinning Song",
      pieceSource: 7,
      attested: true,
    });
    expect((await lessonRow(wrongType.body.lesson.id)).pieceSource).toBeNull();
  });

  it("PATCH carries the source alongside a piece change, never stamps pieceUpdatedAt on its own, and 400s a source-only patch as nothing_to_update", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Spinning Song",
      pieceSource: "typed",
      attested: true,
    });
    const id = created.body.lesson.id as string;

    const named = await patch(`/v1/lessons/${id}`, teacher.token).send({
      pieceId: "clementi_op36_no1_i",
      pieceLabel: "Sonatina Op. 36 No. 1",
      pieceSource: "catalog",
    });
    expect(named.status).toBe(200);
    const afterNamed = await lessonRow(id);
    expect(afterNamed.pieceSource).toBe("catalog");
    expect(afterNamed.pieceUpdatedAt).not.toBeNull();

    const lone = await patch(`/v1/lessons/${id}`, teacher.token).send({ pieceSource: "typed" });
    expect(lone.status).toBe(400);
    expect(lone.body.error).toBe("nothing_to_update");
    expect((await lessonRow(id)).pieceSource).toBe("catalog");
  });

  it("clears provenance rather than keeping the old word when PATCH sends a junk source", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Spinning Song",
      pieceSource: "typed",
      attested: true,
    });
    const id = created.body.lesson.id as string;
    await patch(`/v1/lessons/${id}`, teacher.token).send({
      pieceLabel: "Spinning Song (revised)",
      pieceSource: "guessed",
    });
    expect((await lessonRow(id)).pieceSource).toBeNull();
  });
});

describe("W5 custom pieces", () => {
  it("mints and stamps on a typed create, reuses the entity for a case/whitespace variant", async () => {
    const first = await createLesson(teacher.token, {
      pieceLabel: "Spinning Song",
      pieceSource: "typed",
      attested: true,
    });
    const rows = await customRows(teacher.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayLabel).toBe("Spinning Song");
    expect(rows[0]!.normalizedLabel).toBe("spinning song");
    expect((await lessonRow(first.body.lesson.id)).customPieceId).toBe(rows[0]!.id);

    const second = await createLesson(teacher.token, {
      pieceLabel: "  spinning   SONG  ",
      pieceSource: "typed",
      attested: true,
    });
    const after = await customRows(teacher.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(rows[0]!.id);
    expect(after[0]!.displayLabel).toBe("spinning   SONG");
    expect((await lessonRow(second.body.lesson.id)).customPieceId).toBe(rows[0]!.id);
  });

  it("keeps diacritics out of identity so Für and Fur stay two entities", async () => {
    await createLesson(teacher.token, { pieceLabel: "Für Elise", pieceSource: "typed", attested: true });
    await createLesson(teacher.token, { pieceLabel: "Fur Elise", pieceSource: "typed", attested: true });
    expect(await customRows(teacher.id)).toHaveLength(2);
  });

  it("mints nothing for a vendored pick or an absent source", async () => {
    await createLesson(teacher.token, { pieceLabel: "Bundled Study", pieceSource: "vendored", attested: true });
    await createLesson(teacher.token, { pieceLabel: "Bundled Study", attested: true });
    expect(await customRows(teacher.id)).toHaveLength(0);
  });

  it("scopes entities per teacher: the same label mints one row each", async () => {
    await createLesson(teacher.token, { pieceLabel: "Spinning Song", pieceSource: "typed", attested: true });
    await createLesson(otherTeacher.token, { pieceLabel: "Spinning Song", pieceSource: "typed", attested: true });
    expect(await customRows(teacher.id)).toHaveLength(1);
    expect(await customRows(otherTeacher.id)).toHaveLength(1);
  });

  it("clears custom_piece_id when the lesson becomes a catalog piece but leaves the shared custom-piece entity for other lessons", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Spinning Song",
      pieceSource: "typed",
      attested: true,
    });
    const id = created.body.lesson.id as string;
    expect((await lessonRow(id)).customPieceId).not.toBeNull();

    await patch(`/v1/lessons/${id}`, teacher.token).send({
      pieceId: "clementi_op36_no1_i",
      pieceLabel: "Sonatina Op. 36 No. 1",
      pieceSource: "catalog",
    });
    expect((await lessonRow(id)).customPieceId).toBeNull();
    expect(await customRows(teacher.id)).toHaveLength(1);
  });

  it("mints at send for a label retyped at review, and follows the lesson when the label is equal", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Spinning Song",
      pieceSource: "typed",
      attested: true,
    });
    const lessonId = created.body.lesson.id as string;
    const lessonEntityId = (await lessonRow(lessonId)).customPieceId;

    const retyped = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId,
      pieceLabel: "Spinning Song (Ellmenreich)",
    });
    const sentRetyped = await post(`/v1/notes/${retyped.note.id}/send`, teacher.token).send({});
    expect(sentRetyped.status).toBe(200);
    const [mintedAtSend] = (await customRows(teacher.id)).filter(
      (r) => r.normalizedLabel === "spinning song (ellmenreich)",
    );
    expect(mintedAtSend).toBeDefined();
    expect(sentRetyped.body.customPieceId).toBe(mintedAtSend!.id);

    const before = (await customRows(teacher.id)).length;
    const inherited = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId,
      pieceLabel: "Spinning Song",
    });
    const sentInherited = await post(`/v1/notes/${inherited.note.id}/send`, teacher.token).send({});
    expect(sentInherited.body.customPieceId).toBe(lessonEntityId);
    expect(await customRows(teacher.id)).toHaveLength(before);
  });

  it("mints nothing at send when the lesson's own provenance is unknown", async () => {
    const created = await createLesson(teacher.token, { pieceLabel: "Bundled Study", attested: true });
    const lessonId = created.body.lesson.id as string;
    const draft = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId,
      pieceLabel: "Bundled Study",
    });
    const sent = await post(`/v1/notes/${draft.note.id}/send`, teacher.token).send({});
    expect(sent.status).toBe(200);
    expect(sent.body.customPieceId).toBeNull();
    expect(await customRows(teacher.id)).toHaveLength(0);
  });

  it("leaves a sent note's piece_label untouched when the entity is linked later", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Sonatina",
      pieceSource: "typed",
      attested: true,
    });
    const lessonId = created.body.lesson.id as string;
    const draft = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId,
      pieceLabel: "Sonatina",
    });
    await post(`/v1/notes/${draft.note.id}/send`, teacher.token).send({});
    const entityId = (await customRows(teacher.id))[0]!.id;

    const linked = await post(`/v1/custom-pieces/${entityId}/link`, teacher.token)
      .send({ pieceId: "clementi_op36_no1_i" });
    expect(linked.status).toBe(200);

    const [after] = await db.orm.select().from(notes).where(eq(notes.id, draft.note.id));
    expect(after!.pieceLabel).toBe("Sonatina");
    expect(after!.pieceId).toBeNull();
    expect(after!.status).toBe("sent");
  });

  it("purges the teacher's entities on account deletion while the delivered note keeps its label", async () => {
    const doomed = await makeUser("piece-doomed-oid", "teacher");
    await db.orm
      .insert(teacherStudentLinks)
      .values({ teacherId: doomed.id, studentId: student.id, status: "active", consentAt: new Date() });
    const created = await createLesson(doomed.token, {
      pieceLabel: "Spinning Song",
      pieceSource: "typed",
      attested: true,
    });
    const lessonId = created.body.lesson.id as string;
    const draft = await seedDraft({
      teacherId: doomed.id,
      studentId: student.id,
      lessonId,
      pieceLabel: "Spinning Song",
    });
    await post(`/v1/notes/${draft.note.id}/send`, doomed.token).send({});
    expect((await customRows(doomed.id)).length).toBe(1);

    const deleted = await request(makeApp())
      .delete("/v1/me")
      .set("Authorization", `Bearer ${doomed.token}`);
    expect(deleted.status).toBe(200);

    expect(await customRows(doomed.id)).toHaveLength(0);
    const [survivor] = await db.orm.select().from(notes).where(eq(notes.id, draft.note.id));
    expect(survivor!.pieceLabel).toBe("Spinning Song");
    expect(survivor!.customPieceId).toBeNull();
    expect(survivor!.status).toBe("sent");
  });

  it("link is owner-only, validates the piece, and null clears", async () => {
    await createLesson(teacher.token, { pieceLabel: "Spinning Song", pieceSource: "typed", attested: true });
    const entityId = (await customRows(teacher.id))[0]!.id;

    const stranger = await post(`/v1/custom-pieces/${entityId}/link`, otherTeacher.token)
      .send({ pieceId: "clementi_op36_no1_i" });
    expect(stranger.status).toBe(404);

    const unknown = await post(`/v1/custom-pieces/${entityId}/link`, teacher.token)
      .send({ pieceId: "no_such_piece" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("unknown_piece");

    const set = await post(`/v1/custom-pieces/${entityId}/link`, teacher.token)
      .send({ pieceId: "clementi_op36_no1_i" });
    expect(set.status).toBe(200);
    expect(set.body.customPiece.linkedPieceId).toBe("clementi_op36_no1_i");
    expect(set.body.customPiece.linkedAt).not.toBeNull();

    const cleared = await post(`/v1/custom-pieces/${entityId}/link`, teacher.token).send({ pieceId: null });
    expect(cleared.body.customPiece.linkedPieceId).toBeNull();
    expect(cleared.body.customPiece.linkedAt).toBeNull();
  });
});

describe("W5 backfill", () => {
  it("prints the label list, excludes vendored-looking labels with unknown provenance, and re-runs as a no-op", async () => {
    const typed = await createLesson(teacher.token, {
      pieceLabel: "Spinning Song",
      pieceSource: "typed",
      attested: true,
    });
    const [preRelease] = await db.orm
      .insert(lessonSessions)
      .values([
        { teacherId: teacher.id, pieceLabel: "Grandmother's Waltz" },
        { teacherId: teacher.id, pieceLabel: "I. Allegro maestoso" },   // a vendored title
        { teacherId: teacher.id, pieceLabel: "Sonatina Op. 36 No. 1 in C major" }, // a catalog title
      ])
      .returning();
    await db.orm.delete(customPieces);
    await db.orm.update(lessonSessions).set({ customPieceId: null });

    const plan = await planBackfill(db.orm);
    const printed = renderPlan(plan);
    expect(printed).toContain("Spinning Song");
    expect(printed).toContain("Grandmother's Waltz");
    expect(printed).toContain("SKIP(vendored_title)");
    expect(printed).toContain("SKIP(catalog_title)");
    expect(plan.included.map((g) => g.displayLabel).sort())
      .toEqual(["Grandmother's Waltz", "Spinning Song"]);

    const first = await writeBackfill(db.orm, plan);
    expect(first.entitiesWritten).toBe(2);
    expect(first.lessonsStamped).toBe(2);
    expect(await customRows(teacher.id)).toHaveLength(2);
    const [typedRow] = await db.orm
      .select()
      .from(lessonSessions)
      .where(eq(lessonSessions.id, typed.body.lesson.id));
    expect(typedRow!.customPieceId).not.toBeNull();
    const [preRow] = await db.orm
      .select()
      .from(lessonSessions)
      .where(eq(lessonSessions.id, preRelease!.id));
    expect(preRow!.customPieceId).not.toBeNull();

    const again = await writeBackfill(db.orm, await planBackfill(db.orm));
    expect(again.lessonsStamped).toBe(0);
    expect(await customRows(teacher.id)).toHaveLength(2);
  });
});

describe("W6 suggestion compute", () => {
  const clementi = {
    id: "clementi_op36_no1_i",
    title: "Sonatina Op. 36 No. 1 in C major",
    subtitle: "I. Allegro",
    composer: "Muzio Clementi",
  };
  const arabesque = {
    id: "burgmuller_op100_arabesque",
    title: "Arabesque",
    subtitle: "",
    composer: "Johann Friedrich Burgmüller",
  };

  it("yields the single candidate a mention names", () => {
    const s = computeSuggestion({
      mentions: ["the Sonatina in C major"],
      candidates: [clementi, arabesque],
      dismissedPieceIds: [],
    });
    expect(s).toMatchObject({ source: "transcript", pieceId: clementi.id, quote: "the Sonatina in C major" });
  });

  it("stays silent when two candidates survive", () => {
    const twin = { ...clementi, id: "clementi_reprint" };
    expect(computeSuggestion({
      mentions: ["the Sonatina in C major"],
      candidates: [clementi, twin],
      dismissedPieceIds: [],
    })).toBeNull();
  });

  it("is always silent on a composer-only mention, even with one piece by that composer", () => {
    for (const said of ["Burgmuller", "the Burgmüller", "Clementi",
                        "Johann Friedrich Burgmüller", "Muzio Clementi"]) {
      expect(computeSuggestion({ mentions: [said], candidates: [clementi, arabesque], dismissedPieceIds: [] }))
        .toBeNull();
    }
  });

  it("excludes a dismissed candidate", () => {
    expect(computeSuggestion({
      mentions: ["the Sonatina in C major"],
      candidates: [clementi, arabesque],
      dismissedPieceIds: [clementi.id],
    })).toBeNull();
  });

  it("matches a typed label to a catalog name only on exact equality, folding diacritics", () => {
    const fur = { id: "beethoven_woo59", title: "Für Elise", subtitle: "", composer: "Ludwig van Beethoven" };
    expect(computeSuggestion({ customLabel: "fur elise", mentions: [], candidates: [fur], dismissedPieceIds: [] }))
      .toMatchObject({ source: "library", pieceId: fur.id });
    expect(computeSuggestion({ customLabel: "Elise", mentions: [], candidates: [fur], dismissedPieceIds: [] }))
      .toBeNull();
  });

  it("stays silent when the teacher's own unlinked vocabulary could equally be meant", () => {
    const own: CandidatePiece = { id: "custom:x", title: "Arabesque", subtitle: "", composer: "" };
    expect(computeSuggestion({
      mentions: ["the Arabesque"],
      candidates: [arabesque, own],
      dismissedPieceIds: [],
    })).toBeNull();
  });
});

describe("W6 suggestion endpoints", () => {
  async function draftWithMention(opts: {
    mention?: string;
    pieceLabel?: string | null;
    pieceSource?: string | null;
    annotations?: { instruction: string; quote: string | null; location?: unknown }[];
  } = {}) {
    const created = await createLesson(teacher.token, {
      pieceLabel: opts.pieceLabel ?? "Spinning Song",
      ...(opts.pieceSource ? { pieceSource: opts.pieceSource } : {}),
      attested: true,
    });
    const lessonId = created.body.lesson.id as string;
    return seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId,
      pieceLabel: opts.pieceLabel ?? "Spinning Song",
      pieceMentions: opts.mention ? [opts.mention] : [],
      annotations: opts.annotations,
    });
  }

  it("surfaces on an editable draft and never on a vendored pick or a named piece", async () => {
    const typed = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    const shown = await get(`/v1/notes/${typed.note.id}`, teacher.token);
    expect(shown.body.pieceSuggestion).toMatchObject({
      source: "transcript",
      pieceId: "clementi_op36_no1_i",
      quote: "the Sonatina in C major",
    });

    const vendored = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "vendored" });
    expect((await get(`/v1/notes/${vendored.note.id}`, teacher.token)).body.pieceSuggestion).toBeNull();

    const named = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      pieceId: "burgmuller_op100_arabesque",
      pieceMentions: ["the Sonatina in C major"],
    });
    expect((await get(`/v1/notes/${named.note.id}`, teacher.token)).body.pieceSuggestion).toBeNull();

    const sent = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      pieceLabel: "Spinning Song",
      status: "sent",
      pieceMentions: ["the Sonatina in C major"],
    });
    expect((await get(`/v1/notes/${sent.note.id}`, teacher.token)).body.pieceSuggestion).toBeNull();
  });

  it("confirm applies the piece, regrounds an out-of-range auto pin, and returns the prior triple", async () => {
    const draft = await draftWithMention({
      mention: "the Sonatina in C major",
      pieceSource: "typed",
      annotations: [
        {
          instruction: "Even out the left hand",
          quote: "left hand",
          location: { type: "absolute", measureStart: 84, measureEnd: 84, grounded: true, pinnedBy: "auto" },
        },
        {
          instruction: "Watch the rest",
          quote: "the rest",
          location: { type: "absolute", measureStart: 4, measureEnd: 4, grounded: true, pinnedBy: "teacher" },
        },
      ],
    });
    const res = await post(`/v1/notes/${draft.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "confirm", pieceId: "clementi_op36_no1_i" });
    expect(res.status).toBe(200);
    expect(res.body.note.pieceId).toBe("clementi_op36_no1_i");
    expect(res.body.prior).toEqual({ pieceId: null, pieceLabel: "Spinning Song", pieceSource: "typed" });
    expect(res.body.pieceSuggestion).toBeNull();

    const [auto, human] = res.body.annotations as { location: Record<string, unknown> }[];
    expect(auto!.location.grounded).toBe(false);
    expect(human!.location.grounded).toBe(true);
    expect((await lessonRow(draft.lessonId)).pieceId).toBe("clementi_op36_no1_i");
  });

  it("returns the lesson's real provenance in the prior triple, never a hardcoded word", async () => {
    const draft = await draftWithMention({ mention: "the Sonatina in C major" });
    const res = await post(`/v1/notes/${draft.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "confirm", pieceId: "clementi_op36_no1_i" });
    expect(res.body.prior.pieceSource).toBeNull();

    const undo = await patch(`/v1/lessons/${draft.lessonId}`, teacher.token)
      .send({ pieceId: null, pieceLabel: "Spinning Song", pieceSource: "vendored" });
    expect(undo.status).toBe(200);
    const after = await lessonRow(draft.lessonId);
    expect(after.pieceId).toBeNull();
    expect(after.pieceSource).toBe("vendored");
    expect(after.customPieceId).toBeNull();
    expect(await customRows(teacher.id)).toHaveLength(0);
  });

  it("records a link only for the library arm", async () => {
    const transcript = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    await post(`/v1/notes/${transcript.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "confirm", pieceId: "clementi_op36_no1_i" });
    expect((await customRows(teacher.id)).every((r) => r.linkedPieceId === null)).toBe(true);

    const library = await draftWithMention({ pieceLabel: "Arabesque", pieceSource: "typed" });
    const shown = await get(`/v1/notes/${library.note.id}`, teacher.token);
    expect(shown.body.pieceSuggestion).toMatchObject({ source: "library", pieceId: "burgmuller_op100_arabesque" });
    await post(`/v1/notes/${library.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "confirm", pieceId: "burgmuller_op100_arabesque" });
    const [linked] = (await customRows(teacher.id)).filter((r) => r.normalizedLabel === "arabesque");
    expect(linked!.linkedPieceId).toBe("burgmuller_op100_arabesque");
    expect(linked!.linkedAt).not.toBeNull();
  });

  it("409s on a stale candidate and writes nothing", async () => {
    const draft = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    const res = await post(`/v1/notes/${draft.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "confirm", pieceId: "burgmuller_op100_arabesque" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("suggestion_changed");
    expect(res.body.pieceSuggestion).toMatchObject({ pieceId: "clementi_op36_no1_i" });
    expect((await lessonRow(draft.lessonId)).pieceId).toBeNull();
  });

  it("dismiss persists to both stores and never returns for that candidate", async () => {
    const draft = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    const res = await post(`/v1/notes/${draft.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "dismiss", pieceId: "clementi_op36_no1_i" });
    expect(res.status).toBe(200);
    expect(res.body.pieceSuggestion).toBeNull();

    const [note] = await db.orm.select().from(notes).where(eq(notes.id, draft.note.id));
    expect(note!.pieceSuggestionDismissed).toEqual(["clementi_op36_no1_i"]);
    const [entity] = await customRows(teacher.id);
    expect(entity!.dismissedPieceIds).toEqual(["clementi_op36_no1_i"]);

    await db.orm
      .update(pieces)
      .set({ publishedVersion: 3 })
      .where(eq(pieces.id, "clementi_op36_no1_i"));
    expect((await get(`/v1/notes/${draft.note.id}`, teacher.token)).body.pieceSuggestion).toBeNull();
  });

  it("clears piece_mentions at confirm, dismiss, send, and discard", async () => {
    async function mentionsOf(jobId: string) {
      const [row] = await db.orm.select().from(noteJobs).where(eq(noteJobs.id, jobId));
      return row!.pieceMentions;
    }

    const confirmed = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    expect(await mentionsOf(confirmed.job.id)).toEqual(["the Sonatina in C major"]);
    await post(`/v1/notes/${confirmed.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "confirm", pieceId: "clementi_op36_no1_i" });
    expect(await mentionsOf(confirmed.job.id)).toEqual([]);

    const dismissed = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    await post(`/v1/notes/${dismissed.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "dismiss", pieceId: "clementi_op36_no1_i" });
    expect(await mentionsOf(dismissed.job.id)).toEqual([]);

    const sent = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    await post(`/v1/notes/${sent.note.id}/send`, teacher.token).send({});
    expect(await mentionsOf(sent.job.id)).toEqual([]);

    const discarded = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    await db.orm
      .update(lessonSessions)
      .set({ status: "submitted" })
      .where(eq(lessonSessions.id, discarded.lessonId));
    await db.orm
      .update(noteJobs)
      .set({ status: "failed" })
      .where(eq(noteJobs.id, discarded.job.id));
    const gone = await request(makeApp())
      .delete(`/v1/lessons/${discarded.lessonId}`)
      .set("Authorization", `Bearer ${teacher.token}`);
    expect(gone.status).toBe(200);
    expect(await mentionsOf(discarded.job.id)).toEqual([]);
  });

  it("never forces a match: the only path to notes.piece_id is the confirm endpoint", async () => {
    const draft = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    let [row] = await db.orm.select().from(notes).where(eq(notes.id, draft.note.id));
    expect(row!.pieceId).toBeNull();

    const shown = await get(`/v1/notes/${draft.note.id}`, teacher.token);
    expect(shown.body.pieceSuggestion).not.toBeNull();
    [row] = await db.orm.select().from(notes).where(eq(notes.id, draft.note.id));
    expect(row!.pieceId).toBeNull();

    const sent = await post(`/v1/notes/${draft.note.id}/send`, teacher.token).send({});
    expect(sent.status).toBe(200);
    [row] = await db.orm.select().from(notes).where(eq(notes.id, draft.note.id));
    expect(row!.pieceId).toBeNull();
    expect(row!.pieceLabel).toBe("Spinning Song");
  });

  it("keeps every suggestion key off the student's payloads", async () => {
    const draft = await draftWithMention({ mention: "the Sonatina in C major", pieceSource: "typed" });
    await post(`/v1/notes/${draft.note.id}/send`, teacher.token).send({});

    const list = await get("/v1/me/notes", student.token);
    expect(JSON.stringify(list.body)).not.toContain("pieceSuggestion");
    const detail = await get(`/v1/me/notes/${draft.note.id}`, student.token);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain("pieceSuggestion");
    expect(JSON.stringify(detail.body)).not.toContain("pieceMentions");
  });
});

describe("the library claim tracks the name on the screen", () => {
  it("dies when a source-less rename leaves the entity behind", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Arabesque",
      pieceSource: "typed",
      attested: true,
    });
    const lessonId = created.body.lesson.id as string;
    const minted = await lessonRow(lessonId);
    expect(minted.customPieceId).not.toBeNull();

    const renamed = await patch(`/v1/lessons/${lessonId}`, teacher.token)
      .send({ pieceId: null, pieceLabel: "Rondo alla Turca" });
    expect(renamed.status).toBe(200);
    const after = await lessonRow(lessonId);
    expect(after.pieceLabel).toBe("Rondo alla Turca");
    expect(after.customPieceId).toBeNull();

    const draft = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId,
      pieceLabel: "Rondo alla Turca",
    });
    expect((await get(`/v1/notes/${draft.note.id}`, teacher.token)).body.pieceSuggestion).toBeNull();
  });

  it("dies when the note alone is retyped, with the lesson's entity untouched", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Arabesque",
      pieceSource: "typed",
      attested: true,
    });
    const lessonId = created.body.lesson.id as string;
    const draft = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId,
      pieceLabel: "Arabesque",
    });
    expect((await get(`/v1/notes/${draft.note.id}`, teacher.token)).body.pieceSuggestion)
      .toMatchObject({ source: "library", pieceId: "burgmuller_op100_arabesque" });

    const retyped = await patch(`/v1/notes/${draft.note.id}`, teacher.token)
      .send({ pieceLabel: "Mia's warm-up" });
    expect(retyped.status).toBe(200);
    expect((await lessonRow(lessonId)).customPieceId).not.toBeNull();
    expect((await get(`/v1/notes/${draft.note.id}`, teacher.token)).body.pieceSuggestion).toBeNull();
  });

  it("survives a rename that only changes casing or spacing", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Arabesque",
      pieceSource: "typed",
      attested: true,
    });
    const draft = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId: created.body.lesson.id as string,
      pieceLabel: "  ARABESQUE  ",
    });
    expect((await get(`/v1/notes/${draft.note.id}`, teacher.token)).body.pieceSuggestion)
      .toMatchObject({ source: "library", pieceId: "burgmuller_op100_arabesque" });
  });

  it("never files a sent note under an entity minted for a different name", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Arabesque",
      pieceSource: "typed",
      attested: true,
    });
    const lessonId = created.body.lesson.id as string;
    await patch(`/v1/lessons/${lessonId}`, teacher.token)
      .send({ pieceId: null, pieceLabel: "Rondo alla Turca" });
    const draft = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId,
      pieceLabel: "Rondo alla Turca",
    });
    const sent = await post(`/v1/notes/${draft.note.id}/send`, teacher.token).send({});
    expect(sent.status).toBe(200);
    const [row] = await db.orm.select().from(notes).where(eq(notes.id, draft.note.id));
    expect(row!.pieceLabel).toBe("Rondo alla Turca");
    expect(row!.customPieceId).toBeNull();
  });
});

describe("Undo restores the row it patches", () => {
  it("takes every field of the prior triple from the lesson, not the note", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Arabesque",
      pieceSource: "typed",
      attested: true,
    });
    const lessonId = created.body.lesson.id as string;
    const draft = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId,
      pieceLabel: "Burgmuller thing for Mia",
      pieceMentions: ["the Sonatina in C major"],
    });
    const res = await post(`/v1/notes/${draft.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "confirm", pieceId: "clementi_op36_no1_i" });
    expect(res.status).toBe(200);
    expect(res.body.prior).toEqual({
      pieceId: null,
      pieceLabel: "Arabesque",
      pieceSource: "typed",
    });

    const undo = await patch(`/v1/lessons/${lessonId}`, teacher.token).send(res.body.prior);
    expect(undo.status).toBe(200);
    const after = await lessonRow(lessonId);
    expect(after.pieceLabel).toBe("Arabesque");
    expect(after.pieceSource).toBe("typed");
    expect((await customRows(teacher.id)).map((e) => e.displayLabel)).toEqual(["Arabesque"]);
  });
});

describe("dismissal stores only ever hold real pieces", () => {
  it("refuses an id that names no piece, and stays idempotent on the specced silent retry", async () => {
    const created = await createLesson(teacher.token, {
      pieceLabel: "Spinning Song",
      pieceSource: "typed",
      attested: true,
    });
    const draft = await seedDraft({
      teacherId: teacher.id,
      studentId: student.id,
      lessonId: created.body.lesson.id as string,
      pieceLabel: "Spinning Song",
      pieceMentions: ["the Sonatina in C major"],
    });

    const junk = await post(`/v1/notes/${draft.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "dismiss", pieceId: "not_a_piece_at_all" });
    expect(junk.status).toBe(400);
    expect(junk.body.error).toBe("unknown_piece");
    const [clean] = await db.orm.select().from(notes).where(eq(notes.id, draft.note.id));
    expect(clean!.pieceSuggestionDismissed).toEqual([]);
    expect((await customRows(teacher.id))[0]!.dismissedPieceIds).toEqual([]);

    const first = await post(`/v1/notes/${draft.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "dismiss", pieceId: "clementi_op36_no1_i" });
    expect(first.status).toBe(200);
    const retry = await post(`/v1/notes/${draft.note.id}/piece-suggestion`, teacher.token)
      .send({ action: "dismiss", pieceId: "clementi_op36_no1_i" });
    expect(retry.status).toBe(200);
    const [after] = await db.orm.select().from(notes).where(eq(notes.id, draft.note.id));
    expect(after!.pieceSuggestionDismissed).toEqual(["clementi_op36_no1_i"]);
  });
});

describe("one visible label is one entity", () => {
  it("composes the two Unicode spellings of Für Elise into a single row", async () => {
    const composed = "Für Elise";
    const decomposed = "Für Elise";
    expect(composed).not.toBe(decomposed);
    for (const label of [composed, decomposed]) {
      await createLesson(teacher.token, { pieceLabel: label, pieceSource: "typed", attested: true });
    }
    expect(await customRows(teacher.id)).toHaveLength(1);

    await createLesson(teacher.token, { pieceLabel: "Fur Elise", pieceSource: "typed", attested: true });
    expect(await customRows(teacher.id)).toHaveLength(2);
  });
});

describe("the worker's ready-push endpoint is reachable on the assembled app", () => {
  it("answers 503 with no key configured instead of falling to the 404 catch-all", async () => {
    const res = await request(makeApp()).post("/internal/notes/job-1/ready-push");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("internal_key_unset");
  });

  it("answers 401 for a wrong key once one is configured", async () => {
    const previous = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = "the-real-key";
    try {
      const res = await request(makeApp())
        .post("/internal/notes/job-1/ready-push")
        .set("X-Internal-Key", "not-the-key");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_API_KEY;
      else process.env.INTERNAL_API_KEY = previous;
    }
  });
});

describe("every piece a sent note names carries its own version", () => {
  async function twoSlotDraft() {
    await db.orm.update(pieces).set({ publishedVersion: 7 }).where(eq(pieces.id, "clementi_op36_no1_i"));
    await db.orm.update(pieces).set({ publishedVersion: 4 }).where(eq(pieces.id, "burgmuller_op100_arabesque"));
    const draft = await seedDraft({
      teacherId: teacher.id, studentId: student.id, pieceId: "clementi_op36_no1_i",
    });
    await db.orm.insert(notedPieces).values({
      noteId: draft.note.id, sortIndex: 0, pieceId: "clementi_op36_no1_i",
    });
    return draft;
  }

  async function seedScan(ownerId: string) {
    const [scan] = await db.orm.insert(scoreScans)
      .values({ ownerId, title: "Photos", pageCount: 2, status: "ready", bytes: 10 }).returning();
    await db.orm.update(scoreScans).set({ blobPath: `${ownerId}/${scan!.id}/` })
      .where(eq(scoreScans.id, scan!.id));
    return scan!;
  }

  async function slotsOf(noteId: string) {
    return await db.orm.select().from(notedPieces)
      .where(eq(notedPieces.noteId, noteId)).orderBy(notedPieces.sortIndex);
  }

  it("stamps the second piece with ITS version, not the first one's", async () => {
    const draft = await twoSlotDraft();
    await db.orm.insert(notedPieces).values({
      noteId: draft.note.id, sortIndex: 1000, pieceId: "burgmuller_op100_arabesque",
    });

    const sent = await post(`/v1/notes/${draft.note.id}/send`, teacher.token).send({});
    expect(sent.status).toBe(200);

    expect((await slotsOf(draft.note.id)).map((s) => s.pieceVersion)).toEqual([7, 4]);
  });

  it("refuses to send while a piece has nothing on it, and says which one", async () => {
    const draft = await twoSlotDraft();
    await db.orm.insert(notedPieces).values({ noteId: draft.note.id, sortIndex: 1000 });

    const res = await post(`/v1/notes/${draft.note.id}/send`, teacher.token).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("piece_untitled");
    expect(res.body.message).toBe("Unable to send — Piece 2 is missing a title.");
  });

  it("lets photographs alone stand as a piece", async () => {
    const draft = await twoSlotDraft();
    const scan = await seedScan(teacher.id);
    await db.orm.insert(notedPieces)
      .values({ noteId: draft.note.id, sortIndex: 1000, scoreScanId: scan.id });

    const res = await post(`/v1/notes/${draft.note.id}/send`, teacher.token).send({});
    expect(res.status).toBe(200);
  });

  it("leaves a slot showing photographs unversioned", async () => {
    const draft = await twoSlotDraft();
    await db.orm.insert(notedPieces).values({
      noteId: draft.note.id, sortIndex: 1000, pieceLabel: "From my photographs",
    });

    await post(`/v1/notes/${draft.note.id}/send`, teacher.token).send({});

    expect((await slotsOf(draft.note.id)).map((s) => s.pieceVersion)).toEqual([7, null]);
  });
});
