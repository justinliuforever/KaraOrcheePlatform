import { Router, type Response } from "express";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { CatalogNotFoundError, type CatalogStore } from "../storage";

const CATALOG_TTL_MS = 60_000;

interface GatedPiece {
  instrumentation?: { solo?: string } | null;
  facts?: { structure?: { type?: string } } | null;
}

/// Browse and per-piece download must gate on the SAME rule — a build reaching one past the other misrenders the row.
export function missingCapability(piece: GatedPiece, caps: string): "instruments" | "repeats" | null {
  if (!caps.includes("instruments") && piece.instrumentation && piece.instrumentation.solo !== "piano") {
    return "instruments";
  }
  if (!caps.includes("repeats") && piece.facts?.structure?.type === "repeats") return "repeats";
  return null;
}

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
    for (const key of ["cover_url", "thumbnail_url", "row_icon_url", "portrait_url"]) {
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
      // Pieces filter first; works/books then trim ONCE against the survivors, or the view dangles a reference.
      const caps = String(req.query.caps ?? "");
      if (Array.isArray(copy.pieces)) {
        copy.pieces = copy.pieces.filter((p) => missingCapability(p as GatedPiece, caps) === null);
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
      // A cached catalog or a shared deep link reaches this endpoint without the browse filter ever running.
      const requires = missingCapability(piece as GatedPiece, String(req.query.caps ?? ""));
      if (requires) {
        res.status(403).json({ error: "capability_required", piece: req.params.id, requires });
        return;
      }
      const copy = structuredClone(piece);
      signUrls(copy, store);
      res.status(200).json(copy);
    }),
  );

  return router;
}
