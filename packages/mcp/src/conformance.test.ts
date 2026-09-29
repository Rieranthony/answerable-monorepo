import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { defineMutation, defineProvider, defineTool, manifest, ToolError, type Intent, type Mutation, type Provider, type Served, type Tool, type ToolContext } from "./index"
import { mutateChecks, notYet, providerChecks, readChecks } from "./conformance"
import { createKit, type ConformanceFixture, type Kit, type Subject } from "./kit"
import { assertProviderConformance } from "./testing"

const directory = mkdtempSync(join(tmpdir(), "answerable-conformance-"))
let snapshots = 0
function snapshot(contents: unknown) {
  const path = join(directory, `manifest-${snapshots++}.json`)
  writeFileSync(path, JSON.stringify(contents))
  return path
}

type Note = { id: string; title: string; version: number }
const note = z.object({ id: z.string(), title: z.string(), version: z.number().int() })

type Original = { prepare(input: Record<string, unknown>, context: ToolContext): ReturnType<Served<Mutation>["prepare"]>; execute: Served<Tool>["execute"] }
// A fault replaces fields of named tools, given the notes and the tool as it was.
type Fault = (notes: Map<string, Note>) => Record<string, (original: Original) => object>

/** A provider that passes every check, with its fixture. A fault makes one tool wrong in one way. */
function demo(fault: Fault = () => ({})) {
  const notes = new Map<string, Note>()
  const add = (title: string) => {
    const created = { id: crypto.randomUUID(), title, version: 1 }
    notes.set(created.id, created)
    return created
  }
  const target = (id: string) => {
    const found = notes.get(id)
    if (!found) throw new ToolError("NOT_FOUND", "No such note")
    return { resource_type: "note", resource_id: id, label: found.title, version: { kind: "serial" as const, value: String(found.version) } }
  }
  const whoami = defineTool({
    name: "notes.whoami", description: "Read the organisation you signed in to. A fixture for the conformance tests.",
    input: z.object({}), output: z.object({ organizationId: z.string() }),
    async execute(_input, { principal }) { return { organizationId: principal.organizationId } },
  })
  const list = defineTool({
    name: "notes.list", description: "List the notes, oldest first, 20 per page. When has_more is true, pass next_cursor as cursor.",
    input: z.object({ limit: z.number().int().min(1).max(50).default(20), cursor: z.string().optional() }),
    output: z.object({ items: z.array(note), next_cursor: z.string().nullable(), has_more: z.boolean() }),
    async execute({ limit }) { return { items: [...notes.values()].slice(0, limit), next_cursor: null, has_more: notes.size > limit } },
  })
  const count = defineTool({
    name: "notes.count", description: "Count the notes. Use notes.list to read them, 20 per page.",
    input: z.object({}), output: z.object({ count: z.number().int(), counted_at: z.iso.datetime().nullable(), amount: z.object({ value: z.number(), unit: z.string() }).optional() }),
    async execute() { return { count: notes.size, counted_at: null } },
  })
  const first = defineTool({
    name: "notes.first", description: "Read the oldest note. Use notes.list, which pages through every note.",
    deprecated: { since: "2026-09-29", sunset: "2027-09-29", replacement: "notes.list" },
    input: z.object({}), output: z.object({ title: z.string().nullable() }),
    async execute() { return { title: [...notes.values()][0]?.title ?? null } },
  })
  const create = defineMutation({
    name: "notes.create", risk: "low", description: "Prepare adding a note. Changes nothing: returns a preview and a commit token; commit the intent with demo_commit.",
    input: z.object({ title: z.string().min(1).max(50) }), output: z.object({ id: z.string() }),
    async prepare({ title }) { return { targets: [], preview: { summary: `Add the note “${title}”`, changes: [{ path: "notes[]", to: { title } }] }, plan: { title } } },
    async commit({ plan, preview }) { return { results: { id: add(plan.title).id }, applied_changes: preview.changes, effects_performed: [] } },
  })
  const rename = defineMutation({
    name: "notes.rename", description: "Prepare renaming a note. Changes nothing: returns a preview; show its summary, then commit the intent with demo_commit_confirmed.",
    input: z.object({ id: z.string(), title: z.string().min(1).max(50) }), output: z.object({ id: z.string() }),
    async prepare({ id, title }) {
      const at = target(id)
      return { targets: [at], preview: { summary: `Rename “${at.label}” to “${title}”`, changes: [{ path: `notes[${id}].title`, from: at.label, to: title }] }, plan: { id, title } }
    },
    async commit({ plan, preview }) {
      const found = notes.get(plan.id)!
      notes.set(plan.id, { ...found, title: plan.title, version: found.version + 1 })
      return { results: { id: plan.id }, applied_changes: preview.changes, effects_performed: [] }
    },
  })
  // High risk is human class, which cannot commit yet: the kit runs it as controlled.
  const wipe = defineMutation({
    name: "notes.wipe", risk: "high", effects: ["cascade_delete"], description: "Prepare deleting every note. Changes nothing: returns a preview; the intent needs a person's approval.",
    input: z.object({}), output: z.object({ deleted: z.number().int() }),
    async prepare() { return { targets: [], preview: { summary: "Delete every note", effects: ["cascade_delete"] } } },
    async commit() {
      const deleted = notes.size
      notes.clear()
      return { results: { deleted }, applied_changes: [], effects_performed: ["cascade_delete"] }
    },
  })
  const faults = fault(notes)
  const tools = [whoami, list, count, first, create, rename, wipe].map(tool => ({ ...tool, ...faults[tool.name]?.(tool as unknown as Original) }))
  const provider = defineProvider({ id: "demo", version: "2026-09-29", tools: tools as never })
  const fixture: ConformanceFixture = {
    manifest: snapshot(manifest(provider)),
    examples: {
      "notes.whoami": {}, "notes.list": { limit: 5 }, "notes.count": {}, "notes.first": {},
      "notes.create": { title: "Example" },
      "notes.rename": () => ({ id: add("Before").id, title: "After" }),
      "notes.wipe": {},
    },
    moveTarget: target => { notes.get(target.resource_id)!.version++ },
  }
  return { notes, provider, fixture }
}

const good = demo()
assertProviderConformance(good.provider, good.fixture)

// Wrong in one way each, and the checks that way must fail.
const counter: Fault = () => {
  let calls = 0
  return { "notes.count": () => ({ async execute() { return { count: ++calls, counted_at: null } } }) }
}
const writer: Fault = notes => ({
  "notes.create": original => ({ async prepare(input: Record<string, unknown>, context: ToolContext) { notes.set("stray", { id: "stray", title: "Stray", version: 1 }); return original.prepare(input, context) } }),
})
const previewed = (preview: object, effects: object = {}): Fault => () => ({
  "notes.create": original => ({ ...effects, async prepare(input: Record<string, unknown>, context: ToolContext) { return { ...await original.prepare(input, context), preview } } }),
})
const bare = previewed({ summary: "Add a note" })
const blank = previewed({ summary: "  ", effects: ["cascade_delete"] }, { effects: ["cascade_delete"] })
const versioned = (value: string): Fault => () => ({
  "notes.rename": original => ({
    async prepare(input: Record<string, unknown>, context: ToolContext) {
      const plan = await original.prepare(input, context)
      return { ...plan, targets: plan.targets.map(target => ({ ...target, version: { ...target.version, value } })) }
    },
  }),
})
const unversioned = versioned("")
const frozen = versioned("1")

const kits: Kit[] = []
afterEach(async () => { await Promise.all(kits.splice(0).map(kit => kit.close())) })
async function kitFor({ provider, fixture }: ReturnType<typeof demo>) {
  const kit = await createKit(provider, fixture)
  kits.push(kit)
  return kit
}
type Call = Kit["call"]
// The kit with its calls filtered through `filter`, which may answer for the server or pass the call on.
const intercept = (kit: Kit, filter: (name: string, args: Record<string, unknown>, as: "owner" | "other", next: Call) => ReturnType<Call>): Kit => ({
  ...kit, call: (name, args, as = "owner") => filter(name, args, as, kit.call),
})
const subject = (provider: Provider, fixture: ConformanceFixture = good.fixture): Subject => ({ provider, manifest: manifest(provider), fixture })
const withTools = (provider: Provider, change: (tool: Provider["tools"][number]) => object): Provider => ({ ...provider, tools: provider.tools.map(tool => ({ ...tool, ...change(tool) }) as never) })
const withManifest = (provider: Provider, change: (tool: ReturnType<typeof manifest>["tools"][number]) => object): Subject => {
  const document = manifest(provider)
  return { provider, manifest: { ...document, tools: document.tools.map(tool => ({ ...tool, ...change(tool) }) as never) }, fixture: good.fixture }
}
const mutation = (provider: Provider, name: string) => provider.tools.find(tool => tool.name === name && tool.kind === "mutate") as Extract<Provider["tools"][number], { kind: "mutate" }>
const notFound = { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "NOT_FOUND", message: "Gone", retry: { policy: "never" }, request_id: "r1" } }) }] }
const results = (content: unknown[], structuredContent?: object) => ({ isError: true as const, content, ...(structuredContent ? { structuredContent } : {}) }) as Awaited<ReturnType<Call>>

test("the checks are the ones the standard lists, in its order", () => {
  expect(Object.keys(readChecks)).toEqual([
    "identity_is_stable", "name_is_host_safe", "input_schema_is_closed", "output_schema_declared", "list_paginates",
    "read_has_no_side_effect", "errors_use_envelope", "timeout_bounded", "manifest_matches_snapshot",
  ])
  expect(Object.keys(mutateChecks)).toEqual([
    "prepare_has_no_side_effect", "preview_is_semantic", "targets_have_versions", "commit_requires_token", "commit_rejects_stale", "commit_rejects_expired",
    "commit_is_idempotent", "commit_rejects_other_principal", "approval_bound_to_digest", "receipt_is_structured", "errors_use_envelope",
  ])
  expect(Object.keys(providerChecks)).toEqual(["secrets_declared", "egress_guarded", "descriptions_operational", "deprecations_mirrored"])
  expect([mutateChecks.approval_bound_to_digest, providerChecks.secrets_declared, providerChecks.egress_guarded]).toEqual([
    "Not yet: human approvals", "Not yet: providers declare no secrets and have no upstream client", "Not yet: providers declare no secrets and have no upstream client",
  ])
  expect(notYet("Not yet: human approvals")).toThrow("Not yet: human approvals")
})

// Every check of the kit against a provider, by the names of the ones that failed.
async function failing(built: ReturnType<typeof demo>) {
  const kit = await kitFor(built)
  const failed: string[] = []
  const run = async (name: string, check: () => unknown) => { try { await check() } catch { failed.push(name) } }
  const log = spyOn(console, "log").mockImplementation(() => {})
  try {
    for (const [name, check] of Object.entries(readChecks)) await run(name, () => check(kit))
    for (const definition of built.provider.tools.filter(tool => tool.kind === "mutate")) {
      for (const [name, check] of Object.entries(mutateChecks)) if (typeof check !== "string") await run(`${definition.name} ${name}`, () => check(kit, definition as Served<Mutation>))
    }
    for (const [name, check] of Object.entries(providerChecks)) if (typeof check !== "string") await run(name, () => check(kit))
  } finally { log.mockRestore() }
  return failed
}

test("the good provider fails no check, and each wrong provider fails the check it was made to fail and what that implies", async () => {
  expect(await failing(good)).toEqual([])
  expect(await failing(demo(writer))).toEqual(["notes.create prepare_has_no_side_effect"])
  expect(await failing(demo(bare))).toEqual(["notes.create preview_is_semantic"])
  expect(await failing(demo(blank))).toEqual(["notes.create preview_is_semantic"])
  expect(await failing(demo(frozen))).toEqual(["notes.rename commit_rejects_stale"])
  // A target without a version cannot be seen to move.
  expect(await failing(demo(unversioned))).toEqual(["notes.rename targets_have_versions", "notes.rename commit_rejects_stale"])
  // A read that varies also makes every prepare look as if it changed what the reads return.
  expect(await failing(demo(counter))).toEqual([
    "read_has_no_side_effect", "notes.create prepare_has_no_side_effect", "notes.rename prepare_has_no_side_effect", "notes.wipe prepare_has_no_side_effect",
  ])
})

test("the kit signs in as one caller and hands fixture functions that principal", async () => {
  const kit = await kitFor(good)
  const { organizationId, userId, membershipId, clientId, scopes } = kit.principal
  expect((await kit.call("notes_whoami", {})).structuredContent).toEqual({ organizationId })
  expect((await kit.call("notes_whoami", {}, "other")).structuredContent).not.toEqual({ organizationId })
  const received: unknown[] = []
  const recording = { ...good.fixture, examples: { ...good.fixture.examples, "notes.count": (principal: unknown) => { received.push(principal); return {} } } }
  await readChecks.read_has_no_side_effect({ ...kit, fixture: recording })
  expect(received[0]).toBe(kit.principal)
  expect({ userId, membershipId, clientId }).toEqual({ userId: expect.any(String), membershipId: expect.any(String), clientId: "conformance-kit" })
  expect(scopes).toEqual(["demo:read", "demo:write"])
})

test("identity_is_stable: an identity is <provider>/<name>, in the identity form", () => {
  expect(() => readChecks.identity_is_stable(subject(withTools(good.provider, tool => tool.name === "notes.list" ? { identity: "demo/other.name" } : {})))).toThrow(
    'notes.list: the identity is "demo/other.name"; it must be "demo/notes.list", and it never changes',
  )
  expect(() => readChecks.identity_is_stable(subject(withTools(good.provider, () => ({ name: "Notes.list", identity: "demo/Notes.list" }))))).toThrow(
    "demo/Notes.list: an identity is <provider>/<domain>.<operation>, in lowercase letters and digits",
  )
})

test("name_is_host_safe: the hub name is at most 46 characters of a-z, 0-9 and _", () => {
  const name = "abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz"
  expect(() => readChecks.name_is_host_safe(subject(withTools(good.provider, tool => tool.name === "notes.list" ? { name } : {})))).toThrow(
    `demo/notes.list: the hub tool name "demo_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz" must be 1 to 46 characters of a-z, 0-9 and _; shorten the tool name`,
  )
})

test("input_schema_is_closed: every input schema says additionalProperties false", () => {
  expect(() => readChecks.input_schema_is_closed(withManifest(good.provider, entry => entry.identity === "demo/notes.list" ? { input: { ...entry.input, additionalProperties: true } } : {}))).toThrow(
    "demo/notes.list: the input schema allows unknown fields; it must set additionalProperties to false",
  )
  expect(() => readChecks.input_schema_is_closed(withManifest(good.provider, entry => entry.identity === "demo/commit" ? { input: { type: "object" } } : {}))).toThrow("demo/commit: the input schema allows unknown fields")
})

test("output_schema_declared: an object with properties, timestamps as date-time strings, quantities as value and unit", () => {
  expect(() => readChecks.output_schema_declared(withManifest(good.provider, entry => entry.identity === "demo/notes.count" ? { output: { type: "string" } } : {}))).toThrow(
    "demo/notes.count: the output schema must be an object with properties",
  )
  const output = (shape: z.ZodRawShape, kind: "read" | "mutate" = "read") => {
    const wrong = kind === "read"
      ? defineProvider({ id: "demo", version: "2026-09-29", tools: [defineTool({ name: "notes.get", description: "Read a note. A fixture for the schema lint.", input: z.object({}), output: z.object(shape), async execute() { return {} as never } })] })
      : defineProvider({ id: "demo", version: "2026-09-29", tools: [defineMutation({ name: "notes.set", description: "Prepare a note. A fixture for the schema lint; commit the intent.", input: z.object({}), output: z.object(shape), async prepare() { return { targets: [], preview: { summary: "x" } } }, async commit() { return { results: {} as never, applied_changes: [], effects_performed: [] } } })] })
    return () => readChecks.output_schema_declared(subject(wrong))
  }
  expect(output({ created_at: z.string() })).toThrow('demo/notes.get: output property "created_at" is named like a timestamp, so it must be a string with format date-time, for example z.iso.datetime()')
  expect(output({ items: z.array(z.object({ ended_at: z.number() })) })).toThrow('output property "items[].ended_at" is named like a timestamp')
  expect(output({ span: z.object({ started_at: z.string() }).nullable() })).toThrow('output property "span.started_at" is named like a timestamp')
  for (const name of ["amount", "area", "duration"]) {
    expect(output({ [name]: z.number() })).toThrow(`output property "${name}" is named like a quantity, so it must be an object with value and unit, for example { value: 12, unit: "m2" }`)
  }
  expect(output({ amount: z.object({ value: z.number() }) })).toThrow('output property "amount" is named like a quantity')
  expect(output({ amount: z.number() }, "mutate")).toThrow("demo/notes.set: output property \"amount\"")
  output({ created_at: z.iso.datetime(), ended_at: z.iso.datetime().nullable(), area: z.object({ value: z.number(), unit: z.string() }).nullable(), amount: z.union([z.object({ value: z.number(), unit: z.string() }), z.null()]) })()
  output({ expires: z.string(), items: z.array(z.string()), meta: z.record(z.string(), z.unknown()) })()
})

test("list_paginates: an items array comes with limit, cursor, next_cursor and has_more", () => {
  const items = defineTool({ name: "notes.all", description: "Read every note at once. A fixture for the pagination check.", input: z.object({}), output: z.object({ items: z.array(z.string()) }), async execute() { return { items: [] } } })
  expect(() => readChecks.list_paginates(subject(defineProvider({ id: "demo", version: "2026-09-29", tools: [items] })))).toThrow(
    "demo/notes.all: returns an items array but does not declare input limit, input cursor, output next_cursor, output has_more; a list takes limit and cursor and returns items, next_cursor and has_more, so it never truncates silently",
  )
  const paged = defineTool({
    name: "notes.some", description: "Read some notes at a time. A fixture for the pagination check.",
    input: z.object({ limit: z.number().default(20), cursor: z.string().optional() }), output: z.object({ items: z.array(z.string()), next_cursor: z.string().nullable() }),
    async execute() { return { items: [], next_cursor: null } },
  })
  expect(() => readChecks.list_paginates(subject(defineProvider({ id: "demo", version: "2026-09-29", tools: [paged] })))).toThrow("does not declare output has_more;")
})

test("read_has_no_side_effect: a read returns the same twice and records no intent", async () => {
  const counting = demo(counter)
  await expect(readChecks.read_has_no_side_effect(await kitFor(counting))).rejects.toThrow("demo/notes.count returned different results for the same input twice; a read must not change anything, and must not return a counter or the time")
  const kit = await kitFor(good)
  const stored = { intent_id: "i1" } as Intent
  await expect(readChecks.read_has_no_side_effect(intercept(kit, (name, args, as, next) => { kit.stored.push(stored); return next(name, args, as) }))).rejects.toThrow("demo/notes.whoami recorded an intent; only a mutation's prepare tool does that")
  kit.stored.length = 0
  await expect(readChecks.read_has_no_side_effect({ ...kit, fixture: { ...good.fixture, examples: {} } })).rejects.toThrow("fixture.examples has no entry for notes.whoami; add one valid input for it")
})

test("errors_use_envelope: an error is one text block holding the envelope, with a standard or declared code", async () => {
  const kit = await kitFor(good)
  await readChecks.errors_use_envelope(kit)
  await mutateChecks.errors_use_envelope(kit, mutation(good.provider, "notes.create"))
  const answering = (result: Awaited<ReturnType<Call>>) => intercept(kit, async () => result)
  const text = (value: unknown) => results([{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }])
  const envelope = (error: object) => text({ error: { code: "INVALID_INPUT", message: "m", retry: { policy: "after_fix_input" }, request_id: "r1", ...error } })
  const cases: [Awaited<ReturnType<Call>>, string][] = [
    [{ content: [{ type: "text", text: "{}" }] }, "notes_whoami succeeded where INVALID_INPUT was expected; its input must be closed"],
    [results([{ type: "text", text: "{}" }], { error: {} }), "notes_whoami: an error result must not carry structuredContent; the envelope is one text block"],
    [results([{ type: "text", text: "{}" }, { type: "text", text: "{}" }]), "notes_whoami: an error result must be one text block holding the envelope as JSON"],
    [results([{ type: "image", data: "", mimeType: "image/png" }]), "notes_whoami: an error result must be one text block holding the envelope as JSON"],
    [text("Tool failed"), "notes_whoami: the error text is not JSON"],
    [text({ error: { code: "INVALID_INPUT" } }), "notes_whoami: the error is not { error: { code, message, retry: { policy }, request_id } }"],
    [envelope({ retry: { policy: "sometimes" } }), "notes_whoami: the error is not { error"],
    [envelope({ code: "DEMO_UNDECLARED" }), "notes_whoami: error code DEMO_UNDECLARED is neither a standard code nor declared in errors; add it to the definition's errors"],
    [envelope({ code: "NOT_FOUND" }), "notes_whoami answered NOT_FOUND where INVALID_INPUT was expected"],
  ]
  for (const [result, message] of cases) await expect(readChecks.errors_use_envelope(answering(result))).rejects.toThrow(message)
  await expect(mutateChecks.errors_use_envelope(answering(text("boom")), mutation(good.provider, "notes.create"))).rejects.toThrow("notes_create: the error text is not JSON")
  const declared = demo(() => ({ "notes.whoami": () => ({ errors: ["DEMO_LOCKED"] }) }))
  await expect(readChecks.errors_use_envelope({ ...(await kitFor(declared)), call: async () => envelope({ code: "DEMO_LOCKED" }) })).rejects.toThrow("notes_whoami answered DEMO_LOCKED where INVALID_INPUT was expected")
})

test("timeout_bounded: at most 55 seconds", () => {
  expect(() => readChecks.timeout_bounded(subject(withTools(good.provider, tool => tool.name === "notes.list" ? { timeoutMs: 60_000 } : {})))).toThrow(
    "demo/notes.list: timeoutMs 60000 is above 55000; a tool that needs longer must return an operation, which is not yet built",
  )
  readChecks.timeout_bounded(subject(withTools(good.provider, () => ({ timeoutMs: 55_000 }))))
})

test("manifest_matches_snapshot: the committed file equals the manifest, or UPDATE_MANIFEST=1 rewrites it", async () => {
  const path = snapshot({ id: "demo" })
  const stale = { ...subject(good.provider), fixture: { ...good.fixture, manifest: path } }
  await expect(readChecks.manifest_matches_snapshot(stale)).rejects.toThrow(`${path} is out of date; regenerate it with UPDATE_MANIFEST=1 bun run test in the provider's workspace, then commit the file`)
  await expect(readChecks.manifest_matches_snapshot({ ...stale, fixture: { ...good.fixture, manifest: join(directory, "missing.json") } })).rejects.toThrow("missing.json is out of date")
  process.env.UPDATE_MANIFEST = "1"
  try {
    await readChecks.manifest_matches_snapshot(stale)
    await readChecks.manifest_matches_snapshot({ ...stale, fixture: { ...good.fixture, manifest: new URL(`file://${join(directory, "created.json")}`) } })
  } finally { delete process.env.UPDATE_MANIFEST }
  expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(manifest(good.provider), null, 2)}\n`)
  expect(readFileSync(join(directory, "created.json"), "utf8")).toBe(`${JSON.stringify(manifest(good.provider), null, 2)}\n`)
  await readChecks.manifest_matches_snapshot(stale)
})

test("prepare_has_no_side_effect: preparing leaves what the reads return unchanged", async () => {
  const writing = demo(writer)
  await expect(mutateChecks.prepare_has_no_side_effect(await kitFor(writing), mutation(writing.provider, "notes.create"))).rejects.toThrow("demo/notes.create: preparing changed what the reads return; prepare must not change anything")
})

test("preview_is_semantic: a summary and at least one change or effect", async () => {
  const bared = demo(bare)
  await expect(mutateChecks.preview_is_semantic(await kitFor(bared), mutation(bared.provider, "notes.create"))).rejects.toThrow("demo/notes.create: the preview names no change and no effect; say what will change, from what, to what")
  const blanked = demo(blank)
  await expect(mutateChecks.preview_is_semantic(await kitFor(blanked), mutation(blanked.provider, "notes.create"))).rejects.toThrow("demo/notes.create: the preview summary is blank")
})

test("targets_have_versions: every target carries a version kind and a value", async () => {
  const wrong = demo(unversioned)
  await expect(mutateChecks.targets_have_versions(await kitFor(wrong), mutation(wrong.provider, "notes.rename"))).rejects.toThrow(
    /demo\/notes.rename: target note [0-9a-f-]{36} has no version; every target needs version.kind and a non-empty version.value/,
  )
})

test("commit_requires_token: a wrong token answers COMMIT_TOKEN_INVALID", async () => {
  const kit = await kitFor(good)
  let token = ""
  const lax = intercept(kit, async (name, args, as, next) => {
    const result = await next(name, args, as)
    const { commit_token } = (result.structuredContent ?? {}) as { commit_token?: string }
    if (commit_token) token = commit_token
    return name.includes("_commit") ? next(name, { ...args, commit_token: token }, as) : result
  })
  await expect(mutateChecks.commit_requires_token(lax, mutation(good.provider, "notes.create"))).rejects.toThrow("demo_commit succeeded where COMMIT_TOKEN_INVALID was expected")
  await expect(mutateChecks.commit_requires_token({ ...kit, fixture: { ...good.fixture, examples: { "notes.create": { title: "" } } } }, mutation(good.provider, "notes.create"))).rejects.toThrow("notes_create answered INVALID_INPUT")
})

test("commit_rejects_stale: a moved target answers INTENT_STALE, and a mutation without targets is skipped with the reason", async () => {
  const kit = await kitFor(good)
  const log = spyOn(console, "log").mockImplementation(() => {})
  try {
    await mutateChecks.commit_rejects_stale(kit, mutation(good.provider, "notes.rename"))
    expect(log).not.toHaveBeenCalled()
    await mutateChecks.commit_rejects_stale(kit, mutation(good.provider, "notes.create"))
    expect(log).toHaveBeenCalledWith("commit_rejects_stale skipped for demo/notes.create: it prepares no targets, so no version can move")
  } finally { log.mockRestore() }
  await expect(mutateChecks.commit_rejects_stale({ ...kit, fixture: { ...good.fixture, moveTarget: undefined } }, mutation(good.provider, "notes.rename"))).rejects.toThrow(
    "demo/notes.rename prepares targets, so the fixture needs moveTarget(target, principal) to change one outside the MCP",
  )
  const still = demo(frozen)
  await expect(mutateChecks.commit_rejects_stale(await kitFor(still), mutation(still.provider, "notes.rename"))).rejects.toThrow(
    "demo_commit_confirmed succeeded where INTENT_STALE was expected; make moveTarget change what demo/notes.rename reads as the target's version",
  )
})

test("commit_rejects_expired: past expires_at the commit answers INTENT_EXPIRED", async () => {
  const kit = await kitFor(good)
  await expect(mutateChecks.commit_rejects_expired({ ...kit, advanceTo: () => {} }, mutation(good.provider, "notes.create"))).rejects.toThrow("demo_commit succeeded where INTENT_EXPIRED was expected")
})

test("commit_is_idempotent: a second commit returns the same receipt with idempotent_replay true", async () => {
  const kit = await kitFor(good)
  let commits = 0
  const forgetful = intercept(kit, async (name, args, as, next) => {
    const result = await next(name, args, as)
    if (!name.includes("_commit") || ++commits < 2) return result
    return { ...result, structuredContent: { ...result.structuredContent as object, idempotent_replay: false } }
  })
  await expect(mutateChecks.commit_is_idempotent(forgetful, mutation(good.provider, "notes.create"))).rejects.toThrow(
    "demo_commit: a second commit must return the same receipt with idempotent_replay true",
  )
})

test("commit_rejects_other_principal: another person's commit answers PRINCIPAL_MISMATCH", async () => {
  const kit = await kitFor(good)
  await expect(mutateChecks.commit_rejects_other_principal(intercept(kit, (name, args, _as, next) => next(name, args, "owner")), mutation(good.provider, "notes.create"))).rejects.toThrow(
    "demo_commit succeeded where PRINCIPAL_MISMATCH was expected",
  )
})

test("receipt_is_structured: the receipt has its fields, names the intent and the committer", async () => {
  const kit = await kitFor(good)
  const rewrite = (change: (receipt: Record<string, unknown>) => object) => intercept(kit, async (name, args, as, next) => {
    const result = await next(name, args, as)
    return name.includes("_commit") ? { ...result, structuredContent: change(result.structuredContent as Record<string, unknown>) } : result
  })
  const create = mutation(good.provider, "notes.create")
  await expect(mutateChecks.receipt_is_structured(rewrite(receipt => Object.fromEntries(Object.entries(receipt).filter(([field]) => field !== "receipt_id"))), create)).rejects.toThrow("demo_commit: the receipt is malformed: receipt_id")
  await expect(mutateChecks.receipt_is_structured(rewrite(receipt => ({ ...receipt, intent_id: crypto.randomUUID() })), create)).rejects.toThrow("demo_commit: the receipt names another intent than the one prepared")
  await expect(mutateChecks.receipt_is_structured(rewrite(receipt => ({ ...receipt, committed_by: { user_id: "u", membership_id: "m", client_id: "c" } })), create)).rejects.toThrow("demo_commit: committed_by is not the caller")
  await expect(mutateChecks.receipt_is_structured(rewrite(receipt => ({ ...receipt, idempotent_replay: true })), create)).rejects.toThrow("demo_commit: the first commit must have idempotent_replay false")
})

test("descriptions_operational: 40 to 1,000 characters, and a mutation says it prepares an intent", () => {
  expect(() => providerChecks.descriptions_operational(subject(withTools(good.provider, tool => tool.name === "notes.list" ? { description: "Too short" } : {})))).toThrow(
    "demo/notes.list: the description is 9 characters; write 40 to 1,000 saying what it does, when to use it and its limits",
  )
  expect(() => providerChecks.descriptions_operational(subject(withTools(good.provider, tool => tool.name === "notes.create" ? { description: "Add a note to the list of notes, right now." } : {})))).toThrow(
    'demo/notes.create: a mutation\'s description must say that it prepares an intent; use the word "prepare" or "intent"',
  )
  providerChecks.descriptions_operational(subject(withTools(good.provider, tool => tool.kind === "mutate" ? { description: "Change the notes in this list, with the INTENT it returns." } : {})))
})

test("deprecations_mirrored: a deprecated tool's wire description ends with the deprecation sentence", () => {
  expect(() => providerChecks.deprecations_mirrored(withManifest(good.provider, entry => entry.identity === "demo/notes.first" ? { description: "Read the oldest note." } : {}))).toThrow(
    'demo/notes.first is deprecated, so its description must end with "Deprecated since 2026-09-29; removed on 2027-09-29; use notes.list instead."',
  )
  providerChecks.deprecations_mirrored(subject(good.provider))
})

test("an error answered in place of a result names the tool and its code", async () => {
  const kit = await kitFor(good)
  await expect(readChecks.read_has_no_side_effect(intercept(kit, async () => notFound as never))).rejects.toThrow("notes_whoami answered NOT_FOUND: Gone")
  await expect(readChecks.read_has_no_side_effect(intercept(kit, async () => results([{ type: "text", text: "boom" }])))).rejects.toThrow("notes_whoami: the error text is not JSON: boom")
  const internal = { ...notFound, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "INTERNAL", message: "The tool could not complete", retry: { policy: "after_delay" }, request_id: "r1" } }) }] }
  await expect(readChecks.read_has_no_side_effect(intercept(kit, async () => internal as never))).rejects.toThrow("notes_whoami answered INTERNAL: The tool could not complete; the handler threw something unexpected, such as a custom code missing from errors: read the server log for the request_id")
})
