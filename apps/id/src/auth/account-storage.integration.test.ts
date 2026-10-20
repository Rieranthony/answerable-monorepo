import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createAuth } from "../auth.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { assertDisposableTestDatabase } from "../__tests__/test-database.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { accounts, users } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";

let connection: DatabaseConnection;
const userId = createId();
beforeAll(async () => {
  assertDisposableTestDatabase("account storage adapter proof");
  connection = createDatabase(testEnvironment());
  await connection.db.insert(users).values({
    id: userId,
    name: "Storage proof",
    email: `${userId}@example.com`,
    status: "active",
  });
});
afterAll(async () => {
  await connection.db.delete(users).where(eq(users.id, userId));
  await connection.close();
});

test("an upstream refresh token is never stored, on create or update", async () => {
  const { adapter } = await createAuth(connection.db, testEnvironment())
    .$context;
  const row = await adapter.create({
    model: "account",
    data: {
      userId,
      providerId: "storage-proof",
      issuer: "https://storage.example.com",
      accountId: createId(),
      refreshToken: "upstream-refresh-proof",
    },
  });
  const stored = async () =>
    (
      await connection.db.select().from(accounts).where(eq(accounts.id, row.id))
    )[0]!.refreshToken;
  expect(await stored()).toBeNull();
  await adapter.update({
    model: "account",
    where: [{ field: "id", value: row.id }],
    update: { refreshToken: "updated-refresh-proof" },
  });
  expect(await stored()).toBeNull();
});
