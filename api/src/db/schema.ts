import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  primaryKey,
  unique,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Deletion is soft (GDPR): erase scrubs PII, keeps the row — referral/financial history depends on it staying.
// organization: admin-only in beta, write-once — never surface in student-facing payloads (promised "Not shown publicly").
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  entraOid: text("entra_oid").unique(),
  // Cached claim, NOT identity — never unique (deletion/re-registration reuses emails).
  email: text("email"),
  displayName: text("display_name"),
  isTeacher: boolean("is_teacher").notNull().default(false),
  isStudent: boolean("is_student").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  // Break-glass transcript grant, on top of admin; self-grant is blocked in the roles PATCH, not the UI.
  canViewTranscripts: boolean("can_view_transcripts").notNull().default(false),
  organization: text("organization"),
  status: text("status").notNull().default("active"),  // active | deleted
  referredBy: uuid("referred_by").references((): AnyPgColumn => users.id),
  // Expiry = max(trial_started_at, monetization_live_at) + 30d, computed — never store expiry directly.
  trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
  // LEGACY: satisfies neither consent gate below — never use as a gate.
  notesConsentAt: timestamp("notes_consent_at", { withTimezone: true }),
  // Distinct consent promises (solo vs teacher) — accepting one must never satisfy or backfill the other.
  soloConsentAt: timestamp("solo_consent_at", { withTimezone: true }),
  teacherConsentAt: timestamp("teacher_consent_at", { withTimezone: true }),
  // ageBracket: self-reported at sign-up — 'over_13' | 'under_13'.
  // Never a verified fact or gate — decides parent-managed status only; pre-existing NULLs are intentional, not retro-prompted.
  ageBracket: text("age_bracket"),
  ageAttestedAt: timestamp("age_attested_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Kept FOREVER (entra_oid itself is released at delete) — the only way to recognize and refuse re-creation for a deleted account.
  ciamOidAtDelete: text("ciam_oid_at_delete"),
  // NULL = Graph delete unconfirmed (sync retries); NOT NULL = directory object gone (sync refuses, no retry).
  ciamDeletedAt: timestamp("ciam_deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_users_ciam_oid_at_delete").on(t.ciamOidAtDelete).where(sql`${t.ciamOidAtDelete} IS NOT NULL`),
]);

export const books = pgTable("books", {
  id: text("id").primaryKey(),  // slug, e.g. czerny_op599
  title: text("title").notNull(),
  author: text("author"),
  publisher: text("publisher"),
  edition: text("edition"),
  coverPath: text("cover_path"), // container-relative blob path
  // Authored total (the app's "No. n of M" denominator) — NEVER derive by counting attached piece rows.
  pieceCount: integer("piece_count"),
  description: text("description"),
  rights: text("rights").notNull().default("unknown"), // public_domain | licensed | unknown | blocked
  rightsNote: text("rights_note"),
  sortIndex: integer("sort_index"),
  status: text("status").notNull().default("active"),  // active | archived
  display: jsonb("display").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Works have no independent publish/archive state — emitted to the catalog only while ≥1 published piece references them.
export const works = pgTable("works", {
  id: text("id").primaryKey(),  // slug, e.g. mozart_k330
  title: text("title").notNull(),
  composer: text("composer").notNull(),
  catalogue: text("catalogue"),  // "K. 330" | "BWV 846" — free text, normalized only for dup checks
  workType: text("work_type").notNull().default("other"),  // structural hint only, no business logic
  parentWorkId: text("parent_work_id").references((): AnyPgColumn => works.id),
  movementCount: integer("movement_count"),  // authored total movements, not a row count
  sortIndex: integer("sort_index"),  // admin-maintained ordering within composer
  display: jsonb("display").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// No FK to pieces/works — composer strings are denormalized on pieces.composer/works.composer, joined by name/alias at read time.
export const composers = pgTable("composers", {
  id: text("id").primaryKey(),  // slug, e.g. johann_friedrich_burgmuller
  name: text("name").notNull().unique(),
  sortName: text("sort_name"),  // "Burgmüller, Johann Friedrich"
  aliases: jsonb("aliases").notNull().default([]),
  birthYear: integer("birth_year"),
  deathYear: integer("death_year"),
  bio: text("bio"),
  portraitPath: text("portrait_path"), // container-relative blob path
  attribution: text("attribution"),
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// SQL is the catalog truth; catalog.json is a build artifact regenerated on publish.
export const pieces = pgTable("pieces", {
  id: text("id").primaryKey(),  // asset slug, e.g. bach_bwv_846
  title: text("title").notNull(),
  composer: text("composer").notNull(),
  subtitle: text("subtitle").notNull().default(""),
  mode: text("mode").notNull().default("solo"),  // solo | concerto
  difficulty: integer("difficulty"),  // 1..5 student-facing
  tracking: text("tracking").notNull().default("experimental"),  // validated | experimental
  tags: jsonb("tags").notNull().default([]),
  display: jsonb("display").notNull().default({}),
  bookId: text("book_id").references(() => books.id),
  bookIndex: integer("book_index"),
  // (work_id, work_index) is NOT unique — arrangements on different instruments legitimately share both.
  workId: text("work_id").references(() => works.id),
  workIndex: integer("work_index"),
  // { solo: "violin", parts: ["violin","piano"] }; null = piano (pre-v3 rows).
  instrumentation: jsonb("instrumentation"),
  // Facts shape: { key:{fifths,mode}, time, measures, tempo_bpm, tempo_text, tempo_source:"xml"|"default", duration_sec, solo_part }.
  facts: jsonb("facts").notNull().default({}),
  // NULL = follows fine (serializes true); publish sets false only for repeat pieces the shipped follower can't track.
  followReady: boolean("follow_ready"),
  rights: text("rights").notNull().default("unknown"), // public_domain | licensed | unknown | blocked
  rightsNote: text("rights_note"),
  status: text("status").notNull().default("draft"),  // draft | published | archived
  publishedVersion: integer("published_version"),  // pointer, set transactionally at publish
  thumbnailPath: text("thumbnail_path"),
  rowIconPath: text("row_icon_path"),  // 300x400 webp of the opening system, list-row art
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Immutable; files[] stores container-relative {role, variant?, path, bytes, sha256} — SAS URLs are minted at read time.
export const pieceVersions = pgTable(
  "piece_versions",
  {
    pieceId: text("piece_id")
      .notNull()
      .references(() => pieces.id),
    version: integer("version").notNull(),
    engineSha: text("engine_sha"),
    files: jsonb("files").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid("published_by").references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.pieceId, t.version] })],
);

// Worker owns status/stage/gates/artifacts; API owns creation/retry/publish — respect that split.
export const studioJobs = pgTable("studio_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  pieceId: text("piece_id").notNull(),
  status: text("status").notNull().default("queued"),
  // draft | queued | running | ready_for_review | published | failed | canceled
  stage: text("stage"),  // sanity | alignment | geometry | render
  // Wizard preflight only (fast 3 gates before metadata is filled) — full runs re-verify everything regardless.
  checkStatus: text("check_status").notNull().default("pending"),
  metadata: jsonb("metadata").notNull().default({}),  // frozen wizard form input
  sources: jsonb("sources").notNull().default([]),  // [{kind, path, bytes, sha256, originalName}]
  gates: jsonb("gates").notNull().default({}),  // per-gate {status, metrics, error}
  artifacts: jsonb("artifacts").notNull().default([]),  // staged [{role, variant?, path, bytes, sha256}]
  error: text("error"),
  publishedVersion: integer("published_version"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ix_audit_actor_action_created is not reporting sugar — the redeem throttle derives its lock from it on every attempt.
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  subjectType: text("subject_type"),
  subjectId: text("subject_id"),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_audit_actor_action_created").on(t.actorUserId, t.action, t.createdAt),
]);

// ── Notes domain ────────────────────────────────────────────────────────────────

// Redeem IS the acceptance (rows go straight to active) — removed rows are kept so sent notes stay visible.
export const teacherStudentLinks = pgTable(
  "teacher_student_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id").notNull().references(() => users.id),
    studentId: uuid("student_id").notNull().references(() => users.id),
    status: text("status").notNull().default("active"),  // active | removed
    createdVia: text("created_via").notNull().default("invite_code"),  // invite_code | email_invite | admin
    // "Lessons may be recorded" acceptance at redeem (parent for minors).
    consentAt: timestamp("consent_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    // Reactivation overwrites the row — render join date from coalesce(rejoined_at, created_at), never created_at alone.
    rejoinedAt: timestamp("rejoined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("uq_link_pair").on(t.teacherId, t.studentId)],
);

// teacherId is the ISSUER — the STUDENT on reverse (student_to_teacher) codes, not always a teacher.
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),  // 6-char Crockford base32, no ambiguous chars
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  direction: text("direction").notNull().default("teacher_to_student"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  redeemedBy: jsonb("redeemed_by").notNull().default([]),
  // LEGACY, read-only — no mailer exists; never write, kept only for pre-existing rows' audit trail.
  sentToEmail: text("sent_to_email"),
  // Private to the issuer, often a minor's name — nulled when the code dies or its redeemer erases.
  intendedLabel: text("intended_label"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // NEVER a revoke — code history must keep reading "expired", not "revoked".
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("ck_invite_direction", sql`${t.direction} IN ('teacher_to_student', 'student_to_teacher')`),
  // Deliberately not unique — liveness needs expires_at > now(); enforced by the mint transaction's issuer row-lock instead.
  index("ix_invites_issuer_direction").on(t.teacherId, t.direction),
]);

// normalized_label: lower/trim/collapse whitespace but NEVER fold diacritics — "Für Elise" and "Fur Elise" must stay distinct.
export const customPieces = pgTable("custom_pieces", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  displayLabel: text("display_label").notNull(),
  normalizedLabel: text("normalized_label").notNull(),
  // Never written by a background job — linking is a manual teacher decision only, no automatic reconciliation.
  linkedPieceId: text("linked_piece_id").references(() => pieces.id),
  linkedAt: timestamp("linked_at", { withTimezone: true }),
  dismissedPieceIds: jsonb("dismissed_piece_ids").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_custom_pieces_teacher_label").on(t.teacherId, t.normalizedLabel),
]);

// Never joined to pieces or custom_pieces: `title` is what the owner typed, not a piece identity.
export const scoreScans = pgTable("score_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  // Idempotency key for outbox retries — NULLs never collide against the (ownerId, clientScanId) unique constraint.
  clientScanId: text("client_scan_id"),
  // Declared at create, re-counted from committed blobs at commit — a card must never print a page count the artifact cannot back.
  pageCount: integer("page_count").notNull(),
  blobPath: text("blob_prefix"),  // score-scans container-relative; nulled on purge like lesson_sessions.audio_path
  bytes: integer("bytes"),
  status: text("status").notNull().default("created"),  // created | ready | taken_down
  takenDownAt: timestamp("taken_down_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_score_scans_owner_client").on(t.ownerId, t.clientScanId),
  index("ix_score_scans_owner_created").on(t.ownerId, t.createdAt.desc()),
  check("ck_score_scans_status", sql`${t.status} IN ('created', 'ready', 'taken_down')`),
  check("ck_score_scans_pages", sql`${t.pageCount} BETWEEN 1 AND 20`),
]);

// Row is created at SEND time (recording is local until then) — piece/student are nullable, fixed at review.
// teacherId is the RECORDER/owner — the student themselves on a solo recording.
// owner_role snapshots who held the phone at create — never re-derive it from later role grants.
export const lessonSessions = pgTable("lesson_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  ownerRole: text("owner_role").notNull().default("teacher"),
  // Idempotency key for outbox retries — NULLs never collide against the (teacherId, clientLessonId) unique constraint.
  clientLessonId: text("client_lesson_id"),
  studentId: uuid("student_id").references(() => users.id),
  pieceId: text("piece_id").references(() => pieces.id),
  pieceLabel: text("piece_label"),
  // Disambiguates a nil piece_id (vendored has an on-device score, typed has none) — off-catalog rate metrics key on this.
  // NULL = an old build that never sent this, never "we know it was typed" — don't conflate with 'typed'.
  pieceSource: text("piece_source"),
  // ON DELETE SET NULL, not CASCADE — the lesson row survives its custom_piece being deleted, keeping the frozen piece_label.
  customPieceId: uuid("custom_piece_id").references(() => customPieces.id, { onDelete: "set null" }),
  // ON DELETE SET NULL for the same reason as custom_piece_id — a deleted scan must not take the recording with it.
  scoreScanId: uuid("score_scan_id").references(() => scoreScans.id, { onDelete: "set null" }),
  // Stamped only when the piece value actually changes (never by a student assignment) — updated_at bumps on every PATCH.
  pieceUpdatedAt: timestamp("piece_updated_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSec: integer("duration_sec"),
  audioPath: text("audio_path"),  // lesson-audio container-relative; blob auto-deletes at 90d
  audioBytes: integer("audio_bytes"),
  language: text("language").notNull().default("en"),
  // Consent confirm — NEVER pre-checked; requires a deliberate tap before capture can start.
  attested: boolean("attested").notNull().default(false),
  status: text("status").notNull().default("created"),  // created | submitted | canceled
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_lesson_client_id").on(t.teacherId, t.clientLessonId),
  check("ck_lesson_owner_role", sql`${t.ownerRole} IN ('teacher', 'student')`),
  check("ck_lesson_piece_source", sql`${t.pieceSource} IS NULL OR ${t.pieceSource} IN ('catalog', 'vendored', 'typed')`),
  // Mirrors ck_note_piece_excludes_scan on the far side; the create/PATCH guards are check-then-write, so only this closes the race.
  check("ck_lesson_piece_excludes_scan", sql`${t.pieceId} IS NULL OR ${t.scoreScanId} IS NULL`),
  index("ix_lesson_sessions_teacher_student_started").on(t.teacherId, t.studentId, t.startedAt),
  index("ix_lesson_sessions_score_scan").on(t.scoreScanId).where(sql`${t.scoreScanId} IS NOT NULL`),
]);

// SB message is {jobId, reqId} only — this row is the source of truth for idempotent redelivery, not the message.
export const noteJobs = pgTable("note_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  lessonSessionId: uuid("lesson_session_id").notNull().references(() => lessonSessions.id),
  status: text("status").notNull().default("queued"),  // queued | processing | failed | ready_for_review
  stage: text("stage"),  // asr | llm | gates
  error: text("error"),
  failureHints: jsonb("failure_hints").notNull().default([]),
  attempts: integer("attempts").notNull().default(0),
  // no_speech | thin_note | asr_error | llm_invalid | worker_crash | no_audio | lesson_discarded — cleared on every requeue.
  failureCode: text("failure_code"),
  // Cleared at every resolution point (confirm/dismiss/send/discard) — lesson words must never outlive the draft.
  pieceMentions: jsonb("piece_mentions").notNull().default([]),
  // Discard deletes the transcript blob, nulls transcript_path, strips metrics.warnings — row survives as a content-free record.
  discardedAt: timestamp("discarded_at", { withTimezone: true }),
  // Wall-time/elapsed measurements must anchor here, never on created_at — a retry leaves created_at at the first attempt.
  startedAt: timestamp("started_at", { withTimezone: true }),
  transcriptPath: text("transcript_path"),  // notes-assets; expires on the same 90-day clock as the audio, as both consent sheets promise
  // Must stay under the transcripts/ prefix — the 90-day blob lifecycle rule keys on that prefix.
  modelOutputPath: text("model_output_path"),
  metrics: jsonb("metrics").notNull().default({}),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// No in-place edit after send — retract + duplicate + resend (chained via superseded_by) for one truthful copy.
// origin='self': teacherId=studentId=owner, born already 'sent' — never reviewed, invisible to every teacher-side surface.
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteJobId: uuid("note_job_id").references(() => noteJobs.id),
  lessonSessionId: uuid("lesson_session_id").references(() => lessonSessions.id),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  studentId: uuid("student_id").references(() => users.id),
  origin: text("origin").notNull().default("teacher"),
  pieceId: text("piece_id").references(() => pieces.id),
  pieceLabel: text("piece_label"),
  customPieceId: uuid("custom_piece_id").references(() => customPieces.id, { onDelete: "set null" }),
  scoreScanId: uuid("score_scan_id").references(() => scoreScans.id, { onDelete: "set null" }),
  // Stamped only when a referenced scan was destroyed under a note the recipient had already read — the only thing that makes that sentence renderable.
  scoreScanDetachedAt: timestamp("score_scan_detached_at", { withTimezone: true }),
  // Append-only, never cleared — re-asking a dismissed suggestion is the annoyance this promises not to be.
  pieceSuggestionDismissed: jsonb("piece_suggestion_dismissed").notNull().default([]),
  // Anchors pin to the piece version live at send — republish can renumber measures.
  pieceVersion: integer("piece_version"),
  status: text("status").notNull().default("draft"),  // draft | sent | retracted
  contentOriginal: jsonb("content_original").notNull(),  // frozen LLM output, provenance
  content: jsonb("content").notNull(),  // teacher-edited: lesson_summary, practice_plan
  editedAt: timestamp("edited_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  retractedAt: timestamp("retracted_at", { withTimezone: true }),
  supersededBy: uuid("superseded_by").references((): AnyPgColumn => notes.id),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("ck_note_origin", sql`${t.origin} IN ('teacher', 'self')`),
  // Neither is required; naming one forbids the other. The two attach guards are check-then-write, so only this closes the race.
  check("ck_note_piece_excludes_scan", sql`${t.pieceId} IS NULL OR ${t.scoreScanId} IS NULL`),
  // Backstop for a real race: a deploy-drain window can run two workers on the same delivery — the loser hits this instead of double-inserting.
  uniqueIndex("uq_note_self_per_job").on(t.noteJobId).where(sql`${t.origin} = 'self'`),
  index("ix_notes_teacher_student_sent").on(t.teacherId, t.studentId, t.sentAt),
  index("ix_notes_student_sent").on(t.studentId, t.sentAt),
  // Partial: most notes carry no scan. Serves both the delete preflight and the delete sweep.
  index("ix_notes_score_scan").on(t.scoreScanId).where(sql`${t.scoreScanId} IS NOT NULL`),
]);

// Review may edit the instruction, never the quote — quotes are verbatim transcript evidence; delete the row instead.
export const noteAnnotations = pgTable("note_annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteId: uuid("note_id").notNull().references(() => notes.id),
  idx: integer("idx").notNull(),
  category: text("category").notNull(),
  instruction: text("instruction").notNull(),
  quote: text("quote"),
  // {type: absolute|compound|relative|deixis|none, raw, measureStart?, measureEnd?, grounded: bool, hint?, pinnedBy?: auto|teacher|student}
  location: jsonb("location").notNull().default({}),
  doneAt: timestamp("done_at", { withTimezone: true }),
  practiceReceipt: jsonb("practice_receipt"),  // FOLLOW-session corroboration, additive
  // NULL = General. A slot deleted under an item leaves the item, in General, rather than taking it.
  notePieceId: uuid("note_piece_id").references((): AnyPgColumn => notedPieces.id, { onDelete: "set null" }),
  // Provenance, never display: which slot's score this row's bar numbers were written against.
  groundedPieceId: uuid("grounded_piece_id").references((): AnyPgColumn => notedPieces.id, { onDelete: "set null" }),
  // 'transcript' = verbatim-anchored, never mintable. 'plan' = a synthesized recipe step, freely creatable.
  source: text("source").notNull().default("transcript"),
  groupLabel: text("group_label"),
  target: text("target"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_note_annotations_note").on(t.noteId),
  check("ck_practice_item_source", sql`${t.source} IN ('transcript', 'plan')`),
  // A transcript row without its quote is an unsourced instruction, which this product may never mint.
  check("ck_practice_item_transcript_quoted", sql`${t.source} <> 'transcript' OR ${t.quote} IS NOT NULL`),
  index("ix_note_annotations_piece").on(t.notePieceId).where(sql`${t.notePieceId} IS NOT NULL`),
]);

export const noteNarrationClips = pgTable("note_narration_clips", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  annotationId: uuid("annotation_id").references(() => noteAnnotations.id, { onDelete: "cascade" }),  // null on the overview clip
  voice: text("voice").notNull(),
  clipId: text("clip_id").notNull(),  // "overview" | annotation id
  kind: text("kind").notNull(),
  blobPath: text("blob_path").notNull(),  // notes-assets: narration/<note_id>/<voice>/<clip_id>.mp3
  // sha256 over [text, voiceId, model, seed, settings, outputFormat] — equal means already synthesized, never re-sent (vendor bills per char).
  contentHash: text("content_hash").notNull(),
  // Full lowercase-hex sha256, stored WHOLE — the app compares the exact digest, a truncated one can never match.
  textHash: text("text_hash").notNull(),
  chars: integer("chars").notNull(),  // characters SENT — what the ceiling gates on
  // Account drain = SUM(credits), never SUM(chars) (not 1:1); NULL = the cost header was unreadable.
  credits: integer("credits"),
  bytes: integer("bytes").notNull(),
  model: text("model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_narration_clip").on(t.noteId, t.voice, t.clipId),
  check("ck_narration_voice", sql`${t.voice} IN ('jessica', 'george')`),
  check("ck_narration_kind", sql`${t.kind} IN ('overview', 'step')`),
]);

// Multi-row by design — a user can hold trial + admin_grant + apple_iap rows concurrently; no per-user uniqueness.
// The resolver picks the strongest live row; teachers bypass entitlements entirely.
export const entitlements = pgTable("entitlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  source: text("source").notNull(),  // trial | apple_iap | admin_grant | org
  status: text("status").notNull().default("active"),  // active | grace | expired | revoked
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  productId: text("product_id"),
  appleOriginalTransactionId: text("apple_original_transaction_id").unique(),
  environment: text("environment"),  // sandbox | production — sandbox never grants prod access
  autoRenew: boolean("auto_renew").notNull().default(false),
  orgId: uuid("org_id"),  // future school/studio seats; no orgs table yet
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// APNS device tokens; upsert by token (a device changing owners rebinds it).
export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  platform: text("platform").notNull().default("ios"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Admin-editable runtime config — never store secrets here.
export const platformConfig = pgTable("platform_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Piece = typeof pieces.$inferSelect;
export type Book = typeof books.$inferSelect;
export type Work = typeof works.$inferSelect;
export type Composer = typeof composers.$inferSelect;
export type PieceVersion = typeof pieceVersions.$inferSelect;
export type TeacherStudentLink = typeof teacherStudentLinks.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type LessonSession = typeof lessonSessions.$inferSelect;
export type NoteJob = typeof noteJobs.$inferSelect;
export type Note = typeof notes.$inferSelect;
// ── v0.11: a lesson holds an ordered list of pieces ──────────────────────────────
// The exclusivity rule moves DOWN to the slot: a slot names one piece and shows one score.
// lesson_pieces holds what was captured before any note exists; note_pieces is the note's own list.

export const lessonPieces = pgTable("lesson_pieces", {
  id: uuid("id").primaryKey().defaultRandom(),
  lessonSessionId: uuid("lesson_session_id").notNull()
    .references(() => lessonSessions.id, { onDelete: "cascade" }),
  // Sparse steps of 1000 — a reorder rewrites one row, not the whole list.
  sortIndex: integer("sort_index").notNull(),
  pieceId: text("piece_id").references(() => pieces.id),
  pieceLabel: text("piece_label"),
  pieceSource: text("piece_source"),
  customPieceId: uuid("custom_piece_id").references(() => customPieces.id, { onDelete: "set null" }),
  scoreScanId: uuid("score_scan_id").references(() => scoreScans.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("ck_lesson_piece_slot_excludes_scan", sql`${t.pieceId} IS NULL OR ${t.scoreScanId} IS NULL`),
  check("ck_lesson_piece_slot_source", sql`${t.pieceSource} IS NULL OR ${t.pieceSource} IN ('catalog', 'vendored', 'typed')`),
  uniqueIndex("uq_lesson_pieces_order").on(t.lessonSessionId, t.sortIndex),
  index("ix_lesson_pieces_scan").on(t.scoreScanId).where(sql`${t.scoreScanId} IS NOT NULL`),
]);

export const notedPieces = pgTable("note_pieces", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  sortIndex: integer("sort_index").notNull(),
  practiceSubjectId: uuid("practice_subject_id").references((): AnyPgColumn => practiceSubjects.id, { onDelete: "set null" }),
  pieceId: text("piece_id").references(() => pieces.id),
  pieceLabel: text("piece_label"),
  pieceSource: text("piece_source"),
  customPieceId: uuid("custom_piece_id").references(() => customPieces.id, { onDelete: "set null" }),
  scoreScanId: uuid("score_scan_id").references(() => scoreScans.id, { onDelete: "set null" }),
  // Stamped only when a referenced scan was destroyed under a note the recipient had already read.
  scoreScanDetachedAt: timestamp("score_scan_detached_at", { withTimezone: true }),
  // Anchors pin to the piece version live at send — republish can renumber measures.
  pieceVersion: integer("piece_version"),
  pieceSuggestionDismissed: jsonb("piece_suggestion_dismissed").notNull().default([]),
  // The per-piece half of the grouped summary; notes.lesson_summary keeps the General bucket.
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("ck_note_piece_slot_excludes_scan", sql`${t.pieceId} IS NULL OR ${t.scoreScanId} IS NULL`),
  check("ck_note_piece_slot_source", sql`${t.pieceSource} IS NULL OR ${t.pieceSource} IN ('catalog', 'vendored', 'typed')`),
  uniqueIndex("uq_note_pieces_order").on(t.noteId, t.sortIndex),
  index("ix_note_pieces_scan").on(t.scoreScanId).where(sql`${t.scoreScanId} IS NOT NULL`),
  index("ix_note_pieces_subject").on(t.practiceSubjectId).where(sql`${t.practiceSubjectId} IS NOT NULL`),
]);

// The one entity with no analogue today: replacing a score and setting a target tempo are
// actions taken with NO lesson open, so they need a row outside any note's lifecycle.
export const practiceSubjects = pgTable("practice_subjects", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id").notNull().references(() => users.id),
  // The note's author; equal to studentId on a self-recorded note.
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  pieceId: text("piece_id").references(() => pieces.id),
  customPieceId: uuid("custom_piece_id").references(() => customPieces.id, { onDelete: "set null" }),
  currentScoreScanId: uuid("current_score_scan_id").references(() => scoreScans.id, { onDelete: "set null" }),
  currentScoreSetBy: text("current_score_set_by"),
  currentScoreSetAt: timestamp("current_score_set_at", { withTimezone: true }),
  // Ships unread this round: adding it later is a migration on a table five features will depend on.
  targetBpm: integer("target_bpm"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("ck_practice_subject_identity", sql`(${t.pieceId} IS NULL) <> (${t.customPieceId} IS NULL)`),
  check("ck_practice_subject_set_by", sql`${t.currentScoreSetBy} IS NULL OR ${t.currentScoreSetBy} IN ('teacher', 'student')`),
  uniqueIndex("uq_practice_subject_catalog").on(t.studentId, t.teacherId, t.pieceId)
    .where(sql`${t.pieceId} IS NOT NULL`),
  uniqueIndex("uq_practice_subject_custom").on(t.studentId, t.teacherId, t.customPieceId)
    .where(sql`${t.customPieceId} IS NOT NULL`),
]);

export type LessonPiece = typeof lessonPieces.$inferSelect;
export type NotePiece = typeof notedPieces.$inferSelect;
export type PracticeSubject = typeof practiceSubjects.$inferSelect;

export type NoteAnnotation = typeof noteAnnotations.$inferSelect;
export type NoteNarrationClip = typeof noteNarrationClips.$inferSelect;
export type CustomPiece = typeof customPieces.$inferSelect;
export type ScoreScan = typeof scoreScans.$inferSelect;
export type Entitlement = typeof entitlements.$inferSelect;
export type Device = typeof devices.$inferSelect;
