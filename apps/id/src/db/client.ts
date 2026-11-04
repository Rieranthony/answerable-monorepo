import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { Environment } from "../env.ts";
import { errorFields } from "../http/problem.ts";
import { logEvent } from "../lib/log.ts";
import * as schema from "./schema/index.ts";

export function createDatabase(
  environment: Pick<
    Environment,
    | "databaseUrl"
    | "databasePoolMax"
    | "databasePoolIdleTimeoutMs"
    | "databaseConnectionTimeoutMs"
    | "databaseStatementTimeoutMs"
    | "databaseLockTimeoutMs"
    | "databaseIdleInTransactionTimeoutMs"
    | "nodeEnv"
  >,
) {
  const pool = new Pool({
    connectionString: environment.databaseUrl,
    max: environment.databasePoolMax,
    idleTimeoutMillis: environment.databasePoolIdleTimeoutMs,
    connectionTimeoutMillis: environment.databaseConnectionTimeoutMs,
    statement_timeout: environment.databaseStatementTimeoutMs,
    lock_timeout: environment.databaseLockTimeoutMs,
    idle_in_transaction_session_timeout:
      environment.databaseIdleInTransactionTimeoutMs,
    allowExitOnIdle: environment.nodeEnv === "test",
  });
  // `pg` reports a lost connection as an `error` event, on the pool for an idle client as well
  // as on the client itself, and an event with no listener ends the process. A transaction on it
  // fails, and the next query takes a new connection. The client's listener does the logging:
  // every client emits `connect` before it can be idle. Never the error's message, which can
  // hold credentials.
  pool.on("error", () => {});
  pool.on("connect", (client) =>
    client.on("error", (error) =>
      logEvent("database", "database_connection_lost", errorFields(error)),
    ),
  );

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
