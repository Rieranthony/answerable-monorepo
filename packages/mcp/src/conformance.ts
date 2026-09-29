import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"
import { receipt } from "./commit-tools"
import { errorCodes } from "./errors"
import { createKit, type Kit, type Subject, type ConformanceFixture } from "./kit"
import type { Mutation, Preview, Target } from "./mutation"
import type { Provider, Served } from "./provider"
import { lintOutput, type Schema } from "./schema-lint"
import { deprecationSentence, wireName, type Tool } from "./tool"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const reads = (provider: Provider) => provider.tools.filter((tool): tool is Served<Tool> => tool.kind === "read")
const wire = (tool: { name: string }) => wireName(tool.name)

const envelope = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    retry: z.strictObject({ policy: z.enum([...new Set(Object.values(errorCodes))]), after_ms: z.number().optional() }),
    details: z.record(z.string(), z.unknown()).optional(),
    request_id: z.string(),
  }),
})

/** The envelope of an error result, or a failure saying what is wrong with it. */
function readEnvelope(result: CallToolResult, provider: Provider, tool: string) {
  assert(result.structuredContent === undefined, `${tool}: an error result must not carry structuredContent; the envelope is one text block`)
  const [block, ...rest] = result.content
  assert(block?.type === "text" && !rest.length, `${tool}: an error result must be one text block holding the envelope as JSON`)
  let json: unknown
  try {
    json = JSON.parse(block.text)
  } catch {
    throw new Error(`${tool}: the error text is not JSON: ${block.text}`)
  }
  const parsed = envelope.safeParse(json)
  if (!parsed.success) {
    throw new Error(`${tool}: the error is not { error: { code, message, retry: { policy }, request_id } }: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
  }
  const { code } = parsed.data.error
  assert(Object.hasOwn(errorCodes, code) || provider.tools.some(definition => definition.errors.includes(code)), `${tool}: error code ${code} is neither a standard code nor declared in errors; add it to the definition's errors`)
  return parsed.data.error
}

async function example(kit: Kit, name: string) {
  const value = kit.fixture.examples[name]
  assert(value !== undefined, `fixture.examples has no entry for ${name}; add one valid input for it`)
  return typeof value === "function" ? await value(kit.principal) : value
}

async function ok(kit: Kit, name: string, args: Record<string, unknown>) {
  const result = await kit.call(name, args)
  if (result.isError) {
    const { code, message } = readEnvelope(result, kit.provider, name)
    throw new Error(`${name} answered ${code}: ${message}${code === "INTERNAL" ? "; the handler threw something unexpected, such as a custom code missing from errors: read the server log for the request_id" : ""}`)
  }
  return result.structuredContent as Record<string, unknown>
}

async function refused(kit: Kit, name: string, args: Record<string, unknown>, code: string, options: { as?: "other"; advice?: string } = {}) {
  const result = await kit.call(name, args, options.as)
  const advice = options.advice ? `; ${options.advice}` : ""
  assert(result.isError, `${name} succeeded where ${code} was expected${advice}`)
  const error = readEnvelope(result, kit.provider, name)
  assert(error.code === code, `${name} answered ${error.code} where ${code} was expected: ${error.message}${advice}`)
}

type PreparedIntent = { intent_id: string; commit_token: string; commit_tool: string; expires_at: string; targets: Target[]; preview: Preview }
async function prepare(kit: Kit, mutation: Served<Mutation>, args?: Record<string, unknown>) {
  return await ok(kit, wire(mutation), args ?? await example(kit, mutation.name)) as unknown as PreparedIntent
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

const identityForm = /^[a-z][a-z0-9]{0,11}\/[a-z][a-z0-9]{0,15}\.[a-z][a-z0-9]{0,15}$/

/** The checks of the standard's read checklist, in its order, by name. Each throws, naming the definition and what to change. */
export const readChecks = {
  identity_is_stable({ provider }: Subject) {
    for (const tool of provider.tools) {
      assert(tool.identity === `${provider.id}/${tool.name}`, `${tool.name}: the identity is "${tool.identity}"; it must be "${provider.id}/${tool.name}", and it never changes`)
      assert(identityForm.test(tool.identity), `${tool.identity}: an identity is <provider>/<domain>.<operation>, in lowercase letters and digits`)
    }
  },
  name_is_host_safe({ provider }: Subject) {
    for (const tool of provider.tools) {
      const hub = `${provider.id}_${wire(tool)}`
      assert(/^[a-z0-9_]{1,46}$/.test(hub), `${tool.identity}: the hub tool name "${hub}" must be 1 to 46 characters of a-z, 0-9 and _; shorten the tool name`)
    }
  },
  input_schema_is_closed({ manifest }: Subject) {
    for (const tool of manifest.tools) assert(tool.input.additionalProperties === false, `${tool.identity}: the input schema allows unknown fields; it must set additionalProperties to false`)
  },
  output_schema_declared({ manifest }: Subject) {
    for (const tool of manifest.tools) {
      const output = tool.output as Schema
      assert(output.type === "object" && typeof output.properties === "object", `${tool.identity}: the output schema must be an object with properties`)
      const problems = lintOutput(output)
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
  async errors_use_envelope(kit: Kit) {
    for (const tool of reads(kit.provider)) await refused(kit, wire(tool), { unexpected_field: true }, "INVALID_INPUT", { advice: "its input must be closed" })
  },
  timeout_bounded({ provider }: Subject) {
    for (const tool of provider.tools) assert(tool.timeoutMs <= 55_000, `${tool.identity}: timeoutMs ${tool.timeoutMs} is above 55000; a tool that needs longer must return an operation, which is not yet built`)
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

/** The checks of the mutate checklist, by name, each run for one mutation. A string marks a check that is Not yet built, with its reason. */
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
      assert(target.version?.kind && target.version.value, `${mutation.identity}: target ${target.resource_type} ${target.resource_id} has no version; every target needs version.kind and a non-empty version.value`)
    }
  },
  async commit_requires_token(kit: Kit, mutation: Served<Mutation>) {
    const intent = await prepare(kit, mutation)
    await refused(kit, intent.commit_tool, { ...commitArgs(intent), commit_token: "act_wrong" }, "COMMIT_TOKEN_INVALID")
  },
  async commit_rejects_stale(kit: Kit, mutation: Served<Mutation>) {
    const intent = await prepare(kit, mutation)
    if (!intent.targets.length) return console.log(`commit_rejects_stale skipped for ${mutation.identity}: it prepares no targets, so no version can move`)
    assert(kit.fixture.moveTarget, `${mutation.identity} prepares targets, so the fixture needs moveTarget(target, principal) to change one outside the MCP`)
    await kit.fixture.moveTarget(intent.targets[0]!, kit.principal)
    await refused(kit, intent.commit_tool, commitArgs(intent), "INTENT_STALE", { advice: `make moveTarget change what ${mutation.identity} reads as the target's version` })
  },
  async commit_rejects_expired(kit: Kit, mutation: Served<Mutation>) {
    const intent = await prepare(kit, mutation)
    kit.advanceTo(Date.parse(intent.expires_at) + 1)
    await refused(kit, intent.commit_tool, commitArgs(intent), "INTENT_EXPIRED")
  },
  async commit_is_idempotent(kit: Kit, mutation: Served<Mutation>) {
    const intent = await prepare(kit, mutation)
    const first = await ok(kit, intent.commit_tool, commitArgs(intent))
    const second = await ok(kit, intent.commit_tool, commitArgs(intent))
    expect(second, `${intent.commit_tool}: a second commit must return the same receipt with idempotent_replay true`).toEqual({ ...first, idempotent_replay: true })
  },
  async commit_rejects_other_principal(kit: Kit, mutation: Served<Mutation>) {
    const intent = await prepare(kit, mutation)
    await refused(kit, intent.commit_tool, commitArgs(intent), "PRINCIPAL_MISMATCH", { as: "other" })
  },
  approval_bound_to_digest: "Not yet: human approvals",
  async receipt_is_structured(kit: Kit, mutation: Served<Mutation>) {
    const intent = await prepare(kit, mutation)
    const tool = intent.commit_tool
    const result = await ok(kit, tool, commitArgs(intent))
    const parsed = receipt.safeParse(result)
    if (!parsed.success) throw new Error(`${tool}: the receipt is malformed: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
    const { intent_id, committed_by, idempotent_replay } = parsed.data
    assert(intent_id === intent.intent_id, `${tool}: the receipt names another intent than the one prepared`)
    assert(committed_by.user_id === kit.principal.userId && committed_by.membership_id === kit.principal.membershipId && committed_by.client_id === kit.principal.clientId, `${tool}: committed_by is not the caller`)
    assert(!idempotent_replay, `${tool}: the first commit must have idempotent_replay false`)
  },
  async errors_use_envelope(kit: Kit, mutation: Served<Mutation>) {
    await refused(kit, wire(mutation), { unexpected_field: true }, "INVALID_INPUT", { advice: "its input must be closed" })
    await refused(kit, `${kit.provider.id}_commit`, { intent_id: crypto.randomUUID(), commit_token: "act_unknown" }, "INTENT_NOT_FOUND")
  },
}

const noUpstream = "Not yet: providers declare no secrets and have no upstream client"
/** The checks of the provider checklist, by name. A string marks a check that is Not yet built, with its reason. */
export const providerChecks = {
  secrets_declared: noUpstream,
  egress_guarded: noUpstream,
  descriptions_operational({ provider }: Subject) {
    for (const tool of provider.tools) {
      const { length } = tool.description
      assert(length >= 40 && length <= 1000, `${tool.identity}: the description is ${length} characters; write 40 to 1,000 saying what it does, when to use it and its limits`)
      assert(tool.kind === "read" || /prepare|intent/i.test(tool.description), `${tool.identity}: a mutation's description must say that it prepares an intent; use the word "prepare" or "intent"`)
    }
  },
  deprecations_mirrored({ provider, manifest }: Subject) {
    for (const tool of provider.tools) {
      if (!tool.deprecated) continue
      const sentence = deprecationSentence(tool.deprecated)
      assert(manifest.tools.find(entry => entry.identity === tool.identity)?.description.endsWith(sentence), `${tool.identity} is deprecated, so its description must end with "${sentence}"`)
    }
  },
}

// A todo test that fails with its reason when bun runs todo tests (`bun test --todo`).
export const notYet = (reason: string) => () => { throw new Error(reason) }

function register<Args extends unknown[]>(checks: Record<string, string | ((kit: Kit, ...args: Args) => unknown)>, kit: () => Kit, ...args: Args) {
  for (const [name, check] of Object.entries(checks)) {
    if (typeof check === "string") test.todo(`${name} (${check})`, notYet(check))
    else test(name, async () => { await check(kit(), ...args) })
  }
}

/**
 * Register one test per conformance check for a provider: call it at the top level of a test file, with the provider built on
 * test dependencies such as in-memory stores. The provider is served in-process with its own intent store and clock,
 * so a failing test names the check and the definition to change.
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
  describe(`${provider.id} conformance`, () => {
    let kit: Kit
    beforeAll(async () => { kit = await createKit(provider, fixture) })
    afterAll(async () => { await kit?.close() })
    const current = () => kit
    describe("read", () => register(readChecks, current))
    for (const mutation of provider.tools.filter((tool): tool is Served<Mutation> => tool.kind === "mutate")) {
      describe(`mutate ${mutation.identity}`, () => register(mutateChecks, current, mutation))
    }
    describe("provider", () => register(providerChecks, current))
  })
}
