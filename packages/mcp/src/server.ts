import { createIdVerifier, type IdVerifierConfig, type UserPrincipal } from "@answerable/auth"
import {
  INTERNAL_ERROR, ProtocolError, createMcpHandler, McpServer, requireBearerAuth, OAuthError, OAuthErrorCode,
  hostHeaderValidationResponse, originValidationResponse, getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/server"
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { z } from "zod"
import { advertised, answer, bounded, parseArguments } from "./call"
import { commitIntent } from "./commit"
import { commitToolName, commitTools, receipt } from "./commit-tools"
import { permits, type ToolContext, type View } from "./definitions"
import { createMemoryIntentStore, type IntentStore } from "./intents"
import { preparePlan, riskClass, type Mutation, type PolicyClass } from "./mutation"
import { intentView, recordIntent } from "./prepare"
import type { Provider, Served } from "./provider"
import { readAnnotations, wireDescription, wireName } from "./tool"

/** What `createMcpServer` takes: the provider, the ID issuer and resource to trust, and optional overrides. */
export type McpServerConfig = {
  provider: Provider
  auth: IdVerifierConfig
  /** Hostnames accepted in the Host header. Default: the resource URL's hostname. */
  allowedHosts?: string[]
  /** Hostnames accepted in a browser Origin header. Default: the resource URL's hostname. */
  allowedOrigins?: string[]
  /** Where intents live. Default: a memory store for this server. */
  intents?: IntentStore
  /** The policy class of a mutation for one caller, decided for each request. Default: from the mutation's `risk`. */
  policyClass?: (mutation: Served<Mutation>, principal: UserPrincipal) => PolicyClass
}

const validateOnly = z.boolean().default(false).describe("Return the preview without recording an intent or issuing a commit token; default false")

/**
 * Serve a provider over MCP: `/health`, the protected-resource metadata and the MCP endpoint behind Answerable ID sign-in.
 * It returns a web-standard `{ fetch }` handler; the caller owns the listener.
 *
 * @example
 * ```ts
 * import { createMcpServer, readMcpEnvironment } from "@answerable/mcp"
 * import { provider } from "./provider"
 *
 * const { auth, port } = readMcpEnvironment(process.env)
 * const server = createMcpServer({ provider, auth })
 * Bun.serve({ hostname: "127.0.0.1", port, fetch: server.fetch })
 * ```
 */
export function createMcpServer(config: McpServerConfig): { fetch(request: Request): Promise<Response> } {
  const { provider, auth, allowedHosts, allowedOrigins, intents = createMemoryIntentStore(), policyClass = (mutation: Served<Mutation>) => riskClass[mutation.risk] } = config
  const views = new Set<View>(provider.tools.flatMap(tool => tool.kind === "read" && tool.view ? [tool.view] : []))
  const mutations = provider.tools.filter(tool => tool.kind === "mutate")
  const prepareInputs = new Map(mutations.map(mutation => [mutation, mutation.input.extend({ validate_only: validateOnly })]))
  const commits = commitTools(provider.id)
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
    const context = (signal: AbortSignal): ToolContext => Object.freeze({
      principal, executionId: Bun.randomUUIDv7(), signal: requestInfo?.signal ? AbortSignal.any([signal, requestInfo.signal]) : signal,
    })
    const permitted = (definition: { scopes: readonly string[] }) => permits(principal, definition)
    const tools = provider.tools.filter(permitted)
    const registeredViews = new Set<View>()
    for (const tool of tools) {
      const capability = { identity: tool.identity, version: tool.version, kind: tool.kind }
      const deprecated = tool.deprecated ? { deprecated: tool.deprecated } : {}
      if (tool.kind === "read") {
        registerAppTool(server, wireName(tool.name), {
          title: tool.title, description: wireDescription(tool), inputSchema: advertised(tool.input), outputSchema: tool.output, annotations: readAnnotations,
          _meta: { "com.answerable/capability": { ...capability, ...deprecated }, ...(tool.view ? { ui: { resourceUri: tool.view.uri } } : {}) },
        }, (args, sdkContext) => {
          const call = context(sdkContext.mcpReq.signal)
          return answer(tool.name, call.executionId, async () => {
            const input = await parseArguments(tool.input, args)
            return tool.output.parseAsync(await bounded(tool, call, bound => tool.execute(input, bound)))
          })
        })
        if (tool.view) registeredViews.add(tool.view)
        continue
      }
      const policy = policyClass(tool, principal)
      registerAppTool(server, wireName(tool.name), {
        title: tool.title, description: wireDescription(tool), inputSchema: advertised(prepareInputs.get(tool)!), outputSchema: intentView, annotations: readAnnotations,
        _meta: { "com.answerable/capability": { ...capability, risk: tool.risk, policy_class: policy, ...deprecated } },
      }, (args, sdkContext) => {
        const call = context(sdkContext.mcpReq.signal)
        return answer(tool.name, call.executionId, async () => {
          const { validate_only, ...input } = await parseArguments(prepareInputs.get(tool)!, args)
          const plan = await bounded(tool, call, bound => preparePlan(tool, input, bound))
          // The intent keeps the arguments as sent; a commit parses them again to run prepare.
          const sent = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "validate_only"))
          return recordIntent({
            mutation: tool, input: sent, plan,
            policyClass: policy, commitTool: commitToolName(provider.id, policy), principal, store: intents, validateOnly: validate_only === true,
          })
        })
      })
    }
    // A caller who can use no mutation gets the unknown-tool error from the commit tools too.
    for (const commit of tools.some(tool => tool.kind === "mutate") ? commits : []) {
      registerAppTool(server, commit.name, {
        description: commit.description, inputSchema: advertised(commit.input), outputSchema: receipt, annotations: commit.annotations, _meta: commit.meta,
      }, (args, sdkContext) => {
        const call = context(sdkContext.mcpReq.signal)
        return answer(commit.name, call.executionId, async () => commitIntent({
          id: provider.id, tool: commit.name, input: await parseArguments(commit.input, args), context: call, store: intents, mutations,
        }))
      })
    }
    for (const prompt of provider.prompts.filter(permitted)) {
      server.registerPrompt(prompt.name, { description: prompt.description, argsSchema: prompt.input }, async (input, sdkContext) => {
        try {
          return await prompt.execute(input, context(sdkContext.mcpReq.signal))
        } catch (error) {
          console.error(`[mcp] prompt ${prompt.name} failed`, error)
          throw new ProtocolError(INTERNAL_ERROR, "Content could not be read")
        }
      })
    }
    for (const resource of provider.resources.filter(permitted)) {
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
