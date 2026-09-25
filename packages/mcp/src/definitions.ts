import type { UserPrincipal } from "@answerable/auth"
import type { GetPromptResult } from "@modelcontextprotocol/server"
import type { z } from "zod"

export type ToolContext = Readonly<{ principal: UserPrincipal; signal: AbortSignal }>
export type ToolAnnotations = Readonly<{ readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }>
export type View = Readonly<{ name: string; uri: string; html: string }>
export type Tool<Input extends z.ZodObject = z.ZodObject, Output extends z.ZodObject = z.ZodObject> = Readonly<{
  name: string
  title?: string
  description: string
  input: Input
  output: Output
  scopes: readonly string[]
  annotations?: ToolAnnotations
  view?: View
  execute(input: z.output<Input>, context: ToolContext): Promise<z.input<Output>>
}>
export type Prompt<Input extends z.ZodObject = z.ZodObject> = Readonly<{
  name: string
  description: string
  input: Input
  scopes: readonly string[]
  execute(input: z.output<Input>, context: ToolContext): Promise<GetPromptResult>
}>
export type Resource = Readonly<{
  name: string
  uri: string
  description: string
  mimeType: string
  scopes: readonly string[]
  read(context: ToolContext): Promise<string>
}>

export function defineView(input: { name: string; html: string }): View {
  if (!/^[a-z][a-z0-9-]*$/.test(input.name)) throw new Error("Invalid view name")
  if (!input.html.trim()) throw new Error("View HTML is empty; build the view first")
  return Object.freeze({ ...input, uri: `ui://${input.name}/index.html` })
}

export class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "ToolError"
  }
}

function validate(kind: "Tool" | "Prompt" | "Resource", name: string, scopes: readonly string[]) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid ${kind.toLowerCase()} name: ${name}`)
  if (!scopes.length || scopes.some(scope => !scope || /\s/.test(scope))) throw new Error(`${kind} ${name} must declare scopes`)
}

export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(tool: Tool<Input, Output>): Tool<Input, Output> {
  validate("Tool", tool.name, tool.scopes)
  return Object.freeze({ ...tool, scopes: Object.freeze([...tool.scopes]) })
}

/** Prompt retrieval returns instructions; authors must not perform mutations here. */
export function definePrompt<Input extends z.ZodObject>(prompt: Prompt<Input>): Prompt<Input> {
  validate("Prompt", prompt.name, prompt.scopes)
  return Object.freeze({ ...prompt, scopes: Object.freeze([...prompt.scopes]) })
}

/** A fixed-URI text resource. Use Apps views for interactive HTML. */
export function defineResource(resource: Resource): Resource {
  validate("Resource", resource.name, resource.scopes)
  const uri = new URL(resource.uri)
  if (uri.protocol === "ui:") throw new Error("Use defineView for ui:// resources")
  return Object.freeze({ ...resource, scopes: Object.freeze([...resource.scopes]) })
}
