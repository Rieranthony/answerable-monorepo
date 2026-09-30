import type { UserPrincipal } from "@answerable/auth"
import type { GetPromptResult } from "@modelcontextprotocol/server"
import { z } from "zod"

/** What every handler receives: the verified caller, this call's id (a UUIDv7, also the error envelope's `request_id`) and a signal that aborts on cancel or timeout. */
export type ToolContext = Readonly<{
  /** The verified caller: person, organisation, membership, client and scopes, from the access token. */
  principal: UserPrincipal
  /** A UUIDv7 minted for this call: the error envelope's `request_id`, and the id the server log names. */
  executionId: string
  /** Aborts when the host cancels or disconnects, or the tool's timeout passes. */
  signal: AbortSignal
}>
/** An MCP Apps view: bundled HTML served as a `ui://` resource for one or more tools. */
export type View = Readonly<{ name: string; uri: string; html: string }>
/** A prompt: instructions a host can fetch by name. Retrieval must not change data. */
export type Prompt<Input extends z.ZodObject = z.ZodObject> = Readonly<{
  name: string
  description: string
  input: Input
  /** Token scopes needed to see and get it. Default: `<provider>:read`. */
  scopes?: readonly string[]
  execute(input: z.output<Input>, context: ToolContext): Promise<GetPromptResult>
}>
/** A fixed-URI text resource. Reading it must not change data. */
export type Resource = Readonly<{
  name: string
  uri: string
  description: string
  mimeType: string
  /** Token scopes needed to see and read it. Default: `<provider>:read`. */
  scopes?: readonly string[]
  read(context: ToolContext): Promise<string>
}>

const date = z.iso.date()
export const isDate = (value: string) => date.safeParse(value).success

export function checkScopes(label: string, scopes: readonly string[] | undefined, access: "read" | "write" = "read") {
  if (scopes && (!scopes.length || scopes.some(scope => !scope || /\s/.test(scope)))) {
    throw new Error(`${label}: scopes must be non-empty and contain no spaces; omit them for the default <provider>:${access}`)
  }
  return scopes && Object.freeze([...scopes])
}

/** Whether the caller's token carries every scope a definition needs. */
export const permits = (principal: UserPrincipal, { scopes }: Readonly<{ scopes: readonly string[] }>) => scopes.every(scope => principal.scopes.includes(scope))

const snake = "a lowercase letter then lowercase letters, digits or underscores"

/** Define an MCP Apps view from HTML that `buildView` built; its URI is `ui://<name>/index.html`. */
export function defineView(input: { name: string; html: string }): View {
  if (!/^[a-z][a-z0-9-]*$/.test(input.name)) throw new Error(`View name "${input.name}" must be a lowercase letter then lowercase letters, digits or hyphens, for example records`)
  if (!input.html.trim()) throw new Error(`View ${input.name}: the HTML is empty; build it with buildView first`)
  return Object.freeze({ ...input, uri: `ui://${input.name}/index.html` })
}

/** Define a prompt. Prompt retrieval returns instructions; it must not perform mutations. */
export function definePrompt<Input extends z.ZodObject>(prompt: Prompt<Input>): Prompt<Input> {
  if (!/^[a-z][a-z0-9_]*$/.test(prompt.name)) throw new Error(`Prompt name "${prompt.name}" must be ${snake}, for example walkthrough`)
  return Object.freeze({ ...prompt, scopes: checkScopes(`Prompt ${prompt.name}`, prompt.scopes) })
}

/** Define a fixed-URI text resource. Use `defineView` for interactive HTML. */
export function defineResource(resource: Resource): Resource {
  const { name, uri } = resource
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Resource name "${name}" must be ${snake}, for example guide`)
  if (!URL.canParse(uri)) throw new Error(`Resource ${name}: uri "${uri}" must be an absolute URI, for example fixture://guide`)
  if (new URL(uri).protocol === "ui:") throw new Error(`Resource ${name}: ${uri} is a ui:// view; define it with defineView and set it on a tool`)
  return Object.freeze({ ...resource, scopes: checkScopes(`Resource ${name}`, resource.scopes) })
}
