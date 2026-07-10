import { and, eq, inArray, min } from "drizzle-orm";
import type { Orm } from "./db/client";
import type { StudioStore } from "./storage";
import { books, pieces, pieceVersions, works } from "./db/schema";

export interface BundleFile {
  role: string;
  variant?: string;
  path: string;
  bytes?: number;
  sha256?: string;
}

// SQL is the catalog truth; catalog.json is a build artifact regenerated here at every
// publish. The emit shape is a VERSIONED PUBLIC API — the fielded app decodes it
// tolerantly (unknown fields ignored), so every change here must be additive.
// pieces[] stays FLAT (never nested under works); works[]/books[] are sibling indexes.
//
// Concurrency: two overlapping rebuilds are last-writer-wins on the blob, and the
// last writer may carry the OLDER DB snapshot (e.g. resurrecting a takedown). The
// ETag read happens BEFORE the DB snapshot, so a conditional write that fails means
// someone else wrote in between — retry with a fresh snapshot; convergence is to the
// newest state.
export async function rebuildCatalog(db: Orm, studio: StudioStore): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const etag = studio.getBundleEtag ? await studio.getBundleEtag("catalog.json") : undefined;
    const catalog = await buildCatalogDoc(db, studio);
    try {
      await studio.putBundleJson(
        "catalog.json",
        catalog,
        etag === undefined ? undefined : etag ? { ifMatch: etag } : { ifNoneMatch: "*" },
      );
      return catalog;
    } catch (err) {
      if ((err as Error).name === "EtagConflictError" && attempt < 3) continue;
      throw err;
    }
  }
}

async function buildCatalogDoc(db: Orm, studio: StudioStore): Promise<unknown> {
  const published = await db
    .select()
    .from(pieces)
    .where(eq(pieces.status, "published"))
    .orderBy(pieces.id);

  const workIds = new Set<string>();
  const bookIds = new Set<string>();
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
    const [firstPub] = await db
      .select({ first: min(pieceVersions.publishedAt) })
      .from(pieceVersions)
      .where(eq(pieceVersions.pieceId, p.id));

    const files = (v.files as BundleFile[]).map((f) => ({
      role: f.role,
      ...(f.variant ? { variant: f.variant } : {}),
      url: studio.bundleUrl(f.path),
      bytes: f.bytes,
      sha256: f.sha256,
    }));

    if (p.workId) workIds.add(p.workId);
    if (p.bookId) bookIds.add(p.bookId);

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
      ...(p.workId ? { work_id: p.workId, work_index: p.workIndex } : {}),
      ...(p.instrumentation ? { instrumentation: p.instrumentation } : {}),
      ...(p.facts && Object.keys(p.facts as object).length > 0 ? { facts: p.facts } : {}),
      ...(Array.isArray(p.tags) && (p.tags as unknown[]).length > 0 ? { tags: p.tags } : {}),
      ...(p.display && Object.keys(p.display as object).length > 0 ? { display: p.display } : {}),
      ...(p.thumbnailPath ? { thumbnail_url: studio.bundleUrl(p.thumbnailPath) } : {}),
      ...(firstPub?.first ? { first_published_at: firstPub.first.toISOString() } : {}),
    });
  }

  // works[]: only works referenced by published pieces, plus their parent chain.
  let workRows: (typeof works.$inferSelect)[] = [];
  if (workIds.size > 0) {
    workRows = await db.select().from(works).where(inArray(works.id, [...workIds]));
    const parents = workRows.map((w) => w.parentWorkId).filter((x): x is string => !!x && !workIds.has(x));
    if (parents.length > 0) {
      workRows = workRows.concat(await db.select().from(works).where(inArray(works.id, parents)));
    }
    // Denormalized work_title per piece: zero-join list rendering + missing-entry fallback.
    const titleById = new Map(workRows.map((w) => [w.id, w.title]));
    for (const e of entries as Record<string, unknown>[]) {
      if (e.work_id && titleById.has(e.work_id as string)) {
        e.work_title = titleById.get(e.work_id as string);
      }
    }
  }

  let bookRows: (typeof books.$inferSelect)[] = [];
  if (bookIds.size > 0) {
    bookRows = await db.select().from(books).where(inArray(books.id, [...bookIds]));
  }

  const catalog = {
    catalog_version: 1,
    generated_at: new Date().toISOString(),
    pieces: entries,
    works: workRows.map((w) => ({
      id: w.id,
      title: w.title,
      composer: w.composer,
      catalogue: w.catalogue,
      work_type: w.workType,
      parent_work_id: w.parentWorkId,
      sort_index: w.sortIndex,
      ...(w.display && Object.keys(w.display as object).length > 0 ? { display: w.display } : {}),
    })),
    books: bookRows.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      sort_index: b.sortIndex,
      ...(b.coverPath ? { cover_url: studio.bundleUrl(b.coverPath) } : {}),
      ...(b.display && Object.keys(b.display as object).length > 0 ? { display: b.display } : {}),
    })),
  };
  return catalog;
}
