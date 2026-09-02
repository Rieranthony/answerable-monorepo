import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { Environment } from "../env.ts";
import * as schema from "./schema/index.ts";

export function createDatabase(environment: Environment) {
  const pool = new Pool({
    connectionString: environment.databaseUrl,
    max: environment.databasePoolMax,
    idleTimeoutMillis: environment.databasePoolIdleTimeoutMs,
    connectionTimeoutMillis: environment.databaseConnectionTimeoutMs,
    allowExitOnIdle: environment.nodeEnv === "test",
  });

  const db = drizzle({ client: pool, schema });

  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];
export type DatabaseConnection = ReturnType<typeof createDatabase>;
