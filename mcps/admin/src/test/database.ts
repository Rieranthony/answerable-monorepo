import { runtimeGrants } from "@answerable/mcp-postgres"
import { defineConfig } from "@answerable/config"
import { testDatabase } from "@answerable/mcp-postgres/testing"
import { z } from "zod"
import { migrate } from "../db/migrate"

/** The variable the admin MCP's tests read: on its own, so that a process the tests start with `NODE_ENV=production` needs nothing else. */
export const adminTestDatabaseConfig = defineConfig("admin MCP test database", {
  ADMIN_TEST_DATABASE_URL: { schema: z.url(), fallback: "postgres://answerable:answerable@localhost:47432/answerable_admin_test", doc: "The disposable database the admin MCP's tests reset, named answerable_admin_test" },
})

/** The admin MCP's disposable test database, `answerable_admin_test` (`ADMIN_TEST_DATABASE_URL`). */
export const database = testDatabase("answerable_admin_test", adminTestDatabaseConfig.read(process.env).ADMIN_TEST_DATABASE_URL)

/**
 * The test database as the admin MCP serves it: migrated by the owner, then a fresh login provisioned with `@answerable/mcp-postgres`'s runtime
 * grants, so that every test that serves through it proves the grants are enough. Its `db`, its `url`, and `drop()` for after the file's tests.
 */
export async function serving() {
  const owner = database.connect()
  try {
    await migrate(owner)
  } finally {
    await owner.$client.end()
  }
  return database.runtimeLogin(runtimeGrants)
}
