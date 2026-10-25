import { defineConfig } from "@answerable/config"
import { runtimeGrants } from "@answerable/mcp-postgres"
import { testDatabase } from "@answerable/mcp-postgres/testing"
import { z } from "zod"
import { migrate } from "../db/migrate"

/** The variable the standalone server's tests read: on its own, so that a process the tests start with `NODE_ENV=production` needs nothing else. */
export const standaloneTestDatabaseConfig = defineConfig("standalone server test database", {
  STANDALONE_TEST_DATABASE_URL: {
    schema: z.url(), fallback: "postgres://answerable:answerable@localhost:47432/answerable_standalone_test", doc: "The disposable database the standalone server's tests reset, named answerable_standalone_test",
  },
})

/** The standalone server's disposable test database, `answerable_standalone_test` (`STANDALONE_TEST_DATABASE_URL`). */
export const database = testDatabase("answerable_standalone_test", standaloneTestDatabaseConfig.read(process.env).STANDALONE_TEST_DATABASE_URL)

/**
 * The test database as the standalone server serves it: migrated by the owner, then a fresh login provisioned with `@answerable/mcp-postgres`'s
 * runtime grants, so that every test that serves through it proves the grants are enough. Its `db`, its `url`, and `drop()`.
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
