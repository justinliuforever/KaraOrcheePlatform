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
    wrap(async (_req, res) => {
      const store = deps.catalog;
      if (!store) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      const doc = await loadOr404(store, res);
      if (doc === null) return;
      // Interim: URLs stay signed for app builds ≤ b5ec4cf that download straight from the
      // catalog. Strip once the fleet is on /v1/pieces/:id/download; then add ETag caching.
      const copy = structuredClone(doc);
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
      const copy = structuredClone(piece);
      signUrls(copy, store);
      res.status(200).json(copy);
    }),
  );

  return router;
}
