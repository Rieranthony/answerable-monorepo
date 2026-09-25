import type { IdVerifierConfig } from "@answerable/auth"
import { createTestIssuer, type TestIssuer } from "@answerable/auth/testing"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server"

/** An in-process MCP and its authenticated protocol clients. */
export type TestMcp = {
  /** Issue unusual tokens for authentication tests. */
  readonly issuer: TestIssuer
  /** Send an HTTP request with the URL's Host header by default. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
  /** Connect a client, defaulting to all advertised scopes. */
  connect(options?: { scopes?: readonly string[]; organizationId?: string; userId?: string; protocol?: "2025" | "2026-07-28" }): Promise<Client>
  /** Close every client, including clients whose connection failed. */
  close(): Promise<void>
}

/** Run the real MCP protocol without listening on a port. */
export async function createTestMcp(
  create: (auth: IdVerifierConfig) => { fetch(request: Request): Promise<Response> },
  options: { resource?: string } = {},
): Promise<TestMcp> {
  const issuer = await createTestIssuer()
  const resource = options.resource ?? "https://mcp.test/mcp"
  const server = create({ issuer: issuer.issuer, resource, fetch: issuer.fetch })
  const clients: Client[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.headers.has("Host")) request.headers.set("Host", new URL(request.url).host)
    return server.fetch(request)
  }
  return {
    issuer, fetch,
    async connect(options = {}) {
      const scopes = options.scopes ?? (await (await fetch(getOAuthProtectedResourceMetadataUrl(new URL(resource)))).json()).scopes_supported
      const token = await issuer.sign({ resource, scopes, organizationId: options.organizationId, userId: options.userId })
      const client = new Client({ name: "answerable-test", version: "0.1.0" }, options.protocol === "2026-07-28" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {})
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch,
      }))
      return client
    },
    async close() { await Promise.all(clients.splice(0).map(client => client.close())) },
  }
}
