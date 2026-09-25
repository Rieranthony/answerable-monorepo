import { z } from "zod"
import { createIdVerifier } from "@answerable/auth"

const schema = z.object({
  MCP_ID_ISSUER: z.url(),
  MCP_RESOURCE_URL: z.url(),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(47500),
})

export function readMcpEnvironment(env: Record<string, string | undefined>) {
  const result = schema.safeParse(env)
  if (!result.success) throw new Error(`Invalid MCP configuration: ${result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
  const auth = { issuer: result.data.MCP_ID_ISSUER, resource: result.data.MCP_RESOURCE_URL }
  try {
    createIdVerifier(auth)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid URL"
    const variable = message.startsWith("resource") ? "MCP_RESOURCE_URL" : "MCP_ID_ISSUER"
    throw new Error(`Invalid MCP configuration: ${variable}: ${message}`)
  }
  return { auth, port: result.data.MCP_PORT }
}
