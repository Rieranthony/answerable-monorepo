import type { SQL } from "bun"
import type { IdAdmin } from "@answerable/id-admin"
import { createMcpServer, ToolError, type IdVerifierConfig, type Mutation, type Provider, type Served, type Tool, type UserPrincipal } from "@answerable/mcp"
import { createEvidence, createPostgresIntentStore, withEvidence, type EvidenceEvent } from "@answerable/mcp-postgres"
import type { Tracer } from "@opentelemetry/api"
import { createAdmin } from "./admin"
import { ingest, readCatalogue, readHostClient, type Catalogue, type HostClient } from "./catalogue"
import { createGrantsReader } from "./grants"
import { createToolboxProvider } from "./meta"
import { allowed, ordered, policyClassOf, projectionOf } from "./projection"
import { search } from "./search"
import { traced } from "./spans"

/** What `createToolbox` takes: the providers to mount, the ID issuer and resource to trust, the database, ID's admin API and a tracer. */
export type ToolboxConfig = {
  providers: readonly Provider[]
  auth: IdVerifierConfig
  db: SQL
  /** ID's admin API as the Toolbox's machine client: `createIdAdmin(config)`, shared with `startGrantsPoller`. */
  id: IdAdmin
  /** Where spans go: `createTracer(endpoint).tracer`, or `createMemoryTracer().tracer` in tests. */
  spans: Tracer
}

// The most a read may answer, as JSON: larger data goes through pagination, projection or aggregation.
const resultLimit = 100 * 1024
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * The Toolbox: one MCP endpoint that serves each person the capabilities their organisation granted them. It ingests every provider's manifest
 * (refusing a changed contract under an old version), reads each caller's grant strings from ID, the organisation's catalogue and the host
 * client's settings on every request, serves the direct or the meta projection, keeps intents in Postgres, records evidence and a span for every
 * call and every intent transition, answers `RESULT_TOO_LARGE` for a read above 100 KiB, tells listening callers when a grant changes, answers `GET /health` from the database
 * and serves the platform-tier admin API under `/admin/v1`.
 */
export async function createToolbox({ providers, auth, db, id, spans }: ToolboxConfig) {
  const grants = createGrantsReader({ id, resource: auth.resource, changed: () => server.toolsChanged() })
  const evidence = createEvidence(db)
  const mounted = providers.toSorted((a, b) => (a.id < b.id ? -1 : 1)).map(ordered)
  const admin = createAdmin({ auth, db, providers: mounted, id, evidence })
  const capabilities = mounted.flatMap(provider => provider.tools)
  // One read per request: the SDK verifies the token into a new principal for every request.
  const authorities = new WeakMap<UserPrincipal, Promise<{ grants: readonly string[]; catalogue: Catalogue; host: HostClient }>>()
  function authority(principal: UserPrincipal) {
    let found = authorities.get(principal)
    if (!found) {
      found = Promise.all([grants.read(principal), readCatalogue(db, principal.organizationId), readHostClient(db, principal.clientId)])
        .then(([granted, catalogue, host]) => ({ grants: granted, catalogue, host }))
      authorities.set(principal, found)
    }
    return found
  }
  async function caller(principal: UserPrincipal) {
    const { grants: granted, catalogue } = await authority(principal)
    const usable = capabilities.filter(tool => allowed(granted, catalogue, tool))
    return { grants: granted, capabilities: usable.map(tool => ({ tool, policy_class: tool.kind === "mutate" ? policyClassOf(catalogue, tool) : null })) }
  }
  // The capability a meta tool ran or refused, by execution id: the call's evidence and span are that capability's.
  const named = new Map<string, { tool: Served<Tool | Mutation>; denied?: boolean }>()
  const toolbox = createToolboxProvider({
    providers: mounted,
    caller,
    search: (query, tools, page) => search(db, query, tools, page),
    run(tool, args, context) {
      named.set(context.executionId, { tool })
      return server.call(tool, args, context)
    },
    refused(identity, context) {
      const tool = capabilities.find(capability => capability.identity === identity)
      if (tool) named.set(context.executionId, { tool, denied: true })
    },
  })
  const whoami = toolbox.tools.find(tool => tool.name === "toolbox.whoami")
  const own = new Set(toolbox.tools)
  await ingest(db, [toolbox, ...providers])
  const actor = (principal: UserPrincipal) => ({ organisation_id: principal.organizationId, actor_type: "user" as const, actor_id: principal.userId, client_id: principal.clientId })
  const server = createMcpServer({
    provider: toolbox,
    mount: mounted,
    auth,
    intents: withEvidence(createPostgresIntentStore(db), evidence),
    async allow(principal, tool, called) {
      const scoped = principal.scopes.includes("toolbox")
      const ok = scoped && (own.has(tool) || await authority(principal).then(({ grants, catalogue }) => allowed(grants, catalogue, tool)))
      if (!ok && called) {
        await evidence.record({
          ...actor(principal), kind: "capability.denied", outcome: "denied", capability_identity: tool.identity, capability_version: tool.version,
          reason: scoped ? "not granted" : "no toolbox scope",
        })
      }
      return ok
    },
    // Both projections serve toolbox_whoami; the direct one serves the granted capabilities, the meta one the Toolbox's tools that reach them.
    async project(principal, usable) {
      const meta = projectionOf((await authority(principal)).host, usable.filter(tool => !own.has(tool)).length) === "meta"
      return usable.filter(tool => tool === whoami || own.has(tool) === meta)
    },
    policyClass: async (mutation, principal) => policyClassOf((await authority(principal)).catalogue, mutation),
    wrapCall: (call, run) => traced(spans, call, auth.resource, async span => {
      const settled = await run().then(data => ({ data }), (failure: unknown) => ({ failure }))
      const { tool, denied } = named.get(call.executionId) ?? { tool: call.tool }
      named.delete(call.executionId)
      span.updateName(`tools/call ${tool.identity}`)
      span.setAttributes({ "answerable.capability.identity": tool.identity, "answerable.capability.version": tool.version })
      const { traceId, spanId } = span.spanContext()
      const record = (fields: Pick<EvidenceEvent, "kind" | "outcome" | "reason" | "error_code" | "data" | "intent_id" | "receipt_id">) => evidence.record({
        ...actor(call.principal), capability_identity: tool.identity, capability_version: tool.version,
        execution_id: call.executionId, request_id: String(call.requestId), trace_id: traceId, span_id: spanId, ...fields,
      })
      async function fail(failure: unknown): Promise<never> {
        span.setAttribute("answerable.outcome", denied ? "denied" : "failure")
        await record(denied
          ? { kind: "capability.denied", outcome: "denied", reason: "not granted" }
          : { kind: "capability.completed", outcome: "failure", error_code: failure instanceof ToolError ? failure.code : "INTERNAL" })
        throw failure
      }
      if ("failure" in settled) return fail(settled.failure)
      const bytes = Buffer.byteLength(JSON.stringify(settled.data))
      if (tool.kind === "read" && bytes > resultLimit) {
        return fail(new ToolError("RESULT_TOO_LARGE", `The result of ${tool.identity} is ${bytes} bytes, above the 100 KiB limit (${resultLimit} bytes); narrow the request with limit, cursor or filters`, { details: { bytes, limit: resultLimit } }))
      }
      span.setAttributes({ "answerable.outcome": "success", "answerable.result.bytes": bytes })
      // A prepare or a commit names its intent, and a commit its receipt.
      const ids = tool.kind === "read" ? {} : { intent_id: text(settled.data.intent_id), receipt_id: text(settled.data.receipt_id) }
      await record({ kind: "capability.completed", outcome: "success", data: { result_bytes: bytes }, ...ids })
      return settled.data
    }),
  })
  return {
    async fetch(request: Request) {
      const { pathname } = new URL(request.url)
      if (/^\/admin\/v1(\/|$)/.test(pathname)) return admin(request)
      if (request.method === "GET" && pathname === "/health") {
        try {
          await db`select 1`
          return Response.json({ status: "ok" })
        } catch {
          return Response.json({ status: "unavailable" }, { status: 503 })
        }
      }
      return server.fetch(request)
    },
    /** The grant cache, for `startGrantsPoller` to invalidate; an invalidation tells listening callers that their tools changed. */
    grants,
  }
}
