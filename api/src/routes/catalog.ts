import { Router } from "express";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { CatalogNotFoundError, type CatalogStore } from "../storage";

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

  router.get(
    "/v1/catalog",
    wrap(async (_req, res) => {
      const store = deps.catalog;
      if (!store) {
        res.status(503).json({ error: "storage_not_configured" });
        return;
      }
      let doc: unknown;
      try {
        doc = await store.readCatalog();
      } catch (err) {
        if (err instanceof CatalogNotFoundError) {
          res.status(404).json({ error: "catalog_not_published" });
          return;
        }
        throw err;
      }
      signUrls(doc, store);
      res.status(200).json(doc);
    }),
  );

  return router;
}
