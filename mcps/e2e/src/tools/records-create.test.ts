import { expect, test } from "bun:test"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import { records } from "../db/schema"
import { provider } from "../provider"

type Intent = { intent_id: string; commit_token: string; commit_tool: string; policy_class: string; preview: { summary: string } }

test("records_create prepares an agent-class intent, and e2e_commit adds the record to the caller's organisation alone, in their name", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const [mine, theirs] = [crypto.randomUUID(), crypto.randomUUID()]
    const userId = crypto.randomUUID()
    const client = await mcp.connect({ organizationId: mine, userId })
    const intent = (await client.callTool({ name: "records_create", arguments: { title: "First" } })).structuredContent as Intent
    expect(intent).toMatchObject({ commit_tool: "e2e_commit", policy_class: "agent", preview: { summary: "Create record “First”" } })
    const committed = (await client.callTool({ name: intent.commit_tool, arguments: { intent_id: intent.intent_id, commit_token: intent.commit_token } })).structuredContent
    expect(committed).toMatchObject({ status: "committed", results: { title: "First", organizationId: mine, creatorId: userId, version: 1 } })
    expect(await mcp.asOrganisation(mine, () => mcp.db.select({ title: records.title }).from(records))).toEqual([{ title: "First" }])
    expect(await mcp.asOrganisation(theirs, () => mcp.db.select().from(records))).toEqual([])
    expect((await (await mcp.connect({ organizationId: theirs })).callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ items: [], next_cursor: null, has_more: false })
  } finally {
    await mcp.close()
  }
})
