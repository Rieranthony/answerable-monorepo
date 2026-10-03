import { afterEach, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { createMcpServer, defineMutation, definePrompt, defineProvider, defineResource, defineTool, defineView, ToolError, type McpServerConfig, type McpServerHandle, type Mutation, type Provider, type Served, type Tool, type ToolCall } from "./index"
import { createTestMcp, errorOf, type TestMcp } from "./testing"

// A hub serves its own provider and mounts others: the Toolbox's shape, built on createMcpServer.
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const about = (text: string) => `${text}. A fixture for the hub tests.`
const board = defineView({ name: "board", html: "<!doctype html><title>Board</title>" })
const whoami = defineTool({
  name: "hub.whoami", description: about("Read who you are to the hub"), scopes: ["hub"],
  input: z.object({}), output: z.object({ userId: z.uuid() }),
  async execute(_input, { principal }) { return { userId: principal.userId } },
})
const own = defineProvider({ id: "hub", version: "2026-09-29", tools: [whoami] })

function mounted(id: string, view = board) {
  const notes: string[] = []
  const list = defineTool({
    name: "notes.list", description: about(`List the notes of ${id}`), view,
    input: z.object({ limit: z.number().int().max(3).default(3) }), output: z.object({ notes: z.array(z.string()) }),
    async execute({ limit }) { return { notes: notes.slice(0, limit) } },
  })
  const create = defineMutation({
    name: "notes.create", description: about(`Prepare adding a note to ${id}`),
    input: z.object({ text: z.string() }), output: z.object({ count: z.number() }),
    async prepare({ text }) { return { targets: [], preview: { summary: `Add “${text}”`, changes: [{ path: "notes[]", to: text }] }, plan: { text } } },
    async commit({ plan }) {
      notes.push((plan as { text: string }).text)
      return { results: { count: notes.length }, applied_changes: [], effects_performed: [] }
    },
  })
  const guide = definePrompt({ name: "guide", description: "A mounted prompt", input: z.object({}), async execute() { return { messages: [] } } })
  const readme = defineResource({ name: "readme", uri: `fixture://${id}`, description: "A mounted resource", mimeType: "text/plain", async read() { return id } })
  return defineProvider({ id, version: "2026-09-29", tools: [list, create], prompts: [guide], resources: [readme] })
}

const mcps: TestMcp[] = []
afterEach(async () => { await Promise.all(mcps.splice(0).map(mcp => mcp.close())) })
type Decision = { user: string; identity: string; called: boolean }
async function hub(options: Partial<Pick<McpServerConfig, "allow" | "wrapCall" | "policyClass" | "project">> & { mount?: Provider[]; provider?: Provider } = {}) {
  // Identities each user may use; the hub's own tools follow the scope rule.
  const grants = new Map<string, string[]>()
  const decisions: Decision[] = []
  const allow: McpServerConfig["allow"] = options.allow ?? ((principal, tool, called) => {
    decisions.push({ user: principal.userId, identity: tool.identity, called })
    return tool.identity === "hub/hub.whoami" ? principal.scopes.includes("hub") : (grants.get(principal.userId) ?? []).includes(tool.identity)
  })
  let server!: McpServerHandle
  const mcp = await createTestMcp(auth => (server = createMcpServer({ provider: own, mount: options.mount ?? [mounted("alpha"), mounted("beta")], auth, ...options, allow })))
  mcps.push(mcp)
  const person = (identities: string[], scopes = ["hub"]) => {
    const userId = crypto.randomUUID()
    grants.set(userId, identities)
    return { userId, connect: (protocol?: "2025" | "2026-07-28") => mcp.connect({ userId, scopes, protocol }) }
  }
  return { mcp, grants, decisions, person, server: () => server }
}
const everything = ["alpha/notes.list", "alpha/notes.create", "beta/notes.list", "beta/notes.create"]
const names = async (client: Awaited<ReturnType<TestMcp["connect"]>>) => (await client.listTools()).tools.map(tool => tool.name)

test("mounted tools are named after their provider and follow the hub's own; the hub's id names the server, its scopes and its commit tools", async () => {
  const { mcp, person } = await hub()
  const client = await person(everything).connect("2026-07-28")
  const tools = (await client.listTools()).tools
  expect(tools.map(tool => tool.name)).toEqual([
    "hub_whoami", "alpha_notes_list", "alpha_notes_create", "beta_notes_list", "beta_notes_create", "hub_commit", "hub_commit_confirmed",
  ])
  expect(tools[1]!._meta).toMatchObject({ "com.answerable/capability": { identity: "alpha/notes.list", kind: "read" }, ui: { resourceUri: "ui://board/index.html" } })
  expect(tools[2]!._meta).toMatchObject({ "com.answerable/capability": { identity: "alpha/notes.create", kind: "mutate", policy_class: "controlled" } })
  expect(client.getServerVersion()).toMatchObject({ name: "hub", version: "2026-09-29" })
  expect(await (await mcp.fetch("https://mcp.test/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject({ scopes_supported: ["hub"], resource_name: "hub" })
  expect((await client.readResource({ uri: board.uri })).contents[0]).toMatchObject({ uri: board.uri, text: board.html })
  expect((await client.listResources()).resources.map(resource => resource.uri)).toEqual([board.uri])
  expect(client.getServerCapabilities()?.prompts).toBeUndefined()
})

test("a mounted mutation is prepared under its prefixed name and committed with the hub's commit tool", async () => {
  const { person } = await hub()
  const client = await person(["beta/notes.create", "beta/notes.list"]).connect()
  const prepared = await client.callTool({ name: "beta_notes_create", arguments: { text: "hello" } })
  const intent = prepared.structuredContent as { intent_id: string; commit_token: string; commit_tool: string; capability: string; preview: { summary: string } }
  expect(intent).toMatchObject({ capability: "beta/notes.create", commit_tool: "hub_commit_confirmed" })
  const committed = await client.callTool({ name: "hub_commit_confirmed", arguments: { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary } })
  expect(committed.structuredContent).toMatchObject({ status: "committed", results: { count: 1 } })
  expect((await client.callTool({ name: "beta_notes_list", arguments: {} })).structuredContent).toEqual({ notes: ["hello"] })
})

test("a hub refuses a provider mounted twice and two different views at one URI", async () => {
  const auth = { issuer: "https://id.test", resource: "https://mcp.test/mcp" }
  expect(() => createMcpServer({ provider: own, mount: [mounted("alpha"), mounted("alpha")], auth })).toThrow("Provider alpha is mounted twice; mount each provider once, and never the server's own provider")
  expect(() => createMcpServer({ provider: own, mount: [own], auth })).toThrow("Provider hub is mounted twice")
  const other = defineView({ name: "board", html: "<!doctype html><title>Other</title>" })
  expect(() => createMcpServer({ provider: own, mount: [mounted("alpha"), mounted("gamma", other)], auth })).toThrow("Providers alpha and gamma define two different views at ui://board/index.html; share one defineView result, or rename one view")
})

test("allow decides, per request and in place of the scope rule, what each caller sees and may call", async () => {
  const { grants, person } = await hub()
  const reader = person(["alpha/notes.list"], [])
  const client = await reader.connect()
  expect(await names(client)).toEqual(["alpha_notes_list"])
  await expect(client.callTool({ name: "beta_notes_list", arguments: {} })).rejects.toThrow("Tool beta_notes_list not found")
  grants.set(reader.userId, ["beta/notes.list"])
  expect(await names(client)).toEqual(["beta_notes_list"])
  await expect(client.readResource({ uri: board.uri })).resolves.toBeDefined()
  grants.set(reader.userId, [])
  expect(await names(client)).toEqual([])
  await expect(client.readResource({ uri: board.uri })).rejects.toThrow()
})

test("called is true only for the tool a request calls, including a hidden one", async () => {
  const { decisions, person } = await hub()
  const reader = person(["alpha/notes.list"])
  const client = await reader.connect()
  const mine = () => decisions.splice(0).filter(decision => decision.user === reader.userId)
  mine()
  await client.listTools()
  expect(mine().filter(decision => decision.called)).toEqual([])
  await client.callTool({ name: "alpha_notes_list", arguments: {} })
  expect(mine().filter(decision => decision.called)).toEqual([{ user: reader.userId, identity: "alpha/notes.list", called: true }])
  await expect(client.callTool({ name: "beta_notes_create", arguments: { text: "x" } })).rejects.toThrow("not found")
  expect(mine().filter(decision => decision.called)).toEqual([{ user: reader.userId, identity: "beta/notes.create", called: true }])
  await expect(client.callTool({ name: "hub_commit", arguments: {} })).rejects.toThrow("not found")
  expect(mine().filter(decision => decision.called)).toEqual([])
})

test("a ToolError from allow answers any call with its envelope and fails a list, while connecting needs no decision", async () => {
  let failure: Error | undefined = new ToolError("UPSTREAM_UNAVAILABLE", "Answerable ID did not answer")
  const { person, mcp } = await hub({ allow: (principal, tool) => {
    if (failure) throw failure
    return tool.identity === "hub/hub.whoami"
  } })
  const client = await person([]).connect()
  for (const name of ["alpha_notes_list", "no_such_tool"]) {
    const result = await client.callTool({ name, arguments: {} })
    expect(result.isError).toBe(true)
    expect(errorOf(result)).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: "Answerable ID did not answer", retry: { policy: "after_delay", after_ms: 1000 }, request_id: expect.stringMatching(uuidV7) })
  }
  await expect(client.listTools()).rejects.toThrow()
  failure = new Error("unexpected")
  await expect(client.callTool({ name: "alpha_notes_list", arguments: {} })).rejects.toThrow()
  failure = undefined
  expect(await names(client)).toEqual(["hub_whoami"])
  const token = await mcp.issuer.sign({ resource: "https://mcp.test/mcp", scopes: ["hub"] })
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }
  expect((await mcp.fetch("https://mcp.test/mcp", { method: "GET", headers })).status).toBe(405)
  expect((await mcp.fetch("https://mcp.test/mcp", { method: "POST", headers, body: "{not json" })).status).toBe(400)
})

test("a JSON-RPC batch is refused with a JSON-RPC error, so allow never sees a call it cannot tell from a list", async () => {
  const { mcp, decisions } = await hub()
  const token = await mcp.issuer.sign({ resource: "https://mcp.test/mcp", scopes: ["hub"] })
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "beta_notes_create", arguments: { text: "hidden" } } }
  const response = await mcp.fetch("https://mcp.test/mcp", { method: "POST", headers, body: JSON.stringify([call]) })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches are not supported; send one JSON-RPC request per POST" } })
  expect(decisions).toEqual([])
})

test("a commit rechecks allow: a mutation the caller may no longer use answers PERMISSION_DENIED", async () => {
  const { grants, person } = await hub()
  const writer = person(["alpha/notes.create", "beta/notes.create"])
  const client = await writer.connect()
  const intent = (await client.callTool({ name: "alpha_notes_create", arguments: { text: "late" } })).structuredContent as { intent_id: string; commit_token: string; preview: { summary: string } }
  grants.set(writer.userId, ["beta/notes.create"])
  const refused = await client.callTool({ name: "hub_commit_confirmed", arguments: { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary } })
  expect(errorOf(refused)).toMatchObject({ code: "PERMISSION_DENIED", message: "Your access no longer covers alpha/notes.create" })
})

test("wrapCall runs around every tool, prepare and commit call, sees what it answers and may refuse it", async () => {
  const calls: ToolCall[] = []
  const seen: unknown[] = []
  const frozen: boolean[] = []
  const wrapCall: McpServerConfig["wrapCall"] = async (call, run) => {
    calls.push(call)
    frozen.push(Object.isFrozen(call))
    if (call.meta.refuse) throw new ToolError("RATE_LIMITED", "Too many calls")
    try {
      const data = await run()
      seen.push(data)
      return data
    } catch (error) {
      seen.push((error as ToolError).code)
      throw error
    }
  }
  const { person } = await hub({ wrapCall })
  const caller = person(everything)
  const client = await caller.connect("2026-07-28")
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  expect((await client.callTool({ name: "alpha_notes_list", arguments: {}, _meta: { traceparent } })).structuredContent).toEqual({ notes: [] })
  expect((await client.callTool({ name: "beta_notes_list", arguments: {} })).structuredContent).toEqual({ notes: [] })
  expect(errorOf(await client.callTool({ name: "alpha_notes_list", arguments: { limit: 9 } })).code).toBe("INVALID_INPUT")
  expect(errorOf(await client.callTool({ name: "alpha_notes_list", arguments: {}, _meta: { refuse: true, traceparent } })).code).toBe("RATE_LIMITED")
  const intent = (await client.callTool({ name: "alpha_notes_create", arguments: { text: "a" } })).structuredContent as { intent_id: string; commit_token: string; preview: { summary: string } }
  await client.callTool({ name: "hub_commit_confirmed", arguments: { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary } })
  expect(calls.map(call => [call.tool.identity, call.name])).toEqual([
    ["alpha/notes.list", "alpha_notes_list"], ["beta/notes.list", "beta_notes_list"], ["alpha/notes.list", "alpha_notes_list"], ["alpha/notes.list", "alpha_notes_list"], ["alpha/notes.create", "alpha_notes_create"],
    ["hub/commit_confirmed", "hub_commit_confirmed"],
  ])
  expect(calls.at(-1)!.tool).toEqual({ kind: "commit", identity: "hub/commit_confirmed", version: "2026-09-29" })
  expect(seen.slice(0, 3)).toEqual([{ notes: [] }, { notes: [] }, "INVALID_INPUT"])
  expect(seen.at(-1)).toMatchObject({ intent_id: intent.intent_id, status: "committed", results: { count: 1 } })
  expect(calls[0]).toMatchObject({ principal: { userId: caller.userId }, executionId: expect.stringMatching(uuidV7), requestId: expect.anything(), meta: { traceparent } })
  expect(frozen).toEqual(calls.map(() => true))
  expect(new Set(calls.map(call => call.executionId)).size).toBe(calls.length)
})

test("policyClass may answer asynchronously", async () => {
  const { person } = await hub({ policyClass: async () => "agent" as const })
  const client = await person(["alpha/notes.create"]).connect()
  const tool = (await client.listTools()).tools.find(item => item.name === "alpha_notes_create")!
  expect(tool._meta!["com.answerable/capability"]).toMatchObject({ policy_class: "agent" })
  expect((await client.callTool({ name: "alpha_notes_create", arguments: { text: "a" } })).structuredContent).toMatchObject({ commit_tool: "hub_commit", policy_class: "agent" })
})

// A tool of the hub's own provider that runs another served tool by identity, as the Toolbox's toolbox_execute and toolbox_prepare do.
function runner(server: () => McpServerHandle, tools: () => readonly Served<Tool | Mutation>[]) {
  return defineTool({
    name: "hub.run", description: about("Run a tool of a mounted provider by its identity"), scopes: ["hub"], timeoutMs: 55_000,
    input: z.object({ identity: z.string(), args: z.record(z.string(), z.unknown()).default({}) }), output: z.looseObject({}),
    async execute({ identity, args }, context) { return server().call(tools().find(tool => tool.identity === identity)!, args, context) },
  })
}

test("project serves some of the tools a caller may use; the others are unknown tools, yet their intents commit", async () => {
  const alpha = mounted("alpha")
  const provider = defineProvider({ id: "hub", version: "2026-09-29", tools: [whoami, runner(() => fixture.server(), () => alpha.tools)] })
  const offered: string[][] = []
  const stranger = mounted("gamma").tools[0]!
  const fixture = await hub({
    provider, mount: [alpha],
    // A tool the caller may not use stays unserved, whatever project returns.
    project: (_principal, usable) => {
      offered.push(usable.map(tool => tool.identity))
      return [stranger, ...usable.filter(tool => tool.identity.startsWith("hub/"))]
    },
  })
  const { person } = fixture
  const writer = await person(["hub/hub.run", "alpha/notes.create", "alpha/notes.list"]).connect("2026-07-28")
  expect(await names(writer)).toEqual(["hub_whoami", "hub_run", "hub_commit", "hub_commit_confirmed"])
  expect(offered.at(-1)).toEqual(["hub/hub.whoami", "hub/hub.run", "alpha/notes.list", "alpha/notes.create"])
  await expect(writer.callTool({ name: "alpha_notes_list", arguments: {} })).rejects.toThrow("Tool alpha_notes_list not found")
  const intent = (await writer.callTool({ name: "hub_run", arguments: { identity: "alpha/notes.create", args: { text: "projected" } } })).structuredContent as { intent_id: string; commit_token: string; commit_tool: string; preview: { summary: string } }
  expect(intent.commit_tool).toBe("hub_commit_confirmed")
  const committed = await writer.callTool({ name: "hub_commit_confirmed", arguments: { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary } })
  expect(committed.structuredContent).toMatchObject({ status: "committed", results: { count: 1 } })
  const reader = await person(["hub/hub.run", "alpha/notes.list"]).connect()
  expect(await names(reader)).toEqual(["hub_whoami", "hub_run"])
})

test("call runs a served tool as its direct call would, inside the calling tool: arguments, output, declared errors and intents", async () => {
  const alpha = mounted("alpha")
  const broken = defineTool({
    name: "notes.broken", description: about("Fail with the provider's own error code"), errors: ["FLAKY_BROKEN"],
    input: z.object({}), output: z.object({}), async execute() { throw new ToolError("FLAKY_BROKEN", "Broken on purpose", { retry: { policy: "never" } }) },
  })
  const flaky = defineProvider({ id: "flaky", version: "2026-09-29", tools: [broken] })
  const stranger = mounted("gamma").tools[0]!
  const provider = defineProvider({ id: "hub", version: "2026-09-29", tools: [whoami, runner(() => fixture.server(), () => [...alpha.tools, ...flaky.tools, stranger])] })
  const wrapped: string[] = []
  const fixture = await hub({ provider, mount: [alpha, flaky], wrapCall: (call, run) => (wrapped.push(call.tool.identity), run()) })
  const { person } = fixture
  const client = await person(["hub/hub.run", "alpha/notes.create", "alpha/notes.list", "flaky/notes.broken"]).connect()
  const run = (identity: string, args: Record<string, unknown> = {}) => client.callTool({ name: "hub_run", arguments: { identity, args } })
  expect((await run("alpha/notes.list")).structuredContent).toEqual({ notes: [] })
  expect(errorOf(await run("alpha/notes.list", { limit: 9 }))).toMatchObject({ code: "INVALID_INPUT", details: { field_violations: [{ field: "limit", message: expect.any(String) }] } })
  expect(errorOf(await run("flaky/notes.broken"))).toMatchObject({ code: "FLAKY_BROKEN", message: "Broken on purpose", retry: { policy: "never" } })
  expect((await run("alpha/notes.create", { text: "draft", validate_only: true })).structuredContent).toMatchObject({ intent_id: null, commit_token: null, commit_tool: "hub_commit_confirmed" })
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(errorOf(await run("gamma/notes.list")).code).toBe("INTERNAL")
    expect(String(log.mock.calls[0]![2])).toContain("gamma/notes.list is not served by this server; mount its provider")
  } finally { log.mockRestore() }
  expect(wrapped).toEqual(Array.from({ length: 5 }, () => "hub/hub.run"))
})

test("every request advertises tools.listChanged, and toolsChanged reaches each 2026-07-28 caller that listens", async () => {
  const { person, server, decisions } = await hub()
  const caller = person(["alpha/notes.list"])
  const client = await caller.connect("2026-07-28")
  expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true })
  expect((await caller.connect()).getServerCapabilities()?.tools).toEqual({ listChanged: true })
  const changed = new Promise(resolve => client.setNotificationHandler("notifications/tools/list_changed", resolve))
  decisions.splice(0)
  const subscription = await client.listen({ toolsListChanged: true })
  expect(subscription.honoredFilter).toEqual({ toolsListChanged: true })
  expect(decisions).toEqual([])
  server().toolsChanged()
  expect(await changed).toMatchObject({ method: "notifications/tools/list_changed" })
  await subscription.close()
})
