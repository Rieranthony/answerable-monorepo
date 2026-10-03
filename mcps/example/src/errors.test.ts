import { expect, test } from "bun:test"
import { createTestMcp, errorOf } from "@answerable/mcp/testing"
import { provider } from "./provider"

//#region refusal
test("a cursor the server did not issue answers INVALID_INPUT", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const client = await mcp.connect()
    const result = await client.callTool({ name: "notes_list", arguments: { cursor: "not-a-cursor" } })
    expect(errorOf(result)).toMatchObject({ code: "INVALID_INPUT", retry: { policy: "after_fix_input" } })
  } finally {
    await mcp.close()
  }
})
//#endregion
