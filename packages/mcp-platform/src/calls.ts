import { errorCodeOf, ToolError, type McpServerConfig, type Mutation, type Served, type Tool, type UserPrincipal } from "@answerable/mcp"
import { createEvidence, createPostgresIntentStore, type Database, type EvidenceEvent } from "@answerable/mcp-postgres"
import { isSpanContextValid, trace, type Tracer } from "@opentelemetry/api"
import { traced } from "./spans"

/** Why a caller may not use a tool, as its `capability.denied` evidence records it. */
export type Refusal = { reason: string; data?: Record<string, unknown> }
/** Who decides whether a caller may use a tool: `undefined` when they may, else why not. It throws when it cannot tell, such as when ID does not answer. */
export type Decide = (principal: UserPrincipal, tool: Served<Tool | Mutation>) => Refusal | undefined | Promise<Refusal | undefined>
type Capability = Readonly<{ identity: string; version: string; kind: string }>
type Fields = Omit<EvidenceEvent, "organisation_id" | "actor_type" | "actor_id">

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * The evidence and spans every Answerable server keeps of its calls, on its own database: `evidence`, the `intents` store whose transitions are
 * evidence, and the `allow` and `wrapCall` of `createMcpServer`.
 * - `allow(decide)` records a refusal of the called tool as `capability.denied` with `decide`'s reason and data, and a refusal because `decide`
 *   threw, such as ID not answering the authority read, as `capability.denied` with reason `authority_unavailable` and the error's code.
 * - `wrapCall` runs every call in a span (`traced`) and records it once it settles: `capability.completed`, a success with its result's size, the
 *   intent a prepare made or a commit applied and the commit's receipt, or a failure with its code; or `capability.denied` for a failure whose code
 *   `denials` names. A read whose result is above `readLimit` bytes of JSON answers `RESULT_TOO_LARGE`.
 * - `attribute(executionId, tool, reason?)`, from inside a call, makes the call's span and evidence that capability's, as a hub's own tool that runs
 *   or refuses another records it; with `reason`, the call's failure is a `capability.denied` for that reason.
 */
export function createCalls({ db, spans = trace.getTracer("answerable"), salt, organisation = principal => principal.organizationId, denials = {}, upstream = () => undefined, readLimit = Infinity }: {
  db: Database
  /** Where spans go: `createTracer(service, endpoint).tracer`, or `createMemoryTracer().tracer` in tests. Default: nowhere, and evidence names no trace. */
  spans?: Tracer
  /** What the span's user hash is salted with: the server's resource URL. */
  salt: string
  /** The organisation whose chain a call joins: the caller's, unless the server keeps one chain for every call, as the admin MCP keeps the platform organisation's. */
  organisation?: (principal: UserPrincipal) => string
  /** The `ToolError` codes that refuse a call rather than fail it, each with the reason its `capability.denied` row gives; the error's details are its data. */
  denials?: Readonly<Record<string, string>>
  /** The service a capability calls, named on its evidence; a commit's is that of the capability its intent prepared. */
  upstream?: (identity: string) => string | undefined
  /** The most a read may answer, in bytes of JSON, a whole number of KiB. Default: no limit. */
  readLimit?: number
}) {
  const evidence = createEvidence(db)
  const intents = createPostgresIntentStore(db, evidence)
  // The capability a hub's own tool ran or refused, by execution id: the call's evidence and span are that capability's.
  const attributed = new Map<string, { tool: Capability; reason?: string }>()
  const record = (principal: UserPrincipal, tool: Capability, fields: Fields) => evidence.record({
    organisation_id: organisation(principal), actor_type: "user", actor_id: principal.userId, client_id: principal.clientId,
    capability_identity: tool.identity, capability_version: tool.version, ...fields,
  })
  const wrapCall: NonNullable<McpServerConfig["wrapCall"]> = (call, run) => traced(spans, call, salt, async span => {
    const settled = await run().then(data => ({ data }), (failure: unknown) => ({ failure }))
    const { tool, reason } = attributed.get(call.executionId) ?? { tool: call.tool }
    attributed.delete(call.executionId)
    span.updateName(`tools/call ${tool.identity}`)
    span.setAttributes({ "answerable.capability.identity": tool.identity, "answerable.capability.version": tool.version })
    const context = span.spanContext()
    const traced = isSpanContextValid(context) ? { trace_id: context.traceId, span_id: context.spanId } : {}
    const ran = (fields: Fields) => record(call.principal, tool, {
      execution_id: call.executionId, request_id: String(call.requestId), ...traced,
      upstream: upstream(call.intent?.identity ?? tool.identity), intent_id: call.intent?.id, ...fields,
    })
    async function fail(failure: unknown): Promise<never> {
      const denial = reason ?? (failure instanceof ToolError ? denials[failure.code] : undefined)
      span.setAttribute("answerable.outcome", denial ? "denied" : "failure")
      await ran(denial
        ? { kind: "capability.denied", outcome: "denied", reason: denial, data: reason ? undefined : (failure as ToolError).details }
        : { kind: "capability.completed", outcome: "failure", error_code: errorCodeOf(failure) })
      throw failure
    }
    if ("failure" in settled) return fail(settled.failure)
    const bytes = Buffer.byteLength(JSON.stringify(settled.data))
    if (tool.kind === "read" && bytes > readLimit) {
      return fail(new ToolError("RESULT_TOO_LARGE", `The result of ${tool.identity} is ${bytes} bytes, above the ${readLimit / 1024} KiB limit (${readLimit} bytes); narrow the request with limit, cursor or filters`, { details: { bytes, limit: readLimit } }))
    }
    span.setAttributes({ "answerable.outcome": "success", "answerable.result.bytes": bytes })
    // A prepare names the intent it made; a commit, the intent it applied and its receipt.
    const ids = tool.kind === "read" ? {} : { intent_id: text(settled.data.intent_id), receipt_id: text(settled.data.receipt_id) }
    await ran({ kind: "capability.completed", outcome: "success", data: { result_bytes: bytes }, ...ids })
    return settled.data
  })
  return {
    evidence,
    intents,
    allow(decide: Decide): NonNullable<McpServerConfig["allow"]> {
      return async (principal, tool, called) => {
        let refusal: Refusal | undefined
        try {
          refusal = await decide(principal, tool)
        } catch (error) {
          if (called) await record(principal, tool, { kind: "capability.denied", outcome: "denied", reason: "authority_unavailable", error_code: errorCodeOf(error) })
          throw error
        }
        if (refusal && called) await record(principal, tool, { kind: "capability.denied", outcome: "denied", ...refusal })
        return !refusal
      }
    },
    attribute(executionId: string, tool: Capability, reason?: string) {
      attributed.set(executionId, { tool, reason })
    },
    wrapCall,
  }
}
