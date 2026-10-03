import { testDatabase } from "@answerable/mcp-postgres/testing"

/** The Toolbox's disposable test database, `answerable_toolbox_test` (`TOOLBOX_TEST_DATABASE_URL`). */
export const database = testDatabase("answerable_toolbox_test", process.env.TOOLBOX_TEST_DATABASE_URL)
