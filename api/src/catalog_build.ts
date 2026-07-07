import { and, eq } from "drizzle-orm";
import type { Orm } from "./db/client";
import type { StudioStore } from "./storage";
import { pieces, pieceVersions } from "./db/schema";

export interface BundleFile {
  role: string;
  variant?: string;
  path: string;
  bytes?: number;
  sha256?: string;
}

// SQL is the catalog truth; catalog.json is a build artifact regenerated here at
// every publish. Shape must stay byte-compatible with what the shipped app decodes
// (tier is the legacy field the app still reads; it mirrors tracking).
export async function rebuildCatalog(db: Orm, studio: StudioStore): Promise<unknown> {
  const published = await db
    .select()
    .from(pieces)
    .where(eq(pieces.status, "published"))
    .orderBy(pieces.id);

  const entries = [];
  for (const p of published) {
    if (p.publishedVersion == null) continue;
    const [v] = await db
      .select()
      .from(pieceVersions)
      .where(
        and(eq(pieceVersions.pieceId, p.id), eq(pieceVersions.version, p.publishedVersion)),
      )
      .limit(1);
    if (!v) continue;

    const files = (v.files as BundleFile[]).map((f) => ({
      role: f.role,
      ...(f.variant ? { variant: f.variant } : {}),
      url: studio.bundleUrl(f.path),
      bytes: f.bytes,
      sha256: f.sha256,
    }));

    entries.push({
      id: p.id,
      title: p.title,
      composer: p.composer,
      subtitle: p.subtitle,
      mode: p.mode,
      tier: p.tracking === "validated" ? "core" : "experimental",
      tracking: p.tracking,
      difficulty: p.difficulty,
      bundle_version: p.publishedVersion,
      engine_sha: v.engineSha,
      files,
      ...(p.bookId ? { book_id: p.bookId, book_index: p.bookIndex } : {}),
    });
  }

  const catalog = {
    catalog_version: 1,
    generated_at: new Date().toISOString(),
    pieces: entries,
  };
  await studio.putBundleJson("catalog.json", catalog);
  return catalog;
}
