import type { Orm } from "./db/client";
import { composers } from "./db/schema";

/// WRITE-time only; unregistered composer strings must pass through untouched — this normalizes, it never gates/rejects.
export async function canonicalComposer(db: Orm, name: string): Promise<string> {
  const rows = await db
    .select({ name: composers.name, aliases: composers.aliases })
    .from(composers)
    .orderBy(composers.name);
  for (const r of rows) if (r.name === name) return name;
  for (const r of rows) if ((r.aliases as string[]).includes(name)) return r.name;
  return name;
}
