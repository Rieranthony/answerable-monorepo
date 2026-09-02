import { Pool } from "pg";

import {
  assertDisposableTestDatabase,
  testDatabaseUrl,
} from "../src/__tests__/test-database.ts";

assertDisposableTestDatabase("reset");

const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });

try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
} finally {
  await pool.end();
}
