import { afterEach, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { createMcpServer, createMemoryIntentStore, defineMutation, defineProvider, defineTool, manifest, ToolError, type IntentStore, type McpServerConfig, type Mutation, type PolicyClass, type Tool } from "./index"
import { createTestMcp, errorOf, type TestMcp } from "./testing"

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const commitToken = /^act_[A-Za-z0-9_-]{43}$/
const about = (text: string) => `${text}. A fixture for the prepared-mutation tests.`
const minute = 60_000
const start = Date.parse("2026-09-29T12:00:00.000Z")
const at = (ms: number) => new Date(start + ms).toISOString()
const requestId = expect.stringMatching(uuidV7)

type Doc = { title: string; version: number }
type Resolvers = ReturnType<typeof Promise.withResolvers<void>>
type Gate = { entered: Resolvers; released: Resolvers }

// Documents whose versions a test can move between prepare and commit, and the mutations over them.
function library() {
  const docs = new Map<string, Doc>([["d1", { title: "First", version: 1 }], ["d2", { title: "Second", version: 1 }]])
  let gate: Gate | undefined
  const target = (id: string) => {
    const doc = docs.get(id)
    if (!doc) throw new ToolError("NOT_FOUND", "No accessible document exists")
    return { resource_type: "document", resource_id: id, label: doc.title, version: { kind: "serial" as const, value: String(doc.version) } }
  }
  const list = defineTool({
    name: "docs.list", description: about("List the documents"), input: z.object({}), output: z.object({ titles: z.array(z.string()) }),
    async execute() { return { titles: [...docs.values()].map(doc => doc.title) } },
  })
  const rename = defineMutation({
    name: "docs.rename", risk: "low", description: about("Rename a document"),
    input: z.object({ id: z.string(), title: z.string().trim().min(1) }), output: z.object({ id: z.string(), title: z.string() }),
    async prepare({ id, title }) {
      if (title === "Slow") await gate?.released.promise
      const doc = target(id)
      return { targets: [doc], preview: { summary: `Rename “${doc.label}” to “${title}”`, changes: [{ path: `docs[${id}].title`, from: doc.label, to: title }] }, plan: { id, title } }
    },
    async commit({ plan, preview }) {
      gate?.entered.resolve()
      await gate?.released.promise
      docs.set(plan.id, { title: plan.title, version: docs.get(plan.id)!.version + 1 })
      return { results: { id: plan.id, title: plan.title, internal: "dropped" }, applied_changes: preview.changes, effects_performed: [] }
    },
  })
  const remove = defineMutation({
    name: "docs.delete", description: about("Delete a document"),
    input: z.object({ id: z.string() }), output: z.object({ deleted: z.literal(true) }),
    async prepare({ id }) {
      const doc = target(id)
      return { targets: [doc], preview: { summary: `Delete “${doc.label}”`, changes: [{ path: `docs[${id}]`, from: docs.get(id) }] }, plan: { id } }
    },
    async commit({ plan, preview }) {
      docs.delete(plan.id)
      return { results: { deleted: true as const }, applied_changes: preview.changes, effects_performed: [] }
    },
  })
  const publish = defineMutation({
    name: "docs.publish", risk: "high", effects: ["publication", "notification"], scopes: ["test:publish"], description: about("Publish a document to every reader"),
    input: z.object({ id: z.string() }), output: z.object({ published: z.boolean() }),
    async prepare({ id }) {
      const doc = target(id)
      return { targets: [doc], preview: { summary: `Publish “${doc.label}”`, effects: ["publication"], warnings: ["Readers may be notified"], quantities: [{ name: "readers", value: 3, unit: "people" }] } }
    },
    async commit() { return { results: { published: true }, applied_changes: [], effects_performed: ["publication"] } },
  })
  const purge = defineMutation({
    name: "docs.purge", risk: "low", description: about("Delete every document"), input: z.object({}), output: z.object({ deleted: z.number() }),
    async prepare() { return { targets: [...docs.keys()].map(target), preview: { summary: `Delete ${docs.size} documents` } } },
    async commit() {
      const deleted = docs.size
      docs.clear()
      return { results: { deleted }, applied_changes: [], effects_performed: [] }
    },
  })
  const hold = () => (gate = { entered: Promise.withResolvers(), released: Promise.withResolvers() })
  return { docs, hold, list, rename, remove, publish, purge }
}
type Library = ReturnType<typeof library>

const mcps: TestMcp[] = []
afterEach(async () => { await Promise.all(mcps.splice(0).map(mcp => mcp.close())) })
type Options = { tools?: (library: Library) => (Tool | Mutation)[]; version?: string; intents?: IntentStore; policyClass?: McpServerConfig["policyClass"] }
async function serve(options: Options = {}) {
  const lib = library()
  let clock = start
  const intents = options.intents ?? createMemoryIntentStore({ now: () => clock })
  const tools = options.tools?.(lib) ?? [lib.list, lib.rename, lib.remove, lib.publish, lib.purge]
  const provider = defineProvider({ id: "test", version: options.version ?? "2026-09-29", tools })
  const mcp = await createTestMcp(auth => createMcpServer({ provider, auth, intents, policyClass: options.policyClass }))
  mcps.push(mcp)
  const person = { userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), clientId: "test-client" }
  type Connect = Parameters<TestMcp["connect"]>[0]
  const connect = (overrides: Connect = {}) => mcp.connect({ ...person, ...overrides })
  return { ...lib, provider, mcp, intents, person, connect, advance(ms: number) { clock += ms } }
}

type Client = Awaited<ReturnType<TestMcp["connect"]>>
type Prepared = { intent_id: string; commit_token: string; preview: { summary: string } }
// Returns the text mirror, parsed, after checking that it equals the structured content.
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
  const text = (result.content as { text: string }[])[0]!.text
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }])
  return JSON.parse(text)
}
const refused = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => errorOf(await client.callTool({ name, arguments: args }))
const commitArgs = (intent: Prepared) => ({ intent_id: intent.intent_id, commit_token: intent.commit_token })
const confirmedArgs = (intent: Prepared) => ({ ...commitArgs(intent), preview_summary: intent.preview.summary })
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

test("tools/list shows each prepare tool as read-only with its class, then the two commit tools", async () => {
  const { connect, provider } = await serve()
  const tools = (await (await connect()).listTools()).tools
  expect(tools.map(tool => tool.name)).toEqual(["docs_list", "docs_rename", "docs_delete", "docs_publish", "docs_purge", "test_commit", "test_commit_confirmed"])
  const [, rename, remove, publish, , commit, confirmed] = tools
  expect(rename).toMatchObject({
    description: about("Rename a document"), annotations: readOnly,
    _meta: { "com.answerable/capability": { identity: "test/docs.rename", version: "2026-09-29", kind: "mutate", risk: "low", policy_class: "agent" } },
    inputSchema: { additionalProperties: false, required: ["id", "title"], properties: { validate_only: { type: "boolean", default: false, description: expect.stringContaining("without recording an intent") } } },
    outputSchema: { required: ["intent_id", "capability", "version", "policy_class", "commit_tool", "commit_token", "expires_at", "targets", "preview", "approval"] },
  })
  expect(remove!._meta).toEqual({ "com.answerable/capability": { identity: "test/docs.delete", version: "2026-09-29", kind: "mutate", risk: "normal", policy_class: "controlled" } })
  expect(publish!._meta!["com.answerable/capability"]).toMatchObject({ risk: "high", policy_class: "human" })
  expect(commit).toMatchObject({
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { additionalProperties: false, required: ["intent_id", "commit_token"] },
  })
  expect(commit!._meta).toEqual({ "com.answerable/capability": { identity: "test/commit", kind: "commit" } })
  expect(confirmed).toMatchObject({
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { additionalProperties: false, required: ["intent_id", "commit_token", "preview_summary"] },
  })
  expect(confirmed!._meta).toEqual({ "com.answerable/capability": { identity: "test/commit_confirmed", kind: "commit" }, "anthropic/requiresUserInteraction": true })
  for (const tool of [commit!, confirmed!]) {
    expect(tool.outputSchema).toMatchObject({ required: ["receipt_id", "intent_id", "status", "results", "applied_changes", "effects_performed", "committed_at", "committed_by", "idempotent_replay"] })
    expect(tool.description!.length).toBeGreaterThanOrEqual(40)
    expect(tool.description!.length).toBeLessThanOrEqual(1000)
  }
  const entries = manifest(provider).tools
  for (const tool of tools) {
    const entry = entries.find(item => item.name === tool.name)!
    expect(tool).toMatchObject({ description: entry.description, annotations: entry.annotations })
    if (entry.kind === "commit") expect(tool).toMatchObject({ inputSchema: entry.input, outputSchema: entry.output })
    const { validate_only, ...properties } = tool.inputSchema.properties!
    if (entry.kind === "mutate") expect<object>({ ...tool.inputSchema, properties }).toEqual(entry.input)
    else expect(validate_only).toBeUndefined()
  }
  expect(commit!.description).toContain("agent-class")
  expect(confirmed!.description).toContain("controlled-class")
  expect(confirmed!.description).toContain("word for word")
})

test("prepare returns the intent: a single-use token, the commit tool for its class, the preview with defaults and the expiry", async () => {
  const { connect, docs } = await serve()
  const client = await connect()
  const renamed = await ok(client, "docs_rename", { id: "d1", title: "  Renamed  " })
  expect(renamed).toEqual({
    intent_id: expect.stringMatching(uuidV7), capability: "test/docs.rename", version: "2026-09-29",
    policy_class: "agent", commit_tool: "test_commit", commit_token: expect.stringMatching(commitToken), expires_at: at(10 * minute),
    targets: [{ resource_type: "document", resource_id: "d1", label: "First", version: { kind: "serial", value: "1" } }],
    preview: { summary: "Rename “First” to “Renamed”", changes: [{ path: "docs[d1].title", from: "First", to: "Renamed" }], effects: [], warnings: [], quantities: [] },
    approval: { required: false, status: "not_required" },
  })
  expect(await ok(client, "docs_delete", { id: "d2" })).toMatchObject({
    policy_class: "controlled", commit_tool: "test_commit_confirmed", expires_at: at(30 * minute), approval: { required: false, status: "not_required" },
    preview: { summary: "Delete “Second”", changes: [{ path: "docs[d2]", from: { title: "Second", version: 1 }, to: null }] },
  })
  const published = await ok(client, "docs_publish", { id: "d1" })
  expect(published).toMatchObject({
    policy_class: "human", commit_tool: "test_commit_confirmed", commit_token: expect.stringMatching(commitToken), expires_at: at(24 * 60 * minute),
    approval: { required: true, status: "pending" },
    preview: { summary: "Publish “First”", changes: [], effects: ["publication"], warnings: ["Readers may be notified"], quantities: [{ name: "readers", value: 3, unit: "people" }] },
  })
  expect(new Set([renamed.commit_token, published.commit_token]).size).toBe(2)
  expect(docs.get("d1")).toEqual({ title: "First", version: 1 })
  expect(await refused(client, "docs_delete", { id: "missing" })).toEqual({ code: "NOT_FOUND", message: "No accessible document exists", retry: { policy: "never" }, request_id: requestId })
})

test("validate_only runs prepare and records nothing", async () => {
  const intents = createMemoryIntentStore({ now: () => start })
  const insert = spyOn(intents, "insert")
  const { connect } = await serve({ intents })
  const client = await connect()
  expect(await ok(client, "docs_delete", { id: "d1", validate_only: true })).toEqual({
    intent_id: null, capability: "test/docs.delete", version: "2026-09-29", policy_class: "controlled", commit_tool: "test_commit_confirmed",
    commit_token: null, expires_at: at(30 * minute), targets: [expect.objectContaining({ resource_id: "d1" })],
    preview: expect.objectContaining({ summary: "Delete “First”" }), approval: { required: false, status: "not_required" },
  })
  expect(insert).not.toHaveBeenCalled()
  await ok(client, "docs_delete", { id: "d1", validate_only: false })
  expect(insert).toHaveBeenCalledTimes(1)
  expect(insert.mock.calls[0]![0].input).toEqual({ id: "d1" })
  expect(await refused(client, "docs_delete", { id: "d1", validate_only: "yes" })).toMatchObject({ code: "INVALID_INPUT", details: { field_violations: [{ field: "validate_only" }] } })
})

test("commit applies the intent once and returns the receipt; a repeat by the same person returns it again as a replay", async () => {
  const { connect, docs, person, advance } = await serve()
  const client = await connect()
  const intent = await ok(client, "docs_rename", { id: "d1", title: "Renamed" })
  advance(minute)
  const receipt = await ok(client, "test_commit", commitArgs(intent))
  expect(receipt).toEqual({
    receipt_id: expect.stringMatching(uuidV7), intent_id: intent.intent_id, status: "committed",
    results: { id: "d1", title: "Renamed" }, applied_changes: [{ path: "docs[d1].title", from: "First", to: "Renamed" }], effects_performed: [],
    committed_at: at(minute), committed_by: { user_id: person.userId, membership_id: person.membershipId, client_id: "test-client" },
    idempotent_replay: false,
  })
  expect(docs.get("d1")).toEqual({ title: "Renamed", version: 2 })
  advance(20 * minute)
  expect(await ok(client, "test_commit", commitArgs(intent))).toEqual({ ...receipt, idempotent_replay: true })
  expect(await ok(await connect(), "test_commit", commitArgs(intent))).toEqual({ ...receipt, idempotent_replay: true })
  expect(docs.get("d1")).toEqual({ title: "Renamed", version: 2 })
})

test("the wrong commit tool or a different summary answers APPROVAL_REQUIRED and leaves the intent committable", async () => {
  const { connect, docs } = await serve()
  const client = await connect()
  const approval = (commit_tool: string, policy: string) => ({ code: "APPROVAL_REQUIRED", retry: { policy: "after_approval" }, details: { approval: { class: policy, commit_tool } }, request_id: requestId })
  const controlled = await ok(client, "docs_delete", { id: "d1" })
  expect(await refused(client, "test_commit", commitArgs(controlled))).toEqual({
    ...approval("test_commit_confirmed", "controlled"),
    message: `Intent ${controlled.intent_id} is controlled class: show the person its preview, then commit it with test_commit_confirmed and its summary as preview_summary`,
  })
  expect(await refused(client, "test_commit_confirmed", { ...commitArgs(controlled), preview_summary: "Delete “Second”" })).toEqual({
    ...approval("test_commit_confirmed", "controlled"),
    message: `preview_summary differs from the summary of intent ${controlled.intent_id}; show the person the preview and pass its summary word for word`,
  })
  expect(docs.has("d1")).toBe(true)
  expect(await ok(client, "test_commit_confirmed", confirmedArgs(controlled))).toMatchObject({
    results: { deleted: true }, applied_changes: [{ path: "docs[d1]", from: { title: "First", version: 1 }, to: null }],
  })
  expect(docs.has("d1")).toBe(false)
  const agent = await ok(client, "docs_rename", { id: "d2", title: "Renamed" })
  expect(await refused(client, "test_commit_confirmed", confirmedArgs(agent))).toEqual({
    ...approval("test_commit", "agent"), message: `Intent ${agent.intent_id} is agent class; commit it with test_commit`,
  })
  expect(await ok(client, "test_commit", commitArgs(agent))).toMatchObject({ results: { title: "Renamed" } })
})

test("a human-class intent waits for an approval: both commit tools answer APPROVAL_REQUIRED with the pending approval and no URL", async () => {
  const { connect, intents, docs } = await serve()
  const client = await connect()
  const intent = await ok(client, "docs_publish", { id: "d1" })
  expect(await intents.get(intent.intent_id)).toMatchObject({ status: "awaiting_approval", policy_class: "human", approval: { required: true, status: "pending" } })
  for (const [name, args] of [["test_commit", commitArgs(intent)], ["test_commit_confirmed", confirmedArgs(intent)]] as const) {
    expect(await refused(client, name, args)).toEqual({
      code: "APPROVAL_REQUIRED", message: `Intent ${intent.intent_id} is human class and needs a person's approval, which this server cannot record yet`,
      retry: { policy: "after_approval" }, details: { approval: { class: "human", commit_tool: "test_commit_confirmed", status: "pending" } }, request_id: requestId,
    })
  }
  expect(docs.get("d1")).toEqual({ title: "First", version: 1 })
})

test("a wrong token answers COMMIT_TOKEN_INVALID and leaves the intent committable", async () => {
  const { connect } = await serve()
  const client = await connect()
  const intent = await ok(client, "docs_rename", { id: "d1", title: "Renamed" })
  const other = await ok(client, "docs_rename", { id: "d2", title: "Renamed" })
  for (const commit_token of [other.commit_token, `act_${"A".repeat(43)}`, ""]) {
    expect(await refused(client, "test_commit", { intent_id: intent.intent_id, commit_token })).toEqual({
      code: "COMMIT_TOKEN_INVALID", message: `The commit token does not match intent ${intent.intent_id}`, retry: { policy: "never" }, request_id: requestId,
    })
  }
  expect(await ok(client, "test_commit", commitArgs(intent))).toMatchObject({ idempotent_replay: false })
})

test("another person, membership or client answers PRINCIPAL_MISMATCH before anything else; an unknown intent answers INTENT_NOT_FOUND", async () => {
  const { connect } = await serve()
  const client = await connect()
  const intent = await ok(client, "docs_rename", { id: "d1", title: "Renamed" })
  const strangers = await Promise.all([{ userId: crypto.randomUUID() }, { membershipId: crypto.randomUUID() }, { clientId: "other-client" }].map(other => connect(other)))
  const mismatch = { code: "PRINCIPAL_MISMATCH", message: `Intent ${intent.intent_id} belongs to another person, membership or client; prepare your own`, retry: { policy: "never" }, request_id: requestId }
  for (const stranger of strangers) {
    expect(await refused(stranger, "test_commit", commitArgs(intent))).toEqual(mismatch)
    expect(await refused(stranger, "test_commit_confirmed", { ...confirmedArgs(intent), commit_token: "act_wrong" })).toEqual(mismatch)
  }
  await ok(client, "test_commit", commitArgs(intent))
  expect(await refused(strangers[0]!, "test_commit", commitArgs(intent))).toEqual(mismatch)
  const unknown = Bun.randomUUIDv7()
  expect(await refused(client, "test_commit", { ...commitArgs(intent), intent_id: unknown })).toEqual({
    code: "INTENT_NOT_FOUND", message: `No intent ${unknown} exists; prepare the mutation again`, retry: { policy: "after_reprepare" }, request_id: requestId,
  })
  expect(await refused(client, "test_commit", { ...commitArgs(intent), intent_id: "not-an-id" })).toMatchObject({ code: "INVALID_INPUT", details: { field_violations: [{ field: "intent_id" }] } })
})

test("an intent past its expiry answers INTENT_EXPIRED and stays expired; expiresInMs shortens the expiry", async () => {
  const { connect, intents, advance } = await serve({ tools: lib => [lib.rename, defineMutation({ ...lib.remove, name: "docs.brief", expiresInMs: 5000 })] })
  const client = await connect()
  const intent = await ok(client, "docs_rename", { id: "d1", title: "Renamed" })
  expect(await ok(client, "docs_brief", { id: "d1" })).toMatchObject({ expires_at: at(5000) })
  advance(10 * minute - 1)
  expect((await intents.get(intent.intent_id))!.status).toBe("prepared")
  advance(1)
  const expired = { code: "INTENT_EXPIRED", message: `Intent ${intent.intent_id} expired at ${at(10 * minute)}; prepare it again`, retry: { policy: "after_reprepare" }, request_id: requestId }
  expect(await refused(client, "test_commit", commitArgs(intent))).toEqual(expired)
  expect((await intents.get(intent.intent_id))!.status).toBe("expired")
  expect(await refused(client, "test_commit", commitArgs(intent))).toEqual(expired)
})

test("a moved, missing or new target answers INTENT_STALE with the expected and current versions, and the intent stays stale", async () => {
  const { connect, docs } = await serve()
  const client = await connect()
  const intent = await ok(client, "docs_delete", { id: "d1" })
  docs.set("d1", { title: "First", version: 2 })
  expect(await refused(client, "test_commit_confirmed", confirmedArgs(intent))).toEqual({
    code: "INTENT_STALE", message: `Intent ${intent.intent_id} is stale: “First” changed since it was prepared; prepare it again`,
    retry: { policy: "after_reprepare" }, details: { targets: [{ resource_id: "d1", expected: "1", current: "2" }] }, request_id: requestId,
  })
  expect(docs.has("d1")).toBe(true)
  expect(await refused(client, "test_commit_confirmed", confirmedArgs(intent))).toEqual({
    code: "INTENT_STALE", message: `Intent ${intent.intent_id} is stale; prepare it again`, retry: { policy: "after_reprepare" }, request_id: requestId,
  })
  const purge = await ok(client, "docs_purge")
  docs.delete("d2")
  docs.set("d3", { title: "Third", version: 1 })
  expect(await refused(client, "test_commit", commitArgs(purge))).toMatchObject({
    code: "INTENT_STALE", message: `Intent ${purge.intent_id} is stale: “Second”, “Third” changed since it was prepared; prepare it again`,
    details: { targets: [{ resource_id: "d2", expected: "1", current: null }, { resource_id: "d3", expected: null, current: "1" }] },
  })
  expect(docs.size).toBe(2)
})

test("a second commit while the first runs answers COMMIT_IN_PROGRESS, and later the replay", async () => {
  const { connect, hold } = await serve()
  const client = await connect()
  const intent = await ok(client, "docs_rename", { id: "d1", title: "Renamed" })
  const gate = hold()
  const first = client.callTool({ name: "test_commit", arguments: commitArgs(intent) })
  await gate.entered.promise
  expect(await refused(client, "test_commit", commitArgs(intent))).toEqual({
    code: "COMMIT_IN_PROGRESS", message: `Intent ${intent.intent_id} is being committed; call again shortly for its receipt`,
    retry: { policy: "after_delay", after_ms: 1000 }, request_id: requestId,
  })
  gate.released.resolve()
  expect((await first).structuredContent).toMatchObject({ idempotent_replay: false })
  expect(await ok(client, "test_commit", commitArgs(intent))).toMatchObject({ idempotent_replay: true })
})

test("two commits of one intent at once apply it once: one receipt, and the other answers COMMIT_IN_PROGRESS or replays it", async () => {
  // Both commits read the intent as prepared before either claims it.
  const memory = createMemoryIntentStore()
  const both = Promise.withResolvers<void>()
  let reads = 0
  const intents: IntentStore = {
    ...memory,
    async get(intentId) {
      const intent = await memory.get(intentId)
      if (++reads === 2) both.resolve()
      if (reads <= 2) await both.promise
      return intent
    },
  }
  const { connect, docs } = await serve({ intents })
  const client = await connect()
  const intent = await ok(client, "docs_rename", { id: "d1", title: "Renamed" })
  const results = await Promise.all([1, 2].map(() => client.callTool({ name: "test_commit", arguments: commitArgs(intent) })))
  const receipts = results.filter(result => !result.isError).map(result => result.structuredContent as { receipt_id: string; idempotent_replay: boolean })
  const answers = [...receipts.map(receipt => receipt.idempotent_replay ? "replay" : "receipt"), ...results.filter(result => result.isError).map(result => errorOf(result).code)]
  expect([["COMMIT_IN_PROGRESS", "receipt"], ["receipt", "replay"]]).toContainEqual(answers.sort())
  expect(new Set(receipts.map(receipt => receipt.receipt_id)).size).toBe(1)
  expect(docs.get("d1")).toEqual({ title: "Renamed", version: 2 })
})

test("an intent keeps only the SHA-256 of its commit token", async () => {
  const { connect, intents } = await serve()
  const intent = await ok(await connect(), "docs_rename", { id: "d1", title: "Renamed" })
  const stored = (await intents.get(intent.intent_id))!
  expect(stored.commit_token_hash).toBe(new Bun.CryptoHasher("sha256").update(intent.commit_token).digest("hex"))
  expect(JSON.stringify(stored)).not.toContain(intent.commit_token)
})

test("a commit that throws marks the intent failed: a ToolError is returned, anything else answers INTERNAL, and a retry answers INTENT_CONSUMED", async () => {
  const failing = defineMutation({
    name: "docs.fail", risk: "low", description: about("Fails on purpose"),
    input: z.object({ how: z.enum(["tool", "crash", "output"]) }), output: z.object({ ok: z.boolean() }),
    async prepare({ how }) { return { targets: [], preview: { summary: `Fail by ${how}` }, plan: { how } } },
    async commit({ plan }) {
      if (plan.how === "tool") throw new ToolError("PRECONDITION_FAILED", "The document is locked", { details: { preconditions: ["unlocked"] } })
      if (plan.how === "crash") throw new Error("private-commit-secret")
      return { results: { ok: "yes" as unknown as boolean }, applied_changes: [], effects_performed: [] }
    },
  })
  const { connect, intents, docs } = await serve({ tools: lib => [lib.remove, failing] })
  const client = await connect()
  const consumed = (intent: Prepared) => ({ code: "INTENT_CONSUMED", message: `Intent ${intent.intent_id} was used and its commit failed; prepare it again`, retry: { policy: "after_reprepare" }, request_id: requestId })
  const locked = await ok(client, "docs_fail", { how: "tool" })
  expect(await refused(client, "test_commit", commitArgs(locked))).toEqual({
    code: "PRECONDITION_FAILED", message: "The document is locked", retry: { policy: "after_state_change" }, details: { preconditions: ["unlocked"] }, request_id: requestId,
  })
  expect((await intents.get(locked.intent_id))!.status).toBe("failed")
  expect(await refused(client, "test_commit", commitArgs(locked))).toEqual(consumed(locked))
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const how of ["crash", "output"]) {
      const intent = await ok(client, "docs_fail", { how })
      const result = await refused(client, "test_commit", commitArgs(intent))
      expect(result).toEqual({ code: "INTERNAL", message: "The tool could not complete", retry: { policy: "after_delay", after_ms: 1000 }, request_id: requestId })
      expect(JSON.stringify(result)).not.toContain("private-")
      expect(await refused(client, "test_commit", commitArgs(intent))).toEqual(consumed(intent))
    }
    expect(log.mock.calls.map(call => call[0])).toEqual(["[mcp] tool test_commit failed", "[mcp] tool test_commit failed"])
    expect(log.mock.calls.map(call => call[1])).toEqual([expect.stringMatching(uuidV7), expect.stringMatching(uuidV7)])
  } finally { log.mockRestore() }
  const gone = await ok(client, "docs_delete", { id: "d1" })
  docs.delete("d1")
  expect(await refused(client, "test_commit_confirmed", confirmedArgs(gone))).toMatchObject({ code: "NOT_FOUND", message: "No accessible document exists" })
  expect(await refused(client, "test_commit_confirmed", confirmedArgs(gone))).toEqual(consumed(gone))
})

test("a plan that breaks the contract answers INTERNAL: an undeclared effect, an empty summary or a target without a version", async () => {
  const careless = defineMutation({
    name: "docs.careless", effects: ["notification"], description: about("Returns plans that break the contract"),
    input: z.object({ fault: z.enum(["effect", "summary", "version"]) }), output: z.object({}),
    async prepare({ fault }) {
      if (fault === "effect") return { targets: [], preview: { summary: "Notify and publish", effects: ["notification", "publication"] } }
      if (fault === "summary") return { targets: [], preview: { summary: "" } }
      return { targets: [{ resource_type: "document", resource_id: "d1", label: "First" }], preview: { summary: "No version" } } as never
    },
    async commit() { return { results: {}, applied_changes: [], effects_performed: [] } },
  })
  const intents = createMemoryIntentStore()
  const insert = spyOn(intents, "insert")
  const { connect } = await serve({ tools: () => [careless], intents })
  const client = await connect()
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const fault of ["effect", "summary", "version"]) {
      expect(await refused(client, "docs_careless", { fault })).toMatchObject({ code: "INTERNAL", message: "The tool could not complete" })
    }
    expect(log.mock.calls.map(call => call[0])).toEqual(Array(3).fill("[mcp] tool docs.careless failed"))
    expect((log.mock.calls[0]![2] as Error).message).toBe("Mutation docs.careless: the preview names effects it does not declare (publication); add them to effects or leave them out of the preview")
  } finally { log.mockRestore() }
  expect(insert).not.toHaveBeenCalled()
})

test("a caller who can use no mutation sees no commit tools; one who can use any mutation sees both", async () => {
  const { connect } = await serve()
  const reader = await connect({ scopes: ["test:read"] })
  expect((await reader.listTools()).tools.map(tool => tool.name)).toEqual(["docs_list"])
  await expect(reader.callTool({ name: "test_commit", arguments: {} })).rejects.toThrow("Tool test_commit not found")
  await expect(reader.callTool({ name: "docs_rename", arguments: {} })).rejects.toThrow("Tool docs_rename not found")
  const publisher = await connect({ scopes: ["test:publish"] })
  expect((await publisher.listTools()).tools.map(tool => tool.name)).toEqual(["docs_publish", "test_commit", "test_commit_confirmed"])
})

test("commit rechecks the mutation's scopes: the same person without them answers PERMISSION_DENIED", async () => {
  const { connect } = await serve()
  const writer = await connect({ scopes: ["test:write"] })
  const intent = await ok(writer, "docs_rename", { id: "d1", title: "Renamed" })
  const publisher = await connect({ scopes: ["test:publish"] })
  expect(await refused(publisher, "test_commit", commitArgs(intent))).toEqual({
    code: "PERMISSION_DENIED", message: "Your access no longer covers test/docs.rename", retry: { policy: "never" }, request_id: requestId,
  })
  expect(await ok(writer, "test_commit", commitArgs(intent))).toMatchObject({ results: { title: "Renamed" } })
})

test("an intent for a version this server does not serve answers INTENT_NOT_FOUND", async () => {
  const intents = createMemoryIntentStore()
  const previous = await serve({ intents, version: "2026-09-28" })
  const current = await serve({ intents })
  const intent = await ok(await previous.connect(), "docs_rename", { id: "d1", title: "Renamed" })
  expect(await refused(await current.mcp.connect(previous.person), "test_commit", commitArgs(intent))).toEqual({
    code: "INTENT_NOT_FOUND", message: `Intent ${intent.intent_id} is for test/docs.rename version 2026-09-28, which this server does not serve; prepare it again`,
    retry: { policy: "after_reprepare" }, request_id: requestId,
  })
})

test("policyClass decides the class for each caller: in _meta, the intent, the commit tool and the expiry cap", async () => {
  const calls: string[] = []
  const { connect, person } = await serve({
    tools: lib => [lib.remove, lib.publish, defineMutation({ ...lib.remove, name: "docs.later", expiresInMs: 20 * minute })],
    policyClass(mutation, principal) {
      calls.push(`${mutation.identity} ${principal.userId}`)
      return "agent"
    },
  })
  const client = await connect()
  const tools = (await client.listTools()).tools
  expect(tools.map(tool => (tool._meta?.["com.answerable/capability"] as { policy_class?: string }).policy_class)).toEqual(["agent", "agent", "agent", undefined, undefined])
  const intent = await ok(client, "docs_delete", { id: "d1" })
  expect(intent).toMatchObject({ policy_class: "agent", commit_tool: "test_commit", expires_at: at(10 * minute) })
  expect(await ok(client, "docs_later", { id: "d2" })).toMatchObject({ expires_at: at(10 * minute) })
  expect(await ok(client, "docs_publish", { id: "d2" })).toMatchObject({ policy_class: "agent", approval: { required: false, status: "not_required" } })
  expect(await ok(client, "test_commit", commitArgs(intent))).toMatchObject({ results: { deleted: true } })
  expect(calls).toContain(`test/docs.delete ${person.userId}`)
})

test("commit rechecks the policy class: one that rose since prepare answers APPROVAL_REQUIRED for what a fresh prepare would need, and the intent stays prepared", async () => {
  let policy: PolicyClass = "agent"
  const { connect, docs, intents } = await serve({ policyClass: () => policy })
  const client = await connect()
  const intent = await ok(client, "docs_rename", { id: "d1", title: "Renamed" })
  const rose = (to: PolicyClass, approval: object) => ({
    code: "APPROVAL_REQUIRED", message: `test/docs.rename now needs the ${to} class, not the agent class intent ${intent.intent_id} was prepared with; prepare it again`,
    retry: { policy: "after_approval" }, details: { approval: { class: to, commit_tool: "test_commit_confirmed", ...approval } }, request_id: requestId,
  })
  policy = "controlled"
  expect(await refused(client, "test_commit", commitArgs(intent))).toEqual(rose("controlled", {}))
  policy = "human"
  expect(await refused(client, "test_commit_confirmed", confirmedArgs(intent))).toEqual(rose("human", { status: "pending" }))
  expect(await ok(client, "docs_rename", { id: "d2", title: "Renamed" })).toMatchObject({ policy_class: "human", commit_tool: "test_commit_confirmed", approval: { required: true, status: "pending" } })
  expect((await intents.get(intent.intent_id))!.status).toBe("prepared")
  expect(docs.get("d1")).toEqual({ title: "First", version: 1 })
  policy = "agent"
  expect(await ok(client, "test_commit", commitArgs(intent))).toMatchObject({ results: { title: "Renamed" } })
})

test("timeoutMs bounds prepare, and re-prepare with commit: a commit past it answers TIMEOUT and finishes in the background", async () => {
  const { connect, hold, intents, docs } = await serve({ tools: lib => [defineMutation({ ...lib.rename, timeoutMs: 50 })] })
  const client = await connect()
  const timeout = { code: "TIMEOUT", message: "The tool did not finish within 50 ms", retry: { policy: "after_delay", after_ms: 1000 }, request_id: requestId }
  const slow = hold()
  expect(await refused(client, "docs_rename", { id: "d1", title: "Slow" })).toEqual(timeout)
  slow.released.resolve()
  const intent = await ok(client, "docs_rename", { id: "d1", title: "Renamed" })
  const gate = hold()
  expect(await refused(client, "test_commit", commitArgs(intent))).toEqual(timeout)
  expect(await refused(client, "test_commit", commitArgs(intent))).toMatchObject({ code: "COMMIT_IN_PROGRESS" })
  gate.released.resolve()
  while ((await intents.get(intent.intent_id))!.status === "committing") await Bun.sleep(1)
  expect(await ok(client, "test_commit", commitArgs(intent))).toMatchObject({ idempotent_replay: true, results: { title: "Renamed" } })
  expect(docs.get("d1")).toEqual({ title: "Renamed", version: 2 })
})
