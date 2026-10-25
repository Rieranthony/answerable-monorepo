import { ConfigError, defineConfig, locally, type Config, type Field } from "@answerable/config"
import { createIdVerifier } from "@answerable/auth"
import { z } from "zod"

/** The variables `readMcpEnvironment` reads; the local defaults are the e2e server's. */
export const mcpConfig = defineConfig("MCP", {
  MCP_ID_ISSUER: { schema: z.url(), defaults: locally("http://localhost:47300"), doc: "The Answerable ID issuer whose tokens the server accepts" },
  MCP_RESOURCE_URL: { schema: z.url(), defaults: locally("http://localhost:47500/mcp"), doc: "The server's own URL, the audience of the tokens it accepts" },
  MCP_PORT: { schema: z.coerce.number().int().min(1).max(65535), fallback: "47500", doc: "The port the server listens on; each MCP running at the same time needs its own" },
})

/**
 * Read `env` with `config`, a server's own variables from `defineConfig` (`@answerable/config`), then check the ID issuer and the resource URL,
 * read from the two variables `names` gives, as `createIdVerifier` checks them. Returns the parsed `data` and the `auth` option of
 * `createMcpServer`; throws `Invalid <label> configuration: <VARIABLE>: <problem>`, naming each variable that is missing or invalid.
 *
 * @example
 * ```ts
 * import { defineConfig, locally } from "@answerable/config"
 * import { parseEnvironment } from "@answerable/mcp"
 * import { z } from "zod"
 *
 * const config = defineConfig("Acme", {
 *   ACME_ID_ISSUER: { schema: z.url(), defaults: locally("http://localhost:47300"), doc: "The ID issuer" },
 *   ACME_RESOURCE_URL: { schema: z.url(), defaults: locally("http://localhost:47510/mcp"), doc: "This server's URL" },
 *   ACME_DATABASE_URL: { schema: z.url(), secret: true, doc: "The database" },
 * })
 * const { data, auth } = parseEnvironment(config, process.env, { issuer: "ACME_ID_ISSUER", resource: "ACME_RESOURCE_URL" })
 * ```
 */
export function parseEnvironment<Fields extends Record<string, Field>>(
  config: Config<Fields>,
  env: Record<string, string | undefined>,
  names: { issuer: keyof Fields & string; resource: keyof Fields & string },
): { data: ReturnType<Config<Fields>["read"]>; auth: { issuer: string; resource: string } } {
  const data = config.read(env)
  const auth = { issuer: data[names.issuer] as string, resource: data[names.resource] as string }
  try {
    createIdVerifier(auth)
  } catch (error) {
    // @answerable/auth names the URL it refuses first, `issuer` or `resource`.
    const message = (error as Error).message
    throw new ConfigError(config.label, [{ name: message.startsWith("resource") ? names.resource : names.issuer, message }])
  }
  return { data, auth }
}

/** Read `MCP_ID_ISSUER`, `MCP_RESOURCE_URL` and `MCP_PORT` (default 47500) into the `auth` option of `createMcpServer` and a port; throws naming the variable that is missing or invalid. Outside production, the issuer and the resource default to the local ID and `http://localhost:47500/mcp`. */
export function readMcpEnvironment(env: Record<string, string | undefined>) {
  const { data, auth } = parseEnvironment(mcpConfig, env, { issuer: "MCP_ID_ISSUER", resource: "MCP_RESOURCE_URL" })
  return { auth, port: data.MCP_PORT }
}
