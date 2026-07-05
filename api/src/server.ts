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

export function createServer(deps: Deps = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.use(healthRouter(deps));
  app.use(catalogRouter(deps));
  app.use(usersRouter(deps));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
