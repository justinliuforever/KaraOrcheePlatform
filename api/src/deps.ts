import type { RequestHandler } from "express";
import type { Db } from "./db/client";
import type { CatalogStore, StudioStore } from "./storage";
import type { AuthVerifier } from "./auth";
import type { JobQueue, NotesQueue } from "./queue";
import type { OpsLogsStore } from "./opslogs";
import type { OpsQueueStore } from "./opsqueue";
import type { LessonStore } from "./notes/lessons_store";
import type { NotesAssetsStore } from "./notes/assets_store";
import type { ScanStore } from "./notes/scans_store";
import type { PushSender } from "./notes/push";
import type { GraphIdentityClient } from "./graph";

export interface Deps {
  db?: Db;
  catalog?: CatalogStore;
  studio?: StudioStore;
  piecesQueue?: JobQueue;
  notesQueue?: NotesQueue;
  lessons?: LessonStore;
  notesAssets?: NotesAssetsStore;
  scans?: ScanStore;
  // Absent until the APNs key is configured: every send still completes, silently.
  push?: PushSender;
  // Injected by tests; production resolves it from the environment at the call site.
  graph?: GraphIdentityClient;
  auth?: AuthVerifier;
  corsOrigins?: string[];
  opsLogs?: OpsLogsStore;
  opsQueue?: OpsQueueStore;
  appSupportsRepeats?: boolean;
}

type AsyncHandler = (
  ...args: Parameters<RequestHandler>
) => Promise<unknown> | unknown;

export function wrap(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
