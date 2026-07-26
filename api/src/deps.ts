import type { RequestHandler } from "express";
import type { Db } from "./db/client";
import type { CatalogStore, StudioStore } from "./storage";
import type { AuthVerifier } from "./auth";
import type { JobQueue, NotesQueue } from "./queue";
import type { OpsLogsStore } from "./opslogs";
import type { OpsQueueStore } from "./opsqueue";
import type { LessonStore } from "./notes/lessons_store";
import type { NotesAssetsStore } from "./notes/assets_store";
import type { PushSender } from "./notes/push";

export interface Deps {
  db?: Db;
  catalog?: CatalogStore;
  studio?: StudioStore;
  piecesQueue?: JobQueue;
  notesQueue?: NotesQueue;
  lessons?: LessonStore;
  notesAssets?: NotesAssetsStore;
  // Absent until the APNs key is configured: every send still completes, silently.
  push?: PushSender;
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
