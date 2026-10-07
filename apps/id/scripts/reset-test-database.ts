import { testEnvironment } from "../src/__tests__/support.ts";
import {
  assertDisposableTestDatabase,
  resetPublicSchema,
  testDatabaseUrl,
} from "../src/__tests__/test-database.ts";
import { createDatabase } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";

// Destructive only to the explicitly disposable test database.
assertDisposableTestDatabase("reset");
const connection = createDatabase(testEnvironment());

try {
  await resetPublicSchema(connection.pool);
  await runMigrations(connection.db);
} finally {
  await connection.close();
}

console.log(
  `Reset and migrated database ${new URL(testDatabaseUrl).pathname.slice(1)}`,
);
