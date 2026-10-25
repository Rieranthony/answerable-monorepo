import { defineConfig } from "@answerable/config";
import { z } from "zod";

const testDatabaseName = "answerable_id_test";

/** The variable the tests read: on its own, so that a process a test starts with `NODE_ENV=production` needs nothing else. */
export const idTestDatabaseConfig = defineConfig("ID test database", {
  TEST_DATABASE_URL: {
    schema: z.url(),
    fallback: `postgres://answerable:answerable@localhost:47432/${testDatabaseName}`,
    doc: "The disposable database ID's test suite resets, named answerable_id_test",
  },
});

export const testDatabaseUrl = idTestDatabaseConfig.read(
  process.env,
).TEST_DATABASE_URL;

/**
 * Every destructive test command calls this first. Data in the test database
 * is not recoverable after a run, so nothing else may be targeted.
 */
export function assertDisposableTestDatabase(
  action: string,
  url = testDatabaseUrl,
): void {
  const databaseName = new URL(url).pathname.slice(1);

  if (databaseName !== testDatabaseName) {
    throw new Error(
      `Refusing to ${action} ${databaseName || "an unnamed database"}; expected ${testDatabaseName}`,
    );
  }
}

/** Empty the public schema and forget every applied migration. Assert first. */
export async function resetPublicSchema(client: {
  query(text: string): Promise<unknown>;
}): Promise<void> {
  await client.query("drop schema public cascade");
  await client.query("drop schema if exists drizzle cascade");
  await client.query("create schema public");
}
