import { configureRuntimeRole, connect, ensureLocalMcpDatabases, runtimeGrants } from "@answerable/mcp-postgres"
import { sql } from "drizzle-orm"
import { migrate } from "../src/db/migrate"
import { database } from "../src/test/database"
import { standaloneMigrationConfig } from "./env"

// bun scripts/migrate.ts migrates STANDALONE_DATABASE_MIGRATION_URL, the owner, then provisions STANDALONE_DATABASE_RUNTIME_ROLE
// (answerable_standalone_runtime by default), the restricted role the standalone server serves as. --test resets the test database first.
// The standalone server has no tables of its own: only those of @answerable/mcp-postgres, intents and evidence, and their grants. Outside
// production, the local databases are made first when missing.
const test = process.argv.includes("--test")
const { NODE_ENV, STANDALONE_DATABASE_MIGRATION_URL, STANDALONE_DATABASE_RUNTIME_ROLE: role } = standaloneMigrationConfig.read(Bun.env)
const url = test ? database.url : STANDALONE_DATABASE_MIGRATION_URL
if (test) database.assertDisposable("reset")
if (NODE_ENV !== "production") await ensureLocalMcpDatabases(Object.assign(new URL(database.url), { pathname: "/postgres" }).href)
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
