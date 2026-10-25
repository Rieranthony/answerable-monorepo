import { configureRuntimeRole, connect } from "@answerable/mcp-postgres"
import { sql } from "drizzle-orm"
import { migrate, runtimeGrants } from "../src/db/migrate"
import { database } from "../src/test/database"
import { toolboxMigrationConfig } from "./env"

// bun scripts/migrate.ts migrates TOOLBOX_DATABASE_MIGRATION_URL, the schema owner, then provisions TOOLBOX_DATABASE_RUNTIME_ROLE
// (answerable_toolbox_runtime by default), the restricted role the Toolbox serves as. --test resets the test database first.
const test = process.argv.includes("--test")
const { TOOLBOX_DATABASE_MIGRATION_URL, TOOLBOX_DATABASE_RUNTIME_ROLE: role } = toolboxMigrationConfig.read(Bun.env)
const url = test ? database.url : TOOLBOX_DATABASE_MIGRATION_URL
if (test) database.assertDisposable("reset")
// While DDL waits for a table lock, every later query on that table queues behind it, so a migration on a live database gives up after a few
// seconds rather than stall the service. The statement bound stops a runaway statement from holding its locks indefinitely.
const db = connect(url, { max: 1, lock_timeout: 5_000, statement_timeout: 300_000 })
try {
  if (test) await db.execute(sql.raw("drop schema public cascade; drop schema if exists drizzle cascade; create schema public"))
  await migrate(db)
  await configureRuntimeRole(db, role, runtimeGrants)
  console.log(`Migrated ${new URL(url).pathname.slice(1)}; provisioned ${role}`)
} finally {
  await db.$client.end()
}
