import { expect, test } from "bun:test"
import { assertProviderConformance, createTestMcp } from "@answerable/mcp/testing"
import { provider } from "./provider"

type Intent = { intent_id: string; commit_token: string; commit_tool: string }

//#region conformance
assertProviderConformance(provider, {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: { "notes.list": { limit: 5 }, "notes.add": { text: "Buy milk" } },
})
//#endregion

//#region add-then-list
test("a note added through notes_add and its commit tool is listed", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const client = await mcp.connect()
    const prepared = await client.callTool({ name: "notes_add", arguments: { text: "Buy milk" } })
    const { intent_id, commit_token, commit_tool } = prepared.structuredContent as Intent
    await client.callTool({ name: commit_tool, arguments: { intent_id, commit_token } })
    const listed = await client.callTool({ name: "notes_list", arguments: {} })
    expect(listed.structuredContent).toMatchObject({ items: [{ text: "Buy milk" }], next_cursor: null, has_more: false })
  } finally {
    await mcp.close()
  }
})
//#endregion

test("each organisation reads its own notes, a page at a time", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const [owner, other] = [await mcp.connect(), await mcp.connect()]
    for (const text of ["One", "Two", "Three"]) {
      const prepared = await owner.callTool({ name: "notes_add", arguments: { text } })
      const { intent_id, commit_token, commit_tool } = prepared.structuredContent as Intent
      await owner.callTool({ name: commit_tool, arguments: { intent_id, commit_token } })
    }
    const first = (await owner.callTool({ name: "notes_list", arguments: { limit: 2 } })).structuredContent as { items: { text: string }[]; next_cursor: string; has_more: boolean }
    expect(first.items.map(note => note.text)).toEqual(["One", "Two"])
    expect(first.has_more).toBe(true)
    const second = await owner.callTool({ name: "notes_list", arguments: { limit: 2, cursor: first.next_cursor } })
    expect(second.structuredContent).toMatchObject({ items: [{ text: "Three" }], next_cursor: null, has_more: false })
    expect((await other.callTool({ name: "notes_list", arguments: {} })).structuredContent).toEqual({ items: [], next_cursor: null, has_more: false })
  } finally {
    await mcp.close()
  }
})
