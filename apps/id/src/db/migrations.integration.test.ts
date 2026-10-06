import { afterAll, expect, test } from "bun:test";

import {
  buildCatalogue,
  committedStatements,
  generatedStatements,
} from "../__tests__/migration-catalogue.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { assertDisposableTestDatabase } from "../__tests__/test-database.ts";
import { createDatabase } from "./client.ts";

const connection = createDatabase(testEnvironment());
afterAll(() => connection.close());

test("the committed migrations build what the schema modules generate plus the reviewed invariants", async () => {
  // Each build replaces the public schema inside a transaction that is rolled back.
  assertDisposableTestDatabase("rebuild the schema");
  expect(await buildCatalogue(connection.pool, committedStatements())).toEqual(
    await buildCatalogue(connection.pool, await generatedStatements()),
  );
});
