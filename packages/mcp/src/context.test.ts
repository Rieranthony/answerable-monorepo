import { afterEach, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { callerOrganisation, createMcpServer, defineMutation, definePrompt, defineProvider, defineResource, defineTool, defineView, ToolError, type Profile, type ToolContext } from "./index"
import { createTestMcp, errorOf, type TestMcp } from "./testing"

// Who is calling and the database: what createMcpServer puts in every handler's context.
const purpose = "A fixture provider for the context tests: its handlers keep the context they receive."
const about = (text: string) => `${text}. A fixture for the context tests.`
const mcps: TestMcp[] = []
afterEach(async () => { await Promise.all(mcps.splice(0).map(mcp => mcp.close())) })

// Each handler's context, and the organisation of the call it ran in.
const seen: { name: string; context: ToolContext & { db?: unknown }; organisation: string | undefined }[] = []
const keep = (name: string, context: ToolContext) => seen.push({ name, context, organisation: callerOrganisation() })
const view = defineView({ name: "context", html: "<!doctype html><title>Context</title>" })
const whoami = defineTool({
  name: "people.whoami", description: about("Read who is calling"), view, input: z.object({ label: z.string().optional() }), output: z.object({ name: z.string() }),
  async execute(_input, context) {
    keep("execute", context)
    return { name: context.person.name }
  },
})
const note = defineMutation({
  name: "notes.add", description: about("Prepare adding a note"), input: z.object({}), output: z.object({}),
  async prepare(_input, context) {
    keep("prepare", context)
    return { targets: [], preview: { summary: "Add a note", changes: [{ path: "notes[]", to: "note" }] } }
  },
  async commit(_plan, context) {
    keep("commit", context)
    return { results: {}, applied_changes: [], effects_performed: [] }
  },
})
const guide = definePrompt({ name: "guide", description: "Guide", input: z.object({}), async execute(_input, context) { keep("prompt", context); return { messages: [] } } })
const readme = defineResource({ name: "readme", uri: "fixture://readme", description: "Readme", mimeType: "text/plain", async read(context) { keep("resource", context); return "" } })
const database = { schema: { notes: {} }, migrations: new URL("../drizzle", import.meta.url) }
const provider = (id = "people", withDatabase = false) => defineProvider({
  id, description: purpose, version: "2026-09-29", tools: [whoami, note], prompts: [guide], resources: [readme], ...(withDatabase ? { database } : {}),
})
const ada: Profile = {
  person: { name: "Ada Lovelace", email: "ada@acme.example", groups: [{ id: "0199a4e2-7b06-7000-87bd-91723fe45f93", slug: "engineers", name: "Engineers" }] },
  organisation: { name: "Acme", slug: "acme" },
}
async function serve(served: Parameters<typeof createTestMcp>[0], options?: Parameters<typeof createTestMcp>[1]) {
  const mcp = await createTestMcp(served, options)
  mcps.push(mcp)
  return mcp
}
async function commit(client: Awaited<ReturnType<TestMcp["connect"]>>, name = "notes_add", commitTool?: string) {
  const intent = (await client.callTool({ name, arguments: {} })).structuredContent as { intent_id: string; commit_token: string; commit_tool: string; preview: { summary: string } }
  return client.callTool({ name: commitTool ?? intent.commit_tool, arguments: { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary } })
}

test("a handler gets person, organisation and client with the resolver's values; connect changes them for one membership", async () => {
  const mcp = await serve(provider(), { profiles: async () => ada })
  const userId = crypto.randomUUID()
  const membershipId = crypto.randomUUID()
  const organizationId = crypto.randomUUID()
  const client = await mcp.connect({ userId, membershipId, organizationId, clientId: "claude-code" })
  seen.length = 0
  expect((await client.callTool({ name: "people_whoami", arguments: {} })).structuredContent).toEqual({ name: "Ada Lovelace" })
  expect(seen[0]!.context.person).toEqual({ id: userId, membershipId, name: "Ada Lovelace", email: "ada@acme.example", groups: ada.person.groups })
  expect(seen[0]!.context.organisation).toEqual({ id: organizationId, name: "Acme", slug: "acme" })
  const renamed = await mcp.connect({ person: { name: "Grace Hopper" }, organisation: { slug: "navy" } })
  await renamed.callTool({ name: "people_whoami", arguments: {} })
  expect(seen[1]!.context.person).toMatchObject({ name: "Grace Hopper", email: "ada@acme.example" })
  expect(seen[1]!.context.organisation).toMatchObject({ name: "Acme", slug: "navy" })
  await client.callTool({ name: "people_whoami", arguments: {} })
  expect(seen[2]!.context.person.name).toBe("Ada Lovelace")
})

test("the resolver runs once for each call, prompt and resource read, before the handler, and never for a list or a view", async () => {
  const asked: string[] = []
  const mcp = await serve(provider(), { profiles: async principal => (asked.push(principal.userId), ada) })
  const userId = crypto.randomUUID()
  const client = await mcp.connect({ userId })
  await client.listTools()
  await client.listPrompts()
  await client.listResources()
  await client.readResource({ uri: view.uri })
  expect(asked).toEqual([])
  await client.callTool({ name: "people_whoami", arguments: {} })
  await client.callTool({ name: "people_whoami", arguments: { label: 1 } })
  expect(asked).toHaveLength(2)
  await commit(client)
  expect(asked).toHaveLength(4)
  await client.getPrompt({ name: "guide", arguments: {} })
  await client.readResource({ uri: readme.uri })
  expect(asked).toEqual(Array(6).fill(userId))
})

test("a failing resolver answers UPSTREAM_UNAVAILABLE in the envelope and no handler runs; a ToolError it throws answers itself", async () => {
  let failure: Error = new Error("ID is down")
  const mcp = await serve(provider(), { profiles: async () => { throw failure } })
  const client = await mcp.connect()
  seen.length = 0
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(errorOf(await client.callTool({ name: "people_whoami", arguments: {} }))).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE", message: "Who you are could not be read; try again shortly", retry: { policy: "after_delay" },
    })
    expect(errorOf(await client.callTool({ name: "notes_add", arguments: {} })).code).toBe("UPSTREAM_UNAVAILABLE")
    await expect(client.getPrompt({ name: "guide", arguments: {} })).rejects.toThrow("Content could not be read")
    await expect(client.readResource({ uri: readme.uri })).rejects.toThrow("Content could not be read")
    expect(log.mock.calls.filter(call => call[0] === "[mcp] reading who is calling failed")).toHaveLength(4)
    failure = new ToolError("PERMISSION_DENIED", "Your membership is not in force")
    expect(errorOf(await client.callTool({ name: "people_whoami", arguments: {} }))).toMatchObject({ code: "PERMISSION_DENIED", message: "Your membership is not in force" })
  } finally { log.mockRestore() }
  expect(seen).toEqual([])
})

test("with a database, every handler gets the provider's db and runs inside the caller's organisation; without one, no db", async () => {
  const db = { name: "people-db" }
  const mcp = await serve(provider("people", true), { db })
  const organizationId = crypto.randomUUID()
  const client = await mcp.connect({ organizationId })
  seen.length = 0
  await client.callTool({ name: "people_whoami", arguments: {} })
  await commit(client)
  await client.getPrompt({ name: "guide", arguments: {} })
  await client.readResource({ uri: readme.uri })
  expect(seen.map(({ name, context, organisation }) => [name, context.db, organisation])).toEqual(
    ["execute", "prepare", "prepare", "commit", "prompt", "resource"].map(name => [name, db, organizationId]),
  )
  expect(callerOrganisation()).toBeUndefined()
  const plain = await serve(provider())
  await (await plain.connect()).callTool({ name: "people_whoami", arguments: {} })
  expect("db" in seen.at(-1)!.context).toBe(false)
})

test("a provider with a database and no db refuses to start, naming the provider", async () => {
  const auth = { issuer: "https://id.test", resource: "https://mcp.test/mcp" }
  const profiles = async () => ada
  expect(() => createMcpServer({ provider: provider("people", true), auth, profiles })).toThrow(
    "Provider people has a database, so its server needs its db: mcpDatabase over provider.database.schema, from @answerable/mcp-postgres",
  )
  expect(() => createMcpServer({ provider: provider(), auth, profiles, mount: [{ provider: provider("notes", true) }] })).toThrow("Provider notes has a database")
})
