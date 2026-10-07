import { configureRuntimeRole } from "../src/db/runtime-role.ts";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { runMigrations } from "../src/db/migrate.ts";
import * as schema from "../src/db/schema/index.ts";
import { z } from "zod";

const databaseUrl = z.url().parse(Bun.env.DATABASE_MIGRATION_URL);
// While DDL waits for a table lock, every later query on that table queues behind it, so a
// migration on a live database gives up after a few seconds rather than stall the service.
// The statement bound stops a runaway statement from holding its locks indefinitely.
const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  lock_timeout: 5_000,
  statement_timeout: 300_000,
});

try {
  const db = drizzle({ client: pool, schema });
  await runMigrations(db);
  await configureRuntimeRole(
    db,
    Bun.env.DATABASE_RUNTIME_ROLE ?? "answerable_id_runtime",
  );
} finally {
  await pool.end();
}

console.log(`Migrated database ${new URL(databaseUrl).pathname.slice(1)}`);
