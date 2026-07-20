import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Deletion is soft (GDPR): erase scrubs email/display_name/entra_oid, keeps the row
// so financial and referral history stays intact.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  entraOid: text("entra_oid").unique(),
  // Cached claim, NOT identity — never unique (deletion/re-registration reuses emails).
  email: text("email"),
  displayName: text("display_name"),
  isTeacher: boolean("is_teacher").notNull().default(false),
  isStudent: boolean("is_student").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  status: text("status").notNull().default("active"), // active | deleted
  referredBy: uuid("referred_by").references((): AnyPgColumn => users.id),
  // Trial expiry is computed as max(trial_started_at, monetization_live_at) + 30d so
  // beta testers get a fresh clock when the paywall goes live — never store expiry.
  trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
  // First-use Notes consent (teacher: recording responsibility; student: terms).
  notesConsentAt: timestamp("notes_consent_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A method book / pedagogical collection pieces can belong to. rights gates publish.
export const books = pgTable("books", {
  id: text("id").primaryKey(), // slug, e.g. czerny_op599
  title: text("title").notNull(),
  author: text("author"),
  publisher: text("publisher"),
  edition: text("edition"),
  coverPath: text("cover_path"), // container-relative blob path
  // Authored total per the printed edition (e.g. 98 for Czerny 599) — the app's
  // "No. n of M" denominator. NEVER derived from attached rows.
  pieceCount: integer("piece_count"),
  description: text("description"),
  rights: text("rights").notNull().default("unknown"), // public_domain | licensed | unknown | blocked
  rightsNote: text("rights_note"),
  sortIndex: integer("sort_index"),
  status: text("status").notNull().default("active"), // active | archived
  display: jsonb("display").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A musical composition (sonata, étude set, prelude+fugue pair) grouping its movements.
// Emitted to the catalog only while ≥1 published piece references it — works have no
// independent publish/archive state. parent_work_id = one nesting hop max by convention.
export const works = pgTable("works", {
  id: text("id").primaryKey(), // slug, e.g. mozart_k330
  title: text("title").notNull(),
  composer: text("composer").notNull(),
  catalogue: text("catalogue"), // "K. 330" | "BWV 846" — free text, normalized only for dup checks
  workType: text("work_type").notNull().default("other"), // structural hint only, no business logic
  parentWorkId: text("parent_work_id").references((): AnyPgColumn => works.id),
  movementCount: integer("movement_count"), // authored total movements, not a row count
  sortIndex: integer("sort_index"), // admin-maintained ordering within composer
  display: jsonb("display").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Lean composer registry: NO foreign keys to pieces/works — composer strings live
// denormalized on pieces.composer / works.composer and join by name/alias at read
// time. The registry only adds presentation data (sort name, portrait, attribution).
export const composers = pgTable("composers", {
  id: text("id").primaryKey(), // slug, e.g. johann_friedrich_burgmuller
  name: text("name").notNull().unique(), // canonical display form, as used on pieces
  sortName: text("sort_name"), // "Burgmüller, Johann Friedrich"
  aliases: jsonb("aliases").notNull().default([]), // alternate spellings mapping here
  birthYear: integer("birth_year"),
  deathYear: integer("death_year"),
  bio: text("bio"), // short authored background blurb
  portraitPath: text("portrait_path"), // container-relative blob path
  attribution: text("attribution"),
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// SQL is the catalog truth; catalog.json is a build artifact regenerated on publish.
export const pieces = pgTable("pieces", {
  id: text("id").primaryKey(), // asset slug, e.g. bach_bwv_846
  title: text("title").notNull(),
  composer: text("composer").notNull(),
  subtitle: text("subtitle").notNull().default(""),
  mode: text("mode").notNull().default("solo"), // solo | concerto
  difficulty: integer("difficulty"), // 1..5 student-facing
  tracking: text("tracking").notNull().default("experimental"), // validated | experimental
  tags: jsonb("tags").notNull().default([]),
  display: jsonb("display").notNull().default({}),
  bookId: text("book_id").references(() => books.id),
  bookIndex: integer("book_index"),
  // Work membership is ORTHOGONAL to book membership. (work_id, work_index) is NOT
  // unique — arrangements on different instruments legitimately share both.
  workId: text("work_id").references(() => works.id),
  workIndex: integer("work_index"),
  // { solo: "violin", parts: ["violin","piano"] }; null = piano (pre-v3 rows).
  instrumentation: jsonb("instrumentation"),
  // Auto-extracted musical facts: { key: {fifths, mode}, time: "3/4", measures,
  // tempo_bpm, tempo_text, tempo_source: "xml"|"default", duration_sec, solo_part }.
  facts: jsonb("facts").notNull().default({}),
  // NULL = follows fine (catalog serializes it as true); publish sets false for
  // repeat pieces, whose written measure order the shipped follower cannot track.
  followReady: boolean("follow_ready"),
  rights: text("rights").notNull().default("unknown"), // public_domain | licensed | unknown | blocked
  rightsNote: text("rights_note"),
  status: text("status").notNull().default("draft"), // draft | published | archived
  publishedVersion: integer("published_version"), // pointer, set transactionally at publish
  thumbnailPath: text("thumbnail_path"),
  rowIconPath: text("row_icon_path"), // 300x400 webp of the opening system, list-row art
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Immutable: one row per built bundle version. files[] stores container-RELATIVE paths
// ({role, variant?, path, bytes, sha256}); SAS-signed URLs are minted at read time.
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

// One row per Pieces Studio build. The worker owns status/stage/gates/artifacts;
// the API owns creation, retry, and the publish transition. Artifacts stay in
// staging until publish copies them into the immutable v<N> layout.
export const studioJobs = pgTable("studio_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  pieceId: text("piece_id").notNull(),
  status: text("status").notNull().default("queued"),
  // draft | queued | running | ready_for_review | published | failed | canceled
  stage: text("stage"), // sanity | alignment | geometry | render
  // Wizard preflight (fast 3 gates on the upload, before metadata is even filled):
  // pending | running | pass | fail. Full runs re-verify everything regardless.
  checkStatus: text("check_status").notNull().default("pending"),
  metadata: jsonb("metadata").notNull().default({}), // frozen wizard form input
  sources: jsonb("sources").notNull().default([]), // [{kind, path, bytes, sha256, originalName}]
  gates: jsonb("gates").notNull().default({}), // per-gate {status, metrics, error}
  artifacts: jsonb("artifacts").notNull().default([]), // staged [{role, variant?, path, bytes, sha256}]
  error: text("error"),
  publishedVersion: integer("published_version"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only trail of admin mutations. Reads are not audited.
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(), // e.g. piece.publish, user.set_admin
  subjectType: text("subject_type"),
  subjectId: text("subject_id"),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Notes domain ────────────────────────────────────────────────────────────────

// Teacher↔student pairs. Rows go straight to active on invite redemption (the
// redeem IS the acceptance); removed rows are kept — sent notes stay visible.
export const teacherStudentLinks = pgTable(
  "teacher_student_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id").notNull().references(() => users.id),
    studentId: uuid("student_id").notNull().references(() => users.id),
    status: text("status").notNull().default("active"), // active | removed
    createdVia: text("created_via").notNull().default("invite_code"), // invite_code | email_invite | admin
    // "Lessons may be recorded" acceptance at redeem (parent for minors).
    consentAt: timestamp("consent_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("uq_link_pair").on(t.teacherId, t.studentId)],
);

// Teacher-generated linking codes (no global user search exists by design — minors).
// The code may be redeemed by a student who signs up AFTER it was issued.
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(), // 6-char Crockford base32, no ambiguous chars
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  redeemedBy: jsonb("redeemed_by").notNull().default([]), // user ids, audit only
  // Delivery address for the email fallback; used once, never copied to the link.
  sentToEmail: text("sent_to_email"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One recorded lesson. The row is created at SEND time (recording is fully local
// and offline-first); piece/student stay nullable — both are fixable at review.
export const lessonSessions = pgTable("lesson_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  studentId: uuid("student_id").references(() => users.id),
  pieceId: text("piece_id").references(() => pieces.id),
  pieceLabel: text("piece_label"), // free-text fallback for non-catalog pieces
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSec: integer("duration_sec"),
  audioPath: text("audio_path"), // lesson-audio container-relative; blob auto-deletes at 90d
  audioBytes: integer("audio_bytes"),
  language: text("language").notNull().default("en"),
  // Default-checked "student has been informed this lesson is recorded" confirm.
  attested: boolean("attested").notNull().default(false),
  status: text("status").notNull().default("created"), // created | uploaded | submitted | canceled
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One ASR+LLM run per submitted lesson. Worker owns status/stage; SB message is
// {jobId, reqId} only — this row is the source of truth (idempotent redelivery).
export const noteJobs = pgTable("note_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  lessonSessionId: uuid("lesson_session_id").notNull().references(() => lessonSessions.id),
  status: text("status").notNull().default("queued"), // queued | processing | failed | ready_for_review
  stage: text("stage"), // asr | llm | gates
  error: text("error"),
  failureHints: jsonb("failure_hints").notNull().default([]),
  attempts: integer("attempts").notNull().default(0),
  transcriptPath: text("transcript_path"), // notes-assets, durable (survives audio deletion)
  metrics: jsonb("metrics").notNull().default({}), // asr/llm timings, annotation + grounding counts
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A note delivered (or to be delivered) to ONE student. Group lessons duplicate the
// reviewed note per student. No in-place edit after send: retract + duplicate + resend
// (superseded_by chains versions) so the student always holds one truthful copy.
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteJobId: uuid("note_job_id").notNull().references(() => noteJobs.id),
  lessonSessionId: uuid("lesson_session_id").notNull().references(() => lessonSessions.id),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  studentId: uuid("student_id").references(() => users.id), // nullable until assigned
  pieceId: text("piece_id").references(() => pieces.id),
  pieceLabel: text("piece_label"),
  // Anchors pin to the piece version live at send — republish can renumber measures.
  pieceVersion: integer("piece_version"),
  status: text("status").notNull().default("draft"), // draft | sent | retracted
  contentOriginal: jsonb("content_original").notNull(), // frozen LLM output, provenance
  content: jsonb("content").notNull(), // teacher-edited: lesson_summary, practice_plan
  editedAt: timestamp("edited_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  retractedAt: timestamp("retracted_at", { withTimezone: true }),
  supersededBy: uuid("superseded_by").references((): AnyPgColumn => notes.id),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Annotations are rows (not embedded JSON): per-item student done_at and future
// FOLLOW practice receipts attach here. Quotes are verbatim transcript evidence —
// review edits the instruction, never the quote (delete the row instead).
export const noteAnnotations = pgTable("note_annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteId: uuid("note_id").notNull().references(() => notes.id),
  idx: integer("idx").notNull(),
  category: text("category").notNull(),
  instruction: text("instruction").notNull(),
  quote: text("quote"),
  // {type: absolute|compound|relative|deixis|none, raw, measureStart?, measureEnd?,
  //  grounded: bool, hint?, pinnedBy?: auto|teacher|student}
  location: jsonb("location").notNull().default({}),
  doneAt: timestamp("done_at", { withTimezone: true }),
  practiceReceipt: jsonb("practice_receipt"), // FOLLOW-session corroboration, additive
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Multi-row by design: a user can hold trial + admin_grant + apple_iap rows over time.
// The resolver picks the strongest live row; teachers bypass entitlements entirely.
export const entitlements = pgTable("entitlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  source: text("source").notNull(), // trial | apple_iap | admin_grant | org
  status: text("status").notNull().default("active"), // active | grace | expired | revoked
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  productId: text("product_id"),
  appleOriginalTransactionId: text("apple_original_transaction_id").unique(),
  environment: text("environment"), // sandbox | production — sandbox never grants prod access
  autoRenew: boolean("auto_renew").notNull().default(false),
  orgId: uuid("org_id"), // future school/studio seats; no orgs table yet
  note: text("note"), // admin grant reason
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

// Admin-editable runtime config (e.g. monetization_live_at). Not for secrets.
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
export type NoteAnnotation = typeof noteAnnotations.$inferSelect;
export type Entitlement = typeof entitlements.$inferSelect;
export type Device = typeof devices.$inferSelect;
