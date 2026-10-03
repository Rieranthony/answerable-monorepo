import { afterEach, expect, test } from "bun:test"
import { createTestMcp, errorOf, testPrincipal, type TestMcp } from "@answerable/mcp/testing"
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
type Client = Awaited<ReturnType<TestMcp["connect"]>>
// Returns the text mirror, parsed, after checking that it equals the structured content.
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }])
  return JSON.parse((result.content as { text: string }[])[0]!.text)
}
const refused = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => errorOf(await client.callTool({ name, arguments: args }))
const version = "2026-09-29"

test("entitled clients see three read tools, two mutations and the commit tools, and their verified identity", async () => {
  const { mcp } = await fixture()
  const organizationId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const client = await mcp.connect({ organizationId, userId })
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

test("records_list pages 20 at a time through next_cursor, and refuses an unknown cursor or an oversized page", async () => {
  const { mcp, records } = await fixture()
  const organizationId = crypto.randomUUID()
  const created = Array.from({ length: 25 }, (_, index) => records.create(testPrincipal({ organizationId }), `Record ${index}`))
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
  const shown = await ok(client, "records_show")
  expect(shown).toEqual({ items: created.slice(0, 20), next_cursor: expect.any(String), has_more: true, canWrite: true })
  expect(await ok(client, "records_show", { cursor: shown.next_cursor, limit: 10 })).toEqual({ items: created.slice(20), next_cursor: null, has_more: false, canWrite: true })
})

test("the prompt and the resource describe the tools", async () => {
  const { mcp } = await fixture()
  const client = await mcp.connect()
  expect((await client.getPrompt({ name: "fixture_walkthrough", arguments: {} })).messages[0]!.content).toMatchObject({ type: "text", text: expect.stringContaining("records_list") })
  expect((await client.readResource({ uri: "fixture://guide" })).contents[0]).toMatchObject({ text: expect.stringContaining("Records belong to your authenticated organisation") })
})
