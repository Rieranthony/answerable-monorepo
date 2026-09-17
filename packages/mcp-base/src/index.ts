export { readMcpEnvironment } from "./environment"
import type { ContentDefinition } from "./content"
export { definePrompt, defineResource } from "./content"
import { createIdVerifier, type IdVerifierConfig, type UserPrincipal } from "@answerable/auth"
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server"
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { hostHeaderValidation } from "@modelcontextprotocol/hono"
import { Hono } from "hono"
import { z } from "zod"

export type RequestLog = Readonly<{ requestId: string; status: number; durationMs: number }>

export type ToolContext<Services = unknown> = Readonly<{
  principal: UserPrincipal
  services: Services
  requestId: string
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

type Tool<Services> = {
  name: string
  scopes: readonly string[]
  view?: View
  register(server: McpServer, context: ToolContext<Services>): void
}

export function defineTool<
  Input extends z.ZodObject,
  Output extends z.ZodObject,
  Services = unknown,
>(definition: {
  name: string
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
    scopes: [...definition.scopes],
    view: definition.view,
    register(server, context) {
      // The SDK needs an object schema; the closure preserves the author's exact types.
      const inputSchema: z.ZodObject = definition.input
      const outputSchema: z.ZodObject = definition.output
      registerAppTool(server, definition.name, {
        description: definition.description,
        inputSchema,
        outputSchema,
        annotations: definition.annotations,
        _meta: definition.view ? { ui: { resourceUri: definition.view.uri } } : {},
      }, async (raw, sdkContext) => {
        const callContext = Object.freeze({ ...context, signal: AbortSignal.any([context.signal, sdkContext.mcpReq.signal]) })
        try {
          if (!definition.scopes.every(scope => context.principal.scopes.includes(scope))) {
            throw new ToolError("insufficient_scope", "Required tool permissions are missing")
          }
          callContext.signal.throwIfAborted()
          const input = definition.input.parse(raw)
          const result = await definition.execute(input, callContext)
          const data = definition.output.parse(result.data)
          return { structuredContent: data, content: [{ type: "text", text: result.text }] }
        } catch (error) {
          const code = error instanceof ToolError ? error.code : "tool_failed"
          const message = error instanceof ToolError ? error.message : "The tool could not complete"
          return {
            isError: true,
            content: [{ type: "text", text: `${code}: ${message}` }],
            _meta: { requestId: context.requestId, code },
          }
        }
      })
    },
  }
}

export function createMcpApp<Services>(config: {
  name: string
  version: string
  auth: IdVerifierConfig
  services: Services
  tools: readonly Tool<Services>[]
  prompts?: readonly ContentDefinition<Services>[]
  resources?: readonly (ContentDefinition<Services> & { readonly uri: string })[]
  /** Deadline after authentication, in milliseconds. Default 30 seconds. */
  handlerTimeoutMs?: number
  /** Fixed metadata only. Set false to disable or provide a sink. */
  log?: false | ((event: RequestLog) => void)
  allowedHosts?: string[]
  allowedOrigins?: string[]
}) {
  const handlerTimeoutMs = z.number().int().positive().max(300_000).parse(config.handlerTimeoutMs ?? 30_000)
  const names = new Set<string>()
  const views = new Map<string, View>()
  for (const tool of config.tools) {
    if (names.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
    names.add(tool.name)
    if (tool.view) {
      const existing = views.get(tool.view.uri)
      if (existing && existing.html !== tool.view.html) throw new Error(`Conflicting view: ${tool.view.uri}`)
      views.set(tool.view.uri, tool.view)
    }
  }
  const promptNames = new Set<string>()
  for (const prompt of config.prompts ?? []) {
    if (promptNames.has(prompt.name)) throw new Error(`Duplicate prompt: ${prompt.name}`)
    promptNames.add(prompt.name)
  }
  const resourceUris = new Set(views.keys())
  for (const resource of config.resources ?? []) {
    if (resourceUris.has(resource.uri)) throw new Error(`Duplicate resource: ${resource.uri}`)
    resourceUris.add(resource.uri)
  }
  const verify = createIdVerifier(config.auth)
  const resourceUrl = new URL(config.auth.resource)
  const path = resourceUrl.pathname === "/" ? "/mcp" : resourceUrl.pathname
  const metadataPath = `/.well-known/oauth-protected-resource${path}`
  const scopes = [...new Set([...config.tools, ...(config.prompts ?? []), ...(config.resources ?? [])].flatMap(item => [...item.scopes]))]
  const app = new Hono<{ Variables: { requestId: string } }>()
  app.use("*", hostHeaderValidation(config.allowedHosts ?? [resourceUrl.hostname]))
  app.get("/health", c => c.json({ status: "ok" }))
  app.get(metadataPath, c => c.json({
    resource: config.auth.resource,
    authorization_servers: [config.auth.issuer],
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
  }))
  app.use(path, async (c, next) => {
    const started = performance.now()
    const requestId = crypto.randomUUID()
    c.set("requestId", requestId)
    await next()
    c.res.headers.set("X-Request-Id", requestId)
    c.res.headers.set("Cache-Control", "no-store")
    if (config.log !== false) {
      const event = Object.freeze({ requestId, status: c.res.status, durationMs: Math.max(0, Math.round(performance.now() - started)) })
      try {
        if (config.log) void Promise.resolve(config.log(event)).catch(() => {})
        else console.info(JSON.stringify(event))
      } catch { /* A logging sink must not change a completed operation's outcome. */ }
    }
  })
  app.all(path, async c => {
    const requestId = c.get("requestId")
    const origin = c.req.header("Origin")
    if (origin && !(config.allowedOrigins ?? [resourceUrl.origin]).includes(origin)) {
      return c.json({ error: "untrusted_origin" }, 403)
    }
    const bearer = /^Bearer +([^\s]+)$/i.exec(c.req.header("Authorization") ?? "")?.[1]
    let principal: UserPrincipal
    try {
      if (!bearer) throw new Error("Missing token")
      principal = await verify(bearer)
    } catch {
      const metadataUrl = new URL(metadataPath, config.auth.resource).href
      c.header("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`)
      return c.json({ error: "invalid_token" }, 401)
    }
    const deadline = new AbortController()
    const signal = AbortSignal.any([c.req.raw.signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(), handlerTimeoutMs)
    let onAbort: () => void = () => {}
    const interrupted = new Promise<Response>(resolve => {
      onAbort = () => resolve(Response.json({ error: deadline.signal.aborted ? "request_timeout" : "request_cancelled", requestId }, { status: deadline.signal.aborted ? 504 : 408 }))
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    })
    // A fresh server closes over only this request's immutable principal.
    const server = new McpServer({ name: config.name, version: config.version })
    const context = Object.freeze({ principal, services: config.services, requestId, signal })
    try {
      for (const tool of config.tools) tool.register(server, context)
      for (const item of [...(config.prompts ?? []), ...(config.resources ?? [])]) item.register(server, context)
      for (const view of views.values()) {
        registerAppResource(server, view.name, view.uri, {}, async () => ({
          contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html }],
        }))
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      return await Promise.race([transport.handleRequest(c.req.raw), interrupted])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      await server.close()
    }
  })
  return app
}
