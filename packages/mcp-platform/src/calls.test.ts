import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createMcpServer, defineMutation, defineProvider, defineTool, ToolError, type ToolCall } from "@answerable/mcp"
import { createTestMcp, errorOf, testPrincipal } from "@answerable/mcp/testing"
import { migrate } from "@answerable/mcp-postgres"
import { mcpPostgresTestConfig, rowsOf, testDatabase } from "@answerable/mcp-postgres/testing"
import { z } from "zod"
import { createCalls, type Decide } from "./calls"
import { createMemoryTracer } from "./spans"

// A server's own database, with the tables every server has (evidence and intents): answerable_mcps_test_platform, made beside the shared MCP test
// database and migrated from @answerable/mcp-postgres's own folder.
let hub: Awaited<ReturnType<ReturnType<typeof testDatabase>["scratch"]>>
beforeAll(async () => {
  hub = await testDatabase("answerable_mcps_test", mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL).scratch("platform")
  await migrate(hub.db, { folder: fileURLToPath(new URL("../drizzle", import.meta.resolve("@answerable/mcp-postgres"))) })
})
afterAll(() => hub.drop())

const purpose = (text: string) => `${text}. A fixture for the tests of the platform's evidence.`
const big = defineTool({ name: "notes.big", description: purpose("Answer more than the read limit"), input: z.object({}), output: z.object({ text: z.string() }), async execute() { return { text: "x".repeat(1024) } } })
const stale = defineTool({
  name: "notes.stale", description: purpose("Refuse as a stale sign-in would"), errors: ["NOTES_STALE"], input: z.object({}), output: z.object({}),
  async execute() { throw new ToolError("NOTES_STALE", "Sign in again", { retry: { policy: "after_state_change" }, details: { max_age_seconds: 60 } }) },
})
const broken = defineTool({ name: "notes.broken", description: purpose("Fail as a handler with a bug would"), input: z.object({}), output: z.object({}), async execute() { throw new Error("bug") } })
const add = defineMutation({
  name: "notes.add", risk: "low", description: purpose("Prepare adding a note; commit the intent to add it"), errors: ["NOTES_CONFLICT"],
  input: z.object({ text: z.string() }), output: z.object({ text: z.string() }),
  async prepare({ text }) { return { targets: [], preview: { summary: `Add “${text}”`, changes: [{ path: "notes[]", to: text }] }, plan: { text } } },
  async commit({ plan }) {
    if (plan.text === "fail") throw new ToolError("NOTES_CONFLICT", "Not this one", { retry: { policy: "never" } })
    return { results: { text: plan.text }, applied_changes: [], effects_performed: [] }
  },
})
const provider = defineProvider({ id: "notes", description: purpose("Notes"), version: "2026-10-25", tools: [big, stale, broken, add] })

type Row = Record<"kind" | "outcome" | "capability_identity", string> & Record<"reason" | "error_code" | "upstream" | "intent_id" | "receipt_id" | "execution_id" | "trace_id", string | null> & { data: Record<string, unknown> }
const chain = (organisation: string) => rowsOf(hub.db)<Row>`select kind, outcome, capability_identity, reason, error_code, upstream, intent_id::text, receipt_id::text, execution_id::text, trace_id, data
  from evidence_events where organisation_id = ${organisation} and kind like 'capability.%' order by seq`

async function serve(decide: Decide, options: Partial<Parameters<typeof createCalls>[0]> = {}) {
  const { tracer, spans } = createMemoryTracer()
  const calls = createCalls({ db: hub.db, spans: tracer, salt: "https://mcp.test/mcp", readLimit: 1024, ...options })
  const mcp = await createTestMcp(serving => createMcpServer({ ...serving, provider, intents: calls.intents, allow: calls.allow(decide), wrapCall: calls.wrapCall }))
  return { mcp, spans, calls }
}

test("a refusal because ID did not answer the authority read is evidence: capability.denied, authority_unavailable, with the error's code", async () => {
  const { mcp } = await serve(() => { throw new ToolError("UPSTREAM_UNAVAILABLE", "Answerable ID did not answer") })
  try {
    const organizationId = crypto.randomUUID()
    const client = await mcp.connect({ organizationId })
    expect(errorOf(await client.callTool({ name: "notes_big", arguments: {} })).code).toBe("UPSTREAM_UNAVAILABLE")
    expect(await chain(organizationId)).toEqual([expect.objectContaining({
      kind: "capability.denied", outcome: "denied", capability_identity: "notes/notes.big", reason: "authority_unavailable", error_code: "UPSTREAM_UNAVAILABLE", execution_id: null,
    })])
  } finally {
    await mcp.close()
  }
})

test("a refusal allow decides is evidence for the called tool alone, with its reason and data", async () => {
  const { mcp } = await serve((principal, tool) => (tool.identity === "notes/notes.big" ? { reason: "missing_scope", data: { missing: ["notes:big"] } } : undefined))
  try {
    const organizationId = crypto.randomUUID()
    const client = await mcp.connect({ organizationId })
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("notes_big")
    await expect(client.callTool({ name: "notes_big", arguments: {} })).rejects.toThrow("Tool notes_big not found")
    expect(await chain(organizationId)).toEqual([expect.objectContaining({ kind: "capability.denied", capability_identity: "notes/notes.big", reason: "missing_scope", data: { missing: ["notes:big"] } })])
  } finally {
    await mcp.close()
  }
})

test("every call is evidence with its span: a failure's code, a denial's reason and details, and a read above the limit", async () => {
  const { mcp, spans } = await serve(() => undefined, { denials: { NOTES_STALE: "stale_authentication" } })
  try {
    const organizationId = crypto.randomUUID()
    const client = await mcp.connect({ organizationId })
    expect(errorOf(await client.callTool({ name: "notes_big", arguments: {} }))).toMatchObject({
      code: "RESULT_TOO_LARGE", message: "The result of notes/notes.big is 1035 bytes, above the 1 KiB limit (1024 bytes); narrow the request with limit, cursor or filters", details: { bytes: 1035, limit: 1024 },
    })
    expect(errorOf(await client.callTool({ name: "notes_stale", arguments: {} })).code).toBe("NOTES_STALE")
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(errorOf(await client.callTool({ name: "notes_broken", arguments: {} })).code).toBe("INTERNAL")
    } finally { log.mockRestore() }
    const rows = await chain(organizationId)
    expect(rows.map(({ kind, outcome, capability_identity, reason, error_code, data }) => ({ kind, outcome, capability_identity, reason, error_code, data }))).toEqual([
      { kind: "capability.completed", outcome: "failure", capability_identity: "notes/notes.big", reason: null, error_code: "RESULT_TOO_LARGE", data: {} },
      { kind: "capability.denied", outcome: "denied", capability_identity: "notes/notes.stale", reason: "stale_authentication", error_code: null, data: { max_age_seconds: 60 } },
      { kind: "capability.completed", outcome: "failure", capability_identity: "notes/notes.broken", reason: null, error_code: "INTERNAL", data: {} },
    ])
    const finished = spans()
    expect(rows.map(row => row.trace_id)).toEqual(finished.map(span => span.spanContext().traceId))
    expect(finished.map(span => span.attributes["answerable.outcome"])).toEqual(["failure", "denied", "failure"])
  } finally {
    await mcp.close()
  }
})

test("a commit's evidence names the intent it applied and its receipt, and a failed commit its intent; its upstream is that of the intent's capability", async () => {
  const { mcp } = await serve(() => undefined, { upstream: identity => (identity === "notes/notes.add" ? "notes-service" : undefined) })
  try {
    const organizationId = crypto.randomUUID()
    const client = await mcp.connect({ organizationId })
    const prepare = async (text: string) => (await client.callTool({ name: "notes_add", arguments: { text } })).structuredContent as { intent_id: string; commit_token: string }
    const [kept, failed] = [await prepare("kept"), await prepare("fail")]
    const receipt = (await client.callTool({ name: "notes_commit", arguments: { intent_id: kept.intent_id, commit_token: kept.commit_token } })).structuredContent as { receipt_id: string }
    expect(errorOf(await client.callTool({ name: "notes_commit", arguments: { intent_id: failed.intent_id, commit_token: failed.commit_token } })).code).toBe("NOTES_CONFLICT")
    expect((await chain(organizationId)).map(({ kind, outcome, capability_identity, error_code, upstream, intent_id, receipt_id, data }) => ({ kind, outcome, capability_identity, error_code, upstream, intent_id, receipt_id, data }))).toEqual([
      { kind: "capability.completed", outcome: "success", capability_identity: "notes/notes.add", error_code: null, upstream: "notes-service", intent_id: kept.intent_id, receipt_id: null, data: { result_bytes: expect.any(Number) } },
      { kind: "capability.completed", outcome: "success", capability_identity: "notes/notes.add", error_code: null, upstream: "notes-service", intent_id: failed.intent_id, receipt_id: null, data: { result_bytes: expect.any(Number) } },
      { kind: "capability.completed", outcome: "success", capability_identity: "notes/commit", error_code: null, upstream: "notes-service", intent_id: kept.intent_id, receipt_id: receipt.receipt_id, data: { result_bytes: expect.any(Number) } },
      { kind: "capability.completed", outcome: "failure", capability_identity: "notes/commit", error_code: "NOTES_CONFLICT", upstream: "notes-service", intent_id: failed.intent_id, receipt_id: null, data: {} },
    ])
  } finally {
    await mcp.close()
  }
})

test("without a tracer, a call's evidence names no trace", async () => {
  const calls = createCalls({ db: hub.db, salt: "salt" })
  const principal = testPrincipal()
  const call = Object.freeze({ tool: { kind: "read" as const, identity: "notes/notes.big", version: "2026-10-25" }, name: "notes_big", principal, executionId: Bun.randomUUIDv7(), requestId: 1, meta: {} }) as unknown as ToolCall
  await calls.wrapCall(call, async () => ({}))
  expect((await chain(principal.organizationId)).map(row => row.trace_id)).toEqual([null])
})

test("a hub's own tool names the capability it ran or refused: the call's span and evidence are that capability's", async () => {
  const { tracer, spans } = createMemoryTracer()
  const calls = createCalls({ db: hub.db, spans: tracer, salt: "salt" })
  const principal = testPrincipal()
  const call = () => Object.freeze({ tool: { kind: "read" as const, identity: "hub/hub.run", version: "1" }, name: "hub_run", principal, executionId: Bun.randomUUIDv7(), requestId: 1, meta: {} }) as unknown as ToolCall
  const capability = { identity: "notes/notes.big", version: "2026-10-25", kind: "read" }
  const ran = call()
  expect(await calls.wrapCall(ran, async () => (calls.attribute(ran.executionId, capability), { ok: true }))).toEqual({ ok: true })
  const refused = call()
  await expect(calls.wrapCall(refused, async () => { calls.attribute(refused.executionId, capability, "not granted"); throw new ToolError("PERMISSION_DENIED", "No") })).rejects.toThrow("No")
  expect((await chain(principal.organizationId)).map(({ kind, outcome, capability_identity, reason }) => ({ kind, outcome, capability_identity, reason }))).toEqual([
    { kind: "capability.completed", outcome: "success", capability_identity: "notes/notes.big", reason: null },
    { kind: "capability.denied", outcome: "denied", capability_identity: "notes/notes.big", reason: "not granted" },
  ])
  expect(spans().map(span => span.name)).toEqual(["tools/call notes/notes.big", "tools/call notes/notes.big"])
})
