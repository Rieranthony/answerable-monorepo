import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { Environment } from "../env.ts";
import * as schema from "./schema/index.ts";

export function createDatabase(
  environment: Pick<
    Environment,
    | "databaseUrl"
    | "databasePoolMax"
    | "databasePoolIdleTimeoutMs"
    | "databaseConnectionTimeoutMs"
    | "nodeEnv"
  > &
    Partial<Pick<Environment, "databaseStatementTimeoutMs">>,
) {
  const pool = new Pool({
    connectionString: environment.databaseUrl,
    max: environment.databasePoolMax,
    idleTimeoutMillis: environment.databasePoolIdleTimeoutMs,
    connectionTimeoutMillis: environment.databaseConnectionTimeoutMs,
    statement_timeout: environment.databaseStatementTimeoutMs ?? 10_000,
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

/** A database or the handle supplied to a database transaction. */
export type Executor =
  Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
