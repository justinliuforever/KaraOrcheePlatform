import { loadConfig } from "./config";
import { createPool, createDb } from "./db/client";
import { createBlobCatalogStore, createBlobStudioStore } from "./storage";
import { createBlobLessonStore } from "./notes/lessons_store";
import { createBlobNotesAssetsStore } from "./notes/assets_store";
import { createBlobScanStore } from "./notes/scans_store";
import { createServiceBusQueue, createServiceBusNotesQueue } from "./queue";
import { NARRATION_QUEUE } from "./notes/narration";
import { verifierFromConfig } from "./auth";
import { createServer } from "./server";
import { createLogAnalyticsOpsStore } from "./opslogs";
import { createServiceBusOpsStore } from "./opsqueue";
import { createApnsSender } from "./notes/push";

function main(): void {
  const config = loadConfig();

  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);

  const catalog = config.storage
    ? createBlobCatalogStore(config.storage.connectionString)
    : undefined;
  const studio = config.storage
    ? createBlobStudioStore(config.storage.connectionString)
    : undefined;
  const piecesQueue = config.serviceBus
    ? createServiceBusQueue(config.serviceBus.connectionString, "pieces-jobs", "pieces-preflight")
    : undefined;
  const notesQueue = config.serviceBus
    ? createServiceBusNotesQueue(config.serviceBus.connectionString, "notes-jobs", NARRATION_QUEUE)
    : undefined;
  const lessons = config.storage
    ? createBlobLessonStore(config.storage.connectionString)
    : undefined;
  const notesAssets = config.storage
    ? createBlobNotesAssetsStore(config.storage.connectionString)
    : undefined;
  const scans = config.storage
    ? createBlobScanStore(config.storage.connectionString)
    : undefined;
  const auth = config.auth ? verifierFromConfig(config.auth) : undefined;
  const push = config.apns ? createApnsSender(config.apns) : undefined;
  const opsLogs = config.logAnalyticsWorkspaceId
    ? createLogAnalyticsOpsStore(config.logAnalyticsWorkspaceId)
    : undefined;
  const opsQueue = config.serviceBus
    ? createServiceBusOpsStore(config.serviceBus.connectionString, [
        "pieces-jobs",
        "pieces-preflight",
        "notes-jobs",
        NARRATION_QUEUE,
      ])
    : undefined;

  const app = createServer({
    db,
    catalog,
    studio,
    piecesQueue,
    notesQueue,
    lessons,
    notesAssets,
    scans,
    push,
    auth,
    corsOrigins: config.adminOrigins,
    opsLogs,
    opsQueue,
    appSupportsRepeats: config.appSupportsRepeats,
  });

  app.listen(config.port, () => {
    console.log(`api listening on :${config.port}`);
  });

  const shutdown = () => {
    pool.end().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
