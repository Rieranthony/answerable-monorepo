import { expect, test } from "bun:test"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import { provider } from "../provider"

test("example_status says who is calling and from which organisation", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const client = await mcp.connect({ person: { name: "Ada Lovelace" }, organisation: { name: "Acme" } })
    const result = await client.callTool({ name: "example_status", arguments: {} })
    expect(result.structuredContent).toEqual({ status: "ok", person: "Ada Lovelace", organisation: "Acme" })
  } finally {
    await mcp.close()
  }
})
