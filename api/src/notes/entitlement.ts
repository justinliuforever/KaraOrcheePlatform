import { and, eq, inArray } from "drizzle-orm";
import type { Deps } from "../deps";
import { entitlements, platformConfig, type User } from "../db/schema";

export const TRIAL_DAYS = 30;

// What the app renders from — server is the source of truth, never local receipts.
// lockedAfter: student-side rule "old notes stay readable, new notes lock" — a sent
// note is locked iff status === "lapsed" AND sentAt > lockedAfter.
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

// Trial expiry = max(trial_started_at, monetization_live_at) + 30d, so beta
// testers get a fresh clock the day the paywall goes live. monetization_live_at
// unset = paywall not launched = everything free.
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

// Same rule, one round trip for a whole roster. The per-student call issued a
// platform_config read AND an entitlements read each, which is what made a
// 40-student roster ~90 queries.
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
