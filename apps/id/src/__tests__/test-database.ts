export const testDatabaseName = "answerable_id_test";

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  `postgres://answerable:answerable@localhost:47432/${testDatabaseName}`;

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
