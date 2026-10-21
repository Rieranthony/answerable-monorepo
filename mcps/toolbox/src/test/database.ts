import { testDatabase } from "@answerable/mcp-postgres/testing"
import { migrate, runtimeGrants } from "../db/migrate"

/** The Toolbox's disposable test database, `answerable_toolbox_test` (`TOOLBOX_TEST_DATABASE_URL`). */
export const database = testDatabase("answerable_toolbox_test", process.env.TOOLBOX_TEST_DATABASE_URL)

/**
 * The test database as the Toolbox serves it: migrated by the owner, then a fresh login provisioned with the Toolbox's runtime grants, so that
 * every test that serves through it proves the grants are enough. Its `db`, its `url`, and `drop()` for after the file's tests.
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
