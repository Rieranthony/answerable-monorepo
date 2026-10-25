import { defineConfig, locally } from "@answerable/config"
import { z } from "zod"

const runtimeRole = "answerable_standalone_runtime"

/** What the standalone server's migration, `scripts/migrate.ts`, reads besides the server's own variables. */
export const standaloneMigrationConfig = defineConfig("standalone server migration", {
  STANDALONE_DATABASE_MIGRATION_URL: {
    schema: z.url({ message: "Set STANDALONE_DATABASE_MIGRATION_URL to the standalone server's Postgres URL as its owner" }),
    secret: true,
    defaults: locally("postgres://answerable_standalone_owner:answerable@localhost:47432/answerable_standalone"),
    doc: "The standalone server's Postgres URL as its owner, for the migration only",
    source: "cluster",
  },
  STANDALONE_DATABASE_RUNTIME_ROLE: { schema: z.string().min(1), fallback: runtimeRole, doc: "The restricted role the migration provisions and the standalone server serves as", source: "chart" },
})
