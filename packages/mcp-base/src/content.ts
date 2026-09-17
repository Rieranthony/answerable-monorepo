import { INTERNAL_ERROR, INVALID_REQUEST, ProtocolError, type GetPromptResult, type McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { ToolContext } from "./index"

export type ContentDefinition<Services> = Readonly<{
  name: string
  scopes: readonly string[]
  register(server: McpServer, context: ToolContext<Services>): void
}>

function validate(name: string, scopes: readonly string[]) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Invalid definition name")
  if (!scopes.length || scopes.some(scope => !scope || /\s/.test(scope))) throw new Error(`${name} must declare scopes`)
}

async function authorised<T>(scopes: readonly string[], context: ToolContext, run: () => Promise<T>): Promise<T> {
  if (!scopes.every(scope => context.principal.scopes.includes(scope))) {
    throw new ProtocolError(INVALID_REQUEST, "insufficient_scope: Required permissions are missing", { code: "insufficient_scope", requestId: context.requestId })
  }
  try {
    context.signal.throwIfAborted()
    return await run()
  } catch {
    throw new ProtocolError(INTERNAL_ERROR, "Content could not be read", { requestId: context.requestId })
  }
}

/** Prompt retrieval returns instructions; authors must not perform mutations here. */
export function definePrompt<Input extends z.ZodObject, Services = unknown>(definition: {
  name: string
  description: string
  input: Input
  scopes: readonly string[]
  execute(input: z.output<Input>, context: ToolContext<Services>): Promise<GetPromptResult>
}): ContentDefinition<Services> {
  validate(definition.name, definition.scopes)
  const scopes = Object.freeze([...definition.scopes])
  return Object.freeze({
    name: definition.name, scopes,
    register(server: McpServer, context: ToolContext<Services>) {
      const argsSchema: z.ZodObject = definition.input
      server.registerPrompt(definition.name, { description: definition.description, argsSchema }, async (raw, sdkContext) => {
        const callContext = Object.freeze({ ...context, signal: AbortSignal.any([context.signal, sdkContext.mcpReq.signal]) })
        return authorised(scopes, callContext, () => definition.execute(definition.input.parse(raw), callContext))
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
}): ContentDefinition<Services> & { readonly uri: string } {
  validate(definition.name, definition.scopes)
  const uri = new URL(definition.uri)
  if (uri.protocol === "ui:") throw new Error("Use defineView for ui:// resources")
  const scopes = Object.freeze([...definition.scopes])
  return Object.freeze({
    name: definition.name, uri: definition.uri, scopes,
    register(server: McpServer, context: ToolContext<Services>) {
      server.registerResource(definition.name, definition.uri, { description: definition.description, mimeType: definition.mimeType }, async (_uri, sdkContext) => {
        const callContext = Object.freeze({ ...context, signal: AbortSignal.any([context.signal, sdkContext.mcpReq.signal]) })
        return authorised(scopes, callContext, async () => ({ contents: [{ uri: definition.uri, mimeType: definition.mimeType, text: await definition.read(callContext) }] }))
      })
    },
  })
}
