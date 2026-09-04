import { afterAll, beforeAll, expect, test } from "bun:test";

import { testEnvironment } from "./__tests__/support.ts";
import { createAuth } from "./auth.ts";
import { createDatabase, type DatabaseConnection } from "./db/client.ts";

let connection: DatabaseConnection;

beforeAll(() => {
  connection = createDatabase(testEnvironment());
});

afterAll(async () => {
  await connection.close();
});

test("never links an upstream identity to an existing user by email", async () => {
  const auth = createAuth(connection.db, testEnvironment());

  expect(auth.options.account?.accountLinking?.enabled).toBe(false);
  await auth.$context;
  // The behavioral login test belongs to the federation milestone.
});
