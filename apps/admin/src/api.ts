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
  constructor(public status: number, message: string) {
    super(message);
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
    throw new ApiError(res.status, body.error ?? `http_${res.status}`);
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

export interface AdminPieceDetail extends Omit<AdminPiece, "bookTitle" | "versionCount" | "latestVersion"> {
  book: (AdminBook & { coverUrl: string | null; coverThumbUrl: string | null }) | null;
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
  book?: { id: string; title?: string; index: number | null } | null;
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
  rights: string;
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
    throw new ApiError(res.status, body.message ?? body.error ?? `http_${res.status}`);
  }
  return res.json();
}
