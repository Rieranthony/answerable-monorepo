import { expect, spyOn, test } from "bun:test"
import { Client } from "@modelcontextprotocol/client"
import { z } from "zod"
import { defineProvider, defineTool } from "./index"
import { createTestMcp } from "./testing"

const tools = ["read", "write"].map(scope => defineTool({
  name: `records.${scope}`, description: `A fixture tool that needs the ${scope} scope and returns nothing.`, scopes: [scope],
  input: z.object({}), output: z.object({}), async execute() { return {} },
}))
const provider = defineProvider({ id: "test", version: "2026-09-29", tools })

test("createTestMcp(provider) serves it; connect defaults to advertised scopes, explicit scopes filter, and close closes clients", async () => {
  const mcp = await createTestMcp(provider)
  const all = await mcp.connect()
  const read = await mcp.connect({ scopes: ["read"] })
  expect((await all.listTools()).tools.map(tool => tool.name)).toEqual(["records_read", "records_write"])
  expect((await read.listTools()).tools.map(tool => tool.name)).toEqual(["records_read"])
  expect((await all.callTool({ name: "records_write", arguments: {} })).structuredContent).toEqual({})
  const closeAll = spyOn(all, "close")
  const closeRead = spyOn(read, "close")
  await mcp.close()
  expect(closeAll).toHaveBeenCalledTimes(1)
  expect(closeRead).toHaveBeenCalledTimes(1)
  closeAll.mockRestore()
  closeRead.mockRestore()
})

test("fetch sets Host from its URL and preserves an explicit Host", async () => {
  const mcp = await createTestMcp(provider)
  expect((await mcp.fetch("https://mcp.test/mcp", { method: "POST" })).status).toBe(401)
  expect((await mcp.fetch(new Request("https://mcp.test/mcp", { method: "POST", headers: { Host: "override.test" } }))).status).toBe(403)
  await mcp.close()
})

test("close also closes a client whose connection failed", async () => {
  const mcp = await createTestMcp(provider)
  const connect = spyOn(Client.prototype, "connect").mockRejectedValueOnce(new Error("Unavailable"))
  const close = spyOn(Client.prototype, "close")
  try {
    await expect(mcp.connect({ scopes: [] })).rejects.toThrow("Unavailable")
    await mcp.close()
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    connect.mockRestore()
    close.mockRestore()
  }
})

test("connect can pin the membership and client, so that two connections are one principal", async () => {
  const whoami = defineTool({
    name: "caller.get", description: "A fixture tool that returns the caller's membership and client.",
    input: z.object({}), output: z.object({ membershipId: z.string(), clientId: z.string() }),
    async execute(_input, { principal }) { return { membershipId: principal.membershipId, clientId: principal.clientId } },
  })
  const mcp = await createTestMcp(defineProvider({ id: "test", version: "2026-09-29", tools: [whoami] }))
  try {
    const membershipId = crypto.randomUUID()
    for (let connection = 0; connection < 2; connection++) {
      const client = await mcp.connect({ membershipId, clientId: "claude-code" })
      expect((await client.callTool({ name: "caller_get", arguments: {} })).structuredContent).toEqual({ membershipId, clientId: "claude-code" })
    }
    const other = (await (await mcp.connect()).callTool({ name: "caller_get", arguments: {} })).structuredContent
    expect(other).toMatchObject({ clientId: "test-client" })
    expect(other).not.toMatchObject({ membershipId })
  } finally { await mcp.close() }
})
