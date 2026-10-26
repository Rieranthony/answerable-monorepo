import { fileURLToPath } from "node:url"
import { configureRuntimeRole, connect, sharedMcps } from "@answerable/mcp-postgres"
import { sql } from "drizzle-orm"
import { migrate, runtimeGrants } from "../src/db/migrate"
import { migrateDeclared } from "../src/db/migrate-mcps"
import { database } from "../src/test/database"
import { ownMigrationConfig, ownMigrationVariable, toolboxMigrationConfig } from "./env"

// bun scripts/migrate.ts migrates TOOLBOX_DATABASE_MIGRATION_URL, the schema owner, then provisions TOOLBOX_DATABASE_RUNTIME_ROLE
// (answerable_toolbox_runtime by default), the restricted role the Toolbox serves as; then every MCP of MCPS_DECLARED, the chart's list, from
// its folder in this image, each shared MCP as the migrator login, MCPS_DATABASE_MIGRATION_URL, granting the Toolbox's serving login its tables,
// and each own MCP as its owner login, from MCP_<NAME>_DATABASE_MIGRATION_URL. The deployment's hook Job toolbox-migrate runs it; the bootstrap
// provisioned each MCP's schema from the same list. Locally the list is empty: bun mcp db <name> migrate migrates each MCP. --test resets the
// test database first.
const test = process.argv.includes("--test")
const { TOOLBOX_DATABASE_MIGRATION_URL, TOOLBOX_DATABASE_RUNTIME_ROLE: role, MCPS_DATABASE_MIGRATION_URL, MCPS_DECLARED } = toolboxMigrationConfig.read(Bun.env)
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
const mcps = MCPS_DECLARED
if (mcps.length) {
  const own = ownMigrationConfig(mcps.filter(mcp => mcp.database === "own").map(mcp => mcp.name)).read(Bun.env) as Record<string, string>
  const started = performance.now()
  await migrateDeclared({
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    mcps,
    shared: MCPS_DATABASE_MIGRATION_URL,
    serving: sharedMcps.logins.toolbox,
    own: name => own[ownMigrationVariable(name)]!,
    log: line => console.log(line),
  })
  console.log(`Migrated ${mcps.length} MCP${mcps.length === 1 ? "" : "s"} in ${((performance.now() - started) / 1000).toFixed(1)} s`)
}
