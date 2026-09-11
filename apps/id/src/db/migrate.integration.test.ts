import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { testEnvironment } from "../__tests__/support.ts";
import { assertDisposableTestDatabase } from "../__tests__/test-database.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { migrationCatalog } from "../__tests__/migration-catalog.ts";
import approvedCatalog from "../__tests__/migration-catalog.json";

let connection: DatabaseConnection;

beforeAll(() => {
  assertDisposableTestDatabase("migrate");
  connection = createDatabase(testEnvironment());
});

afterAll(async () => {
  await connection.close();
});

test("custom database objects match the reviewed catalogue", async () => {
  expect(await migrationCatalog(connection.db)).toEqual(approvedCatalog);
});

test("integration: migrations are idempotent", async () => {
  const before = await connection.db.execute<{ count: number }>(sql`
    select count(*)::integer as count from drizzle.__drizzle_migrations
  `);
  expect(before.rows[0]!.count).toBeGreaterThan(0);

  await runMigrations(connection.db);

  const after = await connection.db.execute<{ count: number }>(sql`
    select count(*)::integer as count from drizzle.__drizzle_migrations
  `);
  expect(after.rows[0]!.count).toBe(before.rows[0]!.count);

  const tables = await connection.db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `);
  expect(tables.rows.map((row) => row.table_name)).toEqual([
    "accounts",
    "admin_operation_results",
    "admin_operations",
    "audit_event_subjects",
    "audit_events",
    "entitlements",
    "grant_contexts",
    "group_members",
    "groups",
    "invitations",
    "jwks",
    "members",
    "oauth_access_tokens",
    "oauth_client_assertions",
    "oauth_client_resources",
    "oauth_clients",
    "oauth_consents",
    "oauth_refresh_tokens",
    "oauth_resources",
    "organization_capabilities",
    "organization_domains",
    "organizations",

    "sessions",
    "sso_providers",
    "system_bindings",
    "users",
    "verifications",
  ]);
});
