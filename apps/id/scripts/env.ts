import { defineConfig } from "@answerable/config";
import { z } from "zod";

/** What ID's migration, `scripts/migrate.ts`, reads besides the service's own variables. */
export const idMigrationConfig = defineConfig("ID migration", {
  DATABASE_MIGRATION_URL: {
    schema: z.url(),
    secret: true,
    local: "postgres://answerable:answerable@localhost:47432/answerable_id",
    doc: "ID's Postgres URL as the schema owner, for the migration only",
    source: "cluster",
  },
  DATABASE_RUNTIME_ROLE: {
    schema: z.string(),
    fallback: "answerable_id_runtime",
    doc: "The restricted role the migration provisions and ID serves as",
    source: "chart",
  },
});
