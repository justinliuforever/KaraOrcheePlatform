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
  isTeacher: boolean;
  isStudent: boolean;
  isAdmin: boolean;
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

export type RolePatch = Partial<Pick<AdminUser, "isAdmin" | "isTeacher" | "isStudent">>;

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
  rights: string;
  rightsNote: string | null;
  sortIndex: number | null;
  status: string;
  display: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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

// Detail responses carry the member pieces instead of a pieceCount.
export interface AdminBookDetail extends Omit<AdminBook, "pieceCount"> {
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
  rights: Rights;
  rightsNote: string | null;
  sortIndex: number | null;
}>;

export type WorkEdit = Partial<{
  title: string;
  composer: string;
  catalogue: string | null;
  workType: WorkType;
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
