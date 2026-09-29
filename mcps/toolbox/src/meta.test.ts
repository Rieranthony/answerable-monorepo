import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { defineProvider, defineTool, manifest, type Provider } from "@answerable/mcp"
import { errorOf } from "@answerable/mcp/testing"
import { z } from "zod"
import { writeCatalogue, writeHostClient } from "./catalogue"
import { migrate } from "./db/migrate"
import { testDatabase } from "./test/database"
import { createHub, e2e, names, type Client, type Hub } from "./test/hub"

const db = testDatabase()
beforeAll(() => migrate(db))
afterAll(() => db.close())
const hubs: Hub[] = []
afterEach(async () => { await Promise.all(hubs.splice(0).map(hub => hub.mcp.close())) })
async function hub(providers?: Provider[]) {
  const created = await createHub(db, providers)
  hubs.push(created)
  return created
}
// A host client set to the meta projection.
async function metaClient() {
  const clientId = `meta-${crypto.randomUUID()}`
  await writeHostClient(db, clientId, { projection: "meta" })
  return clientId
}
const metaTools = ["toolbox_whoami", "toolbox_search", "toolbox_describe", "toolbox_execute", "toolbox_prepare"]
const commits = ["toolbox_commit", "toolbox_commit_confirmed"]
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(`${name}: ${errorOf(result).code} ${errorOf(result).message}`)
  return result.structuredContent as Record<string, unknown>
}
const refusal = async (client: Client, name: string, args: Record<string, unknown>) => errorOf(await client.callTool({ name, arguments: args }))
const events = (organisation: string) => db`select kind, outcome, capability_identity, error_code, reason, intent_id::text from evidence_events where organisation_id = ${organisation} order by seq`
// 41 reads: one more than the default direct limit.
const wide = defineProvider({ id: "wide", version: "2026-09-29", tools: Array.from({ length: 41 }, (_, index) => defineTool({
  name: `items.get${index}`, description: `Read item ${index} of the wide fixture; it changes nothing.`, input: z.object({}), output: z.object({}), async execute() { return {} },
})) })

test("a host client set to meta lists toolbox_whoami, the four meta tools and, when the caller may use a mutation, the commit tools, all read-only but the commits", async () => {
  const { member } = await hub()
  const clientId = await metaClient()
  const alpha = await member(["e2e"])
  const tools = (await (await alpha.connect("2026-07-28", clientId)).listTools()).tools
  expect(tools.map(tool => tool.name)).toEqual([...metaTools, ...commits])
  for (const tool of tools.slice(0, 5)) expect(tool.annotations, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
  expect(tools[6]).toMatchObject({ annotations: { destructiveHint: true }, _meta: { "anthropic/requiresUserInteraction": true } })
  const reader = await member(["e2e/records.list"])
  expect(await names(await reader.connect(undefined, clientId))).toEqual(metaTools)
  await expect((await reader.connect(undefined, clientId)).callTool({ name: "e2e_records_list", arguments: {} })).rejects.toThrow("Tool e2e_records_list not found")
})

test("auto serves the direct projection while the granted tools number at most direct_limit, the meta projection above it; direct stays direct", async () => {
  const { member } = await hub([wide])
  const everything = await member(["wide"])
  expect(await names(await everything.connect())).toEqual(metaTools)
  const forty = await member(Array.from({ length: 40 }, (_, index) => `wide/items.get${index}`))
  expect(await names(await forty.connect())).toHaveLength(41)
  const direct = `direct-${crypto.randomUUID()}`
  await writeHostClient(db, direct, { projection: "direct" })
  expect(await names(await everything.connect(undefined, direct))).toHaveLength(42)
  const narrow = `narrow-${crypto.randomUUID()}`
  await writeHostClient(db, narrow, { direct_limit: 1 })
  expect(await names(await (await member(["wide/items.get0"])).connect(undefined, narrow))).toEqual(["toolbox_whoami", "wide_items_get0"])
  expect(await names(await (await member(["wide/items.get0", "wide/items.get1"])).connect(undefined, narrow))).toEqual(metaTools)
})

test("toolbox_search finds the capabilities a caller may use by a word, with the first sentence, kind and policy class, a page at a time", async () => {
  const { member } = await hub()
  const clientId = await metaClient()
  const client = await (await member(["e2e"])).connect(undefined, clientId)
  expect(await call(client, "toolbox_search", { query: "oldest" })).toEqual({
    items: [{ identity: "e2e/records.list", title: null, description: "List your organisation's test records, oldest first, 20 per page by default and at most 100.", kind: "read", policy_class: null }],
    next_cursor: null, has_more: false,
  })
  const first = await call(client, "toolbox_search", { query: "records", limit: 3 })
  expect(first).toMatchObject({ next_cursor: "3", has_more: true })
  const second = await call(client, "toolbox_search", { query: "records", limit: 3, cursor: "3" })
  expect(second).toMatchObject({ next_cursor: null, has_more: false })
  const found = [...first.items as { identity: string }[], ...second.items as { identity: string }[]]
  expect(found.map(item => item.identity).toSorted()).toEqual(["e2e/records.create", "e2e/records.delete", "e2e/records.list", "e2e/records.show"])
  expect(found.find(item => item.identity === "e2e/records.delete")).toMatchObject({ kind: "mutate", policy_class: "controlled", title: null })
  expect(found.find(item => item.identity === "e2e/records.show")).toMatchObject({ title: "Test records" })
  expect(await call(client, "toolbox_search", { query: "?!" })).toEqual({ items: [], next_cursor: null, has_more: false })
  expect(await refusal(client, "toolbox_search", { query: "records", limit: 21, cursor: "x" })).toMatchObject({ code: "INVALID_INPUT", details: { field_violations: [{ field: "limit" }, { field: "cursor" }] } })
})

test("toolbox_search never returns a capability the caller may not use", async () => {
  const { member } = await hub()
  const clientId = await metaClient()
  const beta = await member(["e2e/records"])
  await writeCatalogue(db, beta.organizationId, "e2e", { enabled: true, overrides: { disabled: ["e2e/records.show"] } })
  const client = await beta.connect(undefined, clientId)
  expect(await call(client, "toolbox_search", { query: "identity" })).toEqual({ items: [], next_cursor: null, has_more: false })
  const found = (await call(client, "toolbox_search", { query: "records identity view", limit: 20 })).items as { identity: string }[]
  expect(found.map(item => item.identity).toSorted()).toEqual(["e2e/records.create", "e2e/records.delete", "e2e/records.list"])
})

test("toolbox_describe gives up to five capabilities' descriptions and manifest schemas; one the caller may not use is NOT_FOUND, as an unknown one is", async () => {
  const { member } = await hub()
  const clientId = await metaClient()
  const contract = new Map(manifest(e2e()).tools.map(entry => [entry.identity, entry]))
  const beta = await (await member(["e2e/records"])).connect(undefined, clientId)
  const described = await call(beta, "toolbox_describe", { identities: ["e2e/records.list", "e2e/records.delete"] })
  expect(described).toEqual({ capabilities: ["e2e/records.list", "e2e/records.delete"].map(identity => {
    const { kind, description, input, output } = contract.get(identity)!
    return { identity, kind, policy_class: kind === "mutate" ? "controlled" : null, description, input, output }
  }) })
  for (const identity of ["e2e/identity.get", "e2e/nothing.here"]) {
    expect(await refusal(beta, "toolbox_describe", { identities: ["e2e/records.list", identity] })).toMatchObject({
      code: "NOT_FOUND", message: `You may use no capability ${identity}; find one with toolbox_search`,
    })
  }
  expect((await refusal(beta, "toolbox_describe", { identities: Array.from({ length: 6 }, () => "e2e/records.list") })).code).toBe("INVALID_INPUT")
})

test("toolbox_execute runs a read as its direct call would, recorded as that capability's call; a mutation, a hidden capability or bad arguments are refused", async () => {
  const { member, spans } = await hub()
  const clientId = await metaClient()
  const beta = await member(["e2e/records"])
  const client = await beta.connect(undefined, clientId)
  expect(await call(client, "toolbox_execute", { identity: "e2e/records.list" })).toEqual({ items: [], next_cursor: null, has_more: false })
  expect(await refusal(client, "toolbox_execute", { identity: "e2e/records.list", arguments: { limit: 0, extra: 1 } })).toMatchObject({
    code: "INVALID_INPUT", details: { field_violations: [{ field: "limit" }, { field: "extra", message: "Unknown field" }] },
  })
  expect(await refusal(client, "toolbox_execute", { identity: "e2e/records.delete", arguments: { id: crypto.randomUUID() } })).toMatchObject({
    code: "INVALID_INPUT", message: "e2e/records.delete is a mutation; prepare it with toolbox_prepare",
  })
  for (const identity of ["e2e/identity.get", "e2e/nothing.here"]) expect((await refusal(client, "toolbox_execute", { identity })).code).toBe("NOT_FOUND")
  expect(await events(beta.organizationId)).toEqual([
    { kind: "capability.completed", outcome: "success", capability_identity: "e2e/records.list", error_code: null, reason: null, intent_id: null },
    { kind: "capability.completed", outcome: "failure", capability_identity: "e2e/records.list", error_code: "INVALID_INPUT", reason: null, intent_id: null },
    { kind: "capability.completed", outcome: "failure", capability_identity: "toolbox/toolbox.execute", error_code: "INVALID_INPUT", reason: null, intent_id: null },
    { kind: "capability.denied", outcome: "denied", capability_identity: "e2e/identity.get", error_code: null, reason: "not granted", intent_id: null },
    { kind: "capability.completed", outcome: "failure", capability_identity: "toolbox/toolbox.execute", error_code: "NOT_FOUND", reason: null, intent_id: null },
  ])
  const named = spans().filter(span => span.attributes["answerable.organisation.id"] === beta.organizationId)
  expect(named.map(span => [span.name, span.attributes["answerable.capability.identity"], span.attributes["gen_ai.tool.name"], span.attributes["error.type"]])).toEqual([
    ["tools/call e2e/records.list", "e2e/records.list", "toolbox_execute", undefined],
    ["tools/call e2e/records.list", "e2e/records.list", "toolbox_execute", "INVALID_INPUT"],
    ["tools/call toolbox/toolbox.execute", "toolbox/toolbox.execute", "toolbox_execute", "INVALID_INPUT"],
    ["tools/call e2e/identity.get", "e2e/identity.get", "toolbox_execute", "NOT_FOUND"],
    ["tools/call toolbox/toolbox.execute", "toolbox/toolbox.execute", "toolbox_execute", "NOT_FOUND"],
  ])
})

test("toolbox_prepare prepares a mutation as its direct prepare tool would, and the commit tools commit its intents", async () => {
  const { member } = await hub()
  const clientId = await metaClient()
  const alpha = await member(["e2e"])
  const client = await alpha.connect(undefined, clientId)
  expect(await call(client, "toolbox_prepare", { identity: "e2e/records.create", arguments: { title: "Checked" }, validate_only: true })).toMatchObject({ intent_id: null, commit_token: null })
  const create = await call(client, "toolbox_prepare", { identity: "e2e/records.create", arguments: { title: "Through meta" } }) as { intent_id: string; commit_token: string }
  // Bun 1.3.1's toMatchObject writes asymmetric matchers into the object it checks, so the token is checked on its own.
  expect(create).toMatchObject({ capability: "e2e/records.create", policy_class: "agent", commit_tool: "toolbox_commit" })
  expect(create.commit_token).toStartWith("act_")
  const record = (await call(client, "toolbox_commit", { intent_id: create.intent_id, commit_token: create.commit_token })).results as { id: string; title: string }
  expect(record.title).toBe("Through meta")
  const remove = await call(client, "toolbox_prepare", { identity: "e2e/records.delete", arguments: { id: record.id } }) as { intent_id: string; commit_token: string; preview: { summary: string } }
  expect(remove).toMatchObject({ policy_class: "controlled", commit_tool: "toolbox_commit_confirmed", preview: { summary: "Delete record “Through meta”" } })
  expect(await call(client, "toolbox_commit_confirmed", { intent_id: remove.intent_id, commit_token: remove.commit_token, preview_summary: remove.preview.summary })).toMatchObject({ status: "committed", results: { deleted: true } })
  expect(await refusal(client, "toolbox_prepare", { identity: "e2e/records.list" })).toMatchObject({ code: "INVALID_INPUT", message: "e2e/records.list is a read; run it with toolbox_execute" })
  expect(await refusal(client, "toolbox_prepare", { identity: "e2e/records.create", arguments: {} })).toMatchObject({ code: "INVALID_INPUT", details: { field_violations: [{ field: "title" }] } })
  const kinds = (await events(alpha.organizationId)).map((row: { kind: string; capability_identity: string }) => `${row.kind} ${row.capability_identity}`)
  expect(kinds).toEqual([
    "capability.completed e2e/records.create", "intent.prepared e2e/records.create", "capability.completed e2e/records.create",
    "intent.committed e2e/records.create", "receipt.issued e2e/records.create", "capability.completed toolbox/commit",
    "intent.prepared e2e/records.delete", "capability.completed e2e/records.delete",
    "intent.committed e2e/records.delete", "receipt.issued e2e/records.delete", "capability.completed toolbox/commit_confirmed",
    "capability.completed toolbox/toolbox.prepare", "capability.completed e2e/records.create",
  ])
})
