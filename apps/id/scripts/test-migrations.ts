import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { bootstrap, systemActor } from "../src/bootstrap.ts";
import { createDatabase } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import {
  buildCatalogue,
  generatedStatements,
  readCatalogue,
} from "../src/__tests__/migration-catalogue.ts";
import { testEnvironment } from "../src/__tests__/support.ts";
import {
  assertDisposableTestDatabase,
  testDatabaseUrl,
} from "../src/__tests__/test-database.ts";

// Destructive only to the explicitly disposable test database. Run before other DB suites.
assertDisposableTestDatabase("rehearse migration installation");
const control = new Pool({ connectionString: testDatabaseUrl, max: 1 });
const connection = createDatabase(testEnvironment());
const expectedReceipts = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
}).map(({ hash, folderMillis }) => ({
  hash,
  created_at: String(folderMillis),
}));
async function receipts() {
  return (
    await control.query(
      "select hash, created_at from drizzle.__drizzle_migrations order by id",
    )
  ).rows;
}
async function realRows() {
  return (
    await control.query(
      "select (select jsonb_agg(b) from system_bindings b) as bindings, (select jsonb_agg(a order by id) from audit_events a) as audit",
    )
  ).rows;
}
async function reset() {
  await control.query("drop schema public cascade");
  await control.query("drop schema if exists drizzle cascade");
  await control.query("create schema public");
}
try {
  await reset();
  await runMigrations(connection.db);
  assert.deepEqual(await receipts(), expectedReceipts);
  assert.deepEqual(
    await readCatalogue(control),
    await buildCatalogue(control, await generatedStatements()),
  );
  console.log(
    "A fresh install applies every migration and equals the schema modules plus the invariants",
  );

  await bootstrap(connection.db, systemActor("first-start"), {
    platformOrganizationSlug: "answerable",
    platformOrganizationName: "Answerable",
    adminResourceIdentifier: "http://localhost:47300/api/admin",
  });
  const before = await realRows();
  await runMigrations(connection.db);
  assert.deepEqual(await receipts(), expectedReceipts);
  assert.deepEqual(await realRows(), before);
  console.log("A repeated run applies nothing and preserves real rows");

  // Leave a clean migrated test schema for the serial correctness suite.
  await reset();
  await runMigrations(connection.db);
  console.log(
    `Migration proof passed: ${expectedReceipts.length} committed migration(s)`,
  );
} finally {
  await connection.close();
  await control.end();
}
