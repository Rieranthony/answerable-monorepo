import { createIdVerifier, type IdVerifierConfig, type UserPrincipal } from "@answerable/auth"
import {
  INTERNAL_ERROR, ProtocolError, createMcpHandler, McpServer, requireBearerAuth, OAuthError, OAuthErrorCode,
  hostHeaderValidationResponse, originValidationResponse, getOAuthProtectedResourceMetadataUrl, readRequestBody,
} from "@modelcontextprotocol/server"
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { z } from "zod"
import { advertised, answer, bounded, parseArguments } from "./call"
import { commitIntent } from "./commit"
import { commitToolName, commitTools, receipt } from "./commit-tools"
import { permits, type ToolContext, type View } from "./definitions"
import { ToolError } from "./errors"
import { createMemoryIntentStore, type IntentStore } from "./intents"
import { preparePlan, riskClass, type Mutation, type PolicyClass } from "./mutation"
import { intentView, recordIntent } from "./prepare"
import type { Provider, Served } from "./provider"
import { readAnnotations, wireDescription, wireName, type Tool } from "./tool"

/** One call of a tool, a mutation's prepare tool or a commit tool, as `wrapCall` receives it. */
export type ToolCall = Readonly<{
  /** What the call runs: a tool, a mutation (its prepare tool), or a commit tool, `<id>/commit` or `<id>/commit_confirmed` at the provider's version. */
  tool: Served<Tool | Mutation> | Readonly<{ kind: "commit"; identity: string; version: string }>
  /** The name the call used. */
  name: string
  principal: UserPrincipal
  /** The handler's `executionId`, a UUIDv7, and the error envelope's `request_id`. */
  executionId: string
  /** The JSON-RPC id of the request. */
  requestId: string | number
  /** The request's `_meta`, such as a W3C `traceparent`. Untrusted, like every argument. */
  meta: Readonly<Record<string, unknown>>
}>

/** What `createMcpServer` takes: the provider, the ID issuer and resource to trust, and optional overrides. */
export type McpServerConfig = {
  /** The provider it serves, from `defineProvider`: its tools, prompts and resources, named after it. */
  provider: Provider
  /** The Answerable ID issuer to trust and this server's resource URL, the token audience: `readMcpEnvironment(process.env).auth`. */
  auth: IdVerifierConfig
  /** Where intents live. Default: a memory store for this server. */
  intents?: IntentStore
  /** The policy class of a mutation for one caller, decided for each request. Default: `riskClass[mutation.risk]`. */
  policyClass?: (mutation: Served<Mutation>, principal: UserPrincipal) => PolicyClass | Promise<PolicyClass>
  /**
   * Providers served beside `provider` at the same endpoint, as a hub mounts them. Their tools are named `<provider id>_<wire name>` after
   * `provider`'s own, their mutations commit through `provider`'s commit tools, and their views keep their URIs. Their prompts and resources
   * are not served, and `scopes_supported` lists only `provider`'s scopes. Default: none.
   */
  mount?: readonly Provider[]
  /**
   * Which tools a caller sees and may call, decided in place of the scope rule for each request that lists or calls tools or reads views; other
   * requests, such as `initialize`, see no tools. `called` is true when the request calls that tool, so a hub can record the refusal.
   * A `ToolError` it throws answers a call with that error whatever tool the call names (a name no tool could have, outside lowercase letters,
   * digits and underscores, stays unknown); a list fails. Anything else it throws fails the request with HTTP 500, logged as `[mcp] request failed`.
   * Default: the token carries every scope of the tool.
   */
  allow?: (principal: UserPrincipal, tool: Served<Tool | Mutation>, called: boolean) => boolean | Promise<boolean>
  /**
   * Which of the tools a caller may use are served to them as tools, decided for each request, for a hub that offers some capabilities through
   * its own tools instead. The others stay usable: their intents commit, and `call` runs them. A tool the caller may not use is never served,
   * whatever this returns. Default: all of them.
   */
  project?: (principal: UserPrincipal, usable: readonly Served<Tool | Mutation>[]) => readonly Served<Tool | Mutation>[] | Promise<readonly Served<Tool | Mutation>[]>
  /**
   * Runs around every call of a tool, a prepare tool or a commit tool. `run` parses the arguments, runs the handler within its timeout and checks
   * the output, or commits; it returns the structured content or throws what the call answers. Return what `run` returns, or throw a `ToolError`
   * to answer with it instead. Default: `run()`.
   */
  wrapCall?: (call: ToolCall, run: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>
}

/** What `createMcpServer` returns. */
export type McpServerHandle = {
  /** Answer one HTTP request: the web-standard handler the entry point serves. */
  fetch(request: Request): Promise<Response>
  /**
   * Tell every caller that listens for changes (`subscriptions/listen`, protocol 2026-07-28) that its tool list may have changed, so that it lists
   * again. It reaches every listener of this server, whoever they are. A 2025 caller has no stream to carry it and sees the change when it lists again.
   */
  toolsChanged(): void
  /**
   * Run a tool this server serves exactly as its direct call runs it, for the caller in `context`: parse `args` (answering `INVALID_INPUT`), run
   * the handler within its timeout and check the output; for a mutation, prepare it and record the intent its prepare tool would. Returns the
   * structured content. It is for a hub's own tools, such as one that runs a capability by identity: it does not decide whether the caller may
   * use the tool, and it runs inside the calling tool's `wrapCall`, not one of its own.
   */
  call(tool: Served<Tool | Mutation>, args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>>
}

const validateOnly = z.boolean().default(false).describe("Return the preview without recording an intent or issuing a commit token; default false")
const message = z.object({ method: z.string(), params: z.object({ name: z.string().optional() }).optional() })
type Peeked = { method?: string; name?: string; batch?: true }
// Requests whose answer depends on which tools, and so which views, the caller may use.
const decided = new Set(["tools/list", "tools/call", "resources/list", "resources/read"])
// A caller's tool list changes only with its scopes, fixed for a token's life, or with a hub's grants.
const cacheHints = { "tools/list": { ttlMs: 30_000, cacheScope: "private" as const } }
// Bun.serve closes a connection idle for 10 seconds by default, so a subscriptions/listen stream sends a keep-alive comment more often than that.
const keepAliveMs = 5_000

// The method and tool name of a request, read from a copy of its body, so that `allow` runs only when tools matter and can tell a call from a list;
// or that the body is a JSON-RPC batch, which the protocol no longer has and which would hide its calls from `allow`.
async function peek(request: Request): Promise<Peeked> {
  try {
    const body = await readRequestBody(request.clone())
    const json = JSON.parse(body.tooLarge ? "" : body.text)
    if (Array.isArray(json)) return { batch: true }
    const { method, params } = message.parse(json)
    return { method, name: params?.name }
  } catch {
    return {}
  }
}
// Every name a tool can have on the wire; the longest, a mounted provider's, is 46 characters.
const wireGrammar = /^[a-z0-9_]{1,64}$/
const batchRefused = () => Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches are not supported; send one JSON-RPC request per POST" } }, { status: 400 })

// Each tool with its name on the wire: `provider`'s own unprefixed, mounted ones prefixed with their provider's id.
function wireNames(provider: Provider, mount: readonly Provider[]) {
  const ids = new Set([provider.id])
  for (const { id } of mount) {
    if (ids.has(id)) throw new Error(`Provider ${id} is mounted twice; mount each provider once, and never the server's own provider`)
    ids.add(id)
  }
  const owner = new Map<string, string>()
  const views = new Map<string, View>()
  for (const { id, tools } of [provider, ...mount]) {
    for (const tool of tools) {
      if (tool.kind !== "read" || !tool.view) continue
      const shared = views.get(tool.view.uri)
      if (shared && shared !== tool.view) {
        throw new Error(`Providers ${owner.get(tool.view.uri)} and ${id} define two different views at ${tool.view.uri}; share one defineView result, or rename one view`)
      }
      views.set(tool.view.uri, tool.view)
      owner.set(tool.view.uri, id)
    }
  }
  return new Map<Served<Tool | Mutation>, string>([
    ...provider.tools.map(tool => [tool, wireName(tool.name)] as const),
    ...mount.flatMap(({ id, tools }) => tools.map(tool => [tool, `${id}_${wireName(tool.name)}`] as const)),
  ])
}

/**
 * Serve a provider over MCP: `/health`, the protected-resource metadata and the MCP endpoint behind Answerable ID sign-in.
 * It returns a web-standard `fetch` handler, which the caller serves, with `toolsChanged` and `call`. `tools/list` tells 2026-07-28 hosts they may keep
 * it for 30 seconds, for that caller alone.
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
export function createMcpServer(config: McpServerConfig): McpServerHandle {
  const { provider, auth, mount = [], allow, project } = config
  const { intents = createMemoryIntentStore(), policyClass = (mutation: Served<Mutation>) => riskClass[mutation.risk], wrapCall = (_call, run) => run() } = config
  const names = wireNames(provider, mount)
  const served = [...names.keys()]
  const views = new Set<View>(served.flatMap(tool => tool.kind === "read" && tool.view ? [tool.view] : []))
  const mutations = served.filter(tool => tool.kind === "mutate")
  const prepareInputs = new Map(mutations.map(mutation => [mutation, mutation.input.extend({ validate_only: validateOnly })]))
  const commits = commitTools(provider.id).map(commit => ({ ...commit, call: Object.freeze({ kind: "commit" as const, identity: commit.identity, version: provider.version }) }))
  const verify = createIdVerifier(auth)
  const resourceUrl = new URL(auth.resource)
  // The resource URL is the endpoint; the SDK's 401 challenge names this metadata URL.
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl)
  const metadataPath = new URL(metadataUrl).pathname
  const hosts = [resourceUrl.hostname]
  const definitions = [...provider.tools, ...provider.prompts, ...provider.resources]
  const scopes = [...new Set(definitions.flatMap(item => [...item.scopes]))].sort()
  const capabilities = {
    ...(served.length ? { tools: { listChanged: true } } : {}),
    ...(provider.prompts.length ? { prompts: {} } : {}),
    ...(views.size || provider.resources.length ? { resources: {} } : {}),
  }
  const gate = requireBearerAuth({
    resourceMetadataUrl: metadataUrl,
    verifier: {
      async verifyAccessToken(token) {
        try {
          const principal = await verify(token)
          return { token, clientId: principal.clientId, scopes: [...principal.scopes], expiresAt: principal.expiresAt, resource: resourceUrl, extra: { principal } as Record<string, unknown> }
        } catch {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token")
        }
      },
    },
  })
  // The tools a caller may use; a tool it cannot use is not registered, so calling it answers the unknown-tool error.
  async function usable(principal: UserPrincipal, { method, name }: Peeked) {
    if (!allow) return served.filter(tool => permits(principal, tool))
    if (method !== undefined && !decided.has(method)) return []
    const decisions = await Promise.all(served.map(tool => allow(principal, tool, method === "tools/call" && names.get(tool) === name)))
    return served.filter((_, index) => decisions[index])
  }
  async function projected(principal: UserPrincipal, tools: Served<Tool | Mutation>[]) {
    if (!project || !tools.length) return tools
    const chosen = new Set(await project(principal, tools))
    return tools.filter(tool => chosen.has(tool))
  }
  // A tool's direct path: parse the arguments, run the handler within its timeout and check the output; a mutation's prepare records an intent.
  async function perform(tool: Served<Tool | Mutation>, args: Record<string, unknown>, call: ToolContext) {
    if (tool.kind === "read") {
      const input = await parseArguments(tool.input, args)
      return tool.output.parseAsync(await bounded(tool, call, bound => tool.execute(input, bound)))
    }
    const { validate_only, ...input } = await parseArguments(prepareInputs.get(tool)!, args)
    const plan = await bounded(tool, call, bound => preparePlan(tool, input, bound))
    const policy = await policyClass(tool, call.principal)
    // The intent keeps the arguments as sent; a commit parses them again to run prepare.
    const sent = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "validate_only"))
    return recordIntent({
      mutation: tool, input: sent, plan,
      policyClass: policy, commitTool: commitToolName(provider.id, policy), principal: call.principal, store: intents, validateOnly: validate_only === true,
    })
  }
  const handler = createMcpHandler(async ({ authInfo }) => {
    const { principal, request = {} } = authInfo!.extra as { principal: UserPrincipal; request?: Peeked }
    const called = request.method === "tools/call" ? request.name : undefined
    // Capabilities follow the definitions, not the caller's scopes, so every caller sees the same server.
    const server = new McpServer({ name: provider.id, version: provider.version }, { capabilities, cacheHints })
    // The SDK's request signal also aborts when the HTTP request does.
    const context = (signal: AbortSignal): ToolContext => Object.freeze({ principal, executionId: Bun.randomUUIDv7(), signal })
    let permitted: Served<Tool | Mutation>[]
    let tools: Served<Tool | Mutation>[]
    try {
      permitted = await usable(principal, request)
      tools = await projected(principal, permitted)
    } catch (error) {
      if (!(error instanceof ToolError) || called === undefined) throw error
      // Whatever tool the call names, so that a refusal reveals nothing about which tools exist. A name no tool can have stays unknown: the SDK
      // would print it, newlines included, in its name warnings.
      if (wireGrammar.test(called)) {
        server.registerTool(called, { inputSchema: advertised(z.object({})) }, () => answer(called, Bun.randomUUIDv7(), async () => { throw error }))
      }
      return server
    }
    // One call: a fresh context, then `run` inside wrapCall. A failure is logged under the tool's name, or a commit tool's wire name.
    type Run = (args: Record<string, unknown>, call: ToolContext) => Promise<Record<string, unknown>>
    type Extra = { mcpReq: { id: string | number; signal: AbortSignal; _meta?: Record<string, unknown> } }
    const handle = (tool: ToolCall["tool"], name: string, run: Run) => (args: Record<string, unknown>, { mcpReq }: Extra) => {
      const call = context(mcpReq.signal)
      return answer(tool.kind === "commit" ? name : tool.name, call.executionId, () => wrapCall(Object.freeze({
        tool, name, principal, executionId: call.executionId, requestId: mcpReq.id, meta: mcpReq._meta ?? {},
      }), () => run(args, call)))
    }
    const registeredViews = new Set<View>()
    for (const tool of tools) {
      const name = names.get(tool)!
      const read = tool.kind === "read"
      const capability = {
        identity: tool.identity, version: tool.version, kind: tool.kind,
        ...(read ? {} : { risk: tool.risk, policy_class: await policyClass(tool, principal) }), ...(tool.deprecated ? { deprecated: tool.deprecated } : {}),
      }
      registerAppTool(server, name, {
        title: tool.title, description: wireDescription(tool), annotations: readAnnotations,
        inputSchema: advertised(read ? tool.input : prepareInputs.get(tool)!), outputSchema: read ? tool.output : intentView,
        _meta: { "com.answerable/capability": capability, ...(read && tool.view ? { ui: { resourceUri: tool.view.uri } } : {}) },
      }, handle(tool, name, (args, call) => perform(tool, args, call)))
      if (read && tool.view) registeredViews.add(tool.view)
    }
    // A caller who can use no mutation gets the unknown-tool error from the commit tools too.
    for (const commit of permitted.some(tool => tool.kind === "mutate") ? commits : []) {
      registerAppTool(server, commit.name, {
        description: commit.description, inputSchema: advertised(commit.input), outputSchema: receipt, annotations: commit.annotations, _meta: commit.meta,
      }, handle(commit.call, commit.name, async (args, call) => commitIntent({
        id: provider.id, tool: commit.name, input: await parseArguments(commit.input, args), context: call, store: intents, mutations,
        permitted: mutation => permitted.includes(mutation), policyClass: mutation => policyClass(mutation, principal),
      })))
    }
    for (const prompt of provider.prompts.filter(definition => permits(principal, definition))) {
      server.registerPrompt(prompt.name, { description: prompt.description, argsSchema: prompt.input }, async (input, sdkContext) => {
        try {
          return await prompt.execute(input, context(sdkContext.mcpReq.signal))
        } catch (error) {
          console.error(`[mcp] prompt ${prompt.name} failed`, error)
          throw new ProtocolError(INTERNAL_ERROR, "Content could not be read")
        }
      })
    }
    for (const resource of provider.resources.filter(definition => permits(principal, definition))) {
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
    // The SDK answers a failure of the factory or of serving with a bare 500 and reports it only here: the error alone, never the request.
  }, { keepAliveMs, onerror: error => console.error("[mcp] request failed", error) })
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
      let response = originValidationResponse(request, hosts)
      if (!response) {
        const authInfo = await gate(request)
        const peeked = !(authInfo instanceof Response) && request.method === "POST" ? await peek(request) : {}
        if (!(authInfo instanceof Response) && allow) authInfo.extra = { ...authInfo.extra, request: peeked }
        response = authInfo instanceof Response ? authInfo : peeked.batch ? batchRefused() : await handler.fetch(request, { authInfo })
      }
      response.headers.set("Cache-Control", "no-store")
      return response
    },
    toolsChanged: () => handler.notify.toolsChanged(),
    async call(tool, args, context) {
      if (!names.has(tool)) throw new Error(`${tool.identity} is not served by this server; mount its provider`)
      return perform(tool, args, context)
    },
  }
}
