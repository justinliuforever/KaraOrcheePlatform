import { loadConfig } from "./config";
import { createPool, createDb } from "./db/client";
import { createBlobCatalogStore } from "./storage";
import { verifierFromConfig } from "./auth";
import { createServer } from "./server";

function main(): void {
  const config = loadConfig();

  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);

  const catalog = config.storage
    ? createBlobCatalogStore(config.storage.connectionString)
    : undefined;
  const auth = config.auth ? verifierFromConfig(config.auth) : undefined;

  const app = createServer({ db, catalog, auth, corsOrigins: config.adminOrigins });

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
