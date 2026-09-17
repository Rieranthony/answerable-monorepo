import { afterEach, expect, test } from "bun:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { z } from "zod"
import { createMcpApp, defineTool, defineView, definePrompt, defineResource } from "./index"
import { connectTestClient } from "./testing"

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(options: { handlerTimeoutMs?: number } = {}) {
  const key = await generateKeyPair("EdDSA")
  const jwk = { ...(await exportJWK(key.publicKey)), kid: "test", alg: "EdDSA" }
  const keys = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [jwk] }) })
  cleanup.push(() => keys.stop(true))
  const resourceInstanceId = crypto.randomUUID()
  const resource = "https://fixture.test/mcp"
  const issuer = "https://id.test"
  let calls = 0
  const view = defineView({ name: "identity", html: "<!doctype html><title>Identity</title>" })
  const tool = defineTool({
    name: "identity_get",
    description: "Read authenticated identity",
    input: z.object({}),
    output: z.object({ tenant: z.uuid() }),
    scopes: ["identity:read"],
    view,
    async execute(_input, context) {
      calls++
      await new Promise(resolve => setTimeout(resolve, 2))
      return { data: { tenant: context.principal.organizationId }, text: "Authenticated" }
    },
  })
  let aborted = false
  let waitingStarted = false
  const waiting = defineTool({
    name: "wait_for_abort", description: "Exercise request cancellation", input: z.object({}), output: z.object({}), scopes: ["identity:read"],
    async execute(_input, context) {
      waitingStarted = true
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 300)
        context.signal.addEventListener("abort", () => { aborted = true; clearTimeout(timer); resolve() }, { once: true })
      })
      context.signal.throwIfAborted()
      return { data: {}, text: "Finished waiting" }
    },
  })
  let reads = 0
  const prompt = definePrompt({
    name: "fixture_walkthrough", description: "Explain the fixture", input: z.object({ title: z.string() }), scopes: ["guide:read"],
    async execute({ title }, context) {
      reads++
      return { messages: [{ role: "user", content: { type: "text", text: `${title}: ${context.principal.organizationId}` } }] }
    },
  })
  const guide = defineResource({
    name: "fixture_guide", uri: "fixture://guide", description: "Fixture guide", mimeType: "text/plain", scopes: ["guide:read"],
    async read(context) { reads++; return context.principal.organizationId },
  })
  const invalidOutput = defineTool({
    name: "invalid_output", description: "Exercise output validation", input: z.object({ value: z.number().positive() }),
    output: z.object({ value: z.number().positive() }), scopes: ["identity:read"],
    async execute() { calls++; return { data: { value: -1 }, text: "Internal invalid value" } },
  })
  const failingResource = defineResource({
    name: "failing_resource", uri: "fixture://failure", description: "Exercise failure redaction", mimeType: "text/plain", scopes: ["guide:read"],
    async read() { throw new Error("secret-database-connection") },
  })
  const logs: unknown[] = []
  const config = {
    name: "fixture",
    version: "0.1.0",
    auth: { issuer, resource, resourceInstanceId, jwksUrl: new URL("jwks", keys.url).href, allowLocalHttp: true },
    log: (event: unknown) => { logs.push(event) },
    ...options,
    tools: [tool, invalidOutput, waiting], prompts: [prompt], resources: [guide, failingResource],
    services: {},
    allowedHosts: ["127.0.0.1"],
  }
  const app = createMcpApp(config)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
  cleanup.push(() => server.stop(true))
  const url = new URL("/mcp", server.url)
  async function connect(scopes = "identity:read", tenant = crypto.randomUUID()) {
    const token = await new SignJWT({
      sub: crypto.randomUUID(), subject_type: "user", organization_id: tenant,
      membership_id: crypto.randomUUID(), grant_id: crypto.randomUUID(),
      client_instance: crypto.randomUUID(), resource_instance: resourceInstanceId,
      client_id: "test", azp: "test", scope: scopes, authorization_version: 1,
      organization_authorization_version: 1, upstream_auth_time: null,
    }).setProtectedHeader({ alg: "EdDSA", kid: "test", typ: "at+jwt" })
      .setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime("5m").sign(key.privateKey)
    const client = await connectTestClient({ url, accessToken: token })
    cleanup.push(() => client.close())
    return { client, tenant, token }
  }
  return { connect, url, config, logs, calls: () => calls, reads: () => reads, aborted: () => aborted, waitingStarted: () => waitingStarted }
}

test("challenges unauthenticated requests and serves protected-resource metadata", async () => {
  const f = await fixture()
  const response = await fetch(f.url, { method: "POST" })
  expect(response.status).toBe(401)
  expect(response.headers.get("www-authenticate")).toContain("resource_metadata=")
  const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", f.url))
  expect(await metadata.json()).toMatchObject({ resource: f.config.auth.resource, authorization_servers: [f.config.auth.issuer] })
  expect(f.calls()).toBe(0)
})

test("SDK client discovers an Apps tool, reads its view and receives structured results", async () => {
  const f = await fixture()
  const { client, tenant } = await f.connect()
  const tools = await client.listTools()
  expect(tools.tools[0]._meta).toMatchObject({ ui: { resourceUri: "ui://identity/index.html" } })
  const view = await client.readResource({ uri: "ui://identity/index.html" })
  expect(view.contents[0].mimeType).toBe("text/html;profile=mcp-app")
  const result = await client.callTool({ name: "identity_get", arguments: {} })
  expect(result.structuredContent).toEqual({ tenant })
  expect(result.isError).not.toBe(true)
})

test("missing scopes cannot invoke a tool and concurrent clients retain their own tenant", async () => {
  const f = await fixture()
  const denied = await f.connect("other:read")
  const result = await denied.client.callTool({ name: "identity_get", arguments: {} })
  expect(result.isError).toBe(true)
  expect(f.calls()).toBe(0)
  const a = await f.connect()
  const b = await f.connect()
  const [ra, rb] = await Promise.all([a.client.callTool({ name: "identity_get", arguments: {} }), b.client.callTool({ name: "identity_get", arguments: {} })])
  expect(ra.structuredContent).toEqual({ tenant: a.tenant })
  expect(rb.structuredContent).toEqual({ tenant: b.tenant })
})

test("duplicate tools fail at construction", async () => {
  const f = await fixture()
  expect(() => createMcpApp({ ...f.config, tools: [...f.config.tools, ...f.config.tools] })).toThrow("Duplicate tool")
})


test("prompts and ordinary resources use typed arguments and the authenticated tenant", async () => {
  const f = await fixture()
  const { client, tenant } = await f.connect("guide:read")
  expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(["fixture_walkthrough"])
  expect((await client.listResources()).resources.map(resource => resource.uri)).toContain("fixture://guide")
  const prompt = await client.getPrompt({ name: "fixture_walkthrough", arguments: { title: "Walkthrough" } })
  expect(prompt.messages[0].content).toEqual({ type: "text", text: `Walkthrough: ${tenant}` })
  expect((await client.readResource({ uri: "fixture://guide" })).contents[0]).toMatchObject({ text: tenant, mimeType: "text/plain" })
  expect(f.calls()).toBe(0)
  expect(f.reads()).toBe(2)
})

test("prompt and resource calls cannot bypass scopes or missing prompt arguments", async () => {
  const f = await fixture()
  const denied = await f.connect()
  await expect(denied.client.getPrompt({ name: "fixture_walkthrough", arguments: { title: "Denied" } })).rejects.toThrow("insufficient_scope")
  await expect(denied.client.readResource({ uri: "fixture://guide" })).rejects.toThrow("insufficient_scope")
  const allowed = await f.connect("guide:read")
  await expect(allowed.client.getPrompt({ name: "fixture_walkthrough", arguments: {} })).rejects.toThrow()
  expect(f.reads()).toBe(0)
})

test("duplicate prompt names and resource URIs fail before serving", async () => {
  const f = await fixture()
  expect(() => createMcpApp({ ...f.config, prompts: [...f.config.prompts, ...f.config.prompts] })).toThrow("Duplicate prompt")
  expect(() => createMcpApp({ ...f.config, resources: [...f.config.resources, ...f.config.resources] })).toThrow("Duplicate resource")
})


test("invalid input never runs and invalid output is returned as a safe tool failure", async () => {
  const f = await fixture()
  const { client } = await f.connect()
  const invalid = await client.callTool({ name: "invalid_output", arguments: { value: -1 } })
  expect(invalid.isError).toBe(true)
  expect(f.calls()).toBe(0)
  const output = await client.callTool({ name: "invalid_output", arguments: { value: 1 } })
  expect(output.isError).toBe(true)
  expect(JSON.stringify(output)).not.toContain("Internal invalid value")
  expect(output.structuredContent).toBeUndefined()
  expect(f.calls()).toBe(1)
  await expect(client.callTool({ name: "not_selected", arguments: {} })).rejects.toThrow("not found")
  expect(f.calls()).toBe(1)
})

test("resource failures redact internal exception messages", async () => {
  const f = await fixture()
  const { client } = await f.connect("guide:read")
  await expect(client.readResource({ uri: "fixture://failure" })).rejects.toThrow("Content could not be read")
})


test("handler deadline aborts downstream work and returns a bounded HTTP failure", async () => {
  const f = await fixture({ handlerTimeoutMs: 30 })
  const { client } = await f.connect()
  await expect(client.callTool({ name: "wait_for_abort", arguments: {} })).rejects.toMatchObject({ status: 504 })
  expect(f.aborted()).toBe(true)
  expect((await client.callTool({ name: "identity_get", arguments: {} })).isError).not.toBe(true)
})


test("HTTP cancellation reaches the handler and closes its request", async () => {
  const f = await fixture()
  const { token } = await f.connect()
  const controller = new AbortController()
  const app = createMcpApp(f.config)
  const response = app.fetch(new Request(f.url, {
    method: "POST", signal: controller.signal,
    headers: { Host: f.url.host, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "wait_for_abort", arguments: {} } }),
  }))
  const limit = Date.now() + 1000
  while (!f.waitingStarted() && Date.now() < limit) await Bun.sleep(1)
  if (!f.waitingStarted()) throw new Error(`Handler did not start: ${await (await response).text()}`)
  expect(f.waitingStarted()).toBe(true)
  controller.abort()
  expect((await response).status).toBe(408)
  expect(f.aborted()).toBe(true)
})


test("request logs contain bounded response metadata and no bearer or tool data", async () => {
  const f = await fixture()
  const response = await fetch(f.url, { method: "POST", headers: { Authorization: "Bearer secret-sentinel" } })
  expect(response.status).toBe(401)
  expect(f.logs).toHaveLength(1)
  expect(f.logs[0]).toEqual({ requestId: response.headers.get("x-request-id"), status: 401, durationMs: expect.any(Number) })
  expect(JSON.stringify(f.logs)).not.toContain("secret-sentinel")
  const { client } = await f.connect()
  await client.callTool({ name: "identity_get", arguments: {} })
  expect(f.logs).toContainEqual(expect.objectContaining({ status: 200 }))
})
