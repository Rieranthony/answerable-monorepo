import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test"
import { z } from "zod"
import { createMcpServer, defineProvider, defineTool, defineView, definePrompt, defineResource, manifest, ToolError, type Tool, type ToolContext, type Prompt } from "./index"
import { createTestMcp, errorOf, type TestMcp } from "./testing"

const resource = "https://mcp.test/mcp"
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  setSystemTime()
  for (const close of cleanups.splice(0).reverse()) await close()
})
const about = (text: string) => `${text}. A fixture for the server tests.`
const view = defineView({ name: "example", html: "<!doctype html><title>Example</title>" })
let executions = 0
const contexts: ToolContext[] = []
const read = defineTool({
  name: "org.read", title: "Read organisation", description: about("Read the caller's organisation"), scopes: ["read"], view,
  input: z.object({ label: z.string().trim().min(1), nested: z.object({ count: z.number() }).optional() }),
  output: z.object({ organizationId: z.uuid(), label: z.string() }),
  async execute(input, context) {
    executions++
    contexts.push(context)
    return { organizationId: context.principal.organizationId, label: input.label }
  },
})
const write = defineTool({
  name: "org.write", description: about("Requires both permissions"), scopes: ["read", "write"],
  input: z.object({}), output: z.object({}), async execute() { return {} },
})
const invalid = defineTool({
  name: "org.invalid", description: about("Returns an output that fails its schema"), scopes: ["read"],
  input: z.object({}), output: z.object({ value: z.string().max(2) }),
  async execute() { return { value: "private-output-secret" } },
})
const failed = defineTool({
  name: "org.failed", description: about("Throws an unexpected error"), scopes: ["read"],
  input: z.object({}), output: z.object({}), async execute() { throw new Error("private-exception-secret") },
})
const known = defineTool({
  name: "org.known", description: about("Throws a domain error"), scopes: ["read"],
  input: z.object({}), output: z.object({}),
  async execute() { throw new ToolError("NOT_FOUND", "No accessible record exists", { details: { record_id: "r1" } }) },
})
const old = defineTool({
  name: "org.old", description: about("Reads the organisation the old way"), scopes: ["read"],
  deprecated: { since: "2026-09-29", sunset: "2027-09-29", replacement: "org.read" },
  input: z.object({}), output: z.object({}), async execute() { return {} },
})
const prompt = definePrompt({
  name: "guide", description: "Organisation instructions", scopes: ["content"], input: z.object({ topic: z.string().trim() }),
  async execute({ topic }, { principal }) {
    return { messages: [{ role: "user", content: { type: "text", text: `${topic}:${principal.organizationId}` } }] }
  },
})
const document = defineResource({
  name: "document", uri: "fixture://document", description: "Organisation document", mimeType: "text/plain", scopes: ["content"],
  async read({ principal, executionId }) { return `${principal.organizationId} ${executionId}` },
})
const broken = defineResource({
  name: "broken", uri: "fixture://broken", description: "Failure", mimeType: "text/plain", scopes: ["content"],
  async read() { throw new Error("private-resource-secret") },
})
const brokenPrompt = definePrompt({
  name: "broken_prompt", description: "Failure", scopes: ["content"], input: z.object({}),
  async execute() { throw new Error("private-prompt-secret") },
})
const tools = [read, write, invalid, failed, known, old]

function provider(definitions: readonly Tool[] = tools, prompts: readonly Prompt[] = [prompt, brokenPrompt]) {
  return defineProvider({ id: "test", version: "2026-09-29", tools: definitions, prompts, resources: [document, broken] })
}
async function fixture(definitions?: readonly Tool[], prompts?: readonly Prompt[]) {
  const mcp = await createTestMcp(provider(definitions, prompts))
  cleanups.push(() => mcp.close())
  return mcp
}
async function clientFor(mcp: TestMcp, scopes: string[], protocol?: "2025" | "2026-07-28", organizationId = crypto.randomUUID()) {
  const client = await mcp.connect({ scopes, protocol, organizationId })
  return { client, organizationId }
}
// errorOf checks that an error result is one text block holding the envelope as JSON, and no structuredContent.
const refused = async (client: Awaited<ReturnType<TestMcp["connect"]>>, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => errorOf(await client.callTool({ name, arguments: args }))
function envelope(code: string, message: string, retry: object, details?: object) {
  return { code, message, retry, ...(details ? { details } : {}), request_id: expect.stringMatching(uuidV7) }
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
  const response = await mcp.fetch(resource, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "org_read", arguments: { label: "test" } } }) })
  expect(response.status).toBe(403)
  expect(executions).toBe(before)
  const other = await mcp.issuer.sign({ resource: "https://other.test/mcp" })
  expect((await mcp.fetch(resource, { method: "POST", headers: { Authorization: `Bearer ${other}` } })).status).toBe(401)
})
test("a 2026-07-28 client may keep tools/list for 30 seconds, for itself alone; a 2025 client asks every time", async () => {
  let posts = 0
  const mcp = await createTestMcp(auth => {
    const server = createMcpServer({ provider: provider(), auth })
    return { fetch: request => (posts++, server.fetch(request)) }
  })
  cleanups.push(() => mcp.close())
  const start = Date.now()
  setSystemTime(start)
  const client = await mcp.connect({ scopes: ["read"], protocol: "2026-07-28" })
  await client.listTools()
  const listed = posts
  setSystemTime(start + 29_000)
  await client.listTools()
  expect(posts).toBe(listed)
  setSystemTime(start + 31_000)
  await client.listTools()
  expect(posts).toBe(listed + 1)
  const older = await mcp.connect({ scopes: ["read"] })
  await older.listTools()
  const before = posts
  await older.listTools()
  expect(posts).toBe(before + 1)
})

test("2026-07-28: a client of the new revision lists, calls and is refused as a 2025 client is", async () => {
  const mcp = await fixture()
  const { client, organizationId } = await clientFor(mcp, ["read"], "2026-07-28")
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["org_read", "org_invalid", "org_failed", "org_known", "org_old"])
  expect((await client.callTool({ name: "org_read", arguments: { label: "new" } })).structuredContent).toEqual({ organizationId, label: "new" })
  expect(await refused(client, "org_known")).toEqual(envelope("NOT_FOUND", "No accessible record exists", { policy: "never" }, { record_id: "r1" }))
})
test("tools/list carries the wire name, derived annotations and _meta, the closed schema and deprecations", async () => {
  const mcp = await fixture()
  const { client } = await clientFor(mcp, ["read"])
  const listed = (await client.listTools()).tools
  expect(listed.map(tool => tool.name)).toEqual(["org_read", "org_invalid", "org_failed", "org_known", "org_old"])
  const contract = manifest(provider())
  for (const tool of listed) {
    const entry = contract.tools.find(item => item.name === tool.name)!
    expect(tool).toMatchObject({ description: entry.description, annotations, inputSchema: entry.input, outputSchema: entry.output })
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false })
  }
  expect(listed[0]).toMatchObject({
    title: "Read organisation",
    _meta: { "com.answerable/capability": { identity: "test/org.read", version: "2026-09-29", kind: "read" }, ui: { resourceUri: view.uri } },
  })
  expect(Object.keys(listed[1]!._meta!)).toEqual(["com.answerable/capability"])
  expect(listed[1]!.title).toBeUndefined()
  expect(listed[4]).toMatchObject({
    description: `${about("Reads the organisation the old way")} Deprecated since 2026-09-29; removed on 2027-09-29; use org.read instead.`,
    _meta: { "com.answerable/capability": { identity: "test/org.old", version: "2026-09-29", kind: "read", deprecated: { since: "2026-09-29", sunset: "2027-09-29", replacement: "org.read" } } },
  })
})
test("scopes filter tools and views, and results retain the caller", async () => {
  const mcp = await fixture()
  const { client, organizationId } = await clientFor(mcp, ["read"])
  const result = await client.callTool({ name: "org_read", arguments: { label: "  trimmed  " } })
  expect(result.structuredContent).toEqual({ organizationId, label: "trimmed" })
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }])
  expect((await client.readResource({ uri: view.uri })).contents[0]).toEqual({ uri: view.uri, mimeType: "text/html;profile=mcp-app", text: view.html })
  await expect(client.callTool({ name: "org_write", arguments: {} })).rejects.toThrow("Tool org_write not found")
  const denied = await clientFor(mcp, ["write"])
  expect(denied.client.getServerCapabilities()?.tools).toEqual({ listChanged: true })
  expect((await denied.client.listTools()).tools).toEqual([])
  await expect(denied.client.readResource({ uri: view.uri })).rejects.toThrow()
  const granted = await clientFor(mcp, ["read", "write"])
  expect((await granted.client.listTools()).tools.map(tool => tool.name)).toContain("org_write")
  expect((await granted.client.callTool({ name: "org_write", arguments: {} })).isError).not.toBe(true)
})
test("concurrent clients retain separate organisations", async () => {
  const mcp = await fixture()
  const [alice, bob] = await Promise.all([clientFor(mcp, ["read"]), clientFor(mcp, ["read"])])
  const results = await Promise.all([alice, bob].map(({ client }) => client.callTool({ name: "org_read", arguments: { label: "concurrent" } })))
  expect(results[0]!.structuredContent).toMatchObject({ organizationId: alice.organizationId })
  expect(results[1]!.structuredContent).toMatchObject({ organizationId: bob.organizationId })
  expect(alice.organizationId).not.toBe(bob.organizationId)
})
test("invalid input answers INVALID_INPUT with field violations before the handler runs", async () => {
  const mcp = await fixture()
  const { client } = await clientFor(mcp, ["read"])
  const before = executions
  const retry = { policy: "after_fix_input" }
  expect(await refused(client, "org_read", { label: "x", extra: true, other: 1 })).toEqual(envelope(
    "INVALID_INPUT", "extra: Unknown field; other: Unknown field", retry,
    { field_violations: [{ field: "extra", message: "Unknown field" }, { field: "other", message: "Unknown field" }] },
  ))
  expect(await refused(client, "org_read", { label: 123, nested: { count: "3" } })).toEqual(envelope(
    "INVALID_INPUT", "label: Invalid input: expected string, received number; nested.count: Invalid input: expected number, received string", retry,
    { field_violations: [{ field: "label", message: "Invalid input: expected string, received number" }, { field: "nested.count", message: "Invalid input: expected number, received string" }] },
  ))
  expect(executions).toBe(before)
})
test("tool errors answer the envelope and unexpected failures answer INTERNAL without detail", async () => {
  const mcp = await fixture()
  const { client } = await clientFor(mcp, ["read"])
  expect(await refused(client, "org_known")).toEqual(envelope("NOT_FOUND", "No accessible record exists", { policy: "never" }, { record_id: "r1" }))
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const name of ["org_invalid", "org_failed"]) {
      const result = await refused(client, name)
      expect(result).toEqual(envelope("INTERNAL", "The tool could not complete", { policy: "after_delay", after_ms: 1000 }))
      expect(JSON.stringify(result)).not.toContain("private-")
    }
    expect(log.mock.calls.map(call => call[0])).toEqual(["[mcp] tool org.invalid failed", "[mcp] tool org.failed failed"])
    expect(log.mock.calls.map(call => call[1])).toEqual([expect.stringMatching(uuidV7), expect.stringMatching(uuidV7)])
  } finally { log.mockRestore() }
})
test("handlers receive a frozen context with a fresh UUIDv7 execution id", async () => {
  const mcp = await fixture()
  const { client, organizationId } = await clientFor(mcp, ["read", "content"])
  contexts.length = 0
  await client.callTool({ name: "org_read", arguments: { label: "one" } })
  await client.callTool({ name: "org_read", arguments: { label: "two" } })
  expect(contexts).toHaveLength(2)
  for (const context of contexts) {
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.keys(context).sort()).toEqual(["executionId", "principal", "signal"])
    expect(context.executionId).toMatch(uuidV7)
    expect(context.principal.organizationId).toBe(organizationId)
    expect(context.signal).toBeInstanceOf(AbortSignal)
  }
  expect(contexts[0]!.executionId).not.toBe(contexts[1]!.executionId)
  const text = ((await client.readResource({ uri: document.uri })).contents[0] as { text: string }).text
  expect(text).toMatch(new RegExp(`^${organizationId} [0-9a-f-]{36}$`))
  expect(text.split(" ")[1]).toMatch(uuidV7)
})
test("a handler that exceeds timeoutMs is aborted and answers TIMEOUT", async () => {
  const signals: AbortSignal[] = []
  const slow = defineTool({
    name: "org.slow", description: about("Takes longer than its timeout"), scopes: ["read"], timeoutMs: 50,
    input: z.object({}), output: z.object({}),
    async execute(_input, { signal }) {
      signals.push(signal)
      await Bun.sleep(1000)
      return {}
    },
  })
  const mcp = await fixture([slow])
  const client = await mcp.connect()
  const started = performance.now()
  expect(await refused(client, "org_slow")).toEqual(envelope("TIMEOUT", "The tool did not finish within 50 ms", { policy: "after_delay", after_ms: 1000 }))
  expect(performance.now() - started).toBeLessThan(900)
  expect(signals[0]!.aborted).toBe(true)
})
test("prompts and resources are scope-filtered, typed and redact failures", async () => {
  const mcp = await fixture()
  const { client, organizationId } = await clientFor(mcp, ["content"])
  expect((await client.listPrompts()).prompts.map(item => item.name)).toEqual(["guide", "broken_prompt"])
  expect((await client.listResources()).resources.map(item => item.uri)).toEqual([document.uri, broken.uri])
  expect((await client.getPrompt({ name: "guide", arguments: { topic: "  hello  " } })).messages[0]!.content).toEqual({ type: "text", text: `hello:${organizationId}` })
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const run of [() => client.readResource({ uri: broken.uri }), () => client.getPrompt({ name: "broken_prompt", arguments: {} })]) {
      const error = await run().then(() => { throw new Error("Expected failure") }, error => error)
      expect(error.message).toContain("Content could not be read")
      expect(error.message).not.toContain("private-")
    }
    expect(log.mock.calls.map(call => call[0])).toEqual(["[mcp] resource broken failed", "[mcp] prompt broken_prompt failed"])
  } finally { log.mockRestore() }
  const denied = await clientFor(mcp, ["read"])
  expect(denied.client.getServerCapabilities()?.prompts).toBeDefined()
  expect((await denied.client.listPrompts()).prompts).toEqual([])
  expect((await denied.client.listResources()).resources.map(item => item.uri)).toEqual([view.uri])
  await expect(denied.client.getPrompt({ name: "guide", arguments: { topic: "hello" } })).rejects.toThrow()
  await expect(denied.client.readResource({ uri: document.uri })).rejects.toThrow()
})

test("the resource URL is the endpoint and the challenge names the metadata route that is served", async () => {
  for (const [resource, endpoint, metadata] of [
    ["https://mcp.test", "/", "/.well-known/oauth-protected-resource"],
    ["https://mcp.test/nested/tools", "/nested/tools", "/.well-known/oauth-protected-resource/nested/tools"],
    ["https://mcp.test/mcp/", "/mcp/", "/.well-known/oauth-protected-resource/mcp"],
  ] as const) {
    const app = await createTestMcp(auth => createMcpServer({ provider: provider([], []), auth: { ...auth, resource } }))
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
  const app = await fixture([defineTool({
    name: "org.wait", description: about("Waits for cancellation"), scopes: ["read"], input: z.object({}), output: z.object({}),
    async execute(_input, context) {
      entered.resolve(context.signal)
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => {
        observed.resolve()
        resolve()
      }, { once: true }))
      return {}
    },
  })])
  const controller = new AbortController()
  const token = await app.issuer.sign({ resource, scopes: ["read"] })
  const response = app.fetch(new Request(resource, {
    method: "POST", signal: controller.signal,
    headers: { Host: "mcp.test", Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "org_wait", arguments: {} } }),
  })).then(response => response.text()).catch(() => "")
  const signal = await entered.promise
  controller.abort()
  await observed.promise
  expect(signal.aborted).toBe(true)
  await response
})

test("input transforms run once and output is minimised in both representations", async () => {
  const split = defineTool({
    name: "tags.count", description: about("Counts comma-separated tags"), scopes: ["read"],
    input: z.object({ tags: z.string().transform(value => value.split(",")) }), output: z.object({ count: z.number() }),
    async execute({ tags }) { return { count: tags.length } },
  })
  const stripped = defineTool({
    name: "tags.public", description: about("Reads public fields only"), scopes: ["read"], input: z.object({}), output: z.object({ id: z.string() }),
    async execute() { return { id: "r1", passwordHash: "private-hash" } },
  })
  const date = definePrompt({
    name: "date", description: "Format a date", scopes: ["read"], input: z.object({ date: z.string().transform(value => new Date(value)) }),
    async execute({ date }) { return { messages: [{ role: "user", content: { type: "text", text: date.toISOString() } }] } },
  })
  const mcp = await fixture([split, stripped], [date])
  const client = await mcp.connect()
  for (const [name, args, expected] of [["tags_count", { tags: "a,b,c" }, { count: 3 }], ["tags_public", {}, { id: "r1" }]] as const) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.structuredContent).toEqual(expected)
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }])
    expect(JSON.stringify(result)).not.toContain("private-hash")
  }
  expect((await client.getPrompt({ name: "date", arguments: { date: "2026-01-01" } })).messages[0]!.content).toEqual({ type: "text", text: "2026-01-01T00:00:00.000Z" })
})
test("health accepts internal hosts while the MCP endpoint rejects them", async () => {
  const mcp = await fixture()
  for (const Host of ["10.0.0.5:47500", "localhost:47500"]) {
    const health = await mcp.fetch("https://mcp.test/health", { headers: { Host } })
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: "ok" })
    expect((await mcp.fetch(resource, { headers: { Host } })).status).toBe(403)
  }
})
