import { defineConfig } from "@answerable/config"
import { z } from "zod"

/** What the admin MCP's migration, `scripts/migrate.ts`, reads besides the server's own variables. */
export const adminMigrationConfig = defineConfig("admin MCP migration", {
  ADMIN_DATABASE_MIGRATION_URL: {
    // The message the Errors table of the admin MCP's docs page quotes.
    schema: z.url({ message: "Set ADMIN_DATABASE_MIGRATION_URL to the admin MCP's Postgres URL as its schema owner" }),
    secret: true,
    local: "postgres://answerable:answerable@localhost:47432/answerable_admin",
    doc: "The admin MCP's Postgres URL as the schema owner, for the migration only",
    source: "cluster",
  },
})
