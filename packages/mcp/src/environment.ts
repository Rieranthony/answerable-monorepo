import { z } from "zod"
import { createIdVerifier } from "@answerable/auth"

const schema = z.object({
  MCP_ID_ISSUER: z.url(),
  MCP_RESOURCE_URL: z.url(),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(47500),
})

/**
 * Parse `env` with `schema`, a server's own variables, then check the ID issuer and the resource URL, read from the two variables `names` gives,
 * as `createIdVerifier` checks them. Returns the parsed `data` and the `auth` option of `createMcpServer`; throws
 * `Invalid <label> configuration: <VARIABLE>: <problem>`, naming each variable that is missing or invalid.
 *
 * @example
 * ```ts
 * import { parseEnvironment } from "@answerable/mcp"
 * import { z } from "zod"
 *
 * const schema = z.object({ ACME_ID_ISSUER: z.url(), ACME_RESOURCE_URL: z.url(), ACME_DATABASE_URL: z.url() })
 * const { data, auth } = parseEnvironment("Acme", schema, process.env, { issuer: "ACME_ID_ISSUER", resource: "ACME_RESOURCE_URL" })
 * ```
 */
export function parseEnvironment<Schema extends z.ZodObject>(
  label: string,
  schema: Schema,
  env: Record<string, string | undefined>,
  names: { issuer: keyof z.output<Schema> & string; resource: keyof z.output<Schema> & string },
): { data: z.output<Schema>; auth: { issuer: string; resource: string } } {
  const result = schema.safeParse(env)
  if (!result.success) throw new Error(`Invalid ${label} configuration: ${result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
  const { data } = result
  const auth = { issuer: data[names.issuer] as string, resource: data[names.resource] as string }
  try {
    createIdVerifier(auth)
  } catch (error) {
    // @answerable/auth names the URL it refuses first, `issuer` or `resource`.
    const message = (error as Error).message
    throw new Error(`Invalid ${label} configuration: ${message.startsWith("resource") ? names.resource : names.issuer}: ${message}`)
  }
  return { data, auth }
}

/** Read `MCP_ID_ISSUER`, `MCP_RESOURCE_URL` and `MCP_PORT` (default 47500) into the `auth` option of `createMcpServer` and a port; throws naming the variable that is missing or invalid. */
export function readMcpEnvironment(env: Record<string, string | undefined>) {
  const { data, auth } = parseEnvironment("MCP", schema, env, { issuer: "MCP_ID_ISSUER", resource: "MCP_RESOURCE_URL" })
  return { auth, port: data.MCP_PORT }
}
