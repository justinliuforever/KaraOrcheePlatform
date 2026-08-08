import { and, eq, inArray } from "drizzle-orm";
import type { Deps } from "../deps";
import { entitlements, platformConfig, type User } from "../db/schema";

export const TRIAL_DAYS = 30;

// Source of truth for iOS Notes access — clients must call this, never derive access from local App Store receipts.
export interface NotesAccess {
  status: "teacher_free" | "beta_free" | "trial" | "active" | "grace" | "lapsed";
  trialEndsAt?: string;
  lockedAfter?: string;
}

async function monetizationLiveAt(deps: Deps): Promise<Date | null> {
  const [live] = await deps
    .db!.orm.select()
    .from(platformConfig)
    .where(eq(platformConfig.key, "monetization_live_at"))
    .limit(1);
  const raw = live?.value;
  const at = typeof raw === "string" ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime()) || at > new Date()) return null;
  return at;
}

// Trial anchors to max(trialStartedAt, monetization_live_at) — do not simplify to trialStartedAt alone, or beta testers lose their fresh clock at launch.
export async function notesAccess(deps: Deps, user: User): Promise<NotesAccess> {
  if (user.isTeacher) return { status: "teacher_free" };

  const db = deps.db!.orm;
  const liveAt = await monetizationLiveAt(deps);
  if (!liveAt) return { status: "beta_free" };

  const rows = await db
    .select()
    .from(entitlements)
    .where(and(eq(entitlements.userId, user.id), inArray(entitlements.status, ["active", "grace"])));
  return resolveAccess(user, liveAt, rows);
}

// Batches platform_config + entitlements into one query each — do not call notesAccess per student in a loop (N+1 reads).
export async function notesAccessMany(deps: Deps, people: User[]): Promise<Map<string, NotesAccess>> {
  const out = new Map<string, NotesAccess>();
  const students: User[] = [];
  for (const u of people) {
    if (u.isTeacher) out.set(u.id, { status: "teacher_free" });
    else students.push(u);
  }
  if (!students.length) return out;

  const liveAt = await monetizationLiveAt(deps);
  if (!liveAt) {
    for (const u of students) out.set(u.id, { status: "beta_free" });
    return out;
  }
  const rows = await deps
    .db!.orm.select()
    .from(entitlements)
    .where(and(
      inArray(entitlements.userId, students.map((u) => u.id)),
      inArray(entitlements.status, ["active", "grace"]),
    ));
  const byUser = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push(r);
    byUser.set(r.userId, list);
  }
  for (const u of students) out.set(u.id, resolveAccess(u, liveAt, byUser.get(u.id) ?? []));
  return out;
}

function resolveAccess(
  user: User,
  liveAt: Date,
  rows: (typeof entitlements.$inferSelect)[],
): NotesAccess {
  const now = new Date();
  const current = rows.filter((r) => !r.expiresAt || r.expiresAt > now);
  if (current.some((r) => r.status === "active")) return { status: "active" };
  if (current.some((r) => r.status === "grace")) return { status: "grace" };

  const anchor = new Date(
    Math.max(user.trialStartedAt?.getTime() ?? now.getTime(), liveAt.getTime()),
  );
  const trialEnd = new Date(anchor.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  if (now < trialEnd) {
    return { status: "trial", trialEndsAt: trialEnd.toISOString() };
  }

  // Lapsed: the lock boundary is the latest moment the user still had access.
  const lastExpiry = rows
    .map((r) => r.expiresAt?.getTime() ?? 0)
    .reduce((a, b) => Math.max(a, b), trialEnd.getTime());
  return { status: "lapsed", lockedAfter: new Date(lastExpiry).toISOString() };
}

export function noteIsLocked(access: NotesAccess, sentAt: Date | null): boolean {
  if (access.status !== "lapsed") return false;
  if (!sentAt) return false;
  return !access.lockedAfter || sentAt > new Date(access.lockedAfter);
}
