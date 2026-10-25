import type { IdVerifierConfig, UserPrincipal } from "@answerable/auth"
import { createTestIssuer, type TestIssuer } from "@answerable/auth/testing"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server"
import type { Profile } from "./definitions"
import type { Provider } from "./provider"
import { createMcpServer, type McpServerConfig } from "./server"

/** An in-process MCP and its authenticated protocol clients. */
export type TestMcp = {
  /** Issue unusual tokens for authentication tests. */
  readonly issuer: TestIssuer
  /** Send an HTTP request with the URL's Host header by default. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
  /**
   * Connect a client, defaulting to all advertised scopes and a fresh person, membership and organisation. Pin `userId`, `organizationId` and
   * `membershipId` to connect as the same principal twice. `person` and `organisation` replace fields of the profile the server reads for this
   * membership: the test person and organisation, unless `createTestMcp` was given `profiles`.
   */
  connect(options?: {
    scopes?: readonly string[]
    organizationId?: string
    userId?: string
    membershipId?: string
    clientId?: string
    protocol?: "2025" | "2026-07-28"
    person?: Partial<Profile["person"]>
    organisation?: Partial<Profile["organisation"]>
  }): Promise<Client>
  /** Close every client, including clients whose connection failed. */
  close(): Promise<void>
}

/** What a test's own server is built from: the local issuer's `auth` and the test `profiles`, ready to spread into `createMcpServer`'s options. */
export type TestServing = Pick<McpServerConfig, "auth" | "profiles">

const resource = "https://mcp.test/mcp"
/** The profile every caller has unless a test says otherwise. */
const testProfile: Profile = { person: { name: "Test Person", email: "person@example.test", groups: [] }, organisation: { name: "Test Organisation", slug: "test" } }

/**
 * Serve a provider in-process at `https://mcp.test/mcp`, with a local ID issuer and the official MCP client: no port, no network. Every caller is
 * the test person, `Test Person` (`person@example.test`, in no group), of the test organisation, `Test Organisation` (`test`); `profiles` replaces
 * them, and `connect({ person, organisation })` changes them for one membership. A provider with a `database` needs its `db`: an MCP with a
 * database imports `createTestMcp` from `@answerable/mcp-postgres/testing`, which makes it. In place of a provider, pass a function that builds a
 * server from the local issuer's `auth` and the test `profiles`: a server with `createMcpServer` options such as `intents` or `policyClass`, or a hub.
 *
 * @example
 * ```ts
 * import { createTestMcp } from "@answerable/mcp/testing"
 * import { provider } from "./provider"
 *
 * const mcp = await createTestMcp(provider)
 * const client = await mcp.connect({ scopes: ["example:read"], person: { name: "Ada Lovelace" } })
 * const result = await client.callTool({ name: "identity_get", arguments: {} })
 * await mcp.close()
 * ```
 */
export async function createTestMcp(
  served: Provider | ((serving: TestServing) => { fetch(request: Request): Promise<Response> } | Promise<{ fetch(request: Request): Promise<Response> }>),
  options: {
    /** The provider's database, which its handlers receive as `context.db`. */
    db?: unknown
    /** Who each caller is. Default: the test person of the test organisation. */
    profiles?: McpServerConfig["profiles"]
  } = {},
): Promise<TestMcp> {
  const issuer = await createTestIssuer()
  const auth: IdVerifierConfig = { issuer: issuer.issuer, resource, fetch: issuer.fetch }
  // What connect said to change in a membership's profile.
  const changes = new Map<string, { person?: Partial<Profile["person"]>; organisation?: Partial<Profile["organisation"]> }>()
  const resolve = options.profiles ?? (async () => testProfile)
  const profiles: McpServerConfig["profiles"] = async principal => {
    const { person, organisation } = await resolve(principal)
    const changed = changes.get(principal.membershipId)
    return { person: { ...person, ...changed?.person }, organisation: { ...organisation, ...changed?.organisation } }
  }
  const server = typeof served === "function" ? await served({ auth, profiles }) : createMcpServer({ provider: served, auth, profiles, db: options.db })
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
      const membershipId = options.membershipId ?? crypto.randomUUID()
      if (options.person || options.organisation) changes.set(membershipId, { person: options.person, organisation: options.organisation })
      const claims = Object.fromEntries(Object.entries({ membership_id: membershipId, client_id: options.clientId }).filter(([, value]) => value))
      const token = await issuer.sign({ resource, scopes, organizationId: options.organizationId, userId: options.userId, claims })
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

/**
 * A verified caller for unit tests of code that takes a principal, such as a store: a fresh person, membership, organisation and grant,
 * the client `test-client`, no scopes, organisation authorisation version 1 and a directory sign-in now, each field replaced by `overrides`.
 *
 * @example
 * ```ts
 * import { testPrincipal } from "@answerable/mcp/testing"
 *
 * const alice = testPrincipal()
 * const colleague = testPrincipal({ organizationId: alice.organizationId })
 * ```
 */
export function testPrincipal(overrides: Partial<UserPrincipal> = {}): UserPrincipal {
  return {
    userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), grantId: crypto.randomUUID(),
    clientId: "test-client", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 300, organizationAuthorizationVersion: 1,
    upstreamAuthTime: Math.floor(Date.now() / 1000), ...overrides,
  }
}
