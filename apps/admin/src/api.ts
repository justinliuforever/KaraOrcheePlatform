import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { msal, API_SCOPE } from "./auth";

export const API_BASE =
  import.meta.env.VITE_API_BASE ??
  "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io";

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
  email: string | null;
  displayName: string | null;
  isTeacher: boolean;
  isStudent: boolean;
  isAdmin: boolean;
  status: string;
  createdAt: string;
}

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
  files: { role: string; variant?: string; path: string; bytes?: number; sha256?: string }[];
  publishedAt: string;
}

export interface AdminPieceDetail extends Omit<AdminPiece, "bookTitle" | "versionCount" | "latestVersion"> {
  book: { id: string; title: string; rights: string } | null;
  versions: PieceVersionRow[];
}
