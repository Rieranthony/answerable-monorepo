import { parseEnvironment } from "@answerable/mcp"
import { z } from "zod"

const schema = z.object({
  ADMIN_ID_ISSUER: z.url(),
  ADMIN_RESOURCE_URL: z.url(),
  ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(47520),
  ADMIN_DATABASE_URL: z.url(),
  ADMIN_ID_CLIENT_ID: z.string().min(1),
  ADMIN_ID_CLIENT_SECRET: z.string().min(1),
  ADMIN_ID_ADMIN_RESOURCE: z.url(),
  ADMIN_TOOLBOX_ADMIN_RESOURCE: z.url().optional(),
  ADMIN_FRESH_SECONDS: z.coerce.number().int().min(1).optional(),
})

/** Read the admin MCP's configuration from the environment; throws naming the variable that is missing or invalid. */
export function readAdminEnvironment(env: Record<string, string | undefined>) {
  const { data, auth } = parseEnvironment("admin MCP", schema, env, { issuer: "ADMIN_ID_ISSUER", resource: "ADMIN_RESOURCE_URL" })
  return {
    auth,
    port: data.ADMIN_PORT,
    databaseUrl: data.ADMIN_DATABASE_URL,
    id: { issuer: data.ADMIN_ID_ISSUER, adminResource: data.ADMIN_ID_ADMIN_RESOURCE, clientId: data.ADMIN_ID_CLIENT_ID, clientSecret: data.ADMIN_ID_CLIENT_SECRET },
    /** The Toolbox's admin resource, for enabling the Toolbox for an organisation; unset, that is refused. */
    toolboxAdminResource: data.ADMIN_TOOLBOX_ADMIN_RESOURCE,
    /** How recent an upstream sign-in a critical operation needs, in seconds; unset, `createAdminMcp`'s 1,800. */
    freshSeconds: data.ADMIN_FRESH_SECONDS,
  }
}
