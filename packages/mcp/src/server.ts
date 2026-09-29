import { createIdVerifier, type IdVerifierConfig, type UserPrincipal } from "@answerable/auth"
import {
  INTERNAL_ERROR, ProtocolError, createMcpHandler, McpServer, requireBearerAuth, OAuthError, OAuthErrorCode,
  hostHeaderValidationResponse, originValidationResponse, getOAuthProtectedResourceMetadataUrl,
  type CallToolResult, type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server"
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import type { z } from "zod"
import type { ToolContext, View } from "./definitions"
import { ToolError } from "./errors"
import type { Provider } from "./provider"
import { readAnnotations, wireDescription, wireName } from "./tool"

/** Configuration for `createMcpServer`. */
export type McpServerConfig = {
  provider: Provider
  auth: IdVerifierConfig
  /** Hostnames accepted in the Host header. Default: the resource URL's hostname. */
  allowedHosts?: string[]
  /** Hostnames accepted in a browser Origin header. Default: the resource URL's hostname. */
  allowedOrigins?: string[]
}

// tools/list advertises the real schema, but the SDK's own validation would answer a plain-text error,
// so it accepts every argument and the handler validates, answering INVALID_INPUT.
function advertised(input: z.ZodObject): StandardSchemaWithJSON<Record<string, unknown>> {
  return { "~standard": { version: 1, vendor: "zod", jsonSchema: input["~standard"].jsonSchema, validate: value => ({ value: value as Record<string, unknown> }) } }
}

function invalidInput(issues: readonly z.core.$ZodIssue[]) {
  const field = (path: readonly PropertyKey[]) => path.map(String).join(".")
  const violations = issues.flatMap(issue => issue.code === "unrecognized_keys"
    ? issue.keys.map(key => ({ field: field([...issue.path, key]), message: "Unknown field" }))
    : [{ field: field(issue.path), message: issue.message }])
  const message = violations.map(violation => violation.field ? `${violation.field}: ${violation.message}` : violation.message).join("; ")
  return new ToolError("INVALID_INPUT", message, { details: { field_violations: violations } })
}

// The envelope travels as JSON text only: MCP SDK 1.x clients check any structuredContent
// against the tool's output schema even on an error result, and would reject the envelope.
function failure({ code, message, retry, details }: ToolError, requestId: string): CallToolResult {
  const envelope = { error: { code, message, retry, ...(details ? { details } : {}), request_id: requestId } }
  return { isError: true, content: [{ type: "text", text: JSON.stringify(envelope) }] }
}

/** Serve a provider over MCP with Answerable ID sign-in; returns a web-standard `{ fetch }` handler. */
export function createMcpServer({ provider, auth, allowedHosts, allowedOrigins }: McpServerConfig): { fetch(request: Request): Promise<Response> } {
  const views = new Set<View>(provider.tools.flatMap(tool => tool.view ? [tool.view] : []))
  const verify = createIdVerifier(auth)
  const resourceUrl = new URL(auth.resource)
  // The resource URL is the endpoint; the SDK's 401 challenge names this metadata URL.
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl)
  const metadataPath = new URL(metadataUrl).pathname
  const hosts = allowedHosts ?? [resourceUrl.hostname]
  const origins = allowedOrigins ?? [resourceUrl.hostname]
  const definitions = [...provider.tools, ...provider.prompts, ...provider.resources]
  const scopes = [...new Set(definitions.flatMap(item => [...item.scopes]))].sort()
  const capabilities = {
    ...(provider.tools.length ? { tools: {} } : {}),
    ...(provider.prompts.length ? { prompts: {} } : {}),
    ...(views.size || provider.resources.length ? { resources: {} } : {}),
  }
  const gate = requireBearerAuth({
    resourceMetadataUrl: metadataUrl,
    verifier: {
      async verifyAccessToken(token) {
        try {
          const principal = await verify(token)
          return { token, clientId: principal.clientId, scopes: [...principal.scopes], expiresAt: principal.expiresAt, resource: resourceUrl, extra: { principal } }
        } catch {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token")
        }
      },
    },
  })
  const handler = createMcpHandler(({ authInfo, requestInfo }) => {
    const principal = authInfo!.extra!.principal as UserPrincipal
    // Capabilities follow the definitions, not the caller's scopes, so every caller sees the same server.
    const server = new McpServer({ name: provider.id, version: provider.version }, { capabilities })
    const context = (signals: AbortSignal[]): ToolContext => Object.freeze({
      principal, executionId: Bun.randomUUIDv7(), signal: AbortSignal.any(requestInfo?.signal ? [...signals, requestInfo.signal] : signals),
    })
    const permitted = (definition: { scopes: readonly string[] }) => definition.scopes.every(scope => principal.scopes.includes(scope))
    const registeredViews = new Set<View>()
    for (const tool of provider.tools.filter(permitted)) {
      const capability = { identity: tool.identity, version: tool.version, kind: "read", ...(tool.deprecated ? { deprecated: tool.deprecated } : {}) }
      registerAppTool(server, wireName(tool.name), {
        title: tool.title, description: wireDescription(tool), inputSchema: advertised(tool.input), outputSchema: tool.output, annotations: readAnnotations,
        _meta: { "com.answerable/capability": capability, ...(tool.view ? { ui: { resourceUri: tool.view.uri } } : {}) },
      }, async (args, sdkContext) => {
        const deadline = AbortSignal.timeout(tool.timeoutMs)
        const call = context([sdkContext.mcpReq.signal, deadline])
        const timedOut = new Promise<never>((_, reject) => deadline.addEventListener("abort", reject, { once: true }))
        try {
          const input = await tool.input.safeParseAsync(args)
          if (!input.success) throw invalidInput(input.error.issues)
          const data = await tool.output.parseAsync(await Promise.race([tool.execute(input.data, call), timedOut]))
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] }
        } catch (error) {
          if (deadline.aborted) return failure(new ToolError("TIMEOUT", `The tool did not finish within ${tool.timeoutMs} ms`), call.executionId)
          if (error instanceof ToolError) return failure(error, call.executionId)
          console.error(`[mcp] tool ${tool.name} failed`, call.executionId, error)
          return failure(new ToolError("INTERNAL", "The tool could not complete"), call.executionId)
        }
      })
      if (tool.view) registeredViews.add(tool.view)
    }
    for (const prompt of provider.prompts.filter(permitted)) {
      server.registerPrompt(prompt.name, { description: prompt.description, argsSchema: prompt.input }, async (input, sdkContext) => {
        try {
          return await prompt.execute(input, context([sdkContext.mcpReq.signal]))
        } catch (error) {
          console.error(`[mcp] prompt ${prompt.name} failed`, error)
          throw new ProtocolError(INTERNAL_ERROR, "Content could not be read")
        }
      })
    }
    for (const resource of provider.resources.filter(permitted)) {
      server.registerResource(resource.name, resource.uri, { description: resource.description, mimeType: resource.mimeType }, async (_uri, sdkContext) => {
        try {
          return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await resource.read(context([sdkContext.mcpReq.signal])) }] }
        } catch (error) {
          console.error(`[mcp] resource ${resource.name} failed`, error)
          throw new ProtocolError(INTERNAL_ERROR, "Content could not be read")
        }
      })
    }
    for (const view of registeredViews) {
      registerAppResource(server, view.name, view.uri, {}, async () => ({
        contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html }],
      }))
    }
    return server
  })
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (request.method === "GET" && pathname === "/health") return Response.json({ status: "ok" })
      const hostRejection = hostHeaderValidationResponse(request, hosts)
      if (hostRejection) return hostRejection
      if (request.method === "GET" && pathname === metadataPath) return Response.json({
        resource: auth.resource, authorization_servers: [auth.issuer], scopes_supported: scopes,
        bearer_methods_supported: ["header"], resource_name: provider.id,
      })
      if (pathname !== resourceUrl.pathname) return new Response("Not found", { status: 404 })
      let response = originValidationResponse(request, origins)
      if (!response) {
        const authInfo = await gate(request)
        response = authInfo instanceof Response ? authInfo : await handler.fetch(request, { authInfo })
      }
      response.headers.set("Cache-Control", "no-store")
      return response
    },
  }
}
