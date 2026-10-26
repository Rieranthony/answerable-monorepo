// The variables bun mcp reads: the development Postgres's shared MCP database, and the local ID's machine client and organisation that bun mcp setup makes.
import { defineConfig, locally } from "@answerable/config"
import { z } from "zod"

export const mcpCliConfig = defineConfig("bun mcp", {
  MCPS_DATABASE_ADMIN_URL: {
    schema: z.url(),
    fallback: "postgres://answerable:answerable@localhost:47432/answerable_mcps",
    doc: "The shared MCP database, answerable_mcps, as a superuser of the development Postgres: bun mcp db migrate provisions and migrates an MCP's local schema there, and an own MCP's database beside it",
  },
  MCP_DEV_ID_CLIENT_ID: {
    schema: z.string().min(1).optional(),
    doc: "bun mcp's machine client in your local ID, mcp-dev, through which bun mcp dev registers an MCP and its servers read who is calling; bun mcp setup makes it and writes this",
  },
  MCP_DEV_ID_CLIENT_SECRET: {
    schema: z.string().min(1).optional(),
    secret: true,
    doc: "mcp-dev's secret, which ID shows once; bun mcp setup writes it",
  },
  MCP_DEV_ORGANISATION: {
    schema: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "an organisation's slug: lowercase letters and digits, words joined by single hyphens"),
    defaults: locally("answerable"),
    doc: "The slug of the organisation bun mcp dev gives access to the MCP it runs, so that you can call every tool: your local ID's platform organisation unless bun mcp setup --organisation says another",
  },
  ROOT_ADMIN_SECRET: {
    schema: z.string().min(32).optional(),
    secret: true,
    defaults: locally("development-only-root-admin-secret-never-for-production"),
    doc: "ID's root bearer, which bun mcp setup uses while ID's root is unlocked: the local default, as ID's own definition has it, unless .env sets another",
  },
})
