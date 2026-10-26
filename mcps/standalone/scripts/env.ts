import { defineConfig, locally } from "@answerable/config"
import { declaredMcps, ownMcpDatabase, sharedMcps } from "@answerable/mcp-postgres"
import { z } from "zod"

/** What the standalone server's migration, `scripts/migrate.ts`, reads besides the server's own variables. */
export const standaloneMigrationConfig = defineConfig("standalone server migration", {
  STANDALONE_DATABASE_MIGRATION_URL: {
    schema: z.url({ message: "Set STANDALONE_DATABASE_MIGRATION_URL to the standalone server's Postgres URL as its owner" }),
    secret: true,
    defaults: locally("postgres://answerable_standalone_owner:answerable@localhost:47432/answerable_standalone"),
    doc: "The standalone server's Postgres URL as its owner, for the migration only",
    source: "cluster",
  },
  STANDALONE_DATABASE_RUNTIME_ROLE: { schema: z.string().min(1), fallback: "answerable_standalone_runtime", doc: "The restricted role the migration provisions and the standalone server serves as", source: "chart" },
})

/** What the MCPs' migration, `scripts/migrate-mcps.ts`, the Job mcps-migrate, reads: the shared database as its migrator, and the chart's list. */
export const mcpsMigrationConfig = defineConfig("MCP migration", {
  MCPS_DATABASE_MIGRATION_URL: {
    schema: z.url({ message: "Set MCPS_DATABASE_MIGRATION_URL to the shared MCP database's Postgres URL as its migrator login" }),
    secret: true,
    defaults: locally(`postgres://${sharedMcps.logins.migrator}:answerable@localhost:47432/${sharedMcps.database}`),
    doc: "The shared MCP database, answerable_mcps, as its migrator login, answerable_mcps_migrator, which takes each shared MCP's owner role; for the migration only",
    source: "cluster",
  },
  MCPS_DECLARED: { schema: declaredMcps, doc: "The MCPs charts/answerable/mcps.json declares, as JSON [{ name, serve, database }], which the chart renders", source: "chart" },
})

/** The variable holding an own MCP's database URL as its owner login, for the migration: MCP_<NAME>_DATABASE_MIGRATION_URL. */
export const ownMigrationVariable = (name: string) => `MCP_${name.toUpperCase()}_DATABASE_MIGRATION_URL`

/** The own MCPs' variables the migration reads, one per MCP of `names`, each the database's URL as its owner login. */
export const ownMigrationConfig = (names: readonly string[]) => defineConfig("MCP migration", Object.fromEntries(names.map(name => {
  const { database, owner } = ownMcpDatabase(name)
  const field = { schema: z.url(), secret: true, defaults: locally(`postgres://${owner}:answerable@localhost:47432/${database}`), doc: `The ${name} MCP's own database as its owner login, for the migration only`, source: "cluster" } as const
  return [ownMigrationVariable(name), field]
})))
