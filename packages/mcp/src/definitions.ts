import type { UserPrincipal } from "@answerable/auth"
import type { GetPromptResult } from "@modelcontextprotocol/server"
import { z } from "zod"

/** What every handler receives: the verified caller, this call's id and a signal that aborts on cancel or timeout. */
export type ToolContext = Readonly<{ principal: UserPrincipal; executionId: string; signal: AbortSignal }>
/** An MCP Apps view: bundled HTML served as a `ui://` resource for one or more tools. */
export type View = Readonly<{ name: string; uri: string; html: string }>
/** A prompt: instructions a host can fetch by name. Retrieval must not change data. */
export type Prompt<Input extends z.ZodObject = z.ZodObject> = Readonly<{
  name: string
  description: string
  input: Input
  scopes?: readonly string[]
  execute(input: z.output<Input>, context: ToolContext): Promise<GetPromptResult>
}>
/** A fixed-URI text resource. Reading it must not change data. */
export type Resource = Readonly<{
  name: string
  uri: string
  description: string
  mimeType: string
  scopes?: readonly string[]
  read(context: ToolContext): Promise<string>
}>

const date = z.iso.date()
export const isDate = (value: string) => date.safeParse(value).success

export function checkScopes(label: string, scopes: readonly string[] | undefined) {
  if (scopes && (!scopes.length || scopes.some(scope => !scope || /\s/.test(scope)))) {
    throw new Error(`${label}: scopes must be non-empty and contain no spaces; omit them for the default <provider>:read`)
  }
  return scopes && Object.freeze([...scopes])
}

/** Define an MCP Apps view from HTML built with `buildView`. */
export function defineView(input: { name: string; html: string }): View {
  if (!/^[a-z][a-z0-9-]*$/.test(input.name)) throw new Error("Invalid view name")
  if (!input.html.trim()) throw new Error("View HTML is empty; build the view first")
  return Object.freeze({ ...input, uri: `ui://${input.name}/index.html` })
}

/** Define a prompt. Prompt retrieval returns instructions; it must not perform mutations. */
export function definePrompt<Input extends z.ZodObject>(prompt: Prompt<Input>): Prompt<Input> {
  if (!/^[a-z][a-z0-9_]*$/.test(prompt.name)) throw new Error(`Invalid prompt name: ${prompt.name}`)
  return Object.freeze({ ...prompt, scopes: checkScopes(`Prompt ${prompt.name}`, prompt.scopes) })
}

/** Define a fixed-URI text resource. Use `defineView` for interactive HTML. */
export function defineResource(resource: Resource): Resource {
  if (!/^[a-z][a-z0-9_]*$/.test(resource.name)) throw new Error(`Invalid resource name: ${resource.name}`)
  if (new URL(resource.uri).protocol === "ui:") throw new Error("Use defineView for ui:// resources")
  return Object.freeze({ ...resource, scopes: checkScopes(`Resource ${resource.name}`, resource.scopes) })
}
