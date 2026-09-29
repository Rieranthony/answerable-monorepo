import type { CallToolResult, StandardSchemaWithJSON } from "@modelcontextprotocol/server"
import type { z } from "zod"
import type { ToolContext } from "./definitions"
import { ToolError, errorCodes } from "./errors"

// tools/list advertises the real schema, but the SDK's own validation would answer a plain-text error,
// so it accepts every argument and the handler validates, answering INVALID_INPUT.
export function advertised(input: z.ZodObject): StandardSchemaWithJSON<Record<string, unknown>> {
  return { "~standard": { version: 1, vendor: "zod", jsonSchema: input["~standard"].jsonSchema, validate: value => ({ value: value as Record<string, unknown> }) } }
}

/** Parse tool arguments, answering `INVALID_INPUT` with one field violation per issue. */
export async function parseArguments<Schema extends z.ZodObject>(schema: Schema, args: unknown): Promise<z.output<Schema>> {
  const result = await schema.safeParseAsync(args)
  if (result.success) return result.data
  const field = (path: readonly PropertyKey[]) => path.map(String).join(".")
  const violations = result.error.issues.flatMap(issue => issue.code === "unrecognized_keys"
    ? issue.keys.map(key => ({ field: field([...issue.path, key]), message: "Unknown field" }))
    : [{ field: field(issue.path), message: issue.message }])
  const message = violations.map(violation => violation.field ? `${violation.field}: ${violation.message}` : violation.message).join("; ")
  throw new ToolError("INVALID_INPUT", message, { details: { field_violations: violations } })
}

/**
 * Run a definition's handler `body` with a context whose signal also aborts after `timeoutMs`; past it, answer `TIMEOUT` without waiting for `body`.
 * A custom code the definition does not declare is the author's bug: it becomes a plain error, which answers `INTERNAL` and is logged.
 */
export async function bounded<T>({ name, timeoutMs, errors }: { name: string; timeoutMs: number; errors: readonly string[] }, context: ToolContext, body: (context: ToolContext) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const timedOut = new Promise<never>((_, reject) => deadline.addEventListener("abort", reject, { once: true }))
  try {
    return await Promise.race([body(Object.freeze({ ...context, signal: AbortSignal.any([context.signal, deadline]) })), timedOut])
  } catch (error) {
    if (deadline.aborted) throw new ToolError("TIMEOUT", `The tool did not finish within ${timeoutMs} ms`)
    if (error instanceof ToolError && !Object.hasOwn(errorCodes, error.code) && !errors.includes(error.code)) {
      throw new Error(`${name} threw ${error.code}, which its definition does not declare; add it to errors`, { cause: error })
    }
    throw error
  }
}

// The envelope travels as JSON text only: MCP SDK 1.x clients check any structuredContent
// against the tool's output schema even on an error result, and would reject the envelope.
function failure({ code, message, retry, details }: ToolError, requestId: string): CallToolResult {
  const envelope = { error: { code, message, retry, ...(details ? { details } : {}), request_id: requestId } }
  return { isError: true, content: [{ type: "text", text: JSON.stringify(envelope) }] }
}

/** Answer a tool call with its data as structured content and the same JSON as text, or with the error envelope. */
export async function answer(name: string, requestId: string, body: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const data = await body()
    return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] }
  } catch (error) {
    if (error instanceof ToolError) return failure(error, requestId)
    console.error(`[mcp] tool ${name} failed`, requestId, error)
    return failure(new ToolError("INTERNAL", "The tool could not complete"), requestId)
  }
}
