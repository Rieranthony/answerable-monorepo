import { afterEach, expect, test } from "bun:test"
import { createTestMcp, type TestMcp } from "@answerable/mcp/testing"
import { createE2eMcp } from "./mcp"
import { createRecordStore } from "./records"
import { recordSchema } from "./contracts"

const mcps: TestMcp[] = []
afterEach(async () => { await Promise.all(mcps.splice(0).map(mcp => mcp.close())) })
async function fixture() {
  const records = createRecordStore()
  const mcp = await createTestMcp(auth => createE2eMcp({ auth, records, viewHtml: "<!doctype html><title>Records</title>" }))
  mcps.push(mcp)
  return mcp
}

for (const protocol of ["2025", "2026-07-28"] as const) {
  test(`${protocol}: entitled clients see five tools and their verified identity`, async () => {
    const mcp = await fixture()
    const organizationId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    const client = await mcp.connect({ protocol, organizationId, userId })
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["identity_get", "records_list", "records_show", "records_create", "records_delete"])
    const identity = await client.callTool({ name: "identity_get", arguments: {} })
    expect(identity.structuredContent).toEqual({ userId, organizationId, scopes: ["e2e:identity", "e2e:read", "e2e:write"] })
    expect(identity.content).toEqual([{ type: "text", text: JSON.stringify(identity.structuredContent) }])
  })
}
test("records round trip, domain errors, prompts and resources", async () => {
  const mcp = await fixture()
  const client = await mcp.connect()
  const created = await client.callTool({ name: "records_create", arguments: { title: "  Example  " } })
  expect(created.isError).not.toBe(true)
  const record = recordSchema.parse(created.structuredContent)
  expect(record.title).toBe("Example")
  expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ records: [record] })
  expect((await client.callTool({ name: "records_show", arguments: {} })).structuredContent).toEqual({ records: [record], canWrite: true })
  expect((await client.callTool({ name: "records_delete", arguments: { recordId: record.id } })).structuredContent).toEqual({ deleted: true, id: record.id })
  expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ records: [] })
  expect(await client.callTool({ name: "records_delete", arguments: { recordId: record.id } })).toMatchObject({ isError: true, content: [{ type: "text", text: "record_not_found: No accessible record exists" }] })
  expect((await client.getPrompt({ name: "fixture_walkthrough", arguments: {} })).messages[0]!.content).toMatchObject({ type: "text", text: expect.stringContaining("fixture://guide") })
  expect((await client.readResource({ uri: "fixture://guide" })).contents[0]).toMatchObject({ text: expect.stringContaining("Records belong to your authenticated organisation") })
})
test("read-only clients cannot write and organisations never share records", async () => {
  const mcp = await fixture()
  const organizationId = crypto.randomUUID()
  const alice = await mcp.connect({ organizationId })
  const reader = await mcp.connect({ organizationId, scopes: ["e2e:identity", "e2e:read"] })
  const bob = await mcp.connect()
  expect((await reader.listTools()).tools.map(tool => tool.name)).toEqual(["identity_get", "records_list", "records_show"])
  const record = recordSchema.parse((await alice.callTool({ name: "records_create", arguments: { title: "Alice's record" } })).structuredContent)
  expect((await reader.callTool({ name: "records_show", arguments: {} })).structuredContent).toEqual({ records: [record], canWrite: false })
  await expect(reader.callTool({ name: "records_create", arguments: { title: "Denied" } })).rejects.toThrow()
  expect((await bob.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ records: [] })
  expect((await bob.callTool({ name: "records_delete", arguments: { recordId: record.id } })).isError).toBe(true)
  const other = (await bob.callTool({ name: "records_create", arguments: { title: "Bob's record" } })).structuredContent!
  expect((await alice.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ records: [record] })
  expect((await bob.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ records: [other] })
})
