import { afterAll, beforeAll, expect, test } from "bun:test"
import { createTestMcp, type DatabaseTestMcp } from "@answerable/mcp-postgres/testing"
import { errorOf } from "@answerable/mcp/testing"
import { records } from "../db/schema"
import { provider } from "../provider"
import { recordOf } from "../records"

let mcp: DatabaseTestMcp
beforeAll(async () => { mcp = await createTestMcp(provider) })
afterAll(() => mcp.close())

// The caller's organisation's records, made in its name, in the order of their ids.
async function seed(organizationId: string, count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({ organisation_id: organizationId, creator_id: crypto.randomUUID(), title: `Record ${index}` }))
  return (await mcp.asOrganisation(organizationId, () => mcp.db.insert(records).values(rows).returning())).map(recordOf).toSorted((a, b) => (a.id < b.id ? -1 : 1))
}

test("records_list pages 20 at a time through next_cursor, oldest first, and records_show shows the same page", async () => {
  const organizationId = crypto.randomUUID()
  const created = await seed(organizationId, 25)
  const client = await mcp.connect({ organizationId })
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })).structuredContent as Record<string, unknown>
  const first = await call("records_list")
  expect(first).toEqual({ items: created.slice(0, 20), next_cursor: created[19]!.id, has_more: true })
  expect(await call("records_list", { cursor: first.next_cursor })).toEqual({ items: created.slice(20), next_cursor: null, has_more: false })
  expect(await call("records_list", { limit: 100 })).toEqual({ items: created, next_cursor: null, has_more: false })
  const shown = await call("records_show")
  expect(shown).toEqual({ items: created.slice(0, 20), next_cursor: created[19]!.id, has_more: true, canWrite: true })
  expect(await call("records_show", { cursor: shown.next_cursor, limit: 10 })).toEqual({ items: created.slice(20), next_cursor: null, has_more: false, canWrite: true })
  const reader = await mcp.connect({ organizationId, scopes: ["e2e:read"] })
  expect((await reader.callTool({ name: "records_show", arguments: { limit: 1 } })).structuredContent).toMatchObject({ canWrite: false })
})

test("records_list refuses a cursor its own list did not issue: unknown, another organisation's, or no id at all; and an oversized page", async () => {
  const [mine, theirs] = [crypto.randomUUID(), crypto.randomUUID()]
  await seed(mine, 1)
  const [other] = await seed(theirs, 1)
  const client = await mcp.connect({ organizationId: mine })
  for (const cursor of ["unknown", crypto.randomUUID(), other!.id]) {
    expect(errorOf(await client.callTool({ name: "records_list", arguments: { cursor } }))).toEqual({
      code: "INVALID_INPUT", message: "cursor: Unknown cursor; list again without one", retry: { policy: "after_fix_input" },
      details: { field_violations: [{ field: "cursor", message: "Unknown cursor; list again without one" }] }, request_id: expect.any(String),
    })
  }
  expect(errorOf(await client.callTool({ name: "records_list", arguments: { limit: 101 } }))).toMatchObject({ code: "INVALID_INPUT", details: { field_violations: [{ field: "limit" }] } })
})
