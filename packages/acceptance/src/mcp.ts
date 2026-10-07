import { errorOf } from "@answerable/mcp/testing"
import { Client, StreamableHTTPClientTransport, type OAuthClientProvider } from "@modelcontextprotocol/client"
import { z } from "zod"
import { onCleanup } from "./cleanup"

/** Serve a fetch handler on a loopback port until the kit stops. Throws when the port is busy. */
export function serve(port: number, fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch })
  onCleanup(() => server.stop(true))
  return server
}

/** Serve a sign-in's OAuth callback URL, such as `http://127.0.0.1:47603/callback`, on its port until the kit stops, answering the browser that ID sends back. */
export function serveCallback(callback: string) {
  return serve(Number(new URL(callback).port), () => new Response("Signed in. You can close this page."))
}

/** What a prepare tool answers, as far as the journeys read it: `intentSchema.parse(await tool(client, "records_create", { title }))`. */
export const intentSchema = z.object({
  intent_id: z.uuid(),
  commit_token: z.string(),
  commit_tool: z.string(),
  policy_class: z.string(),
  expires_at: z.iso.datetime(),
  targets: z.array(z.object({ resource_type: z.string(), resource_id: z.string(), version: z.object({ kind: z.string(), value: z.string() }) })),
  preview: z.object({ summary: z.string(), changes: z.array(z.unknown()) }),
})

/** Connect the official MCP client to an MCP with an OAuth provider, speaking the `2025` protocol or pinned to `2026-07-28`. It closes when the kit stops. */
export async function connect(resource: string, provider: OAuthClientProvider, protocol: "2025" | "2026-07-28") {
  const client = new Client({ name: "answerable-acceptance", version: "0.1.0" }, protocol === "2026-07-28" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {})
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider }))
  onCleanup(() => client.close())
  return client
}

/** Call a tool and return its `structuredContent`. A failed call throws with the envelope's code and message. */
export async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    const { code, message } = errorOf(result)
    throw new Error(`${name} answered ${code}: ${message}`)
  }
  return result.structuredContent as Record<string, unknown>
}

/** Call a tool that must fail and return the `error` of its envelope: `code`, `message`, `retry`, `details` and `request_id`. A call that succeeds throws. */
export async function refusal(client: Client, name: string, args: Record<string, unknown> = {}) {
  return errorOf(await client.callTool({ name, arguments: args }))
}
