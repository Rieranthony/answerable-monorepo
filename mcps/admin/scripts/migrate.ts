import { configureRuntimeRole, connect, runtimeGrants } from "@answerable/mcp-postgres"
import { migrate, runtimeRole } from "../src/db/migrate"
import { adminMigrationConfig } from "./env"

// bun scripts/migrate.ts migrates ADMIN_DATABASE_MIGRATION_URL, the schema owner, then provisions answerable_admin_runtime, the restricted role
// the admin MCP serves as. scripts/test-migrate.ts resets and migrates the test database. The admin MCP has no tables of its own: only those of
// @answerable/mcp-postgres, intents and evidence, and their grants.
const { ADMIN_DATABASE_MIGRATION_URL: url } = adminMigrationConfig.read(Bun.env)
// While DDL waits for a table lock, every later query on that table queues behind it, so a migration on a live database gives up after a few
// seconds rather than stall the service. The statement bound stops a runaway statement from holding its locks indefinitely.
const db = connect(url, { max: 1, lock_timeout: 5_000, statement_timeout: 300_000 })
try {
  await migrate(db)
  await configureRuntimeRole(db, runtimeRole, runtimeGrants)
  console.log(`Migrated ${new URL(url).pathname.slice(1)}; provisioned ${runtimeRole}`)
} finally {
  await db.$client.end()
}
