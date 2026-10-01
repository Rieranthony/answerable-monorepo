import { expect, spyOn, test } from "bun:test"
import { Client } from "@modelcontextprotocol/client"
import { z } from "zod"
import { defineProvider, defineTool, ToolError } from "./index"
import { createTestMcp, errorOf, testPrincipal } from "./testing"

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

test("errorOf reads the envelope of a failed call, and throws for a call that succeeded or a result that is not the envelope", async () => {
  const failing = defineTool({
    name: "records.fail", description: "A fixture tool that always answers NOT_FOUND with details.",
    input: z.object({}), output: z.object({}), async execute() { throw new ToolError("NOT_FOUND", "No accessible record exists", { details: { id: "r1" } }) },
  })
  const mcp = await createTestMcp(defineProvider({ id: "test", version: "2026-09-29", tools: [...tools, failing] }))
  try {
    const client = await mcp.connect()
    expect(errorOf(await client.callTool({ name: "records_fail", arguments: {} }))).toEqual({
      code: "NOT_FOUND", message: "No accessible record exists", retry: { policy: "never" }, details: { id: "r1" }, request_id: expect.any(String),
    })
    expect(() => errorOf({ content: [{ type: "text", text: "{}" }], structuredContent: {} })).toThrow("the call succeeded where an error was expected")
    expect(() => errorOf({ isError: true, content: [{ type: "text", text: "Tool failed" }] })).toThrow("the error text is not JSON: Tool failed")
  } finally { await mcp.close() }
})

test("testPrincipal is a verified caller for unit tests: fresh ids, the test client, no scopes, a directory sign-in now, and any field replaced", () => {
  const now = Math.floor(Date.now() / 1000)
  const [first, second] = [testPrincipal(), testPrincipal()]
  expect(first).toEqual({
    userId: expect.any(String), organizationId: expect.any(String), membershipId: expect.any(String), grantId: expect.any(String),
    clientId: "test-client", scopes: [], expiresAt: expect.any(Number), organizationAuthorizationVersion: 1, upstreamAuthTime: expect.any(Number),
  })
  expect(first.expiresAt).toBeGreaterThan(Date.now() / 1000)
  expect(first.upstreamAuthTime).toBeWithin(now, now + 2)
  expect(testPrincipal({ upstreamAuthTime: null }).upstreamAuthTime).toBeNull()
  for (const field of ["userId", "organizationId", "membershipId", "grantId"] as const) expect(first[field]).not.toBe(second[field])
  expect(testPrincipal({ organizationId: "o1", scopes: ["e2e:read"] })).toMatchObject({ organizationId: "o1", scopes: ["e2e:read"], clientId: "test-client" })
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
