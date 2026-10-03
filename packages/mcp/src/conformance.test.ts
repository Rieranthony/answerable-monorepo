import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { defineMutation, defineProvider, defineTool, manifest, ToolError, type Intent, type Mutation, type Provider, type Served, type Tool, type ToolContext } from "./index"
import { mutateChecks, providerChecks, readChecks, targetChecks } from "./conformance"
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

type Original = { prepare(input: Record<string, unknown>, context: ToolContext): ReturnType<Served<Mutation>["prepare"]>; commit: Served<Mutation>["commit"]; execute: Served<Tool>["execute"] }
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
  const create = defineMutation({
    name: "notes.create", risk: "low", description: "Prepare adding a note. Changes nothing: returns a preview and a commit token; commit the intent with demo_commit.",
    input: z.object({ title: z.string().min(1).max(50) }), output: z.object({ id: z.string() }),
    async prepare({ title }) { return { targets: [], preview: { summary: `Add the note “${title}”`, changes: [{ path: "notes[]", to: { title } }] }, plan: { title } } },
    async commit({ plan, preview }) { return { results: { id: add(plan.title).id }, applied_changes: preview.changes, effects_performed: [] } },
  })
  const rename = defineMutation({
    name: "notes.rename", description: "Prepare renaming a note. Changes nothing: returns a preview; show its summary, then commit the intent with the tool its commit_tool names.",
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
  const tools = [whoami, list, count, create, rename, wipe].map(tool => ({ ...tool, ...faults[tool.name]?.(tool as unknown as Original) }))
  const provider = defineProvider({ id: "demo", version: "2026-09-29", tools: tools as never })
  const fixture: ConformanceFixture = {
    manifest: snapshot(manifest(provider)),
    examples: {
      "notes.whoami": {}, "notes.list": { limit: 5 }, "notes.count": {},
      "notes.create": { title: "Example" },
      "notes.rename": () => ({ id: add("Before").id, title: "After" }),
      "notes.wipe": {},
    },
    moveTarget: target => { notes.get(target.resource_id)!.version++ },
  }
  return { notes, provider, fixture }
}

// The kit's own registration, on a provider with one read and one mutation that prepares no targets, whose two target checks are skipped.
const tiny = demo()
const tinyProvider = defineProvider({ id: "tiny", version: "2026-09-29", tools: tiny.provider.tools.filter(tool => tool.name === "notes.list" || tool.name === "notes.create") as never })
assertProviderConformance(tinyProvider, { ...tiny.fixture, manifest: snapshot(manifest(tinyProvider)) })

const good = demo()
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
const refusing: Fault = () => ({ "notes.create": () => ({ async commit() { throw new ToolError("PRECONDITION_FAILED", "Notes are read-only today") } }) })

const kits: Kit[] = []
afterEach(async () => { await Promise.all(kits.splice(0).map(kit => kit.close())) })
async function kitFor({ provider, fixture }: ReturnType<typeof demo>) {
  const kit = await createKit(provider, fixture)
  kits.push(kit)
  return kit
}
const subject = (provider: Provider): Subject => ({ provider, manifest: manifest(provider), fixture: good.fixture })
const mutation = (provider: Provider, name: string) => provider.tools.find(tool => tool.name === name && tool.kind === "mutate") as Served<Mutation>

test("the checks are the ones the standard lists, in its order", () => {
  expect(Object.keys(readChecks)).toEqual(["output_schema_declared", "list_paginates", "read_has_no_side_effect", "manifest_matches_snapshot"])
  expect(Object.keys(mutateChecks)).toEqual(["prepare_has_no_side_effect", "preview_is_semantic", "targets_have_versions", "commit_rejects_stale", "receipt_is_structured"])
  expect(targetChecks).toEqual(["targets_have_versions", "commit_rejects_stale"])
  expect(Object.keys(providerChecks)).toEqual(["descriptions_operational"])
})

// Every check of the kit against a provider, by the names of the ones that failed; a mutation without targets skips the target checks, as the kit's registration does.
async function failing(built: ReturnType<typeof demo>) {
  const kit = await kitFor(built)
  const failed: string[] = []
  const run = async (name: string, check: () => unknown) => { try { await check() } catch { failed.push(name) } }
  for (const [name, check] of Object.entries(readChecks)) await run(name, () => check(kit))
  for (const definition of built.provider.tools.filter(tool => tool.kind === "mutate")) {
    const untargeted = definition.name !== "notes.rename"
    for (const [name, check] of Object.entries(mutateChecks)) {
      if (!(untargeted && targetChecks.includes(name as never))) await run(`${definition.name} ${name}`, () => check(kit, definition as Served<Mutation>))
    }
  }
  for (const [name, check] of Object.entries(providerChecks)) await run(name, () => check(kit))
  return failed
}

test("the good provider fails no check, and each wrong provider fails the check it was made to fail and what that implies", async () => {
  expect(await failing(good)).toEqual([])
  expect(await failing(demo(writer))).toEqual(["notes.create prepare_has_no_side_effect"])
  expect(await failing(demo(bare))).toEqual(["notes.create preview_is_semantic"])
  expect(await failing(demo(blank))).toEqual(["notes.create preview_is_semantic"])
  expect(await failing(demo(frozen))).toEqual(["notes.rename commit_rejects_stale"])
  expect(await failing(demo(refusing))).toEqual(["notes.create receipt_is_structured"])
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
  const received: unknown[] = []
  const recording = { ...good.fixture, examples: { ...good.fixture.examples, "notes.count": (principal: unknown) => { received.push(principal); return {} } } }
  await readChecks.read_has_no_side_effect({ ...kit, fixture: recording })
  expect(received[0]).toBe(kit.principal)
  expect({ userId, membershipId, clientId }).toEqual({ userId: expect.any(String), membershipId: expect.any(String), clientId: "conformance-kit" })
  expect(scopes).toEqual(["demo:read", "demo:write"])
})

test("output_schema_declared: timestamps as date-time strings, quantities as value and unit", () => {
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

test("read_has_no_side_effect: a read returns the same twice and records no intent; a failing example names the tool and its code", async () => {
  const counting = demo(counter)
  await expect(readChecks.read_has_no_side_effect(await kitFor(counting))).rejects.toThrow("demo/notes.count returned different results for the same input twice; a read must not change anything, and must not return a counter or the time")
  const kit = await kitFor(good)
  // A hub's read can record an intent through the server it runs in; this one pretends to.
  const recording: Kit = { ...kit, async call(name, args) { kit.stored.push({ intent_id: "i1" } as Intent); return kit.call(name, args) } }
  await expect(readChecks.read_has_no_side_effect(recording)).rejects.toThrow("demo/notes.whoami recorded an intent; only a mutation's prepare tool does that")
  kit.stored.length = 0
  await expect(readChecks.read_has_no_side_effect({ ...kit, fixture: { ...good.fixture, examples: {} } })).rejects.toThrow("fixture.examples has no entry for notes.whoami; add one valid input for it")
  await expect(readChecks.read_has_no_side_effect({ ...kit, fixture: { ...good.fixture, examples: { ...good.fixture.examples, "notes.list": { limit: 0 } } } })).rejects.toThrow(
    "notes_list answered INVALID_INPUT: limit: Too small: expected number to be >=1",
  )
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

test("commit_rejects_stale: a moved target answers INTENT_STALE; without moveTarget, or with one that moves nothing, the check says what to change", async () => {
  const kit = await kitFor(good)
  const rename = mutation(good.provider, "notes.rename")
  await mutateChecks.commit_rejects_stale(kit, rename)
  await expect(mutateChecks.commit_rejects_stale(kit, mutation(good.provider, "notes.create"))).rejects.toThrow(
    "demo/notes.create prepared no targets this time, though it did when the kit registered its checks; make its example prepare the same targets every time",
  )
  await expect(mutateChecks.commit_rejects_stale({ ...kit, fixture: { ...good.fixture, moveTarget: undefined } }, rename)).rejects.toThrow(
    "demo/notes.rename prepares targets, so the fixture needs moveTarget(target, principal) to change one outside the MCP",
  )
  await expect(mutateChecks.commit_rejects_stale({ ...kit, fixture: { ...good.fixture, moveTarget: target => good.notes.delete(target.resource_id) } }, rename)).rejects.toThrow(
    "demo_commit_confirmed answered NOT_FOUND where INTENT_STALE was expected: No such note; make moveTarget change what demo/notes.rename reads as the target's version",
  )
  const still = demo(frozen)
  await expect(mutateChecks.commit_rejects_stale(await kitFor(still), mutation(still.provider, "notes.rename"))).rejects.toThrow(
    "demo_commit_confirmed succeeded where INTENT_STALE was expected; make moveTarget change what demo/notes.rename reads as the target's version",
  )
})

test("descriptions_operational: a mutation's description says it prepares an intent", () => {
  const silent = defineMutation({ ...mutation(good.provider, "notes.create"), name: "notes.add", description: "Add a note to the list of notes, right now." })
  expect(() => providerChecks.descriptions_operational(subject(defineProvider({ id: "demo", version: "2026-09-29", tools: [silent] })))).toThrow(
    'demo/notes.add: a mutation\'s description must say that it prepares an intent; use the word "prepare" or "intent"',
  )
  providerChecks.descriptions_operational(subject(defineProvider({ id: "demo", version: "2026-09-29", tools: [defineMutation({ ...silent, description: "Change the notes in this list, with the INTENT it returns." })] })))
})
