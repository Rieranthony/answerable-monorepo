import type { z } from "zod"
import { checkScopes, isDate, type ToolContext, type View } from "./definitions"
import { customCode, errorCodes } from "./errors"

type Deprecation = Readonly<{ since: string; sunset: string; replacement?: string }>

/** A read tool: frozen data made by `defineTool`. Only `name`, `description`, `input`, `output` and `execute` are required. */
export type Tool<Input extends z.ZodObject = z.ZodObject, Output extends z.ZodObject = z.ZodObject> = Readonly<{
  kind: "read"
  /** `<domain>.<operation>`, for example `records.list`; the wire name is `records_list`. */
  name: string
  /** What a host may show people in place of the name. */
  title?: string
  /** What it does, when to use it and its limits: 40 to 1,000 characters. */
  description: string
  /**
   * A Zod object, closed with `.strict()`: an unknown top-level field answers `INVALID_INPUT`.
   * @remarks `ZodObject`
   */
  input: Input
  /**
   * A Zod object; the result is checked against it and undeclared fields are dropped.
   * @remarks `ZodObject`
   */
  output: Output
  /** `YYYY-MM-DD`. Default: the provider's version. */
  version?: string
  /** Token scopes needed to see and call it. Default: `<provider>:read`. */
  scopes?: readonly string[]
  /** Marks the tool for removal: its wire description ends with the deprecation sentence, and `replacement`, when given, names a current tool of the provider. */
  deprecated?: Deprecation
  /** An MCP Apps view that hosts show with the result. */
  view?: View
  /** Default 25,000; at most 55,000. The call is aborted and answers `TIMEOUT` after it. */
  timeoutMs: number
  /** The custom `<PROVIDER>_<CODE>` codes the handler throws. Default: none; standard codes need no declaration, and an undeclared custom code answers `INTERNAL`. */
  errors: readonly string[]
  /** Do the work: receives the parsed input and the caller, returns an object that matches `output`, and throws `ToolError` for an expected failure. */
  execute(input: z.output<Input>, context: ToolContext): Promise<z.input<Output>>
}>

type Shared = { name: string; description: string; input: z.ZodObject; version?: string; scopes?: readonly string[]; deprecated?: Deprecation; timeoutMs?: number; errors?: readonly string[] }
const name = /^[a-z][a-z0-9]{0,15}\.[a-z][a-z0-9]{0,15}$/

/** The rules tools and mutations share: name, description, timeout, version, deprecation, scopes and declared errors. */
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
  const errors = definition.errors ?? []
  for (const code of errors) {
    if (Object.hasOwn(errorCodes, code) || !customCode.test(code)) {
      throw new Error(`${label}: errors entry "${code}" must be a custom code, <PROVIDER>_<CODE> in capitals, for example ACME_QUOTA_EXCEEDED; standard codes need no declaration`)
    }
  }
  return {
    ...definition,
    errors: Object.freeze([...errors]),
    input: definition.input.strict() as z.ZodObject as Definition["input"],
    scopes: checkScopes(label, definition.scopes, noun === "Tool" ? "read" : "write"),
    deprecated: definition.deprecated && Object.freeze({ ...definition.deprecated }),
    timeoutMs,
  }
}

/**
 * Define a read tool from five fields: `name`, `description`, `input`, `output` and `execute`; everything else has a default.
 * It refuses a bad name, a description outside 40 to 1,000 characters and a timeout above 55,000 ms, and returns frozen data.
 *
 * @example
 * ```ts
 * import { defineTool } from "@answerable/mcp"
 * import { z } from "zod"
 *
 * export const identityGet = defineTool({
 *   name: "identity.get",
 *   description: "Read your verified identity: your user id and the organisation you signed in to.",
 *   input: z.object({}),
 *   output: z.object({ userId: z.uuid(), organizationId: z.uuid() }),
 *   async execute(_input, { principal }) {
 *     return { userId: principal.userId, organizationId: principal.organizationId }
 *   },
 * })
 * ```
 */
export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(
  tool: Omit<Tool<Input, Output>, "kind" | "timeoutMs" | "errors"> & {
    /** Default 25,000; at most 55,000. The call is aborted and answers `TIMEOUT` after it. */
    timeoutMs?: number
    /** The custom `<PROVIDER>_<CODE>` codes the handler throws. Default: none; standard codes need no declaration. */
    errors?: readonly string[]
  },
): Tool<Input, Output> {
  return Object.freeze({ ...checkShared("Tool", tool), kind: "read" })
}

export const wireName = (name: string) => name.replace(".", "_")

export const deprecationSentence = ({ since, sunset, replacement }: Deprecation) => `Deprecated since ${since}; removed on ${sunset}${replacement ? `; use ${replacement} instead` : ""}.`

export const wireDescription = ({ description, deprecated }: Pick<Tool, "description" | "deprecated">) => deprecated ? `${description} ${deprecationSentence(deprecated)}` : description

export const readAnnotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
