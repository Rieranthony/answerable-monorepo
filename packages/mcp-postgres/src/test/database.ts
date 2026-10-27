import { mcpPostgresTestConfig, testDatabase } from "../testing"

/** This package's disposable test database, `answerable_mcp_postgres_test` (`MCP_POSTGRES_TEST_DATABASE_URL`). */
export const database = testDatabase("answerable_mcp_postgres_test", mcpPostgresTestConfig.read(process.env).MCP_POSTGRES_TEST_DATABASE_URL)
