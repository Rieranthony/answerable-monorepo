import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import { SQL } from "bun"
import { defineMutation, defineProvider, defineTool, type Provider } from "@answerable/mcp"
import { errorOf } from "@answerable/mcp/testing"
import { z } from "zod"
import { writeCatalogue } from "./catalogue"
import { migrate } from "./db/migrate"
import { createEvidence } from "./evidence"
import { createMemoryTracer } from "./spans"
import { testDatabase, testDatabaseUrl } from "./test/database"
import { createFakeId } from "./test/fake-id"
import { createHub, e2e, names, resource, view, type Hub } from "./test/hub"
import { createToolbox } from "./toolbox"

const db = testDatabase()
const evidence = createEvidence(db)
beforeAll(() => migrate(db))
afterAll(() => db.close())
const hubs: Hub[] = []
afterEach(async () => { await Promise.all(hubs.splice(0).map(hub => hub.mcp.close())) })

// Results of any size: {"text":"…"} is 11 bytes of JSON around its text.
const bulk = defineProvider({ id: "bulk", version: "2026-09-29", tools: [
  defineTool({
    name: "items.dump", description: "Return every item at once, which can exceed the Toolbox's result limit; a fixture.",
    input: z.object({ size: z.number().int() }), output: z.object({ text: z.string() }),
    async execute({ size }) { return { text: "x".repeat(size) } },
  }),
  defineMutation({
    name: "items.load", risk: "low", description: "Prepare loading items whose preview can exceed the Toolbox's result limit; a fixture.",
    input: z.object({ size: z.number().int() }), output: z.object({}),
    async prepare({ size }) { return { targets: [], preview: { summary: "Load items", changes: [{ path: "items", to: "x".repeat(size) }] } } },
    async commit() { return { results: {}, applied_changes: [], effects_performed: [] } },
  }),
] })

async function hub(providers?: Provider[]) {
  const created = await createHub(db, providers)
  hubs.push(created)
  return created
}
const events = (organisation: string) => db`select kind, outcome, capability_identity, error_code, data, trace_id, span_id, execution_id::text, request_id, reason from evidence_events where organisation_id = ${organisation} order by seq`
const everything = ["toolbox_whoami", "e2e_identity_get", "e2e_records_create", "e2e_records_delete", "e2e_records_list", "e2e_records_show", "toolbox_commit", "toolbox_commit_confirmed"]

test("a member granted a provider sees toolbox_whoami, then its capabilities by provider, domain and operation, then the commit tools", async () => {
  const { member, mcp } = await hub()
  const client = await (await member(["e2e"])).connect("2026-07-28")
  const tools = (await client.listTools()).tools
  expect(tools.map(tool => tool.name)).toEqual(everything)
  expect(tools[0]).toMatchObject({ title: "Who am I", annotations: { readOnlyHint: true }, _meta: { "com.answerable/capability": { identity: "toolbox/toolbox.whoami", version: "2026-09-29", kind: "read" } } })
  expect(tools[4]).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false }, _meta: { "com.answerable/capability": { identity: "e2e/records.list", kind: "read" } } })
  expect(tools[3]!._meta).toEqual({ "com.answerable/capability": { identity: "e2e/records.delete", version: "2026-09-29", kind: "mutate", risk: "normal", policy_class: "controlled" } })
  expect(tools[5]!._meta).toMatchObject({ ui: { resourceUri: "ui://records/index.html" } })
  expect(tools[4]!.outputSchema).toMatchObject({ type: "object", required: ["items", "next_cursor", "has_more"] })
  expect((await client.readResource({ uri: "ui://records/index.html" })).contents[0]).toMatchObject({ text: view })
  expect(await (await mcp.fetch("https://mcp.test/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject({ scopes_supported: ["toolbox"], resource_name: "toolbox" })
})

test("providers are listed in order of their ids, whatever order they are mounted in", async () => {
  const { member } = await hub([e2e(), bulk])
  expect(await names(await (await member(["e2e/identity", "bulk/items.dump"])).connect())).toEqual(["toolbox_whoami", "bulk_items_dump", "e2e_identity_get"])
})

test("toolbox_whoami names the person, organisation, membership, client and grants, and each usable capability with its policy class", async () => {
  const { member } = await hub()
  const alpha = await member(["e2e/records", "e2e/identity.get", "toolbox/approve", "crm"])
  await writeCatalogue(db, alpha.organizationId, "e2e", { enabled: true, overrides: { policy_class: { "e2e/records.delete": "human" } } })
  const client = await alpha.connect()
  expect((await client.callTool({ name: "toolbox_whoami", arguments: {} })).structuredContent).toEqual({
    user_id: alpha.userId, organisation_id: alpha.organizationId, membership_id: alpha.membershipId, client_id: "test-client",
    grants: ["crm", "e2e/identity.get", "e2e/records", "toolbox/approve"],
    capabilities: [
      { identity: "e2e/identity.get", kind: "read", policy_class: null },
      { identity: "e2e/records.create", kind: "mutate", policy_class: "agent" },
      { identity: "e2e/records.delete", kind: "mutate", policy_class: "human" },
      { identity: "e2e/records.list", kind: "read", policy_class: null },
      { identity: "e2e/records.show", kind: "read", policy_class: null },
    ],
  })
  const tools = (await client.listTools()).tools
  expect(tools.find(tool => tool.name === "e2e_records_delete")!._meta).toMatchObject({ "com.answerable/capability": { policy_class: "human" } })
})

test("a domain grant shows that domain; no grant shows only toolbox_whoami, and asking for a hidden capability is the unknown-tool error and a denial", async () => {
  const { member } = await hub()
  const beta = await (await member(["e2e/records"])).connect()
  expect(await names(beta)).toEqual(["toolbox_whoami", "e2e_records_create", "e2e_records_delete", "e2e_records_list", "e2e_records_show", "toolbox_commit", "toolbox_commit_confirmed"])
  const gamma = await member([])
  const client = await gamma.connect()
  expect(await names(client)).toEqual(["toolbox_whoami"])
  await expect(client.callTool({ name: "e2e_records_list", arguments: {} })).rejects.toThrow("Tool e2e_records_list not found")
  await expect(client.callTool({ name: "e2e_nothing_here", arguments: {} })).rejects.toThrow("Tool e2e_nothing_here not found")
  expect(await events(gamma.organizationId)).toEqual([{
    kind: "capability.denied", outcome: "denied", capability_identity: "e2e/records.list", error_code: null, data: {},
    trace_id: null, span_id: null, execution_id: null, request_id: null, reason: "not granted",
  }])
})

test("a provider the organisation has not enabled, or a capability it disabled, stays hidden when granted", async () => {
  const { member } = await hub()
  expect(await names(await (await member(["e2e"], { enable: [] })).connect())).toEqual(["toolbox_whoami"])
  const partial = await member(["e2e"])
  await writeCatalogue(db, partial.organizationId, "e2e", { enabled: true, overrides: { disabled: ["e2e/records.create", "e2e/records.delete", "e2e/records.show"] } })
  expect(await names(await partial.connect())).toEqual(["toolbox_whoami", "e2e_identity_get", "e2e_records_list"])
})

test("a token without the toolbox scope sees nothing, and each call is the unknown-tool error", async () => {
  const { member } = await hub()
  const outsider = await member(["e2e"], { scopes: ["offline_access"] })
  const client = await outsider.connect()
  expect(await names(client)).toEqual([])
  await expect(client.callTool({ name: "toolbox_whoami", arguments: {} })).rejects.toThrow("Tool toolbox_whoami not found")
  expect((await events(outsider.organizationId)).map((event: { reason: string }) => event.reason)).toEqual(["no toolbox scope"])
})

test("every call leaves one evidence row and one span: a success with its size, a failure with its code", async () => {
  const { member, spans } = await hub()
  const alpha = await member(["e2e"])
  const client = await alpha.connect()
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  const listed = await client.callTool({ name: "e2e_records_list", arguments: {}, _meta: { traceparent } })
  await client.callTool({ name: "e2e_records_delete", arguments: { id: crypto.randomUUID() } })
  await client.callTool({ name: "e2e_records_list", arguments: { limit: 0 } })
  const rows = await events(alpha.organizationId)
  expect(rows.map((row: { outcome: string; error_code: string | null; capability_identity: string }) => [row.capability_identity, row.outcome, row.error_code])).toEqual([
    ["e2e/records.list", "success", null], ["e2e/records.delete", "failure", "NOT_FOUND"], ["e2e/records.list", "failure", "INVALID_INPUT"],
  ])
  expect(rows[0].data).toEqual({ result_bytes: Buffer.byteLength(JSON.stringify(listed.structuredContent)) })
  const [first] = spans().filter(span => span.attributes["answerable.organisation.id"] === alpha.organizationId)
  expect(rows[0]).toMatchObject({ trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: first!.spanContext().spanId, execution_id: first!.attributes["gen_ai.tool.call.id"], request_id: first!.attributes["jsonrpc.request.id"] })
  expect(first!.attributes).toMatchObject({ "answerable.outcome": "success", "answerable.result.bytes": rows[0].data.result_bytes, "answerable.client.name": "test-client" })
  expect(spans().filter(span => span.attributes["answerable.organisation.id"] === alpha.organizationId).map(span => span.attributes["error.type"])).toEqual([undefined, "NOT_FOUND", "INVALID_INPUT"])
  expect(await evidence.verify(alpha.organizationId)).toEqual({ ok: true, length: 3 })
})

test("a read's result above 100 KiB answers RESULT_TOO_LARGE, a failure in the evidence and the span; a prepare's result is not limited", async () => {
  const { member, spans } = await hub([bulk])
  const reader = await member(["bulk"])
  const client = await reader.connect()
  expect((await client.callTool({ name: "bulk_items_dump", arguments: { size: 102_389 } })).structuredContent).toEqual({ text: "x".repeat(102_389) })
  expect(errorOf(await client.callTool({ name: "bulk_items_dump", arguments: { size: 102_390 } }))).toEqual({
    code: "RESULT_TOO_LARGE", retry: { policy: "after_fix_input" }, details: { bytes: 102_401, limit: 102_400 }, request_id: expect.any(String),
    message: "The result of bulk/items.dump is 102401 bytes, above the 100 KiB limit (102400 bytes); narrow the request with limit, cursor or filters",
  })
  expect((await client.callTool({ name: "bulk_items_load", arguments: { size: 110_000 } })).structuredContent).toMatchObject({ commit_tool: "toolbox_commit" })
  expect((await events(reader.organizationId)).map((row: { kind: string; outcome: string; error_code: string | null; data: unknown }) => [row.kind, row.outcome, row.error_code, row.data])).toEqual([
    ["capability.completed", "success", null, { result_bytes: 102_400 }], ["capability.completed", "failure", "RESULT_TOO_LARGE", {}],
    ["intent.prepared", "success", null, { policy_class: "agent" }], ["capability.completed", "success", null, { result_bytes: expect.any(Number) }],
  ])
  expect(spans().filter(span => span.attributes["answerable.organisation.id"] === reader.organizationId).map(span => span.attributes["error.type"])).toEqual([undefined, "RESULT_TOO_LARGE", undefined])
})

test("a mutation through the hub prepares and commits with toolbox_commit", async () => {
  const { member } = await hub()
  const client = await (await member(["e2e/records.create", "e2e/records.list"])).connect()
  const intent = (await client.callTool({ name: "e2e_records_create", arguments: { title: "Through the hub" } })).structuredContent as { intent_id: string; commit_token: string; commit_tool: string }
  expect(intent.commit_tool).toBe("toolbox_commit")
  const receipt = await client.callTool({ name: "toolbox_commit", arguments: { intent_id: intent.intent_id, commit_token: intent.commit_token } })
  expect(receipt.structuredContent).toMatchObject({ status: "committed", results: { title: "Through the hub" } })
})

test("intents live in Postgres and each transition is evidence; a commit call has its own evidence row and span, joined by the intent", async () => {
  const { member, spans } = await hub()
  const alpha = await member(["e2e/records.create"])
  const client = await alpha.connect()
  const intent = (await client.callTool({ name: "e2e_records_create", arguments: { title: "Kept" } })).structuredContent as { intent_id: string; commit_token: string }
  const args = { intent_id: intent.intent_id, commit_token: intent.commit_token }
  expect(errorOf(await client.callTool({ name: "toolbox_commit_confirmed", arguments: { ...args, preview_summary: "x" } })).code).toBe("APPROVAL_REQUIRED")
  const receipt = (await client.callTool({ name: "toolbox_commit", arguments: args })).structuredContent as { receipt_id: string }
  expect<unknown>(await db`select status, receipt ->> 'receipt_id' as receipt_id from intents where intent_id = ${intent.intent_id}`).toEqual([{ status: "committed", receipt_id: receipt.receipt_id }])
  const rows = await db`select kind, outcome, capability_identity, capability_version, error_code, intent_id::text, receipt_id::text from evidence_events where organisation_id = ${alpha.organizationId} order by seq`
  const row = (kind: string, capability_identity: string, fields: object = {}) => ({
    kind, outcome: "success", capability_identity, capability_version: "2026-09-29", error_code: null, intent_id: intent.intent_id, receipt_id: null, ...fields,
  })
  expect(rows).toEqual([
    row("intent.prepared", "e2e/records.create"), row("capability.completed", "e2e/records.create"),
    row("capability.completed", "toolbox/commit_confirmed", { outcome: "failure", error_code: "APPROVAL_REQUIRED", intent_id: null }),
    row("intent.committed", "e2e/records.create", { receipt_id: receipt.receipt_id }), row("receipt.issued", "e2e/records.create", { receipt_id: receipt.receipt_id }),
    row("capability.completed", "toolbox/commit", { receipt_id: receipt.receipt_id }),
  ])
  const own = spans().filter(span => span.attributes["answerable.organisation.id"] === alpha.organizationId)
  expect(own.map(span => [span.name, span.attributes["gen_ai.tool.name"], span.attributes["error.type"]])).toEqual([
    ["tools/call e2e/records.create", "e2e_records_create", undefined], ["tools/call toolbox/commit_confirmed", "toolbox_commit_confirmed", "APPROVAL_REQUIRED"],
    ["tools/call toolbox/commit", "toolbox_commit", undefined],
  ])
  expect(await evidence.verify(alpha.organizationId)).toEqual({ ok: true, length: 6 })
})

test("an organisation's human class holds an intent for approval: both commit tools answer APPROVAL_REQUIRED, pending, with no URL", async () => {
  const { member } = await hub()
  const beta = await member(["e2e/records"])
  await writeCatalogue(db, beta.organizationId, "e2e", { enabled: true, overrides: { policy_class: { "e2e/records.delete": "human" } } })
  const client = await beta.connect()
  const created = (await client.callTool({ name: "e2e_records_create", arguments: { title: "Held" } })).structuredContent as { intent_id: string; commit_token: string }
  const record = ((await client.callTool({ name: "toolbox_commit", arguments: { intent_id: created.intent_id, commit_token: created.commit_token } })).structuredContent as { results: { id: string } }).results
  const intent = (await client.callTool({ name: "e2e_records_delete", arguments: { id: record.id } })).structuredContent as { intent_id: string; commit_token: string; preview: { summary: string } }
  expect(intent).toMatchObject({ policy_class: "human", commit_tool: "toolbox_commit_confirmed", approval: { required: true, status: "pending" } })
  for (const [name, extra] of [["toolbox_commit", {}], ["toolbox_commit_confirmed", { preview_summary: intent.preview.summary }]] as const) {
    expect(errorOf(await client.callTool({ name, arguments: { intent_id: intent.intent_id, commit_token: intent.commit_token, ...extra } }))).toMatchObject({
      code: "APPROVAL_REQUIRED", retry: { policy: "after_approval" }, details: { approval: { class: "human", commit_tool: "toolbox_commit_confirmed", status: "pending" } },
    })
  }
  expect<unknown>(await db`select status from intents where intent_id = ${intent.intent_id}`).toEqual([{ status: "awaiting_approval" }])
  const kinds = await db`select kind from evidence_events where organisation_id = ${beta.organizationId} and intent_id = ${intent.intent_id} order by seq`
  expect(kinds.map((row: { kind: string }) => row.kind)).toEqual(["intent.prepared", "intent.approval_requested", "capability.completed"])
})

test("a grant change the poller reports reaches each listening 2026-07-28 caller as tools/list_changed; the same token then lists it", async () => {
  const { member, id, toolbox } = await hub()
  const gamma = await member([])
  const client = await gamma.connect("2026-07-28")
  const changed = new Promise(resolve => client.setNotificationHandler("notifications/tools/list_changed", resolve))
  await client.listen({ toolsListChanged: true })
  id.grant(gamma.organizationId, gamma.membershipId, [{ kind: "resource", id: resource, scopes: ["e2e/identity"] }])
  toolbox().grants.invalidate([gamma.organizationId])
  expect(await changed).toMatchObject({ method: "notifications/tools/list_changed" })
  expect(await names(client)).toEqual(["toolbox_whoami", "e2e_identity_get"])
})

test("grants are read from ID and cached; after an invalidation the same token sees the change", async () => {
  const { member, id, toolbox } = await hub()
  const gamma = await member([])
  const client = await gamma.connect()
  expect(await names(client)).toEqual(["toolbox_whoami"])
  id.grant(gamma.organizationId, gamma.membershipId, [{ kind: "resource", id: resource, scopes: ["e2e/identity"] }])
  expect(await names(client)).toEqual(["toolbox_whoami"])
  toolbox().grants.invalidate([gamma.organizationId])
  expect(await names(client)).toEqual(["toolbox_whoami", "e2e_identity_get"])
})

test("when ID cannot say what a member may use, a call answers UPSTREAM_UNAVAILABLE and a list fails", async () => {
  const { member, id } = await hub()
  const client = await (await member(["e2e"])).connect()
  id.outage(true)
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(errorOf(await client.callTool({ name: "e2e_records_list", arguments: {} }))).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retry: { policy: "after_delay" } })
    await expect(client.listTools()).rejects.toThrow()
  } finally { log.mockRestore() }
})

test("health answers ok only while the database answers", async () => {
  const own = new SQL({ url: testDatabaseUrl, max: 1 })
  const toolbox = await createToolbox({ providers: [], auth: { issuer: "https://id.test", resource }, db: own, id: createFakeId().config, spans: createMemoryTracer().tracer })
  expect(await (await toolbox.fetch(new Request("https://mcp.test/health"))).json()).toEqual({ status: "ok" })
  await own.close()
  const down = await toolbox.fetch(new Request("https://mcp.test/health"))
  expect(down.status).toBe(503)
  expect(await down.json()).toEqual({ status: "unavailable" })
  expect((await toolbox.fetch(new Request(resource, { method: "POST", headers: { Host: "mcp.test" } }))).status).toBe(401)
})
