import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Deps } from "./deps";
import { healthRouter } from "./routes/health";
import { catalogRouter } from "./routes/catalog";
import { usersRouter } from "./routes/users";
import { adminRouter } from "./routes/admin";
import { studioRouter } from "./routes/studio";
import { opsRouter } from "./routes/ops";
import { rateLimit } from "./ratelimit";
import { cors } from "./cors";
import { requestLog } from "./reqlog";
import compression from "compression";
import multer from "multer";

export function createServer(deps: Deps = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  // Exactly ONE trusted hop (Container Apps ingress). `true` would take the leftmost
  // X-Forwarded-For value — client-controlled — letting callers spoof req.ip and
  // rotate past the rate limiter.
  app.set("trust proxy", 1);
  app.use(requestLog());
  app.use(compression()); // catalog payloads gzip ~10x
  app.use(express.json());
  app.use(cors(deps.corsOrigins ?? []));
  app.use(rateLimit());

  app.use(healthRouter(deps));
  app.use(catalogRouter(deps));
  app.use(usersRouter(deps));
  app.use(studioRouter(deps));
  app.use(opsRouter(deps));
  app.use(adminRouter(deps));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      // Upload-shape errors are user mistakes, not server faults — say what to fix.
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "That file is too large (80 MB max for audio, 80 MB for scores) — export a smaller file and retry."
          : `Upload problem (${err.code}) — check you picked the right files and retry.`;
      res.status(400).json({ error: "upload_rejected", code: err.code, message });
      return;
    }
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
