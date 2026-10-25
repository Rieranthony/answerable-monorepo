// The standalone server in process, serving e2e and example from the suite's MCP database over its test database, with a local ID issuer and a
// fake ID: a person of a fresh organisation connects to one MCP's path with the scopes a test gives.
import { createTestIssuer, type TestIssuer } from "@answerable/auth/testing"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import { createMemoryTracer, mcpDatabases } from "@answerable/mcp-platform"
import type { Database } from "@answerable/mcp-postgres"
import { provider as e2e } from "@answerable/mcp-e2e/provider"
import { provider as example } from "@answerable/mcp-example/provider"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createStandalone } from "../standalone"
import { databases, prefix } from "./mcps"

export const origin = "https://mcp.test"
type FakeId = ReturnType<typeof createFakeId>
/** Who a token is for: their organisation, membership and user. */
export type Who = { organizationId: string; membershipId: string; userId: string }

/** The standalone server over `db`, trusting `issuer` and reading who is calling from `id`: a test issuer and a fake ID of its own unless given. */
export async function startStandalone(db: Database, { issuer, id }: { issuer?: TestIssuer; id?: FakeId } = {}) {
  issuer ??= await createTestIssuer()
  id ??= createFakeId()
  const mcps = mcpDatabases([{ provider: e2e, database: "shared" }, { provider: example, database: "shared" }], { shared: databases.url, own: {}, prefix })
  const { tracer, spans } = createMemoryTracer()
  const standalone = createStandalone({ serve: mcps.mount, pools: mcps.pools, origin, auth: { issuer: issuer.issuer, fetch: issuer.fetch }, db, id: createIdAdmin(id.config), spans: tracer })
  // As a host would send it: the Host header is the URL's.
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.headers.has("Host")) request.headers.set("Host", new URL(request.url).host)
    return standalone.fetch(request)
  }
  const clients: Client[] = []
  /** A token for MCP `name`'s resource, for a person whom the fake ID knows: of a fresh organisation, unless `who` names one. */
  async function person(name: string, scopes: readonly string[], who: Partial<Who> = {}) {
    const { organizationId, membershipId, userId }: Who = { organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), userId: crypto.randomUUID(), ...who }
    id!.organisation(organizationId, { name: "Acme", slug: "acme" })
    id!.member(organizationId, { id: membershipId, userId, name: "Ada Lovelace", email: "ada@acme.test" })
    const token = await issuer!.sign({ resource: `${origin}/${name}/mcp`, scopes, organizationId, userId, claims: { membership_id: membershipId } })
    return { token, organizationId, membershipId, userId }
  }
  /** Connect the official MCP client to MCP `name`'s path with a token for `name`. */
  async function connect(name: string, scopes: readonly string[], who?: Partial<Who>) {
    const { token, ...known } = await person(name, scopes, who)
    const client = new Client({ name: "standalone-test", version: "0.1.0" })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/${name}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch }))
    return { client, ...known }
  }
  return {
    fetch, person, connect, spans, mcps,
    async close() {
      await Promise.all(clients.splice(0).map(client => client.close()))
      await mcps.close()
    },
  }
}
