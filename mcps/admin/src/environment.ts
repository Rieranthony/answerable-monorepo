import { defineConfig, locally } from "@answerable/config"
import { parseEnvironment } from "@answerable/mcp"
import { z } from "zod"

/** Every variable the admin MCP reads, with its local defaults; the client pair has none, since the local ID issues it. */
export const adminConfig = defineConfig("admin MCP", {
  ADMIN_ID_ISSUER: { schema: z.url(), defaults: locally("http://localhost:47300"), doc: "The Answerable ID issuer whose tokens the admin MCP accepts", source: "chart" },
  ADMIN_RESOURCE_URL: { schema: z.url(), defaults: locally("http://localhost:47520/mcp"), doc: "The admin MCP's own URL, the audience of the tokens it accepts", source: "chart" },
  ADMIN_HOST: { schema: z.union([z.ipv4(), z.ipv6()]), fallback: "127.0.0.1", doc: "The address to listen on: loopback unless a container or a proxy in front needs another", source: "image" },
  ADMIN_PORT: { schema: z.coerce.number().int().min(1).max(65535), fallback: "47520", doc: "The port the admin MCP listens on", source: "image" },
  ADMIN_DATABASE_URL: {
    schema: z.url(),
    secret: true,
    defaults: locally("postgres://answerable_admin_runtime:answerable@localhost:47432/answerable_admin"),
    doc: "The admin MCP's Postgres URL as its restricted runtime login, never the schema owner",
    source: "cluster",
  },
  ADMIN_ID_CLIENT_ID: { schema: z.string().min(1), doc: "The admin MCP's machine client in ID, admin-mcp, owned by the platform organisation, registered as the admin MCP's docs show", source: "chart" },
  ADMIN_ID_CLIENT_SECRET: { schema: z.string().min(1), secret: true, doc: "The admin MCP machine client's secret", source: "cluster" },
  ADMIN_ID_ADMIN_RESOURCE: { schema: z.url(), defaults: locally("http://localhost:47300/api/admin"), doc: "ID's admin API, the audience of the machine client's tokens", source: "chart" },
  ADMIN_TOOLBOX_ADMIN_RESOURCE: { schema: z.url().optional(), defaults: locally("http://localhost:47400/admin"), doc: "The Toolbox's admin API, for enabling the Toolbox for an organisation; unset, that is refused", source: "chart" },
  ADMIN_STANDALONE_ORIGIN: {
    schema: z.url().transform(url => url.replace(/\/+$/, "")).optional(),
    defaults: locally("http://localhost:47510"),
    doc: "The standalone server's origin, whose <origin>/<name>/mcp is each standalone MCP's resource, for giving an organisation access to one; unset, that is refused",
    source: "chart",
  },
  ADMIN_FRESH_SECONDS: { schema: z.coerce.number().int().min(1).optional(), doc: "How recent an upstream sign-in a critical operation needs, in seconds; unset, 1,800", source: "operator" },
})

/** Read the admin MCP's configuration from the environment; throws naming the variable that is missing or invalid. */
export function readAdminEnvironment(env: Record<string, string | undefined>) {
  const { data, auth } = parseEnvironment(adminConfig, env, { issuer: "ADMIN_ID_ISSUER", resource: "ADMIN_RESOURCE_URL" })
  return {
    auth,
    /** The address to listen on: loopback unless a container or a proxy in front needs another. */
    hostname: data.ADMIN_HOST,
    port: data.ADMIN_PORT,
    databaseUrl: data.ADMIN_DATABASE_URL,
    id: { issuer: data.ADMIN_ID_ISSUER, adminResource: data.ADMIN_ID_ADMIN_RESOURCE, clientId: data.ADMIN_ID_CLIENT_ID, clientSecret: data.ADMIN_ID_CLIENT_SECRET },
    /** The Toolbox's admin resource, for enabling the Toolbox for an organisation; unset, that is refused. */
    toolboxAdminResource: data.ADMIN_TOOLBOX_ADMIN_RESOURCE,
    /** The standalone server's origin, for giving an organisation access to a standalone MCP; unset, that is refused. */
    standaloneOrigin: data.ADMIN_STANDALONE_ORIGIN,
    /** How recent an upstream sign-in a critical operation needs, in seconds; unset, `createAdminMcp`'s 1,800. */
    freshSeconds: data.ADMIN_FRESH_SECONDS,
  }
}
