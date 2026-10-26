import { ConfigError, type Config, type Field } from "@answerable/config"
import { createIdVerifier } from "@answerable/auth"

/**
 * Read `env` with `config`, a platform server's own variables from `defineConfig` (`@answerable/config`), then check the ID issuer and the
 * resource URL, read from the two variables `names` gives, as `createIdVerifier` checks them. Returns the parsed `data` and the `auth` option of
 * `createMcpServer`; throws `Invalid <label> configuration: <VARIABLE>: <problem>`, naming each variable that is missing or invalid.
 *
 * @example
 * ```ts
 * import { defineConfig } from "@answerable/config"
 * import { parseEnvironment } from "@answerable/mcp-platform"
 * import { z } from "zod"
 *
 * const config = defineConfig("Acme", {
 *   ACME_ID_ISSUER: { schema: z.url(), local: "http://localhost:47300", doc: "The ID issuer" },
 *   ACME_RESOURCE_URL: { schema: z.url(), local: "http://localhost:47510/mcp", doc: "This server's URL" },
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
