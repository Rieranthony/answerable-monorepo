import type { UserPrincipal } from "@answerable/auth"
import { INTERNAL_ERROR, ProtocolError, type GetPromptResult, type McpServer } from "@modelcontextprotocol/server"
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server"
import { z } from "zod"

type RegistrationContext<Services> = Omit<ToolContext<Services>, "signal"> & { signal?: AbortSignal }

/** Combine the request's abort signal with the SDK's own for one call. */
function callContext<Services>(context: RegistrationContext<Services>, sdkSignal: AbortSignal): ToolContext<Services> {
  return Object.freeze({ ...context, signal: context.signal ? AbortSignal.any([sdkSignal, context.signal]) : sdkSignal })
}

/** Unexpected failures stay on the server; callers only see a generic code. */
function logFailure(kind: string, name: string, error: unknown) {
  console.error(`[mcp] ${kind} ${name} failed`, error)
}
export type Resource<Services> = Prompt<Services> & { readonly uri: string }

export type ToolContext<Services = unknown> = Readonly<{
  principal: UserPrincipal
  services: Services
  signal: AbortSignal
}>

export type View = Readonly<{ name: string; uri: string; html: string }>

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

export type Tool<Services> = {
  name: string
  scopes: readonly string[]
  view?: View
  register(server: McpServer, context: RegistrationContext<Services>): void
}

export function defineTool<
  Input extends z.ZodObject,
  Output extends z.ZodObject,
  Services = unknown,
>(definition: {
  name: string
  title?: string
  description: string
  input: Input
  output: Output
  scopes: readonly string[]
  view?: View
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
  execute(input: z.output<Input>, context: ToolContext<Services>): Promise<{ data: z.input<Output>; text: string }>
}): Tool<Services> {
  if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) throw new Error("Invalid tool name")
  if (!definition.scopes.length || definition.scopes.some(scope => !scope || /\s/.test(scope))) {
    throw new Error(`Tool ${definition.name} must declare scopes`)
  }
  return {
    name: definition.name,
    scopes: Object.freeze([...definition.scopes]),
    view: definition.view,
    register(server, context) {
      // The SDK needs an object schema; the closure preserves the author's exact types.
      const inputSchema: z.ZodObject = definition.input
      const outputSchema: z.ZodObject = definition.output
      registerAppTool(server, definition.name, {
        title: definition.title,
        description: definition.description,
        inputSchema,
        outputSchema,
        annotations: definition.annotations,
        _meta: definition.view ? { ui: { resourceUri: definition.view.uri } } : {},
      }, async (raw, sdkContext) => {
        const call = callContext(context, sdkContext.mcpReq.signal)
        try {
          call.signal.throwIfAborted()
          const input = definition.input.parse(raw)
          const result = await definition.execute(input, call)
          const data = definition.output.parse(result.data)
          return { structuredContent: data, content: [{ type: "text", text: result.text }] }
        } catch (error) {
          if (!(error instanceof ToolError)) logFailure("tool", definition.name, error)
          const code = error instanceof ToolError ? error.code : "tool_failed"
          const message = error instanceof ToolError ? error.message : "The tool could not complete"
          return {
            isError: true,
            content: [{ type: "text", text: `${code}: ${message}` }],
            _meta: { code },
          }
        }
      })
    },
  }
}

export type Prompt<Services> = Readonly<{
  name: string
  scopes: readonly string[]
  register(server: McpServer, context: RegistrationContext<Services>): void
}>

function validate(name: string, scopes: readonly string[]) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Invalid definition name")
  if (!scopes.length || scopes.some(scope => !scope || /\s/.test(scope))) throw new Error(`${name} must declare scopes`)
}

async function readContent<T>(kind: string, name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    logFailure(kind, name, error)
    throw new ProtocolError(INTERNAL_ERROR, "Content could not be read")
  }
}

/** Prompt retrieval returns instructions; authors must not perform mutations here. */
export function definePrompt<Input extends z.ZodObject, Services = unknown>(definition: {
  name: string
  description: string
  input: Input
  scopes: readonly string[]
  execute(input: z.output<Input>, context: ToolContext<Services>): Promise<GetPromptResult>
}): Prompt<Services> {
  validate(definition.name, definition.scopes)
  const scopes = Object.freeze([...definition.scopes])
  return Object.freeze({
    name: definition.name, scopes,
    register(server: McpServer, context: RegistrationContext<Services>) {
      const argsSchema: z.ZodObject = definition.input
      server.registerPrompt(definition.name, { description: definition.description, argsSchema }, async (raw, sdkContext) => {
        return readContent("prompt", definition.name, () => definition.execute(definition.input.parse(raw), callContext(context, sdkContext.mcpReq.signal)))
      })
    },
  })
}

/** A fixed-URI text resource. Use Apps views for interactive HTML. */
export function defineResource<Services = unknown>(definition: {
  name: string
  uri: string
  description: string
  mimeType: string
  scopes: readonly string[]
  read(context: ToolContext<Services>): Promise<string>
}): Resource<Services> {
  validate(definition.name, definition.scopes)
  const uri = new URL(definition.uri)
  if (uri.protocol === "ui:") throw new Error("Use defineView for ui:// resources")
  const scopes = Object.freeze([...definition.scopes])
  return Object.freeze({
    name: definition.name, uri: definition.uri, scopes,
    register(server: McpServer, context: RegistrationContext<Services>) {
      server.registerResource(definition.name, definition.uri, { description: definition.description, mimeType: definition.mimeType }, async (_uri, sdkContext) => {
        return readContent("resource", definition.name, async () => ({
          contents: [{ uri: definition.uri, mimeType: definition.mimeType, text: await definition.read(callContext(context, sdkContext.mcpReq.signal)) }],
        }))
      })
    },
  })
}
