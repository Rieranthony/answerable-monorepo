import { createIdVerifier } from "@answerable/auth"
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
  ADMIN_FRESH_SECONDS: z.coerce.number().int().min(1).default(1800),
})

/** Read the admin MCP's configuration from the environment; throws naming the variable that is missing or invalid. */
export function readAdminEnvironment(env: Record<string, string | undefined>) {
  const result = schema.safeParse(env)
  if (!result.success) throw new Error(`Invalid admin MCP configuration: ${result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
  const { data } = result
  const auth = { issuer: data.ADMIN_ID_ISSUER, resource: data.ADMIN_RESOURCE_URL }
  try {
    createIdVerifier(auth)
  } catch (error) {
    const message = (error as Error).message
    throw new Error(`Invalid admin MCP configuration: ${message.startsWith("resource") ? "ADMIN_RESOURCE_URL" : "ADMIN_ID_ISSUER"}: ${message}`)
  }
  return {
    auth,
    port: data.ADMIN_PORT,
    databaseUrl: data.ADMIN_DATABASE_URL,
    id: { issuer: data.ADMIN_ID_ISSUER, adminResource: data.ADMIN_ID_ADMIN_RESOURCE, clientId: data.ADMIN_ID_CLIENT_ID, clientSecret: data.ADMIN_ID_CLIENT_SECRET },
    /** The Toolbox's admin resource, for enabling the Toolbox for an organisation; unset, that is refused. */
    toolboxAdminResource: data.ADMIN_TOOLBOX_ADMIN_RESOURCE,
    /** How recent an upstream sign-in a critical operation needs, in seconds. */
    freshSeconds: data.ADMIN_FRESH_SECONDS,
  }
}
