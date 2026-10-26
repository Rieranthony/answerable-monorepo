import { defineConfig } from "@answerable/config"
import { declaredMcps, ownMcpDatabase, sharedMcps } from "@answerable/mcp-postgres"
import { z } from "zod"

/** What the Toolbox's migration, `scripts/migrate.ts`, reads besides the server's own variables: its database, then every MCP's. */
export const toolboxMigrationConfig = defineConfig("Toolbox migration", {
  TOOLBOX_DATABASE_MIGRATION_URL: {
    // The message the Errors table of the Toolbox's docs page quotes.
    schema: z.url({ message: "Set TOOLBOX_DATABASE_MIGRATION_URL to the Toolbox's Postgres URL as its schema owner" }),
    secret: true,
    local: "postgres://answerable:answerable@localhost:47432/answerable_toolbox",
    doc: "The Toolbox's Postgres URL as the schema owner, for the migration only",
    source: "cluster",
  },
  MCPS_DATABASE_MIGRATION_URL: {
    schema: z.url({ message: "Set MCPS_DATABASE_MIGRATION_URL to the shared MCP database's Postgres URL as its migrator login" }),
    secret: true,
    local: `postgres://${sharedMcps.logins.migrator}:answerable@localhost:47432/${sharedMcps.database}`,
    doc: "The shared MCP database, answerable_mcps, as its migrator login, answerable_mcps_migrator, which owns every shared MCP's schema; for the migration only",
    source: "cluster",
  },
  MCPS_DECLARED: {
    schema: declaredMcps,
    local: "[]",
    doc: "The MCPs charts/answerable/mcps.json declares, as JSON [{ name, serve, database, scopes }], which the chart renders; locally none, since bun mcp db <name> migrate migrates each",
    source: "chart",
  },
})

/** The variable holding an own MCP's database URL as its owner login, for the migration: MCP_<NAME>_DATABASE_MIGRATION_URL. */
export const ownMigrationVariable = (name: string) => `MCP_${name.toUpperCase()}_DATABASE_MIGRATION_URL`

/** The own MCPs' variables the migration reads, one per MCP of `names`, each the database's URL as its owner login. */
export const ownMigrationConfig = (names: readonly string[]) => defineConfig("MCP migration", Object.fromEntries(names.map(name => {
  const { database, owner } = ownMcpDatabase(name)
  const field = { schema: z.url(), secret: true, local: `postgres://${owner}:answerable@localhost:47432/${database}`, doc: `The ${name} MCP's own database as its owner login, for the migration only`, source: "cluster" } as const
  return [ownMigrationVariable(name), field]
})))
