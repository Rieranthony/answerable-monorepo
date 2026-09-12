import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  assertDisposableTestDatabase,
  testDatabaseUrl,
} from "../__tests__/test-database.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase } from "./client.ts";

test("ordinary migration provisions the configured runtime role on the disposable database", async () => {
  assertDisposableTestDatabase(
    "test runtime permission provisioning",
    testDatabaseUrl,
  );
  const connection = createDatabase(testEnvironment());
  const role = `id_test_migrate_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    const child = Bun.spawn([process.execPath, "scripts/migrate.ts"], {
      cwd: import.meta.dir + "/../..",
      env: {
        ...process.env,
        DATABASE_MIGRATION_URL: testDatabaseUrl,
        DATABASE_RUNTIME_ROLE: role,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, diagnostics] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, diagnostics }).toEqual({ code: 0, diagnostics: "" });
    expect(output).toContain("Migrated database answerable_id_test");
    const permissions = await connection.db.execute(sql`
      select has_table_privilege(${role}, 'audit_events', 'INSERT') as can_audit,
        has_table_privilege(${role}, 'audit_events', 'UPDATE,DELETE,TRUNCATE') as can_change_history,
        has_schema_privilege(${role}, 'public', 'CREATE') as can_change_schema
    `);
    expect(permissions.rows).toEqual([
      { can_audit: true, can_change_history: false, can_change_schema: false },
    ]);
  } finally {
    try {
      await connection.db.execute(sql`drop owned by ${sql.identifier(role)}`);
      await connection.db.execute(sql`drop role ${sql.identifier(role)}`);
    } finally {
      await connection.close();
    }
  }
});
