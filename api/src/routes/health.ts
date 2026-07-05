import { Router } from "express";
import type { Deps } from "../deps";
import { wrap } from "../deps";

export function healthRouter(deps: Deps): Router {
  const router = Router();

  router.get(
    "/healthz",
    wrap(async (_req, res) => {
      let db: "ok" | "unconfigured" | "error" = "unconfigured";
      if (deps.db) {
        try {
          await deps.db.ping();
          db = "ok";
        } catch {
          db = "error";
        }
      }
      res.status(200).json({ ok: true, db });
    }),
  );

  return router;
}
