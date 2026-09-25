import { expect, test } from "bun:test"
import { z } from "zod"
import { createMcpServer, defineTool, definePrompt, defineResource, defineView, type Tool, type ToolContext } from "./index"
import { createTestMcp } from "./testing"

const view = defineView({ name: "example", html: "<title>Example</title>" })
test("authoring helpers validate names, scopes and views", () => {
  expect(Object.isFrozen(view)).toBe(true)
  expect(() => defineView({ name: "Bad", html: "x" })).toThrow("Invalid view name")
  expect(() => defineView({ name: "empty", html: " " })).toThrow("View HTML is empty; build the view first")
  for (const scopes of [[], [""], ["has space"]]) {
    expect(() => defineTool({ name: "test", description: "", scopes, input: z.object({}), output: z.object({}), async execute() { return {} } })).toThrow("scopes")
    expect(() => definePrompt({ name: "test", description: "", scopes, input: z.object({}), async execute() { return { messages: [] } } })).toThrow("scopes")
    expect(() => defineResource({ name: "test", uri: "fixture://test", description: "", mimeType: "text/plain", scopes, async read() { return "" } })).toThrow("scopes")
  }
  expect(() => defineResource({ name: "test", uri: view.uri, description: "", mimeType: "text/html", scopes: ["read"], async read() { return "" } })).toThrow("Use defineView for ui:// resources")
})

const count = defineTool({
  name: "count", description: "Count tags", scopes: ["read"],
  input: z.object({ tags: z.string().transform(value => value.split(",")) }), output: z.object({ count: z.number() }),
  async execute({ tags }, { principal }) { return { count: tags.length + principal.scopes.length } },
})

test("definitions are frozen data that run without a server", async () => {
  const prompt = definePrompt({ name: "guide", description: "Guide", scopes: ["read"], input: z.object({}), async execute() { return { messages: [] } } })
  const resource = defineResource({ name: "guide", uri: "fixture://guide", description: "Guide", mimeType: "text/plain", scopes: ["read"], async read() { return "Guide" } })
  for (const definition of [count, prompt, resource]) {
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.scopes)).toBe(true)
  }
  const context = {
    principal: { userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), grantId: crypto.randomUUID(), clientId: "test", expiresAt: 123, scopes: [] },
    signal: new AbortController().signal,
  }
  expect(await count.execute(count.input.parse({ tags: "a,b" }), context)).toEqual({ count: 2 })
  expect(await prompt.execute({}, context)).toEqual({ messages: [] })
  expect(await resource.read(context)).toBe("Guide")
  expect(() => defineTool({ ...count, name: "Bad" })).toThrow("Invalid tool name: Bad")
  expect(() => definePrompt({ ...prompt, name: "Bad" })).toThrow("Invalid prompt name: Bad")
  expect(() => defineResource({ ...resource, name: "Bad" })).toThrow("Invalid resource name: Bad")
  expect(() => defineTool({ ...count, scopes: [] })).toThrow("Tool count must declare scopes")
  expect(() => defineResource({ ...resource, uri: "invalid" })).toThrow()
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

test("a wrapper applies to tools of different shapes and runs through the server with a frozen context", async () => {
  const log: string[] = []
  const contexts: ToolContext[] = []
  const echo = defineTool({
    name: "echo", description: "Echo a title", scopes: ["read"], input: z.object({ title: z.string() }), output: z.object({ title: z.string() }),
    async execute({ title }, context) {
      contexts.push(context)
      return { title }
    },
  })
  const tools = [count, echo].map(tool => audited(tool, line => log.push(line)))
  const mcp = await createTestMcp(auth => createMcpServer({ name: "test", version: "1", auth, tools }))
  try {
    const userId = crypto.randomUUID()
    const client = await mcp.connect({ userId })
    expect((await client.callTool({ name: "count", arguments: { tags: "a,b" } })).structuredContent).toEqual({ count: 3 })
    expect((await client.callTool({ name: "echo", arguments: { title: "Hello" } })).structuredContent).toEqual({ title: "Hello" })
    expect(log).toEqual([`${userId} count`, `${userId} echo`])
    expect(Object.isFrozen(contexts[0])).toBe(true)
  } finally { await mcp.close() }
})
