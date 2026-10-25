// The one variable bun mcp reads: where the development Postgres's shared MCP database is, as a superuser.
import { defineConfig } from "@answerable/config"
import { z } from "zod"

export const mcpCliConfig = defineConfig("bun mcp", {
  MCPS_DATABASE_ADMIN_URL: {
    schema: z.url(),
    fallback: "postgres://answerable:answerable@localhost:47432/answerable_mcps",
    doc: "The shared MCP database, answerable_mcps, as a superuser of the development Postgres: bun mcp db migrate provisions and migrates an MCP's local schema there, and an own MCP's database beside it",
  },
})
