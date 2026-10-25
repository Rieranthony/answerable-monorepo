import { defineConfig, locally } from "@answerable/config"
import { z } from "zod"

const runtimeRole = "answerable_toolbox_runtime"

/** What the Toolbox's migration, `scripts/migrate.ts`, reads besides the server's own variables. */
export const toolboxMigrationConfig = defineConfig("Toolbox migration", {
  TOOLBOX_DATABASE_MIGRATION_URL: {
    // The message the Errors table of the Toolbox's docs page quotes.
    schema: z.url({ message: "Set TOOLBOX_DATABASE_MIGRATION_URL to the Toolbox's Postgres URL as its schema owner" }),
    secret: true,
    defaults: locally("postgres://answerable:answerable@localhost:47432/answerable_toolbox"),
    doc: "The Toolbox's Postgres URL as the schema owner, for the migration only",
    source: "cluster",
  },
  // An empty value means the default too, as it always has.
  TOOLBOX_DATABASE_RUNTIME_ROLE: { schema: z.string().transform(role => role || runtimeRole), fallback: runtimeRole, doc: "The restricted role the migration provisions and the Toolbox serves as", source: "chart" },
})
