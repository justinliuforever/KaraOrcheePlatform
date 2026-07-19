import { Router, type Response } from "express";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { CatalogNotFoundError, type CatalogStore } from "../storage";

const CATALOG_TTL_MS = 60_000;

function signUrls(node: unknown, store: CatalogStore): void {
  if (Array.isArray(node)) {
    for (const item of node) signUrls(item, store);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of ["files", "stems"]) {
      const arr = obj[key];
      if (Array.isArray(arr)) {
        for (const entry of arr) {
          if (entry && typeof entry === "object") {
            const e = entry as Record<string, unknown>;
            if (typeof e.url === "string") e.url = store.signReadUrl(e.url);
          }
        }
      }
    }
    // Top-level string URLs (book covers, piece thumbnails, composer portraits) —
    // the container is private, an unsigned URL is a guaranteed 403 in the app.
    for (const key of ["cover_url", "thumbnail_url", "portrait_url"]) {
      if (typeof obj[key] === "string") obj[key] = store.signReadUrl(obj[key] as string);
    }
    for (const value of Object.values(obj)) signUrls(value, store);
  }
}

export function catalogRouter(deps: Deps): Router {
  const router = Router();
  let cache: { doc: unknown; fetchedAt: number } | null = null;

  // One blob read per TTL window, not per request (the endpoint is unauthenticated).
  async function catalogDoc(store: CatalogStore): Promise<unknown> {
    if (cache && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) return cache.doc;
    const doc = await store.readCatalog();
    cache = { doc, fetchedAt: Date.now() };
    return doc;
  }

  async function loadOr404(store: CatalogStore, res: Response): Promise<unknown | null> {
    try {
      return await catalogDoc(store);
    } catch (err) {
      if (err instanceof CatalogNotFoundError) {
        res.status(404).json({ error: "catalog_not_published" });
        return null;
      }
      throw err;
    }
  }

  router.get(
    "/v1/catalog",
    wrap(async (req, res) => {
      const store = deps.catalog;
      if (!store) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const doc = await loadOr404(store, res);
      if (doc === null) return;
      // Interim: URLs stay signed for app builds ≤ b5ec4cf that download straight from the
      // catalog. Strip once the fleet is on /v1/pieces/:id/download; then add ETag caching.
      const copy = structuredClone(doc) as {
        pieces?: {
          instrumentation?: { solo?: string };
          facts?: { structure?: { type?: string } };
          work_id?: string;
          book_id?: string;
        }[];
        works?: { id: string; parent_work_id?: string | null }[];
        books?: { id: string }[];
      };
      // CAPABILITY GATE: fielded decoders ignore unknown fields — an old app shown a
      // violin row would run the piano follower against guitar/violin audio, and one
      // shown a repeat piece would follow the written measure order instead of the
      // played one. The only lever over shipped builds is not sending rows they'd
      // misrender; capable builds opt in explicitly. All piece filters apply first,
      // then works/books trim ONCE against the combined survivors so the default view
      // never lists an empty shelf or dangles a reference.
      const caps = String(req.query.caps ?? "");
      const pieceFilters: ((p: NonNullable<typeof copy.pieces>[number]) => boolean)[] = [];
      if (!caps.includes("instruments")) {
        pieceFilters.push((p) => !p.instrumentation || p.instrumentation.solo === "piano");
      }
      if (!caps.includes("repeats")) {
        pieceFilters.push((p) => p.facts?.structure?.type !== "repeats");
      }
      if (pieceFilters.length > 0 && Array.isArray(copy.pieces)) {
        copy.pieces = copy.pieces.filter((p) => pieceFilters.every((keep) => keep(p)));
        if (Array.isArray(copy.works)) {
          const referenced = new Set(copy.pieces.map((p) => p.work_id).filter(Boolean));
          // Keep parent chains: the emitter includes parents deliberately.
          const byId = new Map(copy.works.map((w) => [w.id, w]));
          for (const id of [...referenced]) {
            let cur = byId.get(id as string);
            while (cur?.parent_work_id && !referenced.has(cur.parent_work_id)) {
              referenced.add(cur.parent_work_id);
              cur = byId.get(cur.parent_work_id);
            }
          }
          copy.works = copy.works.filter((w) => referenced.has(w.id));
        }
        if (Array.isArray(copy.books)) {
          const usedBooks = new Set(copy.pieces.map((p) => p.book_id).filter(Boolean));
          copy.books = copy.books.filter((b) => usedBooks.has(b.id));
        }
      }
      signUrls(copy, store);
      res.status(200).json(copy);
    }),
  );

  // Per-piece download manifest: SAS minted on tap, not on browse.
  router.get(
    "/v1/pieces/:id/download",
    wrap(async (req, res) => {
      const store = deps.catalog;
      if (!store) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const doc = await loadOr404(store, res);
      if (doc === null) return;
      const pieces = (doc as { pieces?: unknown[] }).pieces ?? [];
      const piece = pieces.find((p) => (p as { id?: unknown }).id === req.params.id);
      if (!piece) {
        res.status(404).json({ error: "piece_not_found" });
        return;
      }
      // Same repeats gate as the catalog list: an old build can still reach this
      // endpoint via a cached catalog or a shared deep link, so the browse-side
      // filter alone does not protect it.
      const structureType = (piece as { facts?: { structure?: { type?: string } } }).facts
        ?.structure?.type;
      if (structureType === "repeats" && !String(req.query.caps ?? "").includes("repeats")) {
        res.status(403).json({
          error: "capability_required",
          piece: req.params.id,
          requires: "repeats",
        });
        return;
      }
      const copy = structuredClone(piece);
      signUrls(copy, store);
      res.status(200).json(copy);
    }),
  );

  return router;
}
