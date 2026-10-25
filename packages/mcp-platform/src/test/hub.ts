import { fileURLToPath } from "node:url"
import { migrate } from "@answerable/mcp-postgres"
import { mcpPostgresTestConfig, testDatabase } from "@answerable/mcp-postgres/testing"

/**
 * A server's own database for these tests, with the tables every server has (evidence and intents): `answerable_mcps_test_platform`, made beside
 * the shared MCP test database and migrated from `@answerable/mcp-postgres`'s own folder. Its `db`, and `drop()`.
 */
export async function hubDatabase() {
  const scratch = await testDatabase("answerable_mcps_test", mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL).scratch("platform")
  await migrate(scratch.db, { folder: fileURLToPath(new URL("../drizzle", import.meta.resolve("@answerable/mcp-postgres"))) })
  return scratch
}
