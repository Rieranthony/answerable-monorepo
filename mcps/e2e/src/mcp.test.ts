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

for (const protocol of ["2025", "2026-07-28"] as const) {
  test(`${protocol}: entitled clients see three read tools and their verified identity`, async () => {
    const { mcp } = await fixture()
    const organizationId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    const client = await mcp.connect({ protocol, organizationId, userId })
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name)).toEqual(["identity_get", "records_list", "records_show"])
    expect(tools.map(tool => tool._meta?.["com.answerable/capability"])).toEqual(["identity.get", "records.list", "records.show"].map(name => ({ identity: `e2e/${name}`, version: "2026-09-29", kind: "read" })))
    const identity = await client.callTool({ name: "identity_get", arguments: {} })
    expect(identity.structuredContent).toEqual({ userId, organizationId, scopes: ["e2e:identity", "e2e:read"] })
    expect(identity.content).toEqual([{ type: "text", text: JSON.stringify(identity.structuredContent) }])
  })
}

test("records_list pages 20 at a time through next_cursor, and refuses an unknown cursor or an oversized page", async () => {
  const { mcp, records } = await fixture()
  const organizationId = crypto.randomUUID()
  const created = Array.from({ length: 25 }, (_, index) => records.create(member(organizationId), `Record ${index}`))
  const client = await mcp.connect({ organizationId })
  const first = (await client.callTool({ name: "records_list", arguments: {} })).structuredContent as { items: unknown[]; next_cursor: string; has_more: boolean }
  expect(first).toEqual({ items: created.slice(0, 20), next_cursor: expect.any(String), has_more: true })
  expect((await client.callTool({ name: "records_list", arguments: { cursor: first.next_cursor } })).structuredContent).toEqual({ items: created.slice(20), next_cursor: null, has_more: false })
  expect((await client.callTool({ name: "records_list", arguments: { limit: 100 } })).structuredContent).toEqual({ items: created, next_cursor: null, has_more: false })
  const failure = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "records_list", arguments: args })
    expect(result).toMatchObject({ isError: true, content: [{ type: "text" }] })
    expect(result.structuredContent).toBeUndefined()
    return JSON.parse((result.content as { text: string }[])[0]!.text)
  }
  expect(await failure({ cursor: "unknown" })).toEqual({ error: {
    code: "INVALID_INPUT", message: "cursor: Unknown cursor; list again without one", retry: { policy: "after_fix_input" },
    details: { field_violations: [{ field: "cursor", message: "Unknown cursor; list again without one" }] }, request_id: expect.any(String),
  } })
  expect(await failure({ limit: 101 })).toMatchObject({ error: { code: "INVALID_INPUT", details: { field_violations: [{ field: "limit" }] } } })
  expect((await client.callTool({ name: "records_show", arguments: {} })).structuredContent).toEqual({ items: created.slice(0, 20) })
})

test("the prompt and the resource describe the read tools", async () => {
  const { mcp } = await fixture()
  const client = await mcp.connect()
  expect((await client.getPrompt({ name: "fixture_walkthrough", arguments: {} })).messages[0]!.content).toMatchObject({ type: "text", text: expect.stringContaining("records_list") })
  expect((await client.readResource({ uri: "fixture://guide" })).contents[0]).toMatchObject({ text: expect.stringContaining("Records belong to your authenticated organisation") })
})

test("scopes filter the tools and organisations never share records", async () => {
  const { mcp, records } = await fixture()
  const organizationId = crypto.randomUUID()
  const record = records.create(member(organizationId), "Alice's record")
  const reader = await mcp.connect({ organizationId, scopes: ["e2e:read"] })
  const bob = await mcp.connect()
  expect((await reader.listTools()).tools.map(tool => tool.name)).toEqual(["records_list", "records_show"])
  await expect(reader.callTool({ name: "identity_get", arguments: {} })).rejects.toThrow("Tool identity_get not found")
  expect((await reader.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ items: [record], next_cursor: null, has_more: false })
  expect((await bob.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ items: [], next_cursor: null, has_more: false })
  expect((await bob.callTool({ name: "records_show", arguments: {} })).structuredContent).toEqual({ items: [] })
})
