import { configureRuntimeRole, connect, runtimeGrants } from "@answerable/mcp-postgres"
import { sql } from "drizzle-orm"
import { migrate, runtimeRole } from "../src/db/migrate"
import { database } from "../src/test/database"

// bun scripts/test-migrate.ts (db:test:migrate) resets the admin MCP's test database, answerable_admin_test (ADMIN_TEST_DATABASE_URL), then
// migrates it and provisions the runtime role as scripts/migrate.ts does. Apart from it, so that the migration Job loads no test kit.
database.assertDisposable("reset")
const db = connect(database.url, { max: 1 })
try {
  await db.execute(sql.raw("drop schema public cascade; drop schema if exists drizzle cascade; create schema public"))
  await migrate(db)
  await configureRuntimeRole(db, runtimeRole, runtimeGrants)
  console.log(`Migrated ${new URL(database.url).pathname.slice(1)}; provisioned ${runtimeRole}`)
} finally {
  await db.$client.end()
}
