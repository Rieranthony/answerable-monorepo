import { afterEach, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { createMcpServer, defineTool, defineView, definePrompt, defineResource, ToolError, type ToolContext, type Tool, type Prompt } from "./index"
import { createTestMcp, type TestMcp } from "./testing"

const resource = "https://mcp.test/mcp"
const auth = { issuer: "https://id.test", resource }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const view = defineView({ name: "example", html: "<!doctype html><title>Example</title>" })
let executions = 0
const read = defineTool({
  name: "read", title: "Read organisation", description: "Read the caller's organisation", scopes: ["read"], view,
  input: z.object({ label: z.string().trim().min(1) }).strict(),
  output: z.object({ organizationId: z.uuid(), label: z.string() }),
  async execute(input, { principal }) {
    executions++
    return { organizationId: principal.organizationId, label: input.label }
  },
})
const write = defineTool({
  name: "write", description: "Requires both permissions", scopes: ["read", "write"],
  input: z.object({}), output: z.object({}), async execute() { return {} },
})
const invalid = defineTool({
  name: "invalid", description: "Invalid output", scopes: ["read"],
  input: z.object({}), output: z.object({ value: z.string().max(2) }),
  async execute() { return { value: "private-output-secret" } },
})
const failed = defineTool({
  name: "failed", description: "Unexpected failure", scopes: ["read"],
  input: z.object({}), output: z.object({}), async execute() { throw new Error("private-exception-secret") },
})
const known = defineTool({
  name: "known", description: "Domain failure", scopes: ["read"],
  input: z.object({}), output: z.object({}), async execute() { throw new ToolError("record_not_found", "No accessible record exists") },
})
const prompt = definePrompt({
  name: "guide", description: "Organisation instructions", scopes: ["content"], input: z.object({ topic: z.string().trim() }),
  async execute({ topic }, { principal }) {
    return { messages: [{ role: "user", content: { type: "text", text: `${topic}:${principal.organizationId}` } }] }
  },
})
const document = defineResource({
  name: "document", uri: "fixture://document", description: "Organisation document", mimeType: "text/plain", scopes: ["content"],
  async read({ principal }) { return principal.organizationId },
})
const broken = defineResource({
  name: "broken", uri: "fixture://broken", description: "Failure", mimeType: "text/plain", scopes: ["content"],
  async read() { throw new Error("private-resource-secret") },
})
const brokenPrompt = definePrompt({
  name: "broken_prompt", description: "Failure", scopes: ["content"], input: z.object({}),
  async execute() { throw new Error("private-prompt-secret") },
})

async function fixture(tools: readonly Tool[] = [read, write, invalid, failed, known], prompts: readonly Prompt[] = [prompt, brokenPrompt]) {
  const mcp = await createTestMcp(auth => createMcpServer({
    name: "test", version: "1", auth, tools, prompts, resources: [document, broken],
  }))
  cleanups.push(() => mcp.close())
  return mcp
}
async function clientFor(mcp: TestMcp, scopes: string[], protocol?: "2025" | "2026-07-28", organizationId = crypto.randomUUID()) {
  const client = await mcp.connect({ scopes, protocol, organizationId })
  return { client, organizationId }
}

test("HTTP routes expose health, discovery and a bearer challenge", async () => {
  const mcp = await fixture()
  const response = await mcp.fetch(resource, { method: "POST" })
  expect(response.status).toBe(401)
  expect(response.headers.get("WWW-Authenticate")).toContain('resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"')
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  expect(await (await mcp.fetch("https://mcp.test/health")).json()).toEqual({ status: "ok" })
  expect((await mcp.fetch("https://mcp.test/unknown")).status).toBe(404)
  expect(await (await mcp.fetch("https://mcp.test/.well-known/oauth-protected-resource/mcp")).json()).toEqual({
    resource, authorization_servers: [mcp.issuer.issuer], scopes_supported: ["content", "read", "write"], bearer_methods_supported: ["header"], resource_name: "test",
  })
})
test("rejects untrusted hosts, origins and a token for another audience", async () => {
  const mcp = await fixture()
  expect((await mcp.fetch(resource, { headers: { Host: "evil.test" } })).status).toBe(403)
  const token = await mcp.issuer.sign({ resource, scopes: ["read"] })
  const before = executions
  const response = await mcp.fetch(resource, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { label: "test" } } }) })
  expect(response.status).toBe(403)
  expect(executions).toBe(before)
  const other = await mcp.issuer.sign({ resource: "https://other.test/mcp" })
  expect((await mcp.fetch(resource, { method: "POST", headers: { Authorization: `Bearer ${other}` } })).status).toBe(401)
})

for (const protocol of [undefined, "2026-07-28"] as const) {
  const era = protocol ?? "default 2025"
  test(`${era}: scopes filter tools and views, and results retain the caller`, async () => {
    const mcp = await fixture()
    const { client, organizationId } = await clientFor(mcp, ["read"], protocol)
    const listed = (await client.listTools()).tools
    expect(listed.map(tool => tool.name)).toEqual(["read", "invalid", "failed", "known"])
    expect(listed.find(tool => tool.name === "read")).toMatchObject({ title: "Read organisation", _meta: { ui: { resourceUri: view.uri } } })
    expect((await client.callTool({ name: "read", arguments: { label: "  trimmed  " } })).structuredContent).toEqual({ organizationId, label: "trimmed" })
    expect((await client.readResource({ uri: view.uri })).contents[0]).toEqual({ uri: view.uri, mimeType: "text/html;profile=mcp-app", text: view.html })
    await expect(client.callTool({ name: "write", arguments: {} })).rejects.toThrow()
    const denied = await clientFor(mcp, ["write"], protocol)
    expect(denied.client.getServerCapabilities()?.tools).toBeDefined()
    expect((await denied.client.listTools()).tools).toEqual([])
    await expect(denied.client.readResource({ uri: view.uri })).rejects.toThrow()
    const granted = await clientFor(mcp, ["read", "write"], protocol)
    expect((await granted.client.listTools()).tools.map(tool => tool.name)).toContain("write")
    expect((await granted.client.callTool({ name: "write", arguments: {} })).isError).not.toBe(true)
  })
  test(`${era}: concurrent clients retain separate organisations`, async () => {
    const mcp = await fixture()
    const [alice, bob] = await Promise.all([clientFor(mcp, ["read"], protocol), clientFor(mcp, ["read"], protocol)])
    const results = await Promise.all([alice, bob].map(({ client }) => client.callTool({ name: "read", arguments: { label: "concurrent" } })))
    expect(results[0]!.structuredContent).toMatchObject({ organizationId: alice.organizationId })
    expect(results[1]!.structuredContent).toMatchObject({ organizationId: bob.organizationId })
    expect(alice.organizationId).not.toBe(bob.organizationId)
  })
  test(`${era}: input validation and safe tool failures`, async () => {
    const mcp = await fixture()
    const { client } = await clientFor(mcp, ["read"], protocol)
    const before = executions
    const badInput = await client.callTool({ name: "read", arguments: { label: 123 } }).catch(error => error)
    expect(badInput instanceof Error || badInput.isError === true).toBe(true)
    expect(executions).toBe(before)
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      for (const name of ["invalid", "failed"]) {
        const result = await client.callTool({ name, arguments: {} })
        expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "tool_failed: The tool could not complete" }], _meta: { code: "tool_failed" } })
        expect(JSON.stringify(result)).not.toContain("private-")
      }
      expect(log.mock.calls.map(call => call[0])).toEqual(["[mcp] tool invalid failed", "[mcp] tool failed failed"])
    } finally { log.mockRestore() }
    expect(await client.callTool({ name: "known", arguments: {} })).toMatchObject({ isError: true, content: [{ type: "text", text: "record_not_found: No accessible record exists" }], _meta: { code: "record_not_found" } })
  })
  test(`${era}: prompts and resources are scope-filtered, typed and redact failures`, async () => {
    const mcp = await fixture()
    const { client, organizationId } = await clientFor(mcp, ["content"], protocol)
    expect((await client.listPrompts()).prompts.map(item => item.name)).toEqual(["guide", "broken_prompt"])
    expect((await client.listResources()).resources.map(item => item.uri)).toEqual([document.uri, broken.uri])
    expect((await client.getPrompt({ name: "guide", arguments: { topic: "  hello  " } })).messages[0]!.content).toEqual({ type: "text", text: `hello:${organizationId}` })
    expect((await client.readResource({ uri: document.uri })).contents[0]).toMatchObject({ text: organizationId })
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      for (const run of [() => client.readResource({ uri: broken.uri }), () => client.getPrompt({ name: "broken_prompt", arguments: {} })]) {
        const error = await run().then(() => { throw new Error("Expected failure") }, error => error)
        expect(error.message).toContain("Content could not be read")
        expect(error.message).not.toContain("private-")
      }
      expect(log.mock.calls.map(call => call[0])).toEqual(["[mcp] resource broken failed", "[mcp] prompt broken_prompt failed"])
    } finally { log.mockRestore() }
    const denied = await clientFor(mcp, ["read"], protocol)
    expect(denied.client.getServerCapabilities()?.prompts).toBeDefined()
    expect((await denied.client.listPrompts()).prompts).toEqual([])
    expect((await denied.client.listResources()).resources.map(item => item.uri)).toEqual([view.uri])
    await expect(denied.client.getPrompt({ name: "guide", arguments: { topic: "hello" } })).rejects.toThrow()
    await expect(denied.client.readResource({ uri: document.uri })).rejects.toThrow()
  })
}

test("duplicate tools, prompts, resource URIs and distinct views throw at construction", () => {
  const config = { name: "test", version: "1", auth, tools: [read] }
  expect(() => createMcpServer({ ...config, tools: [read, read] })).toThrow("Duplicate tool")
  expect(() => createMcpServer({ ...config, prompts: [prompt, prompt] })).toThrow("Duplicate prompt")
  expect(() => createMcpServer({ ...config, resources: [document, document] })).toThrow("Duplicate resource")
  expect(() => createMcpServer({ ...config, resources: [{ ...document, uri: view.uri }] })).toThrow("Duplicate resource")
  expect(() => createMcpServer({ ...config, tools: [read, { ...read, name: "second", view: defineView({ name: view.name, html: view.html }) }] })).toThrow("Conflicting view")
  expect(() => createMcpServer({ ...config, tools: [read, { ...read, name: "second" }] })).not.toThrow()
})
test("the resource URL is the endpoint and the challenge names the metadata route that is served", async () => {
  for (const [resource, endpoint, metadata] of [
    ["https://mcp.test", "/", "/.well-known/oauth-protected-resource"],
    ["https://mcp.test/nested/tools", "/nested/tools", "/.well-known/oauth-protected-resource/nested/tools"],
    ["https://mcp.test/mcp/", "/mcp/", "/.well-known/oauth-protected-resource/mcp"],
  ] as const) {
    const app = await createTestMcp(auth => createMcpServer({ name: "test", version: "1", auth, tools: [] }), { resource })
    cleanups.push(() => app.close())
    const request = (path: string) => new Request(`https://mcp.test${path}`, { headers: { Host: "mcp.test" } })
    const challenge = await app.fetch(request(endpoint))
    expect(challenge.status).toBe(401)
    expect(challenge.headers.get("WWW-Authenticate")).toContain(`resource_metadata="https://mcp.test${metadata}"`)
    expect(await (await app.fetch(request(metadata))).json()).toMatchObject({ resource })
  }
})
test("aborting the HTTP request aborts the tool context", async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const observed = Promise.withResolvers<void>()
  const app = await createTestMcp(auth => createMcpServer({
    name: "abort", version: "1", auth,
    tools: [defineTool({
      name: "wait", description: "Wait for cancellation", scopes: ["read"], input: z.object({}), output: z.object({}),
      async execute(_input, context: ToolContext) {
        entered.resolve(context.signal)
        await new Promise<void>(resolve => context.signal.addEventListener("abort", () => {
          observed.resolve()
          resolve()
        }, { once: true }))
        return {}
      },
    })],
  }))
  const controller = new AbortController()
  cleanups.push(() => app.close())
  const token = await app.issuer.sign({ resource, scopes: ["read"] })
  const response = app.fetch(new Request(resource, {
    method: "POST", signal: controller.signal,
    headers: { Host: "mcp.test", Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait", arguments: {} } }),
  })).then(response => response.text()).catch(() => "")
  const signal = await entered.promise
  controller.abort()
  await observed.promise
  expect(signal.aborted).toBe(true)
  await response
})

for (const protocol of ["2025", "2026-07-28"] as const) {
  test(`${protocol}: input transforms run once and output is minimised in both representations`, async () => {
    const split = defineTool({
      name: "split", description: "Count tags", scopes: ["read"],
      input: z.object({ tags: z.string().transform(value => value.split(",")) }), output: z.object({ count: z.number() }),
      async execute({ tags }) { return { count: tags.length } },
    })
    const stripped = defineTool({
      name: "stripped", description: "Read public fields", scopes: ["read"], input: z.object({}), output: z.object({ id: z.string() }),
      async execute() { return { id: "r1", passwordHash: "private-hash" } },
    })
    const date = definePrompt({
      name: "date", description: "Format a date", scopes: ["read"], input: z.object({ date: z.string().transform(value => new Date(value)) }),
      async execute({ date }) { return { messages: [{ role: "user", content: { type: "text", text: date.toISOString() } }] } },
    })
    const mcp = await fixture([split, stripped], [date])
    const client = await mcp.connect({ protocol })
    for (const [name, args, expected] of [["split", { tags: "a,b,c" }, { count: 3 }], ["stripped", {}, { id: "r1" }]] as const) {
      const result = await client.callTool({ name, arguments: args })
      expect(result.structuredContent).toEqual(expected)
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }])
      expect(JSON.stringify(result)).not.toContain("private-hash")
    }
    expect((await client.getPrompt({ name: "date", arguments: { date: "2026-01-01" } })).messages[0]!.content).toEqual({ type: "text", text: "2026-01-01T00:00:00.000Z" })
  })
}
test("health accepts internal hosts while the MCP endpoint rejects them", async () => {
  const mcp = await fixture()
  for (const Host of ["10.0.0.5:47500", "localhost:47500"]) {
    const health = await mcp.fetch("https://mcp.test/health", { headers: { Host } })
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: "ok" })
    expect((await mcp.fetch(resource, { headers: { Host } })).status).toBe(403)
  }
})
