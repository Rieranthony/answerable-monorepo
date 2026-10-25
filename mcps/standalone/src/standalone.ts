import { createIdProfiles, type IdAdmin } from "@answerable/id-admin"
import { createMcpServer, type IdVerifierConfig, type Mount } from "@answerable/mcp"
import { createCalls, health, type Checked, type Tracer } from "@answerable/mcp-platform"
import type { Database } from "@answerable/mcp-postgres"

/** What `createStandalone` takes: the MCPs to serve, the origin they are served at, the ID issuer to trust, the database, ID's admin API and a tracer. */
export type StandaloneConfig = {
  /** The MCPs it serves, each with its `db` when it has a `database`: `mcpDatabases(served, …).mount`. */
  serve: readonly Mount[]
  /** The pools of the served MCPs' databases, by name, which `/health` checks beside the server's own: `mcpDatabases(served, …).pools`. */
  pools?: Readonly<Record<string, Checked>>
  /** The server's origin: each MCP is the resource `<origin>/<name>/mcp`, the audience of its tokens. */
  origin: string
  /** The Answerable ID issuer to trust, and for tests the HTTP client that reaches it. */
  auth: Pick<IdVerifierConfig, "issuer" | "fetch">
  /** The server's own database, for intents and evidence. */
  db: Database
  /** ID's admin API as the server's `platform:read` machine client: it reads who is calling, and the audit-log poller drops what it read. */
  id: IdAdmin
  /** Where spans go: `createTracer("answerable-standalone", endpoint).tracer`, or `createMemoryTracer().tracer` in tests. */
  spans: Tracer
}

const metadata = "/.well-known/oauth-protected-resource/"

/**
 * The standalone server: one process serving each MCP of `serve` on its own path, `<origin>/<name>/mcp`, with its own `createMcpServer`, whose
 * resource is that URL, so a token for one MCP is refused by another. A request goes to the MCP its path names, `/<name>/…` or
 * `/.well-known/oauth-protected-resource/<name>/…`; `GET /health` answers at the root, from every database, with the served MCPs; anything
 * else is `404`. Every MCP keeps its intents in the server's database and records evidence and a span for every call and every refusal
 * (`@answerable/mcp-platform`); a tool is refused, and the refusal recorded, unless the token carries its scopes.
 */
export function createStandalone({ serve, pools = {}, origin, auth, db, id, spans }: StandaloneConfig) {
  //#region profiles
  // Every handler is told who is calling, which only ID knows: the server's platform:read machine client reads it, cached per member.
  const profiles = createIdProfiles(id)
  //#endregion
  const calls = createCalls({ db, spans, salt: origin })
  const allow = calls.allow((principal, tool) => {
    const missing = tool.scopes.filter(scope => !principal.scopes.includes(scope))
    return missing.length ? { reason: "missing_scope", data: { missing } } : undefined
  })
  //#region servers
  // One server per MCP, its resource the MCP's own path, so a token for one MCP is refused by another.
  const servers = new Map(serve.map(({ provider, db: mcp }) => [provider.id, createMcpServer({
    provider, db: mcp, auth: { ...auth, resource: `${origin}/${provider.id}/mcp` }, profiles, intents: calls.intents, allow, wrapCall: calls.wrapCall,
  })]))
  //#endregion
  const healthy = health({ standalone: db.$client, ...pools }, [...servers.keys()])
  return {
    async fetch(request: Request) {
      const { pathname } = new URL(request.url)
      if (request.method === "GET" && pathname === "/health") return healthy()
      const name = (pathname.startsWith(metadata) ? pathname.slice(metadata.length - 1) : pathname).split("/")[1]
      return servers.get(name!)?.fetch(request) ?? new Response("Not found", { status: 404 })
    },
    /** Who each caller is, cached, for `startAuditPoller` to invalidate. */
    profiles,
  }
}
