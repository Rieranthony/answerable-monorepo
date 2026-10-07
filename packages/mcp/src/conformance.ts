import { afterAll, describe, expect, test } from "bun:test"
import type { z } from "zod"
import { errorOf } from "./call"
import { createKit, type Kit, type Subject, type ConformanceFixture } from "./kit"
import type { Mutation } from "./mutation"
import type { intentView } from "./prepare"
import type { Provider, Served } from "./provider"
import { lintOutput, type Schema } from "./schema-lint"
import { wireName, type Tool } from "./tool"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const reads = (provider: Provider) => provider.tools.filter((tool): tool is Served<Tool> => tool.kind === "read")
const wire = (tool: { name: string }) => wireName(tool.name)

async function example(kit: Kit, name: string) {
  const value = kit.fixture.examples[name]
  assert(value !== undefined, `fixture.examples has no entry for ${name}; add one valid input for it`)
  return typeof value === "function" ? await value(kit.principal) : value
}

async function ok(kit: Kit, name: string, args: Record<string, unknown>) {
  const result = await kit.call(name, args)
  if (result.isError) {
    const { code, message } = errorOf(result)
    throw new Error(`${name} answered ${code}: ${message}${code === "INTERNAL" ? "; the handler threw something unexpected, such as a custom code missing from errors: read the server log for the request_id" : ""}`)
  }
  return result.structuredContent as Record<string, unknown>
}

// The kit never validates only, so every intent it prepares has an id and a token.
type PreparedIntent = z.output<typeof intentView> & { intent_id: string; commit_token: string }
async function prepare(kit: Kit, mutation: Served<Mutation>, args?: Record<string, unknown>) {
  return await ok(kit, wire(mutation), args ?? await example(kit, mutation.name)) as PreparedIntent
}
const commitArgs = (intent: PreparedIntent) => ({
  intent_id: intent.intent_id, commit_token: intent.commit_token,
  ...(intent.commit_tool.endsWith("_confirmed") ? { preview_summary: intent.preview.summary } : {}),
})

// What a read returns for its example, for every read of the provider.
async function snapshot(kit: Kit, inputs: [Served<Tool>, Record<string, unknown>][]) {
  const seen: Record<string, unknown> = {}
  for (const [tool, args] of inputs) seen[tool.identity] = await ok(kit, wire(tool), args)
  return seen
}

/**
 * The checks of the standard's read checklist, in its order, by name. Each throws, naming the definition and what to change. The kit keeps only
 * checks a provider built with `defineTool`, `defineMutation` and `defineProvider` can fail; the SDK enforces the rest itself.
 */
export const readChecks = {
  output_schema_declared({ manifest }: Subject) {
    for (const tool of manifest.tools) {
      const problems = lintOutput(tool.output as Schema)
      assert(!problems.length, problems.map(problem => `${tool.identity}: ${problem}`).join("\n"))
    }
  },
  list_paginates({ manifest }: Subject) {
    for (const tool of manifest.tools.filter(entry => entry.kind === "read")) {
      const input = (tool.input as Schema).properties ?? {}
      const output = (tool.output as Schema).properties ?? {}
      if (output.items?.type !== "array") continue
      const missing = [
        ...["limit", "cursor"].filter(field => !(field in input)).map(field => `input ${field}`),
        ...["next_cursor", "has_more"].filter(field => !(field in output)).map(field => `output ${field}`),
      ]
      assert(!missing.length, `${tool.identity}: returns an items array but does not declare ${missing.join(", ")}; a list takes limit and cursor and returns items, next_cursor and has_more, so it never truncates silently`)
    }
  },
  async read_has_no_side_effect(kit: Kit) {
    for (const tool of reads(kit.provider)) {
      const args = await example(kit, tool.name)
      const before = kit.stored.length
      const first = await ok(kit, wire(tool), args)
      const second = await ok(kit, wire(tool), args)
      expect(second, `${tool.identity} returned different results for the same input twice; a read must not change anything, and must not return a counter or the time`).toEqual(first)
      assert(kit.stored.length === before, `${tool.identity} recorded an intent; only a mutation's prepare tool does that`)
    }
  },
  async manifest_matches_snapshot({ manifest, fixture }: Subject) {
    const file = Bun.file(fixture.manifest)
    const current = `${JSON.stringify(manifest, null, 2)}\n`
    if (process.env.UPDATE_MANIFEST === "1") await Bun.write(file, current)
    const committed = await file.exists() ? await file.json() : undefined
    const path = fixture.manifest instanceof URL ? fixture.manifest.pathname : fixture.manifest
    expect(committed, `${path} is out of date; regenerate it with UPDATE_MANIFEST=1 bun run test in the provider's workspace, then commit the file`).toEqual(JSON.parse(current))
  },
}

/** The checks of the mutate checklist, by name, each run for one mutation. `targets_have_versions` and `commit_rejects_stale` apply only to a mutation that prepares targets. */
export const mutateChecks = {
  async prepare_has_no_side_effect(kit: Kit, mutation: Served<Mutation>) {
    const args = await example(kit, mutation.name)
    const inputs: [Served<Tool>, Record<string, unknown>][] = []
    for (const tool of reads(kit.provider)) inputs.push([tool, await example(kit, tool.name)])
    const before = await snapshot(kit, inputs)
    await prepare(kit, mutation, args)
    await prepare(kit, mutation, args)
    expect(await snapshot(kit, inputs), `${mutation.identity}: preparing changed what the reads return; prepare must not change anything`).toEqual(before)
  },
  async preview_is_semantic(kit: Kit, mutation: Served<Mutation>) {
    const { preview } = await prepare(kit, mutation)
    assert(preview.summary.trim(), `${mutation.identity}: the preview summary is blank`)
    assert(preview.changes.length + preview.effects.length > 0, `${mutation.identity}: the preview names no change and no effect; say what will change, from what, to what`)
  },
  async targets_have_versions(kit: Kit, mutation: Served<Mutation>) {
    for (const target of (await prepare(kit, mutation)).targets) {
      assert(target.version.value, `${mutation.identity}: target ${target.resource_type} ${target.resource_id} has no version; every target needs a non-empty version.value`)
    }
  },
  async commit_rejects_stale(kit: Kit, mutation: Served<Mutation>) {
    const intent = await prepare(kit, mutation)
    const [target] = intent.targets
    assert(target, `${mutation.identity} prepared no targets this time, though it did when the kit registered its checks; make its example prepare the same targets every time`)
    assert(kit.fixture.moveTarget, `${mutation.identity} prepares targets, so the fixture needs moveTarget(target, principal) to change one outside the MCP`)
    await kit.fixture.moveTarget(target, kit.principal)
    const result = await kit.call(intent.commit_tool, commitArgs(intent))
    const advice = `make moveTarget change what ${mutation.identity} reads as the target's version`
    assert(result.isError, `${intent.commit_tool} succeeded where INTENT_STALE was expected; ${advice}`)
    const { code, message } = errorOf(result)
    assert(code === "INTENT_STALE", `${intent.commit_tool} answered ${code} where INTENT_STALE was expected: ${message}; ${advice}`)
  },
  async receipt_is_structured(kit: Kit, mutation: Served<Mutation>) {
    const intent = await prepare(kit, mutation)
    await ok(kit, intent.commit_tool, commitArgs(intent))
  },
}

/** The mutate checks that need a target, so do not apply to a mutation whose prepare returns none, such as a create. */
export const targetChecks: readonly (keyof typeof mutateChecks)[] = ["targets_have_versions", "commit_rejects_stale"]

/** The checks of the provider checklist, by name. */
export const providerChecks = {
  descriptions_operational({ provider }: Subject) {
    for (const tool of provider.tools) {
      assert(tool.kind === "read" || /prepare|intent/i.test(tool.description), `${tool.identity}: a mutation's description must say that it prepares an intent; use the word "prepare" or "intent"`)
    }
  },
}

function register<Args extends unknown[]>(checks: Record<string, (kit: Kit, ...args: Args) => unknown>, kit: Kit, args: Args, skipped: readonly string[] = [], reason = "") {
  for (const [name, check] of Object.entries(checks)) {
    const skip = skipped.includes(name)
    test.skipIf(skip)(skip ? `${name} (not applicable: ${reason})` : name, async () => { await check(kit, ...args) })
  }
}

/**
 * Register one test per conformance check for a provider: call it at the top level of a test file, with the provider built on
 * test dependencies such as in-memory stores. The provider is served in-process with its own intent store, so a failing test names the check
 * and the definition to change. Each mutation is prepared once while the checks are registered: the two checks that need a target are
 * registered as skipped, with the reason, for a mutation that prepares none.
 *
 * @param fixture What the kit cannot derive: the committed manifest, one valid input per tool and how to move a target.
 * @example
 * ```ts
 * import { assertProviderConformance } from "@answerable/mcp/testing"
 * import { createE2eProvider } from "./mcp"
 *
 * assertProviderConformance(createE2eProvider({ records, viewHtml: "<title>Records</title>" }), {
 *   manifest: new URL("../manifest.json", import.meta.url),
 *   examples: { "records.list": { limit: 5 }, "records.create": { title: "Example" } },
 *   moveTarget: (target, principal) => records.touch(principal, target.resource_id),
 * })
 * ```
 */
export function assertProviderConformance(provider: Provider, fixture: ConformanceFixture) {
  describe(`${provider.id} conformance`, async () => {
    const kit = await createKit(provider, fixture)
    afterAll(() => kit.close())
    describe("read", () => register(readChecks, kit, []))
    for (const mutation of provider.tools.filter((tool): tool is Served<Mutation> => tool.kind === "mutate")) {
      const untargeted = !(await prepare(kit, mutation)).targets.length
      describe(`mutate ${mutation.identity}`, () => register(mutateChecks, kit, [mutation], untargeted ? targetChecks : [], `${mutation.identity} prepares no targets`))
    }
    describe("provider", () => register(providerChecks, kit, []))
  })
}
