import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { msal, API_SCOPE } from "./auth";

export const API_BASE =
  import.meta.env.VITE_API_BASE ??
  "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io";

export async function getToken(): Promise<string> {
  return token();
}

async function token(): Promise<string> {
  const account = msal.getAllAccounts()[0];
  if (!account) throw new Error("not_signed_in");
  try {
    const res = await msal.acquireTokenSilent({ scopes: [API_SCOPE], account });
    return res.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await msal.acquireTokenRedirect({ scopes: [API_SCOPE], account });
    }
    throw err;
  }
}

export class ApiError extends Error {
  // message = the server's human explanation when it sent one, else the code.
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${await token()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `http_${res.status}`, body.message);
  }
  return res.json();
}

export interface AdminUser {
  id: string;
  entraOid: string | null;
  email: string | null;
  displayName: string | null;
  // Optional self-reported studio/school from teacher sign-up. Admin-only context —
  // never student-facing.
  organization: string | null;
  isTeacher: boolean;
  isStudent: boolean;
  isAdmin: boolean;
  // Break-glass capability: view lesson transcripts (minors' data). Grantable only
  // by an existing holder; never changeable on your own row (server-enforced).
  canViewTranscripts: boolean;
  status: string;
  referredBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
  actorEmail: string | null;
}

export interface AdminUserDetail {
  user: AdminUser;
  recentAudit: AuditEntry[];
}

// force acknowledges "this account will have no teaching or learning role" — the
// state that silently bricked two dev accounts.
export type RolePatch = Partial<
  Pick<AdminUser, "isAdmin" | "isTeacher" | "isStudent" | "canViewTranscripts">
> & { force?: boolean };

export interface AdminPiece {
  id: string;
  title: string;
  composer: string;
  subtitle: string;
  mode: string;
  difficulty: number | null;
  tracking: string;
  bookId: string | null;
  bookIndex: number | null;
  bookTitle: string | null;
  workId: string | null;
  workIndex: number | null;
  workTitle: string | null;
  workCatalogue: string | null;
  instrumentation: { solo: string; parts: string[] } | null;
  facts: PieceFacts | null;
  rights: string;
  rightsNote: string | null;
  status: string;
  publishedVersion: number | null;
  versionCount: number;
  latestVersion: number | null;
  updatedAt: string;
}

export interface PieceVersionRow {
  pieceId: string;
  version: number;
  engineSha: string | null;
  files: { role: string; variant?: string; path: string; bytes?: number; sha256?: string; url?: string | null }[];
  publishedAt: string;
  publishedByEmail: string | null;
}

export interface PieceSource {
  path: string;
  bytes: number;
  url: string | null;
  kind?: string;
  originalName?: string;
  origin: "studio_upload" | "archive";
}

export interface PieceBuildRow {
  id: string;
  status: string;
  checkStatus: string;
  publishedVersion: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PieceFacts {
  key?: { fifths: number; mode?: string } | null;
  time?: string | null;
  staves?: number | null;
  measures?: number;
  tempo_bpm?: number | null;
  tempo_text?: string | null;
  tempo_source?: "xml" | "default";
  n_parts?: number;
  parts?: { id: string; name: string | null }[];
  solo_part?: string | null;
  structure?: {
    type: "repeats";
    written_measures: number | null;
    played_measures: number | null;
    max_passes: number | null;
    n_spans: number | null;
    expanded_duration_sec: number | null;
    expansion_source: string | null;
  };
}

export interface WorkSibling {
  id: string;
  title: string;
  subtitle: string | null;
  workIndex: number | null;
  status: string;
  publishedVersion: number | null;
  instrumentation: { solo: string; parts: string[] } | null;
}

export interface AdminPieceDetail extends Omit<AdminPiece, "bookTitle" | "workTitle" | "workCatalogue" | "versionCount" | "latestVersion"> {
  book: (AdminBook & { coverUrl: string | null; coverThumbUrl: string | null }) | null;
  work: AdminWork | null;
  workSiblings: WorkSibling[];
  previewAudio: { url: string; jobId: string; renderedAt: string } | null;
  versions: PieceVersionRow[];
  sources: PieceSource[];
  jobs: PieceBuildRow[];
  recentAudit: AuditEntry[];
}

export type PieceEdit = Partial<{
  title: string;
  composer: string;
  subtitle: string;
  difficulty: number | null;
  tracking: "validated" | "experimental";
  bookId: string | null;
  bookIndex: number | null;
  workId: string | null;
  workIndex: number | null;
  confirmMovementClash: boolean;
  rights: "public_domain" | "licensed" | "unknown" | "blocked";
  rightsNote: string | null;
  expectedUpdatedAt: string;
}>;

export interface GateEntry {
  status: "running" | "pass" | "fail";
  metrics: Record<string, unknown>;
  error?: string;
}

export type JobStatus =
  | "draft"
  | "queued"
  | "running"
  | "ready_for_review"
  | "published"
  | "failed"
  | "canceled";

export interface StudioMetadata {
  title?: string;
  composer?: string;
  subtitle?: string;
  difficulty?: number | null;
  tracking?: "validated" | "experimental";
  rights?: "public_domain" | "licensed" | "unknown";
  rightsNote?: string;
  instrument?: "piano" | "violin" | "guitar";
  soloPart?: string | null;
  work?: { id: string; index: number | null } | null;
  book?: { id: string; title?: string; index: number | null } | null;
}

export interface XmlMeta {
  parts: { id: string; name: string | null }[];
  n_parts: number;
  key: { fifths: number; mode?: string } | null;
  time: string | null;
  staves: number | null;
  measures: number;
  tempo_bpm: number | null;
  tempo_text: string | null;
  tempo_source: "xml" | "default";
  software?: string[];
  export_warnings?: { code: string; measures?: string[] }[];
  suggested_title: string | null;
  suggested_movement: string | null;
  suggested_composer: string | null;
}

export interface AdminWork {
  id: string;
  title: string;
  composer: string;
  catalogue: string | null;
  workType: string;
  parentWorkId: string | null;
  movementCount: number | null; // authored total movements, never a row count
  sortIndex: number | null;
  display: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  pieceCount?: number;
}

export interface StudioJob {
  id: string;
  pieceId: string;
  status: JobStatus;
  checkStatus: "pending" | "running" | "pass" | "fail";
  stage: string | null;
  metadata: StudioMetadata;
  sources: { kind: string; path: string; bytes: number; originalName: string }[];
  gates: Record<string, GateEntry>;
  artifacts: { role: string; variant?: string; path: string; bytes: number }[];
  error: string | null;
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
  createdByEmail?: string | null;
  previews?: { role: string; variant?: string; url: string }[];
  // Live-registry cross-check (detail endpoint only): what this piece id currently
  // looks like in the catalog — null when never published.
  piece?: { status: string; publishedVersion: number | null } | null;
}

export interface CheckFinding {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

export interface AdminBook {
  id: string;
  title: string;
  author: string | null;
  publisher: string | null;
  edition: string | null;
  coverPath: string | null;
  description: string | null;
  rights: string;
  rightsNote: string | null;
  sortIndex: number | null;
  status: string;
  display: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // In LIST responses this is the number of ATTACHED rows (server rollup); the
  // authored printed total travels on the detail response instead.
  pieceCount: number;
  coverUrl: string | null;
  coverThumbUrl: string | null;
}

// Multipart calls bypass api(): it forces a JSON content-type on any body, which
// would destroy the FormData boundary.
export async function apiForm<T>(path: string, form: FormData, method = "POST"): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getToken()}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `http_${res.status}`, body.message);
  }
  return res.json();
}

export type Rights = "public_domain" | "licensed" | "unknown" | "blocked";

export const WORK_TYPES = [
  "sonata",
  "suite",
  "etude_set",
  "prelude_fugue",
  "variations",
  "cycle",
  "concerto",
  "collection",
  "other",
] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export interface BookPieceRow {
  id: string;
  title: string;
  subtitle: string;
  composer: string;
  bookIndex: number | null;
  status: string;
  publishedVersion: number | null;
  difficulty: number | null;
  instrumentation: { solo: string; parts: string[] } | null;
  updatedAt: string;
}

export interface WorkPieceRow extends Omit<BookPieceRow, "bookIndex"> {
  workIndex: number | null;
}

// Detail responses carry the member pieces instead of the attached-rows rollup;
// here pieceCount is the AUTHORED printed total (e.g. 98 for Czerny 599).
export interface AdminBookDetail extends Omit<AdminBook, "pieceCount"> {
  pieceCount: number | null;
  pieces: BookPieceRow[];
  recentAudit: AuditEntry[];
}

export interface AdminWorkDetail extends Omit<AdminWork, "pieceCount"> {
  pieces: WorkPieceRow[];
  children: AdminWork[];
  recentAudit: AuditEntry[];
}

export type BookEdit = Partial<{
  title: string;
  author: string | null;
  publisher: string | null;
  edition: string | null;
  pieceCount: number | null;
  description: string | null;
  rights: Rights;
  rightsNote: string | null;
  sortIndex: number | null;
}>;

export type WorkEdit = Partial<{
  title: string;
  composer: string;
  catalogue: string | null;
  workType: WorkType;
  movementCount: number | null;
  sortIndex: number | null;
}>;

export function getBook(id: string): Promise<AdminBookDetail> {
  return api(`/admin/books/${id}`);
}

export function patchBook(id: string, patch: BookEdit): Promise<Omit<AdminBook, "pieceCount">> {
  return api(`/admin/books/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteBook(id: string): Promise<{ ok: boolean }> {
  return api(`/admin/books/${id}`, { method: "DELETE" });
}

export function putBookNumbering(
  id: string,
  entries: { pieceId: string; bookIndex: number | null }[],
): Promise<{ ok: boolean; changed: number }> {
  return api(`/admin/books/${id}/numbering`, { method: "PUT", body: JSON.stringify({ entries }) });
}

export function putBookCover(id: string, cover: File): Promise<Omit<AdminBook, "pieceCount">> {
  const form = new FormData();
  form.set("cover", cover);
  return apiForm(`/admin/books/${id}/cover`, form, "PUT");
}

export function createBook(
  fields: { title: string; author?: string },
  cover: File,
): Promise<Omit<AdminBook, "pieceCount">> {
  const form = new FormData();
  form.set("title", fields.title);
  if (fields.author) form.set("author", fields.author);
  form.set("cover", cover);
  return apiForm("/admin/books", form);
}

export function searchWorks(q: string): Promise<{ items: AdminWork[] }> {
  return api(`/admin/works${q ? `?q=${encodeURIComponent(q)}` : ""}`);
}

export function getWork(id: string): Promise<AdminWorkDetail> {
  return api(`/admin/works/${id}`);
}

export function patchWork(id: string, patch: WorkEdit): Promise<AdminWork> {
  return api(`/admin/works/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteWork(id: string): Promise<{ ok: boolean }> {
  return api(`/admin/works/${id}`, { method: "DELETE" });
}

export function mergeWork(
  id: string,
  targetWorkId: string,
  confirmMovementClash?: boolean,
): Promise<{ ok: boolean; moved: number }> {
  return api(`/admin/works/${id}/merge`, {
    method: "POST",
    body: JSON.stringify({ targetWorkId, ...(confirmMovementClash ? { confirmMovementClash } : {}) }),
  });
}

// ---- Composers registry (lean: joins pieces/works by name/alias string) ----

export interface AdminComposer {
  id: string;
  name: string;
  sortName: string | null;
  aliases: string[];
  birthYear: number | null;
  deathYear: number | null;
  bio: string | null;
  portraitPath: string | null;
  attribution: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  portraitUrl: string | null;
  usageCount: number; // pieces whose composer string matches name OR any alias
}

/** One distinct composer string as it appears on pieces/works rows. */
export interface ComposerString {
  value: string;
  pieceCount: number;
  workCount: number;
  composerId: string | null;
  composerName: string | null;
  matched: "name" | "alias" | null;
}

export interface ComposersResponse {
  items: AdminComposer[];
  strings: ComposerString[];
  unregistered: ComposerString[];
}

export type ComposerEdit = Partial<{
  name: string;
  sortName: string | null;
  aliases: string[];
  birthYear: number | null;
  deathYear: number | null;
  bio: string | null;
  attribution: string | null;
  sourceUrl: string | null;
}>;

export function listComposers(): Promise<ComposersResponse> {
  return api("/admin/composers");
}

export function createComposer(fields: ComposerEdit & { name: string }): Promise<AdminComposer> {
  return api("/admin/composers", { method: "POST", body: JSON.stringify(fields) });
}

export function patchComposer(id: string, patch: ComposerEdit): Promise<AdminComposer> {
  return api(`/admin/composers/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteComposer(id: string): Promise<{ ok: boolean }> {
  return api(`/admin/composers/${id}`, { method: "DELETE" });
}

export function putComposerPortrait(id: string, portrait: File): Promise<AdminComposer> {
  const form = new FormData();
  form.set("portrait", portrait);
  return apiForm(`/admin/composers/${id}/portrait`, form, "PUT");
}

// ---- Ops (logs / request timeline / queue) ----

export type OpsSeverity = "error" | "warn" | "info";

export interface OpsLogRow {
  t: string;
  source: "api" | "worker";
  kind: "http" | "worker" | "raw";
  severity: OpsSeverity;
  reqId: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  ms: number | null;
  oid: string | null;
  admin: string | null;
  job: string | null;
  event: string | null;
  msg: string;
}

// Every value is a plain string; severity alone accepts a comma-list ("error,warn").
export interface OpsFilters {
  from?: string;
  to?: string;
  kind?: string;
  source?: string;
  severity?: string;
  statusClass?: string;
  route?: string;
  method?: string;
  reqId?: string;
  oid?: string;
  admin?: string;
  job?: string;
  event?: string;
  text?: string;
}

export interface OpsLogsResponse {
  rows: OpsLogRow[];
  truncated: boolean;
}

export interface OpsHistogramBucket {
  t: string;
  error: number;
  warn: number;
  info: number;
}

export interface OpsHistogramResponse {
  buckets: OpsHistogramBucket[];
  binMinutes: number;
}

export interface OpsFacetValue {
  value: string;
  count: number;
  /** Present on admin entries: the operator's email. */
  label?: string;
}

export type OpsFacetKey = "severity" | "source" | "statusClass" | "route" | "event" | "admin";

export interface OpsFacetsResponse {
  facets: Record<OpsFacetKey, OpsFacetValue[]>;
}

export interface OpsTimelineEvent {
  t: string;
  lane: "api" | "worker" | "audit";
  severity?: OpsSeverity;
  msg: string;
  method?: string;
  route?: string;
  status?: number;
  ms?: number;
  job?: string;
  event?: string;
  action?: string;
  actorEmail?: string | null;
  detail?: Record<string, unknown>;
}

export interface OpsRequestResponse {
  events: OpsTimelineEvent[];
}

export interface OpsQueueCard {
  name: string;
  active: number;
  deadLettered: number;
  scheduled: number;
}

export interface OpsDlqMessage {
  queue: string;
  sequenceNumber: number;
  enqueuedAt: string;
  reason: string | null;
  jobId: string | null;
  body?: Record<string, unknown>;
}

export interface OpsRecentJob {
  id: string;
  pieceId: string;
  status: string;
  checkStatus: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpsQueueResponse {
  queues: OpsQueueCard[];
  dlq: OpsDlqMessage[];
  recentJobs: OpsRecentJob[];
}

/** Shared serializer for the three filtered ops GETs — skips empty values. */
export function opsQueryString(
  filters: OpsFilters,
  extra?: Record<string, string | number>,
): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function getOpsLogs(
  filters: OpsFilters,
  opts: { limit?: number; order?: "asc" | "desc"; signal?: AbortSignal } = {},
): Promise<OpsLogsResponse> {
  const qs = opsQueryString(filters, { limit: opts.limit ?? 500, order: opts.order ?? "desc" });
  return api(`/admin/ops/logs${qs}`, { signal: opts.signal });
}

export function getOpsHistogram(filters: OpsFilters, signal?: AbortSignal): Promise<OpsHistogramResponse> {
  return api(`/admin/ops/histogram${opsQueryString(filters)}`, { signal });
}

export function getOpsFacets(filters: OpsFilters, signal?: AbortSignal): Promise<OpsFacetsResponse> {
  return api(`/admin/ops/facets${opsQueryString(filters)}`, { signal });
}

export function getOpsRequest(reqId: string, signal?: AbortSignal): Promise<OpsRequestResponse> {
  return api(`/admin/ops/request/${encodeURIComponent(reqId)}`, { signal });
}

export function getOpsQueue(signal?: AbortSignal): Promise<OpsQueueResponse> {
  return api("/admin/ops/queue", { signal });
}

// ---- Notes admin (pairings / subscriptions / note-jobs / activity) ----

export type LinkStatus = "active" | "removed";

export interface NoteLink {
  id: string;
  teacherId: string;
  studentId: string;
  status: LinkStatus;
  createdVia: string;
  consentAt: string | null;
  removedAt: string | null;
  createdAt: string;
  teacherEmail: string | null;
  teacherName: string | null;
  studentEmail: string | null;
  studentName: string | null;
}

export type InviteState = "active" | "expired" | "exhausted" | "revoked";
export type InviteDirection = "teacher_to_student" | "student_to_teacher";

export interface NoteInvite {
  id: string;
  code: string;
  // Issuer of the code (named teacherId for compat; a student for reverse codes).
  teacherId: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  sentToEmail: string | null;
  direction: InviteDirection;
  revokedAt: string | null;
  createdAt: string;
  teacherEmail: string | null;
  teacherName: string | null;
  state: InviteState;
}

export type EntitlementSource = "trial" | "apple_iap" | "admin_grant" | "org";
export type EntitlementStatus = "active" | "grace" | "expired" | "revoked";

export interface NoteEntitlement {
  id: string;
  userId: string;
  source: string;
  status: string;
  startsAt: string;
  expiresAt: string | null;
  productId: string | null;
  appleOriginalTransactionId: string | null;
  environment: string | null;
  autoRenew: boolean;
  orgId: string | null;
  // The admin grant reason lives in the note column; grantor identity is in the audit trail.
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  userEmail: string | null;
  userName: string | null;
}

export interface MonetizationConfig {
  value: string | null;
  state: "beta_free" | "paid_after";
}

/** Server-side effective access resolution (mirrors NotesAccess in api/notes/entitlement.ts). */
export interface NotesAccess {
  status: "teacher_free" | "beta_free" | "trial" | "active" | "grace" | "lapsed";
  trialEndsAt?: string;
  lockedAfter?: string;
}

export type NoteJobStatus = "queued" | "processing" | "failed" | "ready_for_review";
/** Who held the phone during the lesson: 'teacher' = taught lesson, 'student' = solo self-recording. */
export type OwnerRole = "teacher" | "student";

export interface NoteJobMetrics {
  asr_secs?: number;
  llm_secs?: number;
  annotations?: number;
  grounded?: number;
  language?: string | null;
  audio_duration?: number | null;
  llm_model?: string;
  llm_in_tok?: number;
  llm_out_tok?: number;
  reqId?: string;
  [k: string]: unknown;
}

export interface NoteJobRow {
  id: string;
  status: string;
  stage: string | null;
  attempts: number;
  error: string | null;
  failureHints: string[];
  metrics: NoteJobMetrics;
  transcriptPath: string | null;
  modelOutputPath: string | null;
  // Worker-written cause of a failure; null on a healthy job or a pre-0016 row.
  failureCode: string | null;
  discardedAt: string | null;
  // Stamped at submit and on every requeue — the anchor for time-to-note.
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lessonSessionId: string;
  lessonStatus: string | null;
  teacherId: string | null;
  ownerRole: OwnerRole | null;
  pieceId: string | null;
  pieceLabel: string | null;
  // teacherEmail/teacherName kept for compat; ownerEmail/ownerName = recorder identity.
  teacherEmail: string | null;
  teacherName: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  reqId: string | null;
}

export interface NoteJobsResponse {
  items: NoteJobRow[];
  facets: {
    status: { value: string; count: number }[];
    ownerRole: { value: string; count: number }[];
    failureCode: { value: string; count: number }[];
  };
}

export interface NoteJobDetail {
  // Whether the RECORDER's own Retry is still available — the admin requeue is uncapped
  // and says nothing about what the person who reported the failure can do.
  retry: { allowed: boolean; reason: string | null; attempts: number; cap: number };
  job: {
    id: string;
    lessonSessionId: string;
    status: string;
    stage: string | null;
    error: string | null;
    failureHints: string[];
    attempts: number;
    transcriptPath: string | null;
    modelOutputPath: string | null;
    failureCode: string | null;
    discardedAt: string | null;
    metrics: NoteJobMetrics;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  lesson: {
    id: string;
    status: string;
    teacherId: string;
    teacher: { id: string; email: string | null; displayName: string | null } | null;
    ownerRole: OwnerRole;
    // Recorder identity (alias of teacher — lesson.teacherId is the owner, solo included).
    owner: { id: string; email: string | null; displayName: string | null } | null;
    studentId: string | null;
    student: { id: string; email: string | null; displayName: string | null } | null;
    pieceId: string | null;
    pieceLabel: string | null;
    durationSec: number | null;
    language: string | null;
    createdAt: string;
  } | null;
  notes: { id: string; status: string; studentId: string | null }[];
}

export interface NoteTranscript {
  text?: string;
  utterances?: { speaker?: string; text?: string; start?: number; end?: number }[];
  language?: string | null;
  audio_duration?: number | null;
  [k: string]: unknown;
}

export interface NoteTranscriptResponse {
  jobId: string;
  transcriptPath: string;
  transcript: NoteTranscript;
}

// One LLM call and its verdict. `text` is the model's raw output, `error` the validator
// message that rejected it (null when a content gate, not the parser, did the rejecting).
export interface ModelOutputAttempt {
  n: number;
  model?: string;
  in_tok?: number;
  out_tok?: number;
  error?: string | null;
  text?: string;
}

export interface ModelOutputDrop {
  index: number;
  reason: string;
  instruction?: string | null;
  quote?: string | null;
  category?: string | null;
}

export interface NoteModelOutput {
  job_id?: string;
  created_at?: string;
  outcome?: string;
  stage?: string;
  piece?: string | null;
  measure_count?: number | null;
  attempts?: ModelOutputAttempt[];
  parsed?: unknown;
  evidence?: { drops?: ModelOutputDrop[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface NoteModelOutputResponse {
  jobId: string;
  modelOutputPath: string;
  modelOutput: NoteModelOutput;
}

export interface NotesActivity {
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    // Not in the server payload yet — renders in the sheet header once the API sends it.
    organization?: string | null;
    isTeacher: boolean;
    isStudent: boolean;
    isAdmin: boolean;
    status: string;
  };
  links: {
    asTeacher: {
      id: string;
      studentId: string;
      status: string;
      createdVia: string;
      createdAt: string;
      studentEmail: string | null;
      studentName: string | null;
    }[];
    asStudent: {
      id: string;
      teacherId: string;
      status: string;
      createdVia: string;
      createdAt: string;
      teacherEmail: string | null;
      teacherName: string | null;
    }[];
  };
  invitesIssued: {
    id: string;
    code: string;
    expiresAt: string;
    maxUses: number;
    usedCount: number;
    revokedAt: string | null;
    createdAt: string;
    state: InviteState;
  }[];
  lessons: {
    count: number;
    recordedAsTeacher: number;
    recordedAsSelf: number;
    recentPieceLabels: string[];
  };
  // sent/received are unsplit totals (self notes count in both, since a self note
  // has teacherId = studentId = owner); the annotations disambiguate.
  notes: { sent: number; received: number; sentAsTeacher: number; selfNotes: number };
  access: NotesAccess;
}

function notesQs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// Pairings — links
export function listNoteLinks(q: string, status: string): Promise<{ items: NoteLink[] }> {
  return api(`/admin/notes/links${notesQs({ q, status })}`);
}
export function createNoteLink(teacherId: string, studentId: string): Promise<{ link: NoteLink }> {
  return api("/admin/notes/links", { method: "POST", body: JSON.stringify({ teacherId, studentId }) });
}
export function removeNoteLink(id: string): Promise<{ ok: boolean; link: NoteLink }> {
  return api(`/admin/notes/links/${id}`, { method: "DELETE" });
}

// Pairings — invites
export function listNoteInvites(q: string, state: string): Promise<{ items: NoteInvite[] }> {
  return api(`/admin/notes/invites${notesQs({ q, state })}`);
}
export function revokeNoteInvite(id: string): Promise<{ ok: boolean; invite: NoteInvite }> {
  return api(`/admin/notes/invites/${id}/revoke`, { method: "POST" });
}

// Pairings — teacher-trust watch. Read-only in B1.5: outreach is a human emailing
// manually, so no mutation fetchers exist for this surface.
export interface TrustWatchItem {
  userId: string;
  email: string | null;
  displayName: string | null;
  organization: string | null;
  createdAt: string;
  lessons28d: number;
  highVolume: boolean;
}
export interface TrustWatchResponse {
  items: TrustWatchItem[];
  windowDays: number;
}
export function getTrustWatch(): Promise<TrustWatchResponse> {
  return api("/admin/notes/trust/watch");
}

// Subscriptions — entitlements
export function listEntitlements(q: string, source: string, status: string): Promise<{ items: NoteEntitlement[] }> {
  return api(`/admin/notes/entitlements${notesQs({ q, source, status })}`);
}
export function grantEntitlement(input: { userId: string; days: number; reason: string }): Promise<NoteEntitlement> {
  return api("/admin/notes/entitlements/grant", { method: "POST", body: JSON.stringify(input) });
}
export function revokeEntitlement(id: string, reason: string): Promise<NoteEntitlement> {
  return api(`/admin/notes/entitlements/${id}/revoke`, { method: "POST", body: JSON.stringify({ reason }) });
}

// Subscriptions — monetization config
export function getMonetization(): Promise<MonetizationConfig> {
  return api("/admin/notes/config/monetization");
}
export function putMonetization(value: string | null): Promise<MonetizationConfig> {
  return api("/admin/notes/config/monetization", { method: "PUT", body: JSON.stringify({ value }) });
}

// Note-jobs (Ops lane)
export function listNoteJobs(params: { status?: string; stage?: string; ownerRole?: string; failureCode?: string; q?: string }): Promise<NoteJobsResponse> {
  return api(`/admin/note-jobs${notesQs(params)}`);
}
export function getNoteJob(id: string): Promise<NoteJobDetail> {
  return api(`/admin/note-jobs/${id}`);
}
export function requeueNoteJob(id: string): Promise<{ job: NoteJobDetail["job"] }> {
  return api(`/admin/note-jobs/${id}/requeue`, { method: "POST" });
}
export function getNoteTranscript(id: string, reason: string): Promise<NoteTranscriptResponse> {
  return api(`/admin/note-jobs/${id}/transcript?reason=${encodeURIComponent(reason)}`);
}
export function getNoteModelOutput(id: string, reason: string): Promise<NoteModelOutputResponse> {
  return api(`/admin/note-jobs/${id}/model-output?reason=${encodeURIComponent(reason)}`);
}

// User activity aggregate
export function getNotesActivity(userId: string): Promise<NotesActivity> {
  return api(`/admin/users/${userId}/notes-activity`);
}
