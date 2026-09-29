import { errorOf } from "@answerable/mcp/testing"
import { Client, StreamableHTTPClientTransport, type ListChangedCallback, type OAuthClientProvider, type Tool } from "@modelcontextprotocol/client"
import { onCleanup } from "./cleanup"

/** Serve a fetch handler on a loopback port until the kit stops. Throws when the port is busy. */
export function serve(port: number, fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch })
  onCleanup(() => server.stop(true))
  return server
}

/**
 * Connect the official MCP client to an MCP with an OAuth provider, speaking the `2025` protocol or pinned to `2026-07-28`. It closes when the kit stops.
 * With `onToolsChanged`, a `2026-07-28` client listens for `tools/list_changed` and, on each, lists the tools again and passes them, or the error.
 */
export async function connect(resource: string, provider: OAuthClientProvider, protocol: "2025" | "2026-07-28", onToolsChanged?: ListChangedCallback<Tool>) {
  const client = new Client(
    { name: "answerable-acceptance", version: "0.1.0" },
    { ...(protocol === "2026-07-28" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}), listChanged: onToolsChanged && { tools: { onChanged: onToolsChanged } } },
  )
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

/** Call a tool that must fail and return the `error` of its envelope: `code`, `message`, `retry`, `details` and `request_id`. */
export async function refusal(client: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    return errorOf(await client.callTool({ name, arguments: args }))
  } catch (problem) {
    throw new Error(`${name}: ${(problem as Error).message}`)
  }
}
