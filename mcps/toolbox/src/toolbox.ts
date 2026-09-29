import type { SQL } from "bun"
import { createMcpServer, ToolError, type IdVerifierConfig, type Provider, type UserPrincipal } from "@answerable/mcp"
import type { Tracer } from "@opentelemetry/api"
import { ingest, readCatalogue, type Catalogue } from "./catalogue"
import { createEvidence, type EvidenceEvent } from "./evidence"
import { createGrantsReader } from "./grants"
import type { IdConfig } from "./id"
import { allowed, policyClassOf, project } from "./projection"
import { traced } from "./spans"
import { createToolboxProvider } from "./whoami"

/** What `createToolbox` takes: the providers to mount, the ID issuer and resource to trust, the database, ID's admin API and a tracer. */
export type ToolboxConfig = {
  providers: readonly Provider[]
  auth: IdVerifierConfig
  db: SQL
  id: IdConfig
  /** Where spans go: `createTracer(endpoint).tracer`, or `createMemoryTracer().tracer` in tests. */
  spans: Tracer
}

// The most a read may answer, as JSON: larger data goes through pagination, projection or aggregation.
const resultLimit = 100 * 1024

/**
 * The Toolbox: one MCP endpoint that serves each person the capabilities their organisation granted them. It ingests every provider's manifest
 * (refusing a changed contract under an old version), reads each caller's grant strings from ID and the organisation's catalogue on every
 * request, records evidence and a span for every call, answers `RESULT_TOO_LARGE` for a read above 100 KiB, and answers `GET /health` from the database.
 */
export async function createToolbox({ providers, auth, db, id, spans }: ToolboxConfig) {
  const grants = createGrantsReader({ id, resource: auth.resource })
  const evidence = createEvidence(db)
  const mounted = providers.toSorted((a, b) => (a.id < b.id ? -1 : 1)).map(project)
  const capabilities = mounted.flatMap(provider => provider.tools)
  // One read per request: the SDK verifies the token into a new principal for every request.
  const authorities = new WeakMap<UserPrincipal, Promise<{ grants: readonly string[]; catalogue: Catalogue }>>()
  function authority(principal: UserPrincipal) {
    let found = authorities.get(principal)
    if (!found) {
      found = Promise.all([grants.read(principal), readCatalogue(db, principal.organizationId)]).then(([granted, catalogue]) => ({ grants: granted, catalogue }))
      authorities.set(principal, found)
    }
    return found
  }
  const toolbox = createToolboxProvider(async principal => {
    const { grants: granted, catalogue } = await authority(principal)
    return {
      grants: [...granted],
      capabilities: capabilities.filter(tool => allowed(granted, catalogue, tool))
        .map(tool => ({ identity: tool.identity, kind: tool.kind, policy_class: tool.kind === "mutate" ? policyClassOf(catalogue, tool) : null })),
    }
  })
  await ingest(db, [toolbox, ...providers])
  const actor = (principal: UserPrincipal) => ({ organisation_id: principal.organizationId, actor_type: "user" as const, actor_id: principal.userId, client_id: principal.clientId })
  const server = createMcpServer({
    provider: project(toolbox),
    mount: mounted,
    auth,
    async allow(principal, tool, called) {
      const scoped = principal.scopes.includes("toolbox")
      const ok = scoped && (tool.identity.startsWith("toolbox/") || await authority(principal).then(({ grants, catalogue }) => allowed(grants, catalogue, tool)))
      if (!ok && called) {
        await evidence.record({
          ...actor(principal), kind: "capability.denied", outcome: "denied", capability_identity: tool.identity, capability_version: tool.version,
          reason: scoped ? "not granted" : "no toolbox scope",
        })
      }
      return ok
    },
    policyClass: async (mutation, principal) => policyClassOf((await authority(principal)).catalogue, mutation),
    wrapCall: (call, run) => traced(spans, call, auth.resource, async span => {
      const { traceId, spanId } = span.spanContext()
      const record = (outcome: Pick<EvidenceEvent, "outcome" | "error_code" | "data">) => evidence.record({
        ...actor(call.principal), kind: "capability.completed", capability_identity: call.tool.identity, capability_version: call.tool.version,
        execution_id: call.executionId, request_id: String(call.requestId), trace_id: traceId, span_id: spanId, ...outcome,
      })
      let data: Record<string, unknown>
      let bytes: number
      try {
        data = await run()
        bytes = Buffer.byteLength(JSON.stringify(data))
        if (call.tool.kind === "read" && bytes > resultLimit) {
          throw new ToolError("RESULT_TOO_LARGE", `The result of ${call.tool.identity} is ${bytes} bytes, above the 100 KiB limit (${resultLimit} bytes); narrow the request with limit, cursor or filters`, { details: { bytes, limit: resultLimit } })
        }
      } catch (failure) {
        span.setAttribute("answerable.outcome", "failure")
        await record({ outcome: "failure", error_code: failure instanceof ToolError ? failure.code : "INTERNAL" })
        throw failure
      }
      span.setAttributes({ "answerable.outcome": "success", "answerable.result.bytes": bytes })
      await record({ outcome: "success", data: { result_bytes: bytes } })
      return data
    }),
  })
  return {
    async fetch(request: Request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/health") {
        try {
          await db`select 1`
          return Response.json({ status: "ok" })
        } catch {
          return Response.json({ status: "unavailable" }, { status: 503 })
        }
      }
      return server.fetch(request)
    },
    /** The grant cache, for `startGrantsPoller` to invalidate. */
    grants,
  }
}
