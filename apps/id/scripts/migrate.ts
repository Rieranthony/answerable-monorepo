import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  assertDisposableTestDatabase,
  testDatabaseUrl,
} from "../src/__tests__/test-database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import * as schema from "../src/db/schema/index.ts";
import { loadEnvironment } from "../src/env.ts";

const isTest = process.argv.includes("--test");
if (isTest) assertDisposableTestDatabase("migrate");
const databaseUrl = isTest ? testDatabaseUrl : loadEnvironment().databaseUrl;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  await runMigrations(drizzle({ client: pool, schema }));
} finally {
  await pool.end();
}

console.log(`Migrated database ${new URL(databaseUrl).pathname.slice(1)}`);
