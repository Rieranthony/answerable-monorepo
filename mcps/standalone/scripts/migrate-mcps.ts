import { fileURLToPath } from "node:url"
import { migrateDeclared } from "../src/db/migrate-mcps"
import { mcpsMigrationConfig, ownMigrationConfig, ownMigrationVariable } from "./env"

// bun mcps/standalone/scripts/migrate-mcps.ts, the hook Job mcps-migrate: migrates every MCP of MCPS_DECLARED, the chart's list, from its
// folder in this image, each shared MCP through MCPS_DATABASE_MIGRATION_URL as its owner role and each own MCP as its owner login, from
// MCP_<NAME>_DATABASE_MIGRATION_URL. The bootstrap provisioned each one's schema and roles from the same list. The hub databases, the Toolbox's,
// the admin MCP's and the standalone server's, have Jobs of their own.
const { MCPS_DATABASE_MIGRATION_URL, MCPS_DECLARED } = mcpsMigrationConfig.read(Bun.env)
const own = ownMigrationConfig(MCPS_DECLARED.filter(mcp => mcp.database === "own").map(mcp => mcp.name)).read(Bun.env) as Record<string, string>
const started = performance.now()
await migrateDeclared({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mcps: MCPS_DECLARED,
  shared: MCPS_DATABASE_MIGRATION_URL,
  own: name => own[ownMigrationVariable(name)]!,
  prefix: "mcp",
  log: line => console.log(line),
})
console.log(`Migrated ${MCPS_DECLARED.length} MCP${MCPS_DECLARED.length === 1 ? "" : "s"} in ${((performance.now() - started) / 1000).toFixed(1)} s`)
