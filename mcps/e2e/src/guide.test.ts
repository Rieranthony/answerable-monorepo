import { expect, test } from "bun:test"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import { provider } from "./provider"

test("the prompt and the resource describe the tools", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const client = await mcp.connect()
    expect((await client.getPrompt({ name: "fixture_walkthrough", arguments: {} })).messages[0]!.content).toMatchObject({ type: "text", text: expect.stringContaining("records_list") })
    expect((await client.readResource({ uri: "fixture://guide" })).contents[0]).toMatchObject({ text: expect.stringContaining("Records belong to your authenticated organisation") })
  } finally {
    await mcp.close()
  }
})
