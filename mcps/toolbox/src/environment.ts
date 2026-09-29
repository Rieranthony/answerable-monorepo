import { createIdVerifier } from "@answerable/auth"
import { z } from "zod"

const schema = z.object({
  TOOLBOX_DATABASE_URL: z.url(),
  TOOLBOX_ID_ISSUER: z.url(),
  TOOLBOX_RESOURCE_URL: z.url(),
  TOOLBOX_PORT: z.coerce.number().int().min(1).max(65535).default(47400),
  TOOLBOX_ID_CLIENT_ID: z.string().min(1),
  TOOLBOX_ID_CLIENT_SECRET: z.string().min(1),
  TOOLBOX_ID_ADMIN_RESOURCE: z.url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
})

/** Read the Toolbox's configuration from the environment; throws naming the variable that is missing or invalid. */
export function readToolboxEnvironment(env: Record<string, string | undefined>) {
  const result = schema.safeParse(env)
  if (!result.success) throw new Error(`Invalid Toolbox configuration: ${result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
  const { data } = result
  const auth = { issuer: data.TOOLBOX_ID_ISSUER, resource: data.TOOLBOX_RESOURCE_URL }
  try {
    createIdVerifier(auth)
  } catch (error) {
    const message = (error as Error).message
    throw new Error(`Invalid Toolbox configuration: ${message.startsWith("resource") ? "TOOLBOX_RESOURCE_URL" : "TOOLBOX_ID_ISSUER"}: ${message}`)
  }
  return {
    databaseUrl: data.TOOLBOX_DATABASE_URL,
    auth,
    port: data.TOOLBOX_PORT,
    id: { issuer: data.TOOLBOX_ID_ISSUER, adminResource: data.TOOLBOX_ID_ADMIN_RESOURCE, clientId: data.TOOLBOX_ID_CLIENT_ID, clientSecret: data.TOOLBOX_ID_CLIENT_SECRET },
    otlpEndpoint: data.OTEL_EXPORTER_OTLP_ENDPOINT,
  }
}
