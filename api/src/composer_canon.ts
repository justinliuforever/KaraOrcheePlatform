import type { Orm } from "./db/client";
import { composers } from "./db/schema";

/// Registry-canonical spelling for a composer string, resolved at WRITE time so alias
/// variants never enter pieces/works rows. Exact canonical name wins over any alias;
/// unregistered strings pass through untouched — the registry normalizes, it never gates.
export async function canonicalComposer(db: Orm, name: string): Promise<string> {
  const rows = await db
    .select({ name: composers.name, aliases: composers.aliases })
    .from(composers);
  for (const r of rows) if (r.name === name) return name;
  for (const r of rows) if ((r.aliases as string[]).includes(name)) return r.name;
  return name;
}
