import { expect, test } from "bun:test"
import { assertProviderConformance, createTestMcp } from "@answerable/mcp-postgres/testing"
import { provider } from "./provider"

type Intent = { intent_id: string; commit_token: string; commit_tool: string; preview: { summary: string } }

// One test per check of the Answerable MCP standard, for every tool, each called with its example; and manifest.json, the contract.
assertProviderConformance(provider, { manifest: new URL("../manifest.json", import.meta.url) })

//#region add-then-list
test("a note added through notes_add and the commit tool its intent names is listed", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const client = await mcp.connect()
    const prepared = await client.callTool({ name: "notes_add", arguments: { title: "Buy milk" } })
    const { intent_id, commit_token, commit_tool, preview } = prepared.structuredContent as Intent
    await client.callTool({ name: commit_tool, arguments: { intent_id, commit_token, preview_summary: preview.summary } })
    const listed = await client.callTool({ name: "notes_list", arguments: {} })
    expect(listed.structuredContent).toMatchObject({ items: [{ title: "Buy milk" }], next_cursor: null, has_more: false })
  } finally {
    await mcp.close()
  }
})
//#endregion
