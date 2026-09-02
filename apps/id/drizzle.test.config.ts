import { defineConfig } from "drizzle-kit";

import {
  assertDisposableTestDatabase,
  testDatabaseUrl,
} from "./src/__tests__/test-database.ts";

assertDisposableTestDatabase("push schema to");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  dbCredentials: { url: testDatabaseUrl },
  strict: true,
  verbose: true,
});
