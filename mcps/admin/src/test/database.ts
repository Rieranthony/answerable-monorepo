import { migrate, migrations, runtimeGrants } from "@answerable/mcp-postgres"
import { testDatabase } from "@answerable/mcp-postgres/testing"

/** The admin MCP's disposable test database, `answerable_admin_test` (`ADMIN_TEST_DATABASE_URL`). */
export const database = testDatabase("answerable_admin_test", process.env.ADMIN_TEST_DATABASE_URL)

/**
 * The test database as the admin MCP serves it: migrated by the owner, then a fresh login provisioned with `@answerable/mcp-postgres`'s runtime
 * grants, so that every test that serves through it proves the grants are enough. Its `db`, its `url`, and `drop()` for after the file's tests.
 */
export async function serving() {
  const owner = database.connect()
  try {
    await migrate(owner, [migrations])
  } finally {
    await owner.close()
  }
  return database.runtimeLogin(runtimeGrants)
}
