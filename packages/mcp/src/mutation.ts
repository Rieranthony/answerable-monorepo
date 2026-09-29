import { z } from "zod"
import type { ToolContext } from "./definitions"
import { checkShared, type Tool } from "./tool"

/** How much harm a mutation can do. It sets the default policy class: `low` gives `agent`, `normal` `controlled`, `high` `human`. */
export type Risk = "low" | "normal" | "high"
/** Who may commit an intent: the agent alone (`agent`), the agent once the host has shown the person the summary (`controlled`), or a person's approval (`human`). */
export type PolicyClass = "agent" | "controlled" | "human"
const vocabulary = ["notification", "external_call", "money_movement", "cascade_delete", "permission_change", "publication"] as const
/** A side effect beyond the change itself, named in a preview and in a receipt: `notification`, `external_call`, `money_movement`, `cascade_delete`, `permission_change` or `publication`. */
export type Effect = (typeof vocabulary)[number]
/** One change: where (`path`), what it was (`from`) and what it becomes (`to`); each of the last two defaults to `null`. */
export type Change = { path: string; from?: unknown; to?: unknown }
/** A resource the commit reads or writes, with the version `prepare` saw: `kind` names how the source versions it, and `label` names the resource for people. */
export type Target = {
  resource_type: string
  resource_id: string
  label: string
  version: { kind: "etag" | "version" | "timestamp" | "serial"; value: string }
}
/** What would change, in the words the person confirms: a `summary` of 1 to 500 characters, then `changes`, `effects`, `warnings` and `quantities`, each defaulting to empty. */
export type Preview = {
  summary: string
  changes: Change[]
  effects: Effect[]
  /** Consequences that are possible, not certain. */
  warnings: string[]
  quantities: { name: string; value: number; unit: string }[]
}

/** The policy class each risk gives a mutation unless `createMcpServer`'s `policyClass` decides otherwise: `low` agent, `normal` controlled, `high` human. */
export const riskClass: Readonly<Record<Risk, PolicyClass>> = Object.freeze({ low: "agent", normal: "controlled", high: "human" })
/** How long an intent of each class can be committed, in milliseconds from prepare. */
export const classExpiry: Readonly<Record<PolicyClass, number>> = Object.freeze({ agent: 600_000, controlled: 1_800_000, human: 86_400_000 })

export const target = z.object({
  resource_type: z.string().min(1),
  resource_id: z.string().min(1),
  label: z.string(),
  version: z.object({ kind: z.enum(["etag", "version", "timestamp", "serial"]), value: z.string() }),
}) satisfies z.ZodType<Target>
export const change = z.object({ path: z.string(), from: z.unknown().default(null), to: z.unknown().default(null) }) satisfies z.ZodType<Change>
export const preview = z.object({
  summary: z.string().min(1).max(500),
  changes: z.array(change).default([]),
  effects: z.array(z.enum(vocabulary)).default([]),
  warnings: z.array(z.string()).default([]),
  quantities: z.array(z.object({ name: z.string(), value: z.number(), unit: z.string() })).default([]),
}) satisfies z.ZodType<Preview>
const plan = z.object({ targets: z.array(target), preview, plan: z.unknown().optional() })
/** What `commit` reports besides its results. */
export const outcome = z.object({ applied_changes: z.array(change), effects_performed: z.array(z.string()) })

/** What `commit` receives: the targets and preview `prepare` returned, and the author's own `plan` data, stored as JSON. */
export type Plan<Data = unknown> = { targets: Target[]; preview: Preview; plan: Data }

/** A mutation: frozen data made by `defineMutation`. A read tool's fields with `prepare` and `commit` in place of `execute`. */
export type Mutation<Input extends z.ZodObject = z.ZodObject, Output extends z.ZodObject = z.ZodObject, Data = unknown> = Readonly<
  Omit<Tool<Input, Output>, "kind" | "output" | "scopes" | "view" | "execute"> & {
    kind: "mutate"
    /** The schema of the receipt's `results`; undeclared fields are dropped. */
    output: Output
    /** Token scopes needed to see and call it. Default: `<provider>:write`. */
    scopes?: readonly string[]
    /** Sets the default policy class. Default: `normal`. */
    risk: Risk
    /** The effects a preview may name. Default: none. */
    effects: readonly Effect[]
    /** Shortens the expiry of the mutation's intents; at most the expiry its risk gives. */
    expiresInMs?: number
    /** Resolve the targets and describe the change. It must not change anything. */
    prepare(input: z.output<Input>, context: ToolContext): Promise<{ targets: Target[]; preview: Pick<Preview, "summary"> & Partial<Preview>; plan?: Data }>
    /** Apply exactly the prepared plan; `results` is checked against `output`. */
    commit(plan: Plan<Data>, context: ToolContext): Promise<{ results: z.input<Output>; applied_changes: Change[]; effects_performed: Effect[] }>
  }
>

/**
 * Define a mutation from a read tool's fields with `prepare` and `commit` in place of `execute`; `risk`, `effects` and `expiresInMs` are optional.
 * `prepare` resolves targets and describes the change without making it; `commit` applies exactly that plan, once the server has checked
 * the commit token, the principal, the expiry, the policy class and every target's version.
 *
 * @example
 * ```ts
 * import { defineMutation, ToolError } from "@answerable/mcp"
 * import { z } from "zod"
 *
 * export const recordsDelete = defineMutation({
 *   name: "records.delete",
 *   description: "Prepare deleting one of your organisation's records. Changes nothing: returns a preview; show the person its summary, then commit it with example_commit_confirmed.",
 *   input: z.object({ id: z.uuid() }),
 *   output: z.object({ deleted: z.literal(true) }),
 *   async prepare({ id }, { principal }) {
 *     const record = await records.get(principal.organizationId, id)
 *     if (!record) throw new ToolError("NOT_FOUND", "No accessible record exists")
 *     return {
 *       targets: [{ resource_type: "record", resource_id: id, label: record.title, version: { kind: "serial", value: String(record.version) } }],
 *       preview: { summary: `Delete record “${record.title}”`, changes: [{ path: `records[${id}]`, from: record, to: null }] },
 *       plan: { id },
 *     }
 *   },
 *   async commit({ plan, preview }, { principal }) {
 *     await records.remove(principal.organizationId, plan.id)
 *     return { results: { deleted: true }, applied_changes: preview.changes, effects_performed: [] }
 *   },
 * })
 * ```
 */
export function defineMutation<Input extends z.ZodObject, Output extends z.ZodObject, Data = unknown>(
  mutation: Omit<Mutation<Input, Output, Data>, "kind" | "timeoutMs" | "errors" | "risk" | "effects"> & { timeoutMs?: number; errors?: readonly string[]; risk?: Risk; effects?: readonly Effect[] },
): Mutation<Input, Output, Data> {
  const checked = checkShared("Mutation", mutation)
  const label = `Mutation ${mutation.name}`
  const risk = mutation.risk ?? "normal"
  if (!Object.hasOwn(riskClass, risk)) throw new Error(`${label}: risk "${risk}" must be low, normal or high`)
  const effects = mutation.effects ?? []
  const unknown = effects.find(effect => !vocabulary.includes(effect))
  if (unknown !== undefined) throw new Error(`${label}: effect "${unknown}" is not in the vocabulary: ${vocabulary.join(", ")}`)
  const limit = classExpiry[riskClass[risk]]
  const { expiresInMs } = mutation
  if (expiresInMs !== undefined && !(Number.isInteger(expiresInMs) && expiresInMs >= 1 && expiresInMs <= limit)) {
    throw new Error(`${label}: expiresInMs ${expiresInMs} must be a whole number of milliseconds from 1 to ${limit.toLocaleString("en-GB")}, the expiry of ${risk} risk; a mutation may shorten its expiry, not lengthen it`)
  }
  return Object.freeze({ ...checked, kind: "mutate", risk, effects: Object.freeze([...effects]) })
}

/** Run `prepare` and hold its plan to the contract; a plan that breaks it is the author's bug and answers `INTERNAL`. */
export async function preparePlan(mutation: Mutation, input: z.output<z.ZodObject>, context: ToolContext): Promise<Plan> {
  const result = plan.parse(await mutation.prepare(input, context))
  const undeclared = result.preview.effects.filter(effect => !mutation.effects.includes(effect))
  if (undeclared.length) {
    throw new Error(`Mutation ${mutation.name}: the preview names effects it does not declare (${undeclared.join(", ")}); add them to effects or leave them out of the preview`)
  }
  return result as Plan
}
