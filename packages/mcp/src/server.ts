import { createIdVerifier, type IdVerifierConfig, type UserPrincipal } from "@answerable/auth"
import {
  INTERNAL_ERROR, ProtocolError, createMcpHandler, McpServer, requireBearerAuth, OAuthError, OAuthErrorCode,
  hostHeaderValidationResponse, originValidationResponse, getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/server"
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { ToolError, type Tool, type Prompt, type Resource, type View } from "./definitions"

export type McpServerConfig = {
  name: string
  version: string
  auth: IdVerifierConfig
  tools: readonly Tool[]
  prompts?: readonly Prompt[]
  resources?: readonly Resource[]
  /** Hostnames accepted in the Host header. Default: the resource URL's hostname. */
  allowedHosts?: string[]
  /** Hostnames accepted in a browser Origin header. Default: the resource URL's hostname. */
  allowedOrigins?: string[]
}

export function createMcpServer(config: McpServerConfig): { fetch(request: Request): Promise<Response> } {
  const views = new Map<string, View>()
  function unique(values: readonly string[], kind: string) {
    const seen = new Set<string>()
    for (const value of values) {
      if (seen.has(value)) throw new Error(`Duplicate ${kind}: ${value}`)
      seen.add(value)
    }
  }
  unique(config.tools.map(tool => tool.name), "tool")
  unique((config.prompts ?? []).map(prompt => prompt.name), "prompt")
  for (const tool of config.tools) {
    if (!tool.view) continue
    const existing = views.get(tool.view.uri)
    if (existing && existing !== tool.view) throw new Error(`Conflicting view: ${tool.view.uri}`)
    views.set(tool.view.uri, tool.view)
  }
  unique([...views.keys(), ...(config.resources ?? []).map(resource => resource.uri)], "resource")
  const verify = createIdVerifier(config.auth)
  const resourceUrl = new URL(config.auth.resource)
  // The resource URL is the endpoint; the SDK's 401 challenge names this metadata URL.
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl)
  const metadataPath = new URL(metadataUrl).pathname
  const allowedHosts = config.allowedHosts ?? [resourceUrl.hostname]
  const allowedOrigins = config.allowedOrigins ?? [resourceUrl.hostname]
  const definitions = [...config.tools, ...(config.prompts ?? []), ...(config.resources ?? [])]
  const scopes = [...new Set(definitions.flatMap(item => [...item.scopes]))].sort()
  const capabilities = {
    ...(config.tools.length ? { tools: {} } : {}),
    ...(config.prompts?.length ? { prompts: {} } : {}),
    ...(views.size || config.resources?.length ? { resources: {} } : {}),
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
    const server = new McpServer({ name: config.name, version: config.version }, { capabilities })
    const context = (sdkSignal: AbortSignal) => Object.freeze({ principal, signal: requestInfo?.signal ? AbortSignal.any([sdkSignal, requestInfo.signal]) : sdkSignal })
    const permitted = (definition: { scopes: readonly string[] }) => definition.scopes.every(scope => principal.scopes.includes(scope))
    const registeredViews = new Set<View>()
    for (const tool of config.tools.filter(permitted)) {
      registerAppTool(server, tool.name, {
        title: tool.title, description: tool.description, inputSchema: tool.input, outputSchema: tool.output,
        annotations: tool.annotations, _meta: tool.view ? { ui: { resourceUri: tool.view.uri } } : {},
      }, async (input, sdkContext) => {
        const call = context(sdkContext.mcpReq.signal)
        try {
          call.signal.throwIfAborted()
          const data = tool.output.parse(await tool.execute(input, call))
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] }
        } catch (error) {
          if (!(error instanceof ToolError)) console.error(`[mcp] tool ${tool.name} failed`, error)
          const code = error instanceof ToolError ? error.code : "tool_failed"
          const message = error instanceof ToolError ? error.message : "The tool could not complete"
          return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }], _meta: { code } }
        }
      })
      if (tool.view) registeredViews.add(tool.view)
    }
    for (const prompt of (config.prompts ?? []).filter(permitted)) {
      server.registerPrompt(prompt.name, { description: prompt.description, argsSchema: prompt.input }, async (input, sdkContext) => {
        try {
          return await prompt.execute(input, context(sdkContext.mcpReq.signal))
        } catch (error) {
          console.error(`[mcp] prompt ${prompt.name} failed`, error)
          throw new ProtocolError(INTERNAL_ERROR, "Content could not be read")
        }
      })
    }
    for (const resource of (config.resources ?? []).filter(permitted)) {
      server.registerResource(resource.name, resource.uri, { description: resource.description, mimeType: resource.mimeType }, async (_uri, sdkContext) => {
        try {
          return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await resource.read(context(sdkContext.mcpReq.signal)) }] }
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
      const hostRejection = hostHeaderValidationResponse(request, allowedHosts)
      if (hostRejection) return hostRejection
      if (request.method === "GET" && pathname === metadataPath) return Response.json({
        resource: config.auth.resource, authorization_servers: [config.auth.issuer], scopes_supported: scopes,
        bearer_methods_supported: ["header"], resource_name: config.name,
      })
      if (pathname !== resourceUrl.pathname) return new Response("Not found", { status: 404 })
      let response = originValidationResponse(request, allowedOrigins)
      if (!response) {
        const authInfo = await gate(request)
        response = authInfo instanceof Response ? authInfo : await handler.fetch(request, { authInfo })
      }
      response.headers.set("Cache-Control", "no-store")
      return response
    },
  }
}
