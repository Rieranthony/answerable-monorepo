import { testDatabase } from "@answerable/mcp-postgres/testing"

/** The admin MCP's disposable test database, `answerable_admin_test` (`ADMIN_TEST_DATABASE_URL`). */
export const database = testDatabase("answerable_admin_test", process.env.ADMIN_TEST_DATABASE_URL)
