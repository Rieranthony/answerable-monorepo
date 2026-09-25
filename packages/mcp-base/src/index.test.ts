import { afterEach, expect, spyOn, test } from "bun:test"
import { createTestIssuer, type TestIssuer } from "@answerable/auth/testing"
import { z } from "zod"
import { createMcpApp, defineTool, defineView, definePrompt, defineResource, ToolError, type ToolContext } from "./index"
import { connectTestClient } from "./testing"

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
    return { data: { organizationId: principal.organizationId, label: input.label }, text: input.label }
  },
})
const write = defineTool({
  name: "write", description: "Requires both permissions", scopes: ["read", "write"],
  input: z.object({}), output: z.object({}), async execute() { return { data: {}, text: "Written" } },
})
const invalid = defineTool({
  name: "invalid", description: "Invalid output", scopes: ["read"],
  input: z.object({}), output: z.object({ value: z.string().max(2) }),
  async execute() { return { data: { value: "private-output-secret" }, text: "private-output-secret" } },
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

async function fixture() {
  const issuer = await createTestIssuer()
  cleanups.push(() => issuer.stop())
  const app = createMcpApp({
    name: "test", version: "1", auth: { issuer: issuer.issuer, resource }, services: {},
    tools: [read, write, invalid, failed, known], prompts: [prompt, brokenPrompt], resources: [document, broken],
    allowedHosts: ["127.0.0.1"],
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
  cleanups.push(() => { server.stop(true) })
  return { issuer, app, url: new URL("/mcp", server.url), base: server.url }
}
async function clientFor(issuer: TestIssuer, url: URL, scopes: string[], protocol?: "2025" | "2026-07-28", organizationId = crypto.randomUUID()) {
  const accessToken = await issuer.sign({ resource, scopes, organizationId })
  const client = await connectTestClient({ url, accessToken, protocol })
  cleanups.push(() => client.close())
  return { client, organizationId }
}

test("HTTP routes expose health, discovery and a bearer challenge", async () => {
  const { url, base, issuer } = await fixture()
  const response = await fetch(url, { method: "POST" })
  expect(response.status).toBe(401)
  expect(response.headers.get("WWW-Authenticate")).toContain('resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"')
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  expect(await (await fetch(new URL("/health", base))).json()).toEqual({ status: "ok" })
  expect((await fetch(new URL("/unknown", base))).status).toBe(404)
  expect(await (await fetch(new URL("/.well-known/oauth-protected-resource/mcp", base))).json()).toEqual({
    resource, authorization_servers: [issuer.issuer], scopes_supported: ["content", "read", "write"], bearer_methods_supported: ["header"], resource_name: "test",
  })
})
test("rejects untrusted hosts, origins and a token for another audience", async () => {
  const { url, app, issuer } = await fixture()
  expect((await app.fetch(new Request(url, { headers: { Host: "evil.test" } }))).status).toBe(403)
  const token = await issuer.sign({ resource, scopes: ["read"] })
  const before = executions
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { label: "test" } } }) })
  expect(response.status).toBe(403)
  expect(executions).toBe(before)
  const other = await issuer.sign({ resource: "https://other.test/mcp" })
  expect((await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${other}` } })).status).toBe(401)
})

for (const protocol of [undefined, "2026-07-28"] as const) {
  const era = protocol ?? "default 2025"
  test(`${era}: scopes filter tools and views, and results retain the caller`, async () => {
    const { issuer, url } = await fixture()
    const { client, organizationId } = await clientFor(issuer, url, ["read"], protocol)
    const listed = (await client.listTools()).tools
    expect(listed.map(tool => tool.name)).toEqual(["read", "invalid", "failed", "known"])
    expect(listed.find(tool => tool.name === "read")).toMatchObject({ title: "Read organisation", _meta: { ui: { resourceUri: view.uri } } })
    expect((await client.callTool({ name: "read", arguments: { label: "  trimmed  " } })).structuredContent).toEqual({ organizationId, label: "trimmed" })
    expect((await client.readResource({ uri: view.uri })).contents[0]).toEqual({ uri: view.uri, mimeType: "text/html;profile=mcp-app", text: view.html })
    await expect(client.callTool({ name: "write", arguments: {} })).rejects.toThrow()
    const denied = await clientFor(issuer, url, ["write"], protocol)
    expect(denied.client.getServerCapabilities()?.tools).toBeDefined()
    expect((await denied.client.listTools()).tools).toEqual([])
    await expect(denied.client.readResource({ uri: view.uri })).rejects.toThrow()
    const granted = await clientFor(issuer, url, ["read", "write"], protocol)
    expect((await granted.client.listTools()).tools.map(tool => tool.name)).toContain("write")
    expect((await granted.client.callTool({ name: "write", arguments: {} })).isError).not.toBe(true)
  })
  test(`${era}: concurrent clients retain separate organisations`, async () => {
    const { issuer, url } = await fixture()
    const [alice, bob] = await Promise.all([clientFor(issuer, url, ["read"], protocol), clientFor(issuer, url, ["read"], protocol)])
    const results = await Promise.all([alice, bob].map(({ client }) => client.callTool({ name: "read", arguments: { label: "concurrent" } })))
    expect(results[0]!.structuredContent).toMatchObject({ organizationId: alice.organizationId })
    expect(results[1]!.structuredContent).toMatchObject({ organizationId: bob.organizationId })
    expect(alice.organizationId).not.toBe(bob.organizationId)
  })
  test(`${era}: input validation and safe tool failures`, async () => {
    const { issuer, url } = await fixture()
    const { client } = await clientFor(issuer, url, ["read"], protocol)
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
    const { issuer, url } = await fixture()
    const { client, organizationId } = await clientFor(issuer, url, ["content"], protocol)
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
    const denied = await clientFor(issuer, url, ["read"], protocol)
    expect(denied.client.getServerCapabilities()?.prompts).toBeDefined()
    expect((await denied.client.listPrompts()).prompts).toEqual([])
    expect((await denied.client.listResources()).resources.map(item => item.uri)).toEqual([view.uri])
    await expect(denied.client.getPrompt({ name: "guide", arguments: { topic: "hello" } })).rejects.toThrow()
    await expect(denied.client.readResource({ uri: document.uri })).rejects.toThrow()
  })
}

test("duplicate tools, prompts, resource URIs and distinct views throw at construction", () => {
  const config = { name: "test", version: "1", auth, services: {}, tools: [read] }
  expect(() => createMcpApp({ ...config, tools: [read, read] })).toThrow("Duplicate tool")
  expect(() => createMcpApp({ ...config, prompts: [prompt, prompt] })).toThrow("Duplicate prompt")
  expect(() => createMcpApp({ ...config, resources: [document, document] })).toThrow("Duplicate resource")
  expect(() => createMcpApp({ ...config, resources: [{ ...document, uri: view.uri }] })).toThrow("Duplicate resource")
  expect(() => createMcpApp({ ...config, tools: [read, { ...read, name: "second", view: defineView({ name: view.name, html: view.html }) }] })).toThrow("Conflicting view")
  expect(() => createMcpApp({ ...config, tools: [read, { ...read, name: "second" }] })).not.toThrow()
})
test("authoring helpers validate names, scopes and views", () => {
  expect(Object.isFrozen(view)).toBe(true)
  expect(() => defineView({ name: "Bad", html: "x" })).toThrow("Invalid view name")
  expect(() => defineView({ name: "empty", html: " " })).toThrow("View HTML is empty; build the view first")
  for (const scopes of [[], [""], ["has space"]]) {
    expect(() => defineTool({ name: "test", description: "", scopes, input: z.object({}), output: z.object({}), async execute() { return { data: {}, text: "" } } })).toThrow("scopes")
    expect(() => definePrompt({ name: "test", description: "", scopes, input: z.object({}), async execute() { return { messages: [] } } })).toThrow("scopes")
    expect(() => defineResource({ name: "test", uri: "fixture://test", description: "", mimeType: "text/plain", scopes, async read() { return "" } })).toThrow("scopes")
  }
  expect(() => defineResource({ name: "test", uri: view.uri, description: "", mimeType: "text/html", scopes: ["read"], async read() { return "" } })).toThrow("Use defineView for ui:// resources")
})
test("the resource URL is the endpoint and the challenge names the metadata route that is served", async () => {
  for (const [resource, endpoint, metadata] of [
    ["https://mcp.test", "/", "/.well-known/oauth-protected-resource"],
    ["https://mcp.test/nested/tools", "/nested/tools", "/.well-known/oauth-protected-resource/nested/tools"],
    ["https://mcp.test/mcp/", "/mcp/", "/.well-known/oauth-protected-resource/mcp"],
  ] as const) {
    const app = createMcpApp({ name: "test", version: "1", auth: { ...auth, resource }, services: {}, tools: [] })
    const request = (path: string) => new Request(`https://mcp.test${path}`, { headers: { Host: "mcp.test" } })
    const challenge = await app.fetch(request(endpoint))
    expect(challenge.status).toBe(401)
    expect(challenge.headers.get("WWW-Authenticate")).toContain(`resource_metadata="https://mcp.test${metadata}"`)
    expect(await (await app.fetch(request(metadata))).json()).toMatchObject({ resource })
  }
})
test("aborting the HTTP request aborts the tool context", async () => {
  const issuer = await createTestIssuer()
  cleanups.push(() => issuer.stop())
  const entered = Promise.withResolvers<AbortSignal>()
  const observed = Promise.withResolvers<void>()
  const app = createMcpApp({
    name: "abort", version: "1", auth: { issuer: issuer.issuer, resource }, services: {},
    tools: [defineTool({
      name: "wait", description: "Wait for cancellation", scopes: ["read"], input: z.object({}), output: z.object({}),
      async execute(_input, context: ToolContext) {
        entered.resolve(context.signal)
        await new Promise<void>(resolve => context.signal.addEventListener("abort", () => {
          observed.resolve()
          resolve()
        }, { once: true }))
        return { data: {}, text: "Aborted" }
      },
    })],
  })
  const controller = new AbortController()
  const token = await issuer.sign({ resource, scopes: ["read"] })
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
