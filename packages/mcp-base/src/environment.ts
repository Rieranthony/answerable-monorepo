import { z } from "zod"
import { createIdVerifier } from "@answerable/auth"

const schema = z.object({
  MCP_ID_ISSUER: z.url(),
  MCP_ID_JWKS_URL: z.url(),
  MCP_RESOURCE_URL: z.url(),
  MCP_RESOURCE_INSTANCE_ID: z.uuid(),
  MCP_ALLOW_LOCAL_HTTP: z.enum(["true", "false"]).default("false"),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(47500),
})

export function readMcpEnvironment(env: Record<string, string | undefined>) {
  const result = schema.safeParse(env)
  if (!result.success) throw new Error(`Invalid MCP configuration: ${result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
  const parsed = result.data
  const auth = {
    issuer: parsed.MCP_ID_ISSUER, jwksUrl: parsed.MCP_ID_JWKS_URL,
    resource: parsed.MCP_RESOURCE_URL, resourceInstanceId: parsed.MCP_RESOURCE_INSTANCE_ID,
    allowLocalHttp: parsed.MCP_ALLOW_LOCAL_HTTP === "true",
  }
  createIdVerifier(auth) // Validate trusted URLs before opening storage or listening.
  return { auth, port: parsed.MCP_PORT }
}
