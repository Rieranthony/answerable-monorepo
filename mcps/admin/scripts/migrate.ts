import { configureRuntimeRole, connect, runtimeGrants } from "@answerable/mcp-postgres"
import { sql } from "drizzle-orm"
import { z } from "zod"
import { migrate } from "../src/db/migrate"
import { database } from "../src/test/database"

// bun scripts/migrate.ts migrates ADMIN_DATABASE_MIGRATION_URL, the schema owner, then provisions ADMIN_DATABASE_RUNTIME_ROLE
// (answerable_admin_runtime by default), the restricted role the admin MCP serves as. --test resets the test database first.
// The admin MCP has no tables of its own: only those of @answerable/mcp-postgres, intents and evidence, and their grants.
const test = process.argv.includes("--test")
const url = test ? database.url : z.url({ message: "Set ADMIN_DATABASE_MIGRATION_URL to the admin MCP's Postgres URL as its schema owner" }).parse(Bun.env.ADMIN_DATABASE_MIGRATION_URL)
const role = Bun.env.ADMIN_DATABASE_RUNTIME_ROLE || "answerable_admin_runtime"
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
