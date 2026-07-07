import { loadConfig } from "./config";
import { createPool, createDb } from "./db/client";
import { createBlobCatalogStore, createBlobStudioStore } from "./storage";
import { createServiceBusQueue } from "./queue";
import { verifierFromConfig } from "./auth";
import { createServer } from "./server";

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
    ? createServiceBusQueue(config.serviceBus.connectionString, "pieces-jobs")
    : undefined;
  const auth = config.auth ? verifierFromConfig(config.auth) : undefined;

  const app = createServer({
    db,
    catalog,
    studio,
    piecesQueue,
    auth,
    corsOrigins: config.adminOrigins,
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
