import type { z } from "zod"
import { violationsOf } from "./call"
import { checkScopes, isDate, type ToolContext, type View } from "./definitions"
import { customCode, errorCodes } from "./errors"
import { checkDescription, checkToolName } from "./rules"

type Deprecation = Readonly<{ since: string; sunset: string; replacement?: string }>

/**
 * A read tool: frozen data made by `defineTool`. Only `name`, `description`, `input`, `output` and `execute` are required. `Context` is what
 * `execute` receives: `ToolContext`, with the MCP's `db` for a tool made with `withDatabase`.
 */
export type Tool<Input extends z.ZodObject = z.ZodObject, Output extends z.ZodObject = z.ZodObject, Context extends ToolContext = ToolContext> = Readonly<{
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
  /** One valid input, checked against `input` when the module loads. The conformance kit calls the tool with it, unless the fixture's `examples` give another. */
  example?: z.input<Input>
  /** Do the work: receives the parsed input and the caller, returns an object that matches `output`, and throws `ToolError` for an expected failure. */
  execute(input: z.output<Input>, context: Context): Promise<z.input<Output>>
}>

/** What `defineTool` takes: a tool's fields, with `timeoutMs` and `errors` optional. */
export type ToolDefinition<Input extends z.ZodObject, Output extends z.ZodObject, Context extends ToolContext> = Omit<Tool<Input, Output, Context>, "kind" | "timeoutMs" | "errors"> & {
  /** Default 25,000; at most 55,000. The call is aborted and answers `TIMEOUT` after it. */
  timeoutMs?: number
  /** The custom `<PROVIDER>_<CODE>` codes the handler throws. Default: none; standard codes need no declaration. */
  errors?: readonly string[]
}

type Shared = {
  name: string; description: string; input: z.ZodObject; example?: unknown; version?: string; scopes?: readonly string[]; deprecated?: Deprecation; timeoutMs?: number; errors?: readonly string[]
}

/** The rules tools and mutations share: name, description, example, timeout, version, deprecation, scopes and declared errors. */
export function checkShared<Definition extends Shared>(noun: "Tool" | "Mutation", definition: Definition) {
  const named = checkToolName(definition.name)
  if (named) throw new Error(`${noun} name ${named}`)
  const label = `${noun} ${definition.name}`
  const described = checkDescription(definition.description)
  if (described) throw new Error(`${label}: the description ${described}`)
  const input = definition.input.strict()
  if (definition.example !== undefined) {
    const checked = input.safeParse(definition.example)
    if (!checked.success) throw new Error(`${label}: the example is not a valid input: ${violationsOf(checked.error).message}`)
  }
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
    input: input as z.ZodObject as Definition["input"],
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
export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject, Context extends ToolContext = ToolContext>(
  tool: ToolDefinition<Input, Output, Context>,
): Tool<Input, Output, Context> {
  return Object.freeze({ ...checkShared("Tool", tool), kind: "read" })
}

export const wireName = (name: string) => name.replace(".", "_")

const deprecationSentence = ({ since, sunset, replacement }: Deprecation) => `Deprecated since ${since}; removed on ${sunset}${replacement ? `; use ${replacement} instead` : ""}.`

export const wireDescription = ({ description, deprecated }: Pick<Tool, "description" | "deprecated">) => deprecated ? `${description} ${deprecationSentence(deprecated)}` : description

export const readAnnotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
