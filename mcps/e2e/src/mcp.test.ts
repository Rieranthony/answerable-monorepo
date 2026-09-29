import { afterEach, expect, test } from "bun:test"
import { createTestMcp, type TestMcp } from "@answerable/mcp/testing"
import type { UserPrincipal } from "@answerable/mcp"
import { createE2eProvider } from "./mcp"
import { createRecordStore } from "./records"

const mcps: TestMcp[] = []
afterEach(async () => { await Promise.all(mcps.splice(0).map(mcp => mcp.close())) })
async function fixture() {
  const records = createRecordStore()
  const mcp = await createTestMcp(createE2eProvider({ records, viewHtml: "<!doctype html><title>Records</title>" }))
  mcps.push(mcp)
  return { mcp, records }
}
const member = (organizationId: string): UserPrincipal => ({ userId: crypto.randomUUID(), organizationId, membershipId: crypto.randomUUID(), grantId: crypto.randomUUID(), clientId: "test", scopes: [], expiresAt: 1 })
type Client = Awaited<ReturnType<TestMcp["connect"]>>
// Returns the text mirror, parsed, after checking that it equals the structured content.
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }])
  return JSON.parse((result.content as { text: string }[])[0]!.text)
}
async function refused(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  expect(result).toMatchObject({ isError: true, content: [{ type: "text" }] })
  expect(result.structuredContent).toBeUndefined()
  return JSON.parse((result.content as { text: string }[])[0]!.text).error
}
const version = "2026-09-29"

for (const protocol of ["2025", "2026-07-28"] as const) {
  test(`${protocol}: entitled clients see three read tools, two mutations and the commit tools, and their verified identity`, async () => {
    const { mcp } = await fixture()
    const organizationId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    const client = await mcp.connect({ protocol, organizationId, userId })
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name)).toEqual(["identity_get", "records_list", "records_show", "records_create", "records_delete", "e2e_commit", "e2e_commit_confirmed"])
    expect(tools.map(tool => tool._meta?.["com.answerable/capability"])).toEqual([
      ...["identity.get", "records.list", "records.show"].map(name => ({ identity: `e2e/${name}`, version, kind: "read" })),
      { identity: "e2e/records.create", version, kind: "mutate", risk: "low", policy_class: "agent" },
      { identity: "e2e/records.delete", version, kind: "mutate", risk: "normal", policy_class: "controlled" },
      { identity: "e2e/commit", kind: "commit" },
      { identity: "e2e/commit_confirmed", kind: "commit" },
    ])
    expect(tools.at(-1)!._meta!["anthropic/requiresUserInteraction"]).toBe(true)
    const identity = await client.callTool({ name: "identity_get", arguments: {} })
    expect(identity.structuredContent).toEqual({ userId, organizationId, scopes: ["e2e:identity", "e2e:read", "e2e:write"] })
    expect(identity.content).toEqual([{ type: "text", text: JSON.stringify(identity.structuredContent) }])
  })
}

test("records_list pages 20 at a time through next_cursor, and refuses an unknown cursor or an oversized page", async () => {
  const { mcp, records } = await fixture()
  const organizationId = crypto.randomUUID()
  const created = Array.from({ length: 25 }, (_, index) => records.create(member(organizationId), `Record ${index}`))
  const client = await mcp.connect({ organizationId })
  const first = await ok(client, "records_list")
  expect(first).toEqual({ items: created.slice(0, 20), next_cursor: expect.any(String), has_more: true })
  expect(await ok(client, "records_list", { cursor: first.next_cursor })).toEqual({ items: created.slice(20), next_cursor: null, has_more: false })
  expect(await ok(client, "records_list", { limit: 100 })).toEqual({ items: created, next_cursor: null, has_more: false })
  expect(await refused(client, "records_list", { cursor: "unknown" })).toEqual({
    code: "INVALID_INPUT", message: "cursor: Unknown cursor; list again without one", retry: { policy: "after_fix_input" },
    details: { field_violations: [{ field: "cursor", message: "Unknown cursor; list again without one" }] }, request_id: expect.any(String),
  })
  expect(await refused(client, "records_list", { limit: 101 })).toMatchObject({ code: "INVALID_INPUT", details: { field_violations: [{ field: "limit" }] } })
  expect(await ok(client, "records_show")).toEqual({ items: created.slice(0, 20), canWrite: true })
})

test("records_create prepares an agent-class intent that e2e_commit applies once; a repeat replays the receipt", async () => {
  const { mcp } = await fixture()
  const organizationId = crypto.randomUUID()
  const client = await mcp.connect({ organizationId })
  const intent = await ok(client, "records_create", { title: "  First record  " })
  expect(intent).toMatchObject({
    capability: "e2e/records.create", version, policy_class: "agent", commit_tool: "e2e_commit", targets: [],
    preview: { summary: "Create record “First record”", changes: [{ path: "records[]", from: null, to: { title: "First record" } }], effects: [] },
    approval: { required: false, status: "not_required" },
  })
  expect(await ok(client, "records_list")).toEqual({ items: [], next_cursor: null, has_more: false })
  const commit = { intent_id: intent.intent_id, commit_token: intent.commit_token }
  const receipt = await ok(client, "e2e_commit", commit)
  expect(receipt).toMatchObject({ intent_id: intent.intent_id, status: "committed", results: { organizationId, title: "First record", version: 1 }, idempotent_replay: false })
  expect(receipt.applied_changes).toEqual([{ path: "records[]", from: null, to: receipt.results }])
  expect(await ok(client, "e2e_commit", commit)).toEqual({ ...receipt, idempotent_replay: true })
  expect(await ok(client, "records_list")).toEqual({ items: [receipt.results], next_cursor: null, has_more: false })
})

test("records_delete names the record and its version; e2e_commit_confirmed with the summary deletes it", async () => {
  const { mcp, records } = await fixture()
  const organizationId = crypto.randomUUID()
  const record = records.create(member(organizationId), "Doomed")
  const client = await mcp.connect({ organizationId })
  const intent = await ok(client, "records_delete", { id: record.id })
  expect(intent).toMatchObject({
    capability: "e2e/records.delete", policy_class: "controlled", commit_tool: "e2e_commit_confirmed",
    targets: [{ resource_type: "record", resource_id: record.id, label: "Doomed", version: { kind: "serial", value: "1" } }],
    preview: { summary: "Delete record “Doomed”", changes: [{ path: `records[${record.id}]`, from: record, to: null }] },
  })
  const commit = { intent_id: intent.intent_id, commit_token: intent.commit_token }
  expect(await refused(client, "e2e_commit", commit)).toMatchObject({ code: "APPROVAL_REQUIRED", details: { approval: { class: "controlled", commit_tool: "e2e_commit_confirmed" } } })
  expect(await refused(client, "e2e_commit_confirmed", { ...commit, preview_summary: "Delete record" })).toMatchObject({ code: "APPROVAL_REQUIRED" })
  expect(await ok(client, "e2e_commit_confirmed", { ...commit, preview_summary: "Delete record “Doomed”" })).toMatchObject({
    results: { deleted: true, id: record.id }, applied_changes: [{ path: `records[${record.id}]`, from: record, to: null }],
  })
  expect(await ok(client, "records_list")).toEqual({ items: [], next_cursor: null, has_more: false })
})

test("a record touched between prepare and commit makes the delete stale", async () => {
  const { mcp, records } = await fixture()
  const organizationId = crypto.randomUUID()
  const owner = member(organizationId)
  const record = records.create(owner, "Moving")
  const client = await mcp.connect({ organizationId })
  const intent = await ok(client, "records_delete", { id: record.id })
  records.touch(owner, record.id)
  expect(await refused(client, "e2e_commit_confirmed", { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary })).toMatchObject({
    code: "INTENT_STALE", retry: { policy: "after_reprepare" }, details: { targets: [{ resource_id: record.id, expected: "1", current: "2" }] },
  })
  expect(await ok(client, "records_list")).toMatchObject({ items: [{ id: record.id, version: 2 }] })
})

test("the prompt and the resource describe the tools", async () => {
  const { mcp } = await fixture()
  const client = await mcp.connect()
  expect((await client.getPrompt({ name: "fixture_walkthrough", arguments: {} })).messages[0]!.content).toMatchObject({ type: "text", text: expect.stringContaining("records_list") })
  expect((await client.readResource({ uri: "fixture://guide" })).contents[0]).toMatchObject({ text: expect.stringContaining("Records belong to your authenticated organisation") })
})

test("scopes filter the tools, and organisations never share records", async () => {
  const { mcp, records } = await fixture()
  const organizationId = crypto.randomUUID()
  const record = records.create(member(organizationId), "Alice's record")
  const reader = await mcp.connect({ organizationId, scopes: ["e2e:read"] })
  const partial = await mcp.connect({ organizationId, scopes: ["e2e:identity", "e2e:read"] })
  const bob = await mcp.connect()
  expect((await reader.listTools()).tools.map(tool => tool.name)).toEqual(["records_list", "records_show"])
  expect((await partial.listTools()).tools.map(tool => tool.name)).toEqual(["identity_get", "records_list", "records_show"])
  for (const name of ["identity_get", "records_create", "e2e_commit"]) {
    await expect(reader.callTool({ name, arguments: {} })).rejects.toThrow(`Tool ${name} not found`)
  }
  await expect(partial.callTool({ name: "e2e_commit_confirmed", arguments: {} })).rejects.toThrow("Tool e2e_commit_confirmed not found")
  expect(await ok(reader, "records_list")).toEqual({ items: [record], next_cursor: null, has_more: false })
  expect(await ok(reader, "records_show")).toEqual({ items: [record], canWrite: false })
  expect(await ok(bob, "records_list")).toEqual({ items: [], next_cursor: null, has_more: false })
  expect(await ok(bob, "records_show")).toEqual({ items: [], canWrite: true })
  expect(await refused(bob, "records_delete", { id: record.id })).toMatchObject({ code: "NOT_FOUND", message: "No accessible record exists", retry: { policy: "never" } })
  expect(await ok(reader, "records_list")).toEqual({ items: [record], next_cursor: null, has_more: false })
})
