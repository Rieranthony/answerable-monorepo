import type { z } from "zod"
import { checkScopes, isDate, type ToolContext, type View } from "./definitions"

type Deprecation = Readonly<{ since: string; sunset: string; replacement?: string }>

/** A read tool: frozen data made by `defineTool`. Only `name`, `description`, `input`, `output` and `execute` are required. */
export type Tool<Input extends z.ZodObject = z.ZodObject, Output extends z.ZodObject = z.ZodObject> = Readonly<{
  kind: "read"
  /** `<domain>.<operation>`, for example `records.list`; the wire name is `records_list`. */
  name: string
  title?: string
  /** What it does, when to use it and its limits: 40 to 1,000 characters. */
  description: string
  /** Closed with `.strict()`: an unknown top-level field answers `INVALID_INPUT`. */
  input: Input
  /** The result is checked against it; undeclared fields are dropped. */
  output: Output
  /** `YYYY-MM-DD`. Default: the provider's version. */
  version?: string
  /** Token scopes needed to see and call it. Default: `<provider>:read`. */
  scopes?: readonly string[]
  deprecated?: Deprecation
  view?: View
  /** Default 25,000; at most 55,000. The call is aborted and answers `TIMEOUT` after it. */
  timeoutMs: number
  execute(input: z.output<Input>, context: ToolContext): Promise<z.input<Output>>
}>

type Shared = { name: string; description: string; input: z.ZodObject; version?: string; scopes?: readonly string[]; deprecated?: Deprecation; timeoutMs?: number }
const name = /^[a-z][a-z0-9]{0,15}\.[a-z][a-z0-9]{0,15}$/

/** The rules tools and mutations share: name, description, timeout, version, deprecation and scopes. */
export function checkShared<Definition extends Shared>(noun: "Tool" | "Mutation", definition: Definition) {
  if (!name.test(definition.name)) {
    throw new Error(`${noun} name "${definition.name}" must be <domain>.<operation>, each part a lowercase letter then up to 15 lowercase letters or digits, for example records.list`)
  }
  const label = `${noun} ${definition.name}`
  const { length } = definition.description
  if (length < 40 || length > 1000) throw new Error(`${label}: the description is ${length} characters; write 40 to 1,000 saying what it does, when to use it and its limits`)
  const timeoutMs = definition.timeoutMs ?? 25_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000) {
    throw new Error(`${label}: timeoutMs ${timeoutMs} must be a whole number of milliseconds from 1 to 55,000`)
  }
  if (definition.version !== undefined && !isDate(definition.version)) throw new Error(`${label}: version "${definition.version}" must be a date, YYYY-MM-DD`)
  if (definition.deprecated && !(isDate(definition.deprecated.since) && isDate(definition.deprecated.sunset))) {
    throw new Error(`${label}: deprecated.since and deprecated.sunset must be dates, YYYY-MM-DD`)
  }
  return {
    ...definition,
    input: definition.input.strict() as z.ZodObject as Definition["input"],
    scopes: checkScopes(label, definition.scopes, noun === "Tool" ? "read" : "write"),
    deprecated: definition.deprecated && Object.freeze({ ...definition.deprecated }),
    timeoutMs,
  }
}

/** Define a read tool: the five fields, and optionally `title`, `version`, `scopes`, `deprecated`, `view` and `timeoutMs`. */
export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(
  tool: Omit<Tool<Input, Output>, "kind" | "timeoutMs"> & { timeoutMs?: number },
): Tool<Input, Output> {
  return Object.freeze({ ...checkShared("Tool", tool), kind: "read" })
}

export const wireName = (name: string) => name.replace(".", "_")

export function wireDescription({ description, deprecated }: Pick<Tool, "description" | "deprecated">) {
  if (!deprecated) return description
  const replacement = deprecated.replacement ? `; use ${deprecated.replacement} instead` : ""
  return `${description} Deprecated since ${deprecated.since}; removed on ${deprecated.sunset}${replacement}.`
}

export const readAnnotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
