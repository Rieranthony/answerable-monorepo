import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  assertDisposableTestDatabase,
  testDatabaseUrl,
} from "../src/__tests__/test-database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import * as schema from "../src/db/schema/index.ts";
import { z } from "zod";

const isTest = process.argv.includes("--test");
if (isTest) assertDisposableTestDatabase("migrate");
const databaseUrl = isTest
  ? testDatabaseUrl
  : z.url().parse(Bun.env.DATABASE_MIGRATION_URL);
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  await runMigrations(drizzle({ client: pool, schema }));
} finally {
  await pool.end();
}

console.log(`Migrated database ${new URL(databaseUrl).pathname.slice(1)}`);
