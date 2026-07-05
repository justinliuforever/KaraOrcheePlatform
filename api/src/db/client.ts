import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Orm = NodePgDatabase<typeof schema>;

export interface Db {
  orm: Orm;
  ping(): Promise<void>;
}

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
  });
}

export function createDb(pool: Pool): Db {
  const orm = drizzle(pool, { schema });
  return {
    orm,
    async ping() {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("db_ping_timeout")), 2000);
      });
      try {
        await Promise.race([pool.query("SELECT 1"), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
