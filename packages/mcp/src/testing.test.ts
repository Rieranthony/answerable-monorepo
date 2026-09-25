import { expect, spyOn, test } from "bun:test"
import { Client } from "@modelcontextprotocol/client"
import { z } from "zod"
import { createMcpServer, defineTool } from "./index"
import { createTestMcp } from "./testing"

test("connect defaults to advertised scopes, explicit scopes filter, and close closes clients", async () => {
  const tools = ["read", "write"].map(name => defineTool({ name, description: name, scopes: [name], input: z.object({}), output: z.object({}), async execute() { return {} } }))
  const mcp = await createTestMcp(auth => createMcpServer({ name: "test", version: "1", auth, tools }))
  const all = await mcp.connect()
  const read = await mcp.connect({ scopes: ["read"] })
  expect((await all.listTools()).tools.map(tool => tool.name)).toEqual(["read", "write"])
  expect((await read.listTools()).tools.map(tool => tool.name)).toEqual(["read"])
  expect((await all.callTool({ name: "write", arguments: {} })).structuredContent).toEqual({})
  const closeAll = spyOn(all, "close")
  const closeRead = spyOn(read, "close")
  await mcp.close()
  expect(closeAll).toHaveBeenCalledTimes(1)
  expect(closeRead).toHaveBeenCalledTimes(1)
  closeAll.mockRestore()
  closeRead.mockRestore()
})

test("fetch sets Host from its URL and preserves explicit headers", async () => {
  const mcp = await createTestMcp(() => ({ async fetch(request) { return Response.json({ host: request.headers.get("Host") }) } }))
  expect(await (await mcp.fetch(new URL("https://example.test:1234/path"))).json()).toEqual({ host: "example.test:1234" })
  expect(await (await mcp.fetch(new Request("https://example.test", { headers: { Host: "override.test" } }))).json()).toEqual({ host: "override.test" })
  await mcp.close()
})

test("close also closes a client whose connection failed", async () => {
  const mcp = await createTestMcp(() => ({ async fetch() { return new Response("Unavailable", { status: 503 }) } }))
  const close = spyOn(Client.prototype, "close")
  try {
    await expect(mcp.connect({ scopes: [] })).rejects.toThrow()
    close.mockClear()
    await mcp.close()
    expect(close).toHaveBeenCalledTimes(1)
  } finally { close.mockRestore() }
})
