import { defineConfig, locally } from "@answerable/config"
import { parseEnvironment } from "@answerable/mcp"
import { z } from "zod"

/** Every variable the Toolbox reads, with its local defaults; the client pair has none, since the local ID issues it. */
export const toolboxConfig = defineConfig("Toolbox", {
  TOOLBOX_DATABASE_URL: {
    schema: z.url(),
    secret: true,
    defaults: locally("postgres://answerable_toolbox_runtime:answerable@localhost:47432/answerable_toolbox"),
    doc: "The Toolbox's Postgres URL as its restricted runtime login, never the schema owner",
    source: "cluster",
  },
  TOOLBOX_ID_ISSUER: { schema: z.url(), defaults: locally("http://localhost:47300"), doc: "The Answerable ID issuer whose tokens the Toolbox accepts", source: "chart" },
  TOOLBOX_RESOURCE_URL: { schema: z.url(), defaults: locally("http://localhost:47400/mcp"), doc: "The Toolbox's own URL, the audience of the tokens it accepts", source: "chart" },
  TOOLBOX_HOST: { schema: z.union([z.ipv4(), z.ipv6()]), fallback: "127.0.0.1", doc: "The address to listen on: loopback unless a container or a proxy in front needs another", source: "image" },
  TOOLBOX_PORT: { schema: z.coerce.number().int().min(1).max(65535), fallback: "47400", doc: "The port the Toolbox listens on", source: "image" },
  TOOLBOX_ID_CLIENT_ID: { schema: z.string().min(1), doc: "The Toolbox's machine client in ID, toolbox-hub, with platform:read and platform:write, registered as the Toolbox's docs show", source: "chart" },
  TOOLBOX_ID_CLIENT_SECRET: { schema: z.string().min(1), secret: true, doc: "The Toolbox machine client's secret", source: "cluster" },
  TOOLBOX_ID_ADMIN_RESOURCE: { schema: z.url(), defaults: locally("http://localhost:47300/api/admin"), doc: "ID's admin API, the audience of the machine client's tokens", source: "chart" },
  OTEL_EXPORTER_OTLP_ENDPOINT: { schema: z.url().optional(), doc: "Where to export spans over OTLP/HTTP, such as a local collector; unset, none are exported", source: "operator" },
})

/** Read the Toolbox's configuration from the environment; throws naming the variable that is missing or invalid. */
export function readToolboxEnvironment(env: Record<string, string | undefined>) {
  const { data, auth } = parseEnvironment(toolboxConfig, env, { issuer: "TOOLBOX_ID_ISSUER", resource: "TOOLBOX_RESOURCE_URL" })
  return {
    databaseUrl: data.TOOLBOX_DATABASE_URL,
    auth,
    /** The address to listen on: loopback unless a container or a proxy in front needs another. */
    hostname: data.TOOLBOX_HOST,
    port: data.TOOLBOX_PORT,
    id: { issuer: data.TOOLBOX_ID_ISSUER, adminResource: data.TOOLBOX_ID_ADMIN_RESOURCE, clientId: data.TOOLBOX_ID_CLIENT_ID, clientSecret: data.TOOLBOX_ID_CLIENT_SECRET },
    otlpEndpoint: data.OTEL_EXPORTER_OTLP_ENDPOINT,
  }
}
