import { fileURLToPath } from "node:url"
import { configureRuntimeRole, connect, sharedMcps } from "@answerable/mcp-postgres"
import { migrate, runtimeGrants, runtimeRole } from "../src/db/migrate"
import { migrateDeclared } from "../src/db/migrate-mcps"
import { ownMigrationConfig, ownMigrationVariable, toolboxMigrationConfig } from "./env"

// bun scripts/migrate.ts migrates TOOLBOX_DATABASE_MIGRATION_URL, the schema owner, then provisions answerable_toolbox_runtime, the restricted
// role the Toolbox serves as; then every MCP of MCPS_DECLARED, the chart's list, from its folder in this image, each shared MCP as the migrator
// login, MCPS_DATABASE_MIGRATION_URL, granting the Toolbox's serving login its tables, and each own MCP as its owner login, from
// MCP_<NAME>_DATABASE_MIGRATION_URL. The deployment's hook Job toolbox-migrate runs it; the bootstrap provisioned each MCP's schema from the same
// list. Locally the list is empty: bun mcp db <name> migrate migrates each MCP. scripts/test-migrate.ts resets and migrates the test database.
const { TOOLBOX_DATABASE_MIGRATION_URL: url, MCPS_DATABASE_MIGRATION_URL, MCPS_DECLARED: mcps } = toolboxMigrationConfig.read(Bun.env)
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
