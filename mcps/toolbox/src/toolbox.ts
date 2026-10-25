import { createIdProfiles, type IdAdmin } from "@answerable/id-admin"
import { createMcpServer, type IdVerifierConfig, type Mount, type Mutation, type Served, type Tool, type UserPrincipal } from "@answerable/mcp"
import { createCalls, health, perRequest, type Checked, type Tracer } from "@answerable/mcp-platform"
import type { Database } from "@answerable/mcp-postgres"
import { createAdmin } from "./admin"
import { ingest, readCatalogue, readHostClient } from "./catalogue"
import { createGrantsReader } from "./grants"
import { createToolboxProvider } from "./meta"
import { allowed, ordered, policyClassOf, projectionOf } from "./projection"
import { search } from "./search"

/** What `createToolbox` takes: the providers to mount, the ID issuer and resource to trust, the database, ID's admin API and a tracer. */
export type ToolboxConfig = {
  /** The providers it serves, each with its `db` when it has a `database`: `mcpDatabases(mounted, …).mount`. */
  mount: readonly Mount[]
  /** The pools of the mounted providers' databases, by name, which `/health` checks beside the Toolbox's own: `mcpDatabases(mounted, …).pools`. */
  pools?: Readonly<Record<string, Checked>>
  auth: IdVerifierConfig
  db: Database
  /** ID's admin API as the Toolbox's machine client: `createIdAdmin(config)`, shared with the audit-log poller; it also reads who is calling. */
  id: IdAdmin
  /** Where spans go: `createTracer("answerable-toolbox", endpoint).tracer`, or `createMemoryTracer().tracer` in tests. */
  spans: Tracer
}

/**
 * The Toolbox: one MCP endpoint that serves each person the capabilities their organisation granted them. It ingests every provider's manifest
 * (refusing a changed contract under an old version), reads each caller's grant strings and who they are from ID through 60-second caches that the
 * poller invalidates, and the organisation's catalogue and the host client's settings once per request, serves the direct or the meta projection,
 * runs each capability with its own provider's `db`, keeps intents in Postgres, records evidence and a span for every call, every refusal and every
 * intent transition (`@answerable/mcp-platform`), answers `RESULT_TOO_LARGE` for a read above 100 KiB, tells listening callers when a grant changes,
 * answers `GET /health` from every database with the mounted providers, and serves the platform-tier admin API under `/admin/v1`.
 */
export async function createToolbox({ mount, pools = {}, auth, db, id, spans }: ToolboxConfig) {
  const grants = createGrantsReader({ id, resource: auth.resource, changed: () => server.toolsChanged() })
  const profiles = createIdProfiles(id)
  // The most a read may answer, as JSON: larger data goes through pagination, projection or aggregation.
  const calls = createCalls({ db, spans, salt: auth.resource, readLimit: 100 * 1024 })
  const entries = mount.toSorted((a, b) => (a.provider.id < b.provider.id ? -1 : 1)).map(entry => ({ ...entry, provider: ordered(entry.provider) }))
  const mounted = entries.map(entry => entry.provider)
  const admin = createAdmin({ auth, db, providers: mounted, id, evidence: calls.evidence })
  const capabilities = mounted.flatMap(provider => provider.tools)
  const authority = perRequest((principal: UserPrincipal) => Promise.all([grants.read(principal), readCatalogue(db, principal.organizationId), readHostClient(db, principal.clientId)])
    .then(([granted, catalogue, host]) => ({ grants: granted, catalogue, host })))
  async function caller(principal: UserPrincipal) {
    const { grants: granted, catalogue } = await authority(principal)
    const usable = capabilities.filter(tool => allowed(granted, catalogue, tool))
    return { grants: granted, capabilities: usable.map(tool => ({ tool, policy_class: tool.kind === "mutate" ? policyClassOf(catalogue, tool) : null })) }
  }
  const toolbox = createToolboxProvider({
    providers: mounted,
    caller,
    search: (query, tools, page) => search(db, query, tools, page),
    // The capability a meta tool runs or refuses: the call's evidence and span are that capability's.
    run(tool, args, context) {
      calls.attribute(context.executionId, tool)
      return server.call(tool, args, context)
    },
    refused(identity, context) {
      const tool = capabilities.find(capability => capability.identity === identity)
      if (tool) calls.attribute(context.executionId, tool, "not granted")
    },
  })
  const whoami = toolbox.tools.find(tool => tool.name === "toolbox.whoami")
  const own = new Set<Served<Tool | Mutation>>(toolbox.tools)
  await ingest(db, [toolbox, ...mount.map(entry => entry.provider)])
  const server = createMcpServer({
    provider: toolbox,
    mount: entries,
    auth,
    profiles,
    intents: calls.intents,
    allow: calls.allow(async (principal, tool) => {
      if (!principal.scopes.includes("toolbox")) return { reason: "no toolbox scope" }
      if (own.has(tool)) return undefined
      const { grants: granted, catalogue } = await authority(principal)
      return allowed(granted, catalogue, tool) ? undefined : { reason: "not granted" }
    }),
    // Both projections serve toolbox_whoami; the direct one serves the granted capabilities, the meta one the Toolbox's tools that reach them.
    async project(principal, usable) {
      const meta = projectionOf((await authority(principal)).host, usable.filter(tool => !own.has(tool)).length) === "meta"
      return usable.filter(tool => tool === whoami || own.has(tool) === meta)
    },
    policyClass: async (mutation, principal) => policyClassOf((await authority(principal)).catalogue, mutation),
    wrapCall: calls.wrapCall,
  })
  const healthy = health({ toolbox: db.$client, ...pools }, mounted.map(provider => provider.id))
  return {
    async fetch(request: Request) {
      const { pathname } = new URL(request.url)
      if (/^\/admin\/v1(\/|$)/.test(pathname)) return admin(request)
      if (request.method === "GET" && pathname === "/health") return healthy()
      return server.fetch(request)
    },
    /** The grant cache, for `startAuditPoller` to invalidate; an invalidation tells listening callers that their tools changed. */
    grants,
    /** Who each caller is, cached, for `startAuditPoller` to invalidate on the same events. */
    profiles,
  }
}
