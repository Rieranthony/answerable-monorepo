import { expect, test } from "bun:test"
import { z } from "zod"
import { defineProvider, defineTool, definePrompt, defineResource, defineView, type Tool } from "./index"
import { createTestMcp } from "./testing"

const view = defineView({ name: "example", html: "<title>Example</title>" })
test("prompts, resources and views validate names, scopes and URIs", () => {
  expect(Object.isFrozen(view)).toBe(true)
  expect(view.uri).toBe("ui://example/index.html")
  expect(() => defineView({ name: "Bad", html: "x" })).toThrow("Invalid view name")
  expect(() => defineView({ name: "empty", html: " " })).toThrow("View HTML is empty; build the view first")
  for (const scopes of [[], [""], ["has space"]]) {
    expect(() => definePrompt({ name: "test", description: "", scopes, input: z.object({}), async execute() { return { messages: [] } } })).toThrow("Prompt test: scopes must be non-empty and contain no spaces; omit them for the default <provider>:read")
    expect(() => defineResource({ name: "test", uri: "fixture://test", description: "", mimeType: "text/plain", scopes, async read() { return "" } })).toThrow("Resource test: scopes must be non-empty and contain no spaces; omit them for the default <provider>:read")
  }
  expect(() => defineResource({ name: "test", uri: view.uri, description: "", mimeType: "text/html", async read() { return "" } })).toThrow("Use defineView for ui:// resources")
  expect(() => defineResource({ name: "test", uri: "invalid", description: "", mimeType: "text/plain", async read() { return "" } })).toThrow()
  expect(() => definePrompt({ name: "Bad", description: "", input: z.object({}), async execute() { return { messages: [] } } })).toThrow("Invalid prompt name: Bad")
  expect(() => defineResource({ name: "Bad", uri: "fixture://bad", description: "", mimeType: "text/plain", async read() { return "" } })).toThrow("Invalid resource name: Bad")
})

const context = {
  principal: { userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), grantId: crypto.randomUUID(), clientId: "test", expiresAt: 123, organizationAuthorizationVersion: 1, scopes: [] },
  executionId: Bun.randomUUIDv7(),
  signal: new AbortController().signal,
}
const count = defineTool({
  name: "tags.count", description: "Count comma-separated tags and the caller's scopes.",
  input: z.object({ tags: z.string().transform(value => value.split(",")) }), output: z.object({ count: z.number() }),
  async execute({ tags }, { principal }) { return { count: tags.length + principal.scopes.length } },
})

test("definitions are frozen data that run without a server", async () => {
  const prompt = definePrompt({ name: "guide", description: "Guide", scopes: ["read"], input: z.object({}), async execute() { return { messages: [] } } })
  const resource = defineResource({ name: "guide", uri: "fixture://guide", description: "Guide", mimeType: "text/plain", async read() { return "Guide" } })
  for (const definition of [count, prompt, resource]) expect(Object.isFrozen(definition)).toBe(true)
  expect(Object.isFrozen(prompt.scopes)).toBe(true)
  expect(resource.scopes).toBeUndefined()
  expect(await count.execute(count.input.parse({ tags: "a,b" }), context)).toEqual({ count: 2 })
  expect(await prompt.execute({}, context)).toEqual({ messages: [] })
  expect(await resource.read(context)).toBe("Guide")
})

// The composition pattern the authoring guide documents.
function audited(tool: Tool, log: (line: string) => void): Tool {
  return defineTool({
    ...tool,
    async execute(input, context) {
      log(`${context.principal.userId} ${tool.name}`)
      return tool.execute(input, context)
    },
  })
}

test("a wrapper applies to tools of different shapes and runs through the server", async () => {
  const log: string[] = []
  const echo = defineTool({
    name: "titles.echo", description: "Echo a title back to the caller unchanged.", input: z.object({ title: z.string() }), output: z.object({ title: z.string() }),
    async execute({ title }) { return { title } },
  })
  const tools = [count, echo].map(tool => audited(tool, line => log.push(line)))
  const mcp = await createTestMcp(defineProvider({ id: "test", version: "2026-09-29", tools }))
  try {
    const userId = crypto.randomUUID()
    const client = await mcp.connect({ userId })
    expect((await client.callTool({ name: "tags_count", arguments: { tags: "a,b" } })).structuredContent).toEqual({ count: 3 })
    expect((await client.callTool({ name: "titles_echo", arguments: { title: "Hello" } })).structuredContent).toEqual({ title: "Hello" })
    expect(log).toEqual([`${userId} tags.count`, `${userId} titles.echo`])
  } finally { await mcp.close() }
})
