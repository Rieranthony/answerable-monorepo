import { defineConfig, locally } from "@answerable/config"
import { parseEnvironment } from "@answerable/mcp"
import { ownDatabases } from "@answerable/mcp-platform"
import { z } from "zod"
import { served } from "./served.generated"

// The database URL of each served MCP whose database is its own.
const own = ownDatabases(served)

/** Every variable the standalone server reads, with its local defaults; the client pair has none, since the local ID issues it. */
export const standaloneConfig = defineConfig("standalone server", {
  ...own.fields,
  STANDALONE_ORIGIN: { schema: z.url(), defaults: locally("http://localhost:47510"), doc: "The standalone server's origin: each MCP it serves is the resource <origin>/<name>/mcp, the audience of its tokens", source: "chart" },
  STANDALONE_ID_ISSUER: { schema: z.url(), defaults: locally("http://localhost:47300"), doc: "The Answerable ID issuer whose tokens the standalone server accepts", source: "chart" },
  STANDALONE_HOST: { schema: z.union([z.ipv4(), z.ipv6()]), fallback: "127.0.0.1", doc: "The address to listen on: loopback unless a container or a proxy in front needs another", source: "image" },
  STANDALONE_PORT: { schema: z.coerce.number().int().min(1).max(65535), fallback: "47510", doc: "The port the standalone server listens on", source: "image" },
  STANDALONE_DATABASE_URL: {
    schema: z.url(),
    secret: true,
    defaults: locally("postgres://answerable_standalone_runtime:answerable@localhost:47432/answerable_standalone"),
    doc: "The standalone server's Postgres URL, for intents and evidence, as its restricted runtime login, never the owner",
    source: "cluster",
  },
  STANDALONE_MCPS_DATABASE_URL: {
    schema: z.url(),
    secret: true,
    defaults: locally("postgres://answerable_mcps_standalone:answerable@localhost:47432/answerable_mcps"),
    doc: "The shared MCP database, answerable_mcps, as the standalone server's serving login, answerable_mcps_standalone, which takes each served MCP's runtime role",
    source: "cluster",
  },
  STANDALONE_MCPS_ROLE_PREFIX: { schema: z.string().regex(/^[a-z][a-z0-9_]*$/), fallback: "mcp", doc: "The prefix of the MCPs' roles in the shared database: mcp; a test that serves its own database names its own" },
  STANDALONE_ID_CLIENT_ID: { schema: z.string().min(1), doc: "The standalone server's machine client in ID, standalone-hub, with platform:read, through which it reads who is calling", source: "chart" },
  STANDALONE_ID_CLIENT_SECRET: { schema: z.string().min(1), secret: true, doc: "The standalone server machine client's secret", source: "cluster" },
  STANDALONE_ID_ADMIN_RESOURCE: { schema: z.url(), defaults: locally("http://localhost:47300/api/admin"), doc: "ID's admin API, the audience of the machine client's tokens", source: "chart" },
  OTEL_EXPORTER_OTLP_ENDPOINT: { schema: z.url().optional(), doc: "Where to export spans over OTLP/HTTP, such as a local collector; unset, none are exported", source: "operator" },
})

/** Read the standalone server's configuration from the environment; throws naming the variable that is missing or invalid. */
export function readStandaloneEnvironment(env: Record<string, string | undefined>) {
  // The origin is checked as a resource is: an MCP's resource is the origin with its path.
  const { data, auth } = parseEnvironment(standaloneConfig, env, { issuer: "STANDALONE_ID_ISSUER", resource: "STANDALONE_ORIGIN" })
  return {
    origin: auth.resource,
    issuer: auth.issuer,
    databaseUrl: data.STANDALONE_DATABASE_URL,
    /** The served MCPs' databases, for `mcpDatabases`: the shared one, each own one's URL by its variable, and the role prefix. */
    mcps: { shared: data.STANDALONE_MCPS_DATABASE_URL, own: own.urls(data), prefix: data.STANDALONE_MCPS_ROLE_PREFIX },
    /** The address to listen on: loopback unless a container or a proxy in front needs another. */
    hostname: data.STANDALONE_HOST,
    port: data.STANDALONE_PORT,
    id: { issuer: data.STANDALONE_ID_ISSUER, adminResource: data.STANDALONE_ID_ADMIN_RESOURCE, clientId: data.STANDALONE_ID_CLIENT_ID, clientSecret: data.STANDALONE_ID_CLIENT_SECRET },
    otlpEndpoint: data.OTEL_EXPORTER_OTLP_ENDPOINT,
  }
}
