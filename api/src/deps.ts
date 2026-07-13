import type { RequestHandler } from "express";
import type { Db } from "./db/client";
import type { CatalogStore, StudioStore } from "./storage";
import type { AuthVerifier } from "./auth";
import type { JobQueue } from "./queue";
import type { OpsLogsStore } from "./opslogs";
import type { OpsQueueStore } from "./opsqueue";

export interface Deps {
  db?: Db;
  catalog?: CatalogStore;
  studio?: StudioStore;
  piecesQueue?: JobQueue;
  auth?: AuthVerifier;
  corsOrigins?: string[];
  opsLogs?: OpsLogsStore;
  opsQueue?: OpsQueueStore;
  appSupportsRepeats?: boolean;
}

type AsyncHandler = (
  ...args: Parameters<RequestHandler>
) => Promise<unknown> | unknown;

// Forwards async rejections to the error handler on both Express 4 and 5.
export function wrap(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
