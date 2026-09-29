# Answerable MCP foundation: code inventory

Read-only inventory taken 2026-09-28. Two trees are documented:

- **MAIN** = `/Users/anthonyriera/code/answerable` at `d55220d` ("Document issuing the entitled scope subset"). Foundation = `packages/mcp-base` (@answerable/mcp-base), `packages/auth` (@answerable/auth), `mcps/e2e`.
- **WORKTREE (PR #11, approved, = FUTURE API)** = `/Users/anthonyriera/code/answerable/.claude/worktrees/mcp-sdk-dx` at `7af150b` ("Document the MCP package API and in-process tests"; parent `1377ed7` "Reshape the MCP package API and run its tests in-process", on top of `d55220d`). Foundation = `packages/mcp` (@answerable/mcp) replacing `packages/mcp-base`; `packages/auth` gains an injectable `fetch`; `mcps/e2e` moves to `createMcpServer` + in-process tests.

Diff MAIN..WORKTREE: 49 files, +741/-455. `packages/mcp-base/{build-worker,build,environment}.ts` and `tsconfig.json`/`eslint.config.mjs` are renamed unchanged into `packages/mcp/`; `index.ts` -> `server.ts` (64 lines changed), `index.test.ts` -> `server.test.ts`; `definitions.ts` rewritten (168 lines deleted, 70 new); new `definitions.test.ts`, `testing.test.ts`, `testing.ts` (46 lines), `bunfig.toml` (coverage gate), asset fixtures. Untracked planning files in the worktree root (`findings.md`, `progress.md`, `task_plan.md`) are not part of the PR.

---

## 1. `@answerable/auth` (`packages/auth`)

Package: `packages/auth/package.json` — name `@answerable/auth`, private, `exports: { ".": "./src/index.ts", "./testing": "./src/testing.ts" }` (TypeScript source is the published surface; no build). Deps: `jose 6.2.12`, `zod 4.6.5`. Scripts: `test` = `bun test` (WORKTREE adds `bunfig.toml` with `coverageThreshold = { lines = 1, functions = 1 }`, i.e. 100 % lines and functions, `root = "src"`, lcov + text reporters).

### 1.1 Public API (`packages/auth/src/index.ts`)

MAIN lines 4-9 / WORKTREE lines 4-11:

```ts
export type IdVerifierConfig = {
  /** Trusted Answerable ID issuer, for example https://id.answerable.org. */
  issuer: string
  /** This service's canonical resource URL as registered in ID; the token audience must contain it. */
  resource: string
  // WORKTREE ONLY (index.ts:9-10):
  /** HTTP client for discovery and key requests. Default: the global fetch. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}
```

MAIN lines 11-19 (identical in WORKTREE, lines 13-21):

```ts
export type UserPrincipal = Readonly<{
  userId: string          // claims.sub (uuid)
  organizationId: string  // claims.organization_id (uuid)
  membershipId: string    // claims.membership_id (uuid)
  grantId: string         // claims.grant_id (uuid)
  clientId: string        // claims.client_id
  scopes: readonly string[] // de-duplicated, split on " ", frozen
  expiresAt: number       // claims.exp (seconds)
}>
```

`AuthenticationError extends Error` (lines 21-26): message "A valid Answerable ID user access token is required", `name = "AuthenticationError"`. It carries NO detail by design (README "Failures").

`createIdVerifier(config): (token: string) => Promise<UserPrincipal>` (MAIN lines 54-94; WORKTREE 56-97):

- URL hygiene `trustedUrl()` (lines 41-52): issuer, resource and discovered `jwks_uri` must parse, carry no credentials, no `?`, no `#`, and be `https:` or `http:` on `localhost` / `127.0.0.1` / `[::1]`.
- Discovery (lines 59-68): lazily fetches `<issuer>/.well-known/oauth-authorization-server[<issuer path>]` (RFC 8414 layout: well-known prefix + issuer path), 5 s timeout, `redirect: "error"`; parses `{ issuer: z.literal(issuer), jwks_uri }`; `jwks_uri` must share the issuer origin; builds `createRemoteJWKSet(jwksUrl)` (WORKTREE passes `{ [customFetch]: fetcher }`, line 70). Discovery promise is memoised; on failure it is reset so the next call retries (lines 71-74).
- Verification `jwtVerify(token, jwks, { issuer, audience: resource, algorithms: ["EdDSA","ES256","RS256"], typ: "at+jwt", requiredClaims: ["exp","iat","sub"] })` (lines 75-78). So it checks: **iss** (exact), **aud** (must contain the resource URL), **typ** = `at+jwt`, **alg** in EdDSA/ES256/RS256, **exp** (jose enforces expiry; also required), **iat** required, **sub** required, signature via JWKS (kid lookup, jose remote set handles rotation refetch).
- Claims schema (lines 28-39): `sub: uuid`, `subject_type: literal "user"` (machine/client-credentials tokens are rejected), `organization_id: uuid`, `membership_id: uuid`, `grant_id: uuid`, `client_id: string min 1`, `azp?: string`, `scope: string`, `exp: positive int`, `cnf: z.never().optional()` (any `cnf`/DPoP-bound token is rejected). If `azp` present it must equal `client_id` (line 80).
- **Tenant**: there is no configurable tenant check. `organization_id` is merely required and surfaced as `organizationId`; the README ("Revocation") tells callers to "Constrain every query by `organizationId`". No `nbf`, no `jti`, no revocation/introspection call (offline verification only).
- Every failure of any kind collapses to `throw new AuthenticationError()` (lines 90-92).

### 1.2 `@answerable/auth/testing` (`packages/auth/src/testing.ts`)

`createTestIssuer(options)` returns `TestIssuer`:

```ts
export type TestIssuer = {
  issuer: string
  sign(options: { resource: string; scopes?: readonly string[]; organizationId?: string; userId?: string;
                  expiresIn?: string | number; claims?: Record<string, unknown>; header?: Record<string, unknown> }): Promise<string>
  rotate(): Promise<void>          // new key pair + kid; old public keys stay in the JWKS
  outage(unavailable: boolean): void // makes discovery + jwks answer 503
  jwksRequests(): number
  // MAIN (testing.ts:17):  stop(): void        — MAIN runs a real Bun.serve on 127.0.0.1:0
  // WORKTREE (testing.ts:17): fetch(input, init): Promise<Response>  — in-process; nothing listens
}
```

- MAIN: `createTestIssuer({ algorithm? })` boots `Bun.serve({ hostname: "127.0.0.1", port: 0 })` serving `/.well-known/oauth-authorization-server` and `/jwks`; `issuer = server.url.origin` (http loopback, allowed by `trustedUrl`).
- WORKTREE: `createTestIssuer({ algorithm?, issuer? })`, default issuer `https://id.test` (testing.ts:34); `fetch` answers only its own origin (404 otherwise), same two paths; pass `fetch` into `createIdVerifier({ fetch: issuer.fetch })`. Removes port usage from unit tests.
- `sign()` builds an ID-shaped token: `iss`, `aud: resource`, `sub`, `subject_type: "user"`, `organization_id`, `membership_id`, `grant_id`, `client_id: "test-client"`, `scope` (space-joined), `iat`, `exp` (default `5m`); `claims` override/merge (an `undefined` value deletes the claim), `header` merges into `{ alg, kid, typ: "at+jwt" }`.

README contract (`packages/auth/README.md`): keys from RFC 8414 metadata on first use, `at+jwt`, EdDSA/ES256/RS256, audience contains resource, unexpired, user + organisation claims, no `cnf`; rejection = `AuthenticationError` -> answer with a 401 challenge; verification is offline so "an issued token stays valid until it expires".

---

## 2. The MCP package

### 2.1 MAIN: `@answerable/mcp-base` (`packages/mcp-base`)

`package.json`: exports `.` -> `src/index.ts`, `./build` -> `src/build.ts`, `./testing` -> `src/testing.ts`. Deps: `@answerable/auth workspace:*`, `@modelcontextprotocol/client 2.1.0`, `@modelcontextprotocol/core 2.1.0`, `@modelcontextprotocol/ext-apps 2.0.0`, `@modelcontextprotocol/server 2.1.0`, `zod 4.6.5`. No `bunfig.toml` (no coverage gate on MAIN for this package).

Exports from `src/index.ts` (lines 8-10, 12-26): `createMcpApp`, `McpAppConfig<Services>`, `defineTool`, `definePrompt`, `defineResource`, `defineView`, `ToolError`, types `ToolContext`, `View`, and `readMcpEnvironment`.

```ts
// packages/mcp-base/src/index.ts:12-24
export type McpAppConfig<Services> = {
  name: string; version: string; auth: IdVerifierConfig; services: Services
  tools: readonly Tool<Services>[]; prompts?: readonly Prompt<Services>[]; resources?: readonly Resource<Services>[]
  allowedHosts?: string[]   // Host header allow-list. Default: resource URL hostname
  allowedOrigins?: string[] // browser Origin allow-list. Default: resource URL hostname
}
export function createMcpApp<Services>(config): { fetch(request: Request): Promise<Response> }
```

Definitions (`packages/mcp-base/src/definitions.ts`) are **closures carrying a `register(server, context)` method** (Tool line 40-45; Prompt 104-108; Resource 17):

```ts
export type ToolContext<Services = unknown> = Readonly<{ principal: UserPrincipal; services: Services; signal: AbortSignal }>  // :19-23
export type View = Readonly<{ name: string; uri: string; html: string }>  // :25 ; uri = `ui://${name}/index.html`
export class ToolError extends Error { constructor(readonly code: string, message: string) }  // :33-38
defineTool({ name, title?, description, input: ZodObject, output: ZodObject, scopes, view?, annotations?: {readOnlyHint?,destructiveHint?,idempotentHint?,openWorldHint?},
             execute(input: z.output<Input>, context: ToolContext<Services>): Promise<{ data: z.input<Output>; text: string }> })  // :47-61
definePrompt({ name, description, input: ZodObject, scopes, execute(input, context): Promise<GetPromptResult> })  // :125-131
defineResource({ name, uri, description, mimeType, scopes, read(context): Promise<string> })  // :146-153 ; ui:// rejected (:156)
```

- Name rules: tool/prompt/resource `^[a-z][a-z0-9_]*$` (:62, :111), view `^[a-z][a-z0-9-]*$` (:28). Every definition MUST declare >= 1 non-empty, whitespace-free scope (:63-65, :112) — there is no "public" definition.
- Tool registration uses `registerAppTool` from `@modelcontextprotocol/ext-apps/server` (:74-99) with `inputSchema`, `outputSchema`, `annotations`, `_meta: { ui: { resourceUri } }` when a view exists (:80). Handler: `signal.throwIfAborted()`, re-parses input with the author's zod schema (:85), `execute`, parses `result.data` with the output schema (:87), returns `{ structuredContent: data, content: [{ type: "text", text: result.text }] }` (:88). Errors: `ToolError` -> `{ isError: true, content: [{type:"text", text: "<code>: <message>"}], _meta: { code } }`; anything else -> `console.error("[mcp] tool <name> failed", error)` and code `tool_failed`, message "The tool could not complete" (:89-97). Output-schema violations are treated as failures (secret never leaks; tested in index.test.ts:137-141).
- Prompt/resource failures -> `console.error("[mcp] <kind> <name> failed")` + `ProtocolError(INTERNAL_ERROR, "Content could not be read")` (:115-122).
- Abort: `callContext` combines the SDK per-request signal with the HTTP request signal via `AbortSignal.any` (:9-11).

### 2.2 WORKTREE (FUTURE): `@answerable/mcp` (`packages/mcp`)

`package.json`: name `@answerable/mcp`; same exports (`.`, `./build`, `./testing`); deps drop `@modelcontextprotocol/core` (kept: client 2.1.0, ext-apps 2.0.0, server 2.1.0, zod 4.6.5, @answerable/auth); `jose` no longer a devDependency. `bunfig.toml` gates 100 % lines + functions (`coverageThreshold = { lines = 1, functions = 1 }`), ignores `src/**/*.test.ts` and `../auth/**`.

`src/index.ts` (5 lines) exports: `createMcpServer`, `McpServerConfig`, `defineTool`, `definePrompt`, `defineResource`, `defineView`, `ToolError`, types `Tool`, `Prompt`, `Resource`, `View`, `ToolContext`, `ToolAnnotations`, re-exports `UserPrincipal`, `IdVerifierConfig` from `@answerable/auth`, and `readMcpEnvironment`.

Definitions are now **plain frozen data** (`packages/mcp/src/definitions.ts`), no `register` method and no `Services` generic:

```ts
export type ToolContext = Readonly<{ principal: UserPrincipal; signal: AbortSignal }>                           // :5
export type ToolAnnotations = Readonly<{ readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }> // :6
export type View = Readonly<{ name: string; uri: string; html: string }>                                       // :7
export type Tool<Input extends z.ZodObject = z.ZodObject, Output extends z.ZodObject = z.ZodObject> = Readonly<{
  name: string; title?: string; description: string; input: Input; output: Output; scopes: readonly string[]
  annotations?: ToolAnnotations; view?: View
  execute(input: z.output<Input>, context: ToolContext): Promise<z.input<Output>>                              // :8-18  (returns the OUTPUT directly, no {data,text})
}>
export type Prompt<Input extends z.ZodObject = z.ZodObject> = Readonly<{ name; description; input: Input; scopes; execute(input, context): Promise<GetPromptResult> }> // :19-25
export type Resource = Readonly<{ name; uri; description; mimeType; scopes; read(context: ToolContext): Promise<string> }>  // :26-33
export function defineView(input: { name: string; html: string }): View                                        // :35-39
export class ToolError extends Error { constructor(readonly code: string, message: string) }                   // :41-46
export function defineTool<Input, Output>(tool: Tool<Input, Output>): Tool<Input, Output>                      // :53-56  validate + Object.freeze({...tool, scopes: frozen copy})
export function definePrompt<Input>(prompt: Prompt<Input>): Prompt<Input>                                      // :59-62
export function defineResource(resource: Resource): Resource                                                   // :65-70  (rejects ui:// -> "Use defineView for ui:// resources")
```

Error messages changed to `Invalid tool name: <name>` / `Tool <name> must declare scopes` (:48-51). Because a definition is just data, wrappers compose by spreading: the documented pattern (definitions.test.ts:46-55) is

```ts
function audited(tool: Tool, log: (line: string) => void): Tool {
  return defineTool({ ...tool, async execute(input, context) { log(`${context.principal.userId} ${tool.name}`); return tool.execute(input, context) } })
}
```

Dependencies ("services") come from closures (README line 21: "Dependencies come from closures; wrap or combine definitions with ordinary code").

Server (`packages/mcp/src/server.ts`):

```ts
// :9-20
export type McpServerConfig = { name: string; version: string; auth: IdVerifierConfig; tools: readonly Tool[]; prompts?: readonly Prompt[]; resources?: readonly Resource[]; allowedHosts?: string[]; allowedOrigins?: string[] }
export function createMcpServer(config: McpServerConfig): { fetch(request: Request): Promise<Response> }  // :22
```

Registration moved into the server: `registerAppTool(server, tool.name, { title, description, inputSchema: tool.input, outputSchema: tool.output, annotations, _meta: view ? { ui: { resourceUri } } : {} }, handler)` (:75-78). The handler receives the SDK-parsed `input` (the SDK runs the zod parse once; transforms run once — tested server.test.ts:219-244), then `tool.output.parse(await tool.execute(input, call))` (:82) and returns `{ structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] }` (:83) — **the text representation is now always the JSON of the minimised structured output**, authors no longer supply a `text`. Undeclared output fields are stripped by zod (server.test.ts:226-229, `passwordHash` never leaves). Errors identical to MAIN (:84-89). Prompts via `server.registerPrompt(name, { description, argsSchema: prompt.input }, ...)` (:94); resources via `server.registerResource(name, uri, { description, mimeType }, ...)` (:104); views via `registerAppResource(server, view.name, view.uri, {}, ...)` with `RESOURCE_MIME_TYPE` (`text/html;profile=mcp-app`) (:113-117).

Route order change: `/health` is answered BEFORE the Host check (server.ts:122-125; tested "health accepts internal hosts while the MCP endpoint rejects them", server.test.ts:245-253) so load balancers with internal Host headers can probe it. On MAIN the Host check ran first (mcp-base/src/index.ts:92-95).

### 2.3 Behaviour common to MAIN and WORKTREE (line numbers = WORKTREE `server.ts` / MAIN `index.ts`)

- **Construction-time checks**: duplicate tool names, prompt names, resource URIs (views included), and two distinct `View` objects sharing a URI throw (`Duplicate <kind>: <value>`, `Conflicting view: <uri>`) — server.ts:23-39 / index.ts:27-43.
- **Auth gate**: `requireBearerAuth({ resourceMetadataUrl, verifier: { verifyAccessToken } })` from `@modelcontextprotocol/server` (server.ts:54-66 / index.ts:58-70). `verifyAccessToken` calls `createIdVerifier(config.auth)` and returns SDK `AuthInfo` `{ token, clientId, scopes: [...principal.scopes], expiresAt, resource: resourceUrl, extra: { principal } }`; any failure -> `new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token")` -> the SDK emits a 401 with `WWW-Authenticate: Bearer ... resource_metadata="<metadata URL>"`. `requireBearerAuth` is called with NO `requiredScopes` — scope enforcement is entirely Answerable's own per-request filter.
- **Protected-resource metadata**: URL from the SDK's `getOAuthProtectedResourceMetadataUrl(resourceUrl)` (RFC 9728 path-suffix form: `/.well-known/oauth-protected-resource<resource path>`; tested for `/`, `/nested/tools`, `/mcp/`). Served by Answerable's own code (server.ts:126-129) as `{ resource, authorization_servers: [issuer], scopes_supported: <sorted union of all definition scopes>, bearer_methods_supported: ["header"], resource_name: config.name }`. The SDK's `mcpAuthMetadataRouter` is NOT used (it is Express-based).
- **Host / Origin**: `hostHeaderValidationResponse(request, allowedHosts)` and `originValidationResponse(request, allowedOrigins)` from the SDK (403s). Defaults = resource hostname only. Origin check runs only on the MCP endpoint, before the bearer gate (server.ts:131 / index.ts:101).
- **Routing**: only `GET /health`, `GET <metadata path>` and `<resource path>` (any method) exist; everything else 404. All MCP responses get `Cache-Control: no-store`.
- **Per-request server & scope filtering**: `createMcpHandler(({ authInfo, requestInfo }) => McpServer)` builds a **fresh `McpServer` on every HTTP request** (server.ts:67-119 / index.ts:71-89). `permitted = definition.scopes.every(scope => principal.scopes.includes(scope))` (AND semantics over the definition's scopes; server.ts:72). Only permitted tools/prompts/resources are registered; views are registered only if a permitted tool references them (so `resources/list` shows the `ui://` resource only to callers who can call the tool; server.test.ts:157). `capabilities` are computed once from the full definition set (`{ tools: {}, prompts: {}, resources: {} }` present iff any definition of that kind exists) — comment: "Capabilities follow the definitions, not the caller's scopes, so every caller sees the same server" (server.ts:49-53,69-70). No `listChanged`, no `logging`, no `completions` capability is advertised.
- **Context** received by `execute`/`read`: MAIN `{ principal, services, signal }`; WORKTREE `{ principal, signal }` (frozen object, server.ts:71). `signal` = `AbortSignal.any([sdkSignal, requestInfo.signal])`. Nothing else (no session id, no request id, no headers, no logger, no `sendNotification`, no elicitation or sampling handle) reaches the author.
- **Environment** (`environment.ts`, unchanged): `readMcpEnvironment(env)` parses only `MCP_ID_ISSUER` (url), `MCP_RESOURCE_URL` (url), `MCP_PORT` (int 1-65535, default `47500`); runs `createIdVerifier` to validate the URLs and rewrites the error to the variable name.
- **Logging**: `console.error("[mcp] <kind> <name> failed", error)` is the entire logging surface. No structured logger, no request logging, no MCP `logging` capability.
- **Views (MCP Apps)**: `@answerable/mcp/build` `buildView({ entry, title })` spawns `build-worker.ts` in a **separate Bun process** (`Bun.spawn([process.execPath, worker, entry])`, build.ts:3-8) that runs `Bun.build({ target: "browser", minify: true, define NODE_ENV=production })` and prints `[{path,text}]` JSON. `buildView` requires exactly one `.js` output and optional `.css` (build.ts:15-17; WORKTREE adds a test that a separately emitted `.svg` asset is rejected), escapes the title and inlines everything into one HTML document with `<div id="root">` and a `<script type="module">` (build.ts:19). Views are served as a resource with MIME `text/html;profile=mcp-app` and referenced from the tool's `_meta.ui.resourceUri`. Inside the iframe the view uses `@modelcontextprotocol/ext-apps` (`App` / `useApp` React hook) and calls tools through the host with `app.callServerTool({ name, arguments })` — the view never sees the bearer token (host.ts:12 comment; README).

### 2.4 `./testing`

- MAIN `packages/mcp-base/src/testing.ts`: `connectTestClient({ url, accessToken, protocol?: "2025" | "2026-07-28" })` -> official `Client` over `StreamableHTTPClientTransport` with `Authorization: Bearer`; tests boot `Bun.serve` on port 0 and a `Bun.serve` test issuer (index.test.ts:58-69).
- WORKTREE `packages/mcp/src/testing.ts`:

```ts
export type TestMcp = { readonly issuer: TestIssuer; fetch(input, init?): Promise<Response>;
  connect(options?: { scopes?: readonly string[]; organizationId?: string; userId?: string; protocol?: "2025" | "2026-07-28" }): Promise<Client>; close(): Promise<void> }
export async function createTestMcp(create: (auth: IdVerifierConfig) => { fetch(request: Request): Promise<Response> }, options: { resource?: string } = {}): Promise<TestMcp>  // :19-22
```

`createTestMcp` builds an in-process issuer (`createTestIssuer()`, default issuer `https://id.test`), calls `create({ issuer, resource (default https://mcp.test/mcp), fetch: issuer.fetch })`, and gives the official client a custom `fetch` that routes straight into `server.fetch` (setting `Host` from the URL) — **no port, no network** (:27-31, :39-41). `connect()` without `scopes` reads `scopes_supported` from the served metadata (:35). `close()` closes every client, including failed connections (:44).

---

## 3. SDK usage

- Packages (both trees): `@modelcontextprotocol/server 2.1.0`, `@modelcontextprotocol/client 2.1.0`, `@modelcontextprotocol/ext-apps 2.0.0`; MAIN additionally lists `@modelcontextprotocol/core 2.1.0` (dropped in WORKTREE `packages/mcp`; still a dep of `mcps/e2e` on MAIN — check WORKTREE `mcps/e2e/package.json` diff below).
- Server-side SDK functions used: `createMcpHandler`, `McpServer`, `requireBearerAuth`, `OAuthError`, `OAuthErrorCode.InvalidToken`, `hostHeaderValidationResponse`, `originValidationResponse`, `getOAuthProtectedResourceMetadataUrl`, `ProtocolError`, `INTERNAL_ERROR`, type `GetPromptResult`; from ext-apps/server: `registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE`. Client side: `Client`, `StreamableHTTPClientTransport` (+ in the acceptance: `UnauthorizedError`, `OAuthClientProvider`, `OAuthDiscoveryState`). Apps: `App`, `useApp` (`ext-apps/react`), `AppBridge`, `PostMessageTransport` (`ext-apps/app-bridge`).
- Protocol versions: tests pin the client to `2026-07-28` via `versionNegotiation: { mode: { pin: "2026-07-28" } }` or use the default (labelled "default 2025"; the abort test sends `MCP-Protocol-Version: 2025-11-25`). README: `createMcpHandler` "serves both the 2026-07-28 and 2025 protocol versions".
- Sessions: `createMcpHandler` is called with a **factory and no options object** — a new `McpServer` per request; Answerable code never generates or reads `Mcp-Session-Id`, keeps no event store and never resumes streams. (Whether the SDK's default is stateless is confirmed in section 6.)

---

## 4. `mcps/e2e` (reference MCP + real-ID acceptance)

Package `@answerable/mcp-e2e` (`mcps/e2e/package.json`): scripts `test` = `bun test src`, `build` = `bun scripts/build.ts` (writes `dist/records.html`), `dev` = build + `bun --hot src/server.ts`, `start` = `bun src/server.ts`. MAIN deps: `@answerable/auth`, `@answerable/mcp-base`, `@modelcontextprotocol/core 2.1.0`, `ext-apps 2.0.0`, react/react-dom 19.2.4, zod; dev: `@modelcontextprotocol/client 2.1.0`, `@playwright/test 1.63.0`, jose. WORKTREE deps: `@answerable/mcp` (replaces auth+mcp-base+core), ext-apps, react, react-dom, zod. No `bunfig.toml` in either tree (no coverage gate for the e2e workspace). `compose.yaml`: `postgres:16-alpine`, user/password `answerable`, db `answerable_id_test`, bound to `127.0.0.1:47532`, tmpfs data, healthcheck `pg_isready`.

### 4.1 What the server exposes (`mcps/e2e/src/mcp.ts`)

| Kind | Name | Scopes | Input -> output | Annotations | Notes |
| --- | --- | --- | --- | --- | --- |
| tool | `identity_get` | `e2e:identity` | `{}` strict -> `{ userId, organizationId, scopes[] }` | readOnly, not destructive, closed world | echoes `principal` |
| tool | `records_list` | `e2e:read` | `{}` -> `{ records: Record[] }` | readOnly | `records.list(principal)` (first 100) |
| tool | `records_show` | `e2e:read` | `{}` -> `{ records, canWrite }` + view `ui://records/index.html` | readOnly | `canWrite = principal.scopes.includes("e2e:write")` |
| tool | `records_create` | `e2e:write` | `{ title: 1..200 trimmed }` strict -> Record | readOnlyHint false, destructive false | `creatorId = principal.userId` |
| tool | `records_delete` | `e2e:write` | `{ recordId: uuid }` strict -> `{ deleted: true, id }` | destructiveHint true | `ToolError("record_not_found", ...)` when not in caller's org |
| prompt | `fixture_walkthrough` | `e2e:read` | `{}` -> one user message ("Read fixture://guide. List records with records_list ...") | | |
| resource | `fixture_guide` = `fixture://guide` | `e2e:read` | `text/markdown` | | |
| view | `records` -> `ui://records/index.html` | (via `records_show`) | built from `src/views/records.tsx` | | MIME `text/html;profile=mcp-app` |

Contracts (`src/contracts.ts`): `recordSchema { id uuid, organizationId uuid, creatorId uuid, title 1..200, createdAt datetime }` (WORKTREE: `z.iso.datetime()`), `createInput`, `deleteInput`, `recordsOutput`, `recordsViewOutput = recordsOutput + canWrite`. Server name `answerable-e2e`, version `0.1.0`. MAIN: tools are module-level exports using `context.services.records` (`Services = { records: RecordStore }`) and `createE2eMcp({ auth, viewHtml, records, allowedHosts?, allowedOrigins? })` (mcp.ts:68-90). WORKTREE: `identity_get`, prompt and resource stay module-level; the four record tools are created inside `createE2eMcp({ auth, records, viewHtml })` and reach the store by closure (mcp.ts:36-78); `allowedHosts/allowedOrigins` pass-through removed.

### 4.2 Records store (`src/records.ts`)

`createRecordStore()` -> `{ list(principal), create(principal, title), remove(principal, recordId) }` over `Map<organizationId, Map<recordId, FixtureRecord>>` (in memory, lost on restart). `list` = insertion order, `.slice(0, 100)` (oldest first; tested with 105 records). Partition key is ONLY `principal.organizationId`; any member of the organisation can delete any record of that organisation (no per-user ownership check; `creatorId` is recorded but never enforced). `remove` throws `ToolError("record_not_found", "No accessible record exists")` for a foreign or missing id (same message for both, so existence is not leaked).

### 4.3 Entry point, view, host bridge

- `src/server.ts`: `readMcpEnvironment(process.env)`, requires `dist/records.html` (error "Missing records view. Run bun run --filter @answerable/mcp-e2e build first."), `Bun.serve({ hostname: "127.0.0.1", port, fetch })`, SIGINT/SIGTERM -> `server.stop()`. Loopback only.
- `src/views/records.tsx`: React 19 + `useApp` from `@modelcontextprotocol/ext-apps/react`; `app.ontoolresult` parses `recordsViewOutput.safeParse(result.structuredContent)` (sets records + canWrite); actions call `app.callServerTool({ name: "records_create" | "records_delete", arguments })` then re-fetch with `records_list`; the create form and delete buttons render only when `canWrite`. The view never holds a token; the host performs the tool calls.
- `src/testing/host.ts` (test-only host): `new AppBridge(null, { name: "Answerable test host" }, { serverTools: {} })`, `bridge.oncalltool = params => window.callTool(params)` (a Playwright-exposed function that runs the real MCP client in the test process), `bridge.onsizechange` resizes the iframe (max 1200 px), `oninitialized` -> `sendToolInput({ arguments: {} })` + `sendToolResult(initial.result)`; `bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow))`, then `iframe.srcdoc = initial.html`. The iframe is `sandbox="allow-scripts"`.
- `src/apps.test.ts`: builds the real view (`buildView`) and the host bundle (`bundleBrowser`), serves the host page from `Bun.serve` port 0, launches headless Chromium (10 s launch timeout, 5 s default page timeout, 30 s test timeout); for `write = true` (scopes `e2e:read e2e:write`) it creates "Browser record" through the UI, checks `records_list` from the client, deletes through the UI; for `write = false` it asserts the form/button are absent; asserts zero `pageerror`s. MAIN boots the MCP on `Bun.serve` + a port-bound test issuer; WORKTREE uses `createTestMcp(auth => createE2eMcp(...))` and `mcp.connect({ organizationId, scopes })` (only the host page still binds a port).
- `src/records.test.ts`: organisation partition + 100-cap ordering.
- WORKTREE `src/mcp.test.ts` (58 lines): for `2025` and `2026-07-28`: an entitled client (default scopes = advertised `e2e:identity e2e:read e2e:write`) lists exactly `["identity_get","records_list","records_show","records_create","records_delete"]`, `identity_get` returns `{ userId, organizationId, scopes }` and `content` == `[{type:"text", text: JSON.stringify(structuredContent)}]`; records round-trip (create trims title, list, show with `canWrite: true`, delete, second delete -> `record_not_found`), prompt contains `fixture://guide`, resource contains "Records belong to your authenticated organisation"; a read-only client (`e2e:identity e2e:read`) lists three tools, sees `canWrite: false`, `records_create` rejects (unknown tool -> protocol error); a second organisation sees an empty list and cannot delete the first organisation's record.

### 4.4 ID fixture (`apps/id/scripts/mcp-e2e-fixture.ts`, identical in both trees)

Guarded by `--isolated-mcp-fixture`. Constants: DB `postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test`; `idOrigin = http://127.0.0.1:47600`; `resource = http://127.0.0.1:47602/mcp`; `callback = http://127.0.0.1:47603/callback`; `clientId = mcp-e2e-browser`; `scopes = ["e2e:identity","e2e:read","e2e:write"]`; `rootSecret` = two random UUIDs. Steps:

1. Start three in-process OIDC upstream issuers (`startOidcIssuer()` from `src/__tests__/oidc-issuer.ts`), one per tenant.
2. `testEnvironment({ databaseUrl, betterAuthUrl: idOrigin, port: 47600, adminResourceIdentifier: idOrigin + "/api/admin", trustedOrigins: [callback, ...upstream origins], databasePoolMax: 4, rootAdminSecret })`.
3. `createDatabase` (setup role) -> `runMigrations` -> `bootstrap(db, systemActor("mcp-e2e"), { platformOrganizationSlug: "answerable", platformOrganizationName: "Answerable", adminResourceIdentifier })`.
4. `configureRuntimeRole(db, "mcp_e2e_runtime")`, random password, second `createDatabase` on that restricted role; `createAuth(runtime.db, env)`, `createApp({ auth, db, environment })`, `Bun.serve` on 47600.
5. Admin API provisioning (all `Authorization: Bearer <rootSecret>` + fresh `Idempotency-Key`): `POST /api/admin/v1/resources { classification: "platform_shared", organizationId: null, identifier: resource, name: "E2E MCP", allowedScopes: [...scopes, "offline_access"], accessTokenTtl: 60 }`; `POST /clients { clientId, name: "MCP acceptance", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code","refresh_token"], redirectUris: [callback], scopes: ["openid","offline_access",...scopes] }`; `PUT /clients/{clientId}/resources/{encoded resource}` (link).
6. For each tenant `mcp-alpha`, `mcp-beta`, `mcp-gamma`: `POST /organizations { slug, name }`; `POST /organizations/{id}/domains { domain: "<slug>.example.test" }`; `PUT /organizations/{id}/sso-provider` (OIDC, `credentials: "own"`, clientId = slug, secret `local-fixture-only`, endpoints of that tenant's local upstream; header `If-None-Match: *`); for `grantKind` in `authorization_code`, `refresh_token`: `POST /organizations/{id}/capabilities { clientId, resource: null, grantKind, scopes: ["openid","offline_access"] }` and `{ clientId, resource, grantKind, scopes }`; `POST /organizations/{id}/entitlements { clientId, scopes: ["openid","offline_access"] }` and `{ clientId, resource, scopes: entitled }` where **`mcp-gamma` is entitled to `["e2e:identity","e2e:read"]` only**; enqueue three upstream identities (`sub: "<slug>-tester"`, `email: tester@<domain>`, verified) — one per sign-in the acceptance performs.
7. Write manifest `{ idOrigin, resource, callback, clientId, scopes, rootSecret, tenants: [{ slug, email, organizationId, scopes }] }`; log "Isolated ID fixture ready"; SIGINT/SIGTERM close everything.

### 4.5 Acceptance (`mcps/e2e/scripts/acceptance.ts`, identical in both trees)

Ports: Postgres 47532, ID 47600, e2e MCP 47602, OAuth callback 47603, second MCP 47605. Sequence:

1. `docker compose -p answerable-mcp-e2e -f mcps/e2e/compose.yaml up -d --wait`; spawn the ID fixture (`bun scripts/mcp-e2e-fixture.ts <tmp>/manifest.json --isolated-mcp-fixture`, cwd `apps/id`); poll for the manifest every 200 ms, deadline 90 s.
2. Serve the e2e MCP on 47602 (`createE2eMcp({ auth: { issuer: idOrigin, resource }, viewHtml: "<!doctype html><title>Records</title>", records })`), a second e2e MCP on 47605 with resource `http://127.0.0.1:47605/mcp` sharing the same record store, and a callback page on 47603 ("Signed in. You can close this page."). Launch headless Chromium with `handleSIGINT/SIGTERM/SIGHUP: false` (Playwright's handlers would exit before cleanup).
3. Per tenant, `signIn()`: an in-memory `OAuthClientProvider` (pre-registered `client_id`, `redirect_uris: [callback]`, `token_endpoint_auth_method: "none"`, PKCE verifier + discovery state stored in memory); `new Client(...).connect(new StreamableHTTPClientTransport(resource, { authProvider }))` must reject with `UnauthorizedError`; the captured authorise URL must have ID's origin, `client_id`, `resource` == MCP URL (RFC 8707), `code_challenge_method=S256`, and `scope` == metadata `scopes_supported` + `offline_access`. Playwright then drives ID's pages: fill `email`, click "Continue", wait for heading "Choose an organisation" -> "Continue", heading "Access it will receive" -> the `section ul` must list each entitled scope and "Stay connected after you leave"; for a partially entitled tenant the text `Not approved for <slug>:` must name each withheld scope (and the list must not); click "Accept"; wait for `<callback>?**`; assert `iss` == idOrigin (RFC 9207); `transport.finishAuth(callbackParams)`.
4. Token assertions: access + refresh token present; token-response `scope` and JWT `scope` == entitled scopes + `offline_access`; `aud` == resource; `exp - iat == 60`.
5. For `2025` and `2026-07-28` clients: `listTools` == all five (full) or `["identity_get","records_list","records_show"]` (partial); `identity_get` returns the selected `organizationId`, `userId == sub`, scopes; `readResource fixture://guide` and `getPrompt fixture_walkthrough` work.
6. Tenant isolation (2026-07-28 client): partial tenant -> empty list and `records_create` rejects; full tenant -> creates `<slug> record`, lists only its own id, `records_delete` of every earlier tenant's record returns `isError` with `record_not_found`.
7. The access token against the second MCP (47605): `401` with `www-authenticate` containing `resource_metadata=`.
8. Refresh: overwrite `access_token` with "expired", reconnect (2025) -> `identity_get` works; refresh token rotated; scope subset preserved in both the token response and the JWT.
9. `POST {idOrigin}/api/admin/v1/organizations/{id}/disable` (root bearer + Idempotency-Key) -> 200; a manual `refresh_token` grant at the discovered `token_endpoint` -> `400 invalid_grant`; the still-valid access token continues to work ("the MCP verifies offline").
10. `PASS`; cleanup closes clients/contexts/servers in reverse, SIGTERMs the fixture (SIGKILL after 5 s), `compose down --volumes`, removes the temp dir; SIGINT exits 130, SIGTERM 143.

Scenarios covered: **full entitlement** (mcp-alpha, mcp-beta) and **partial entitlement** (mcp-gamma, no `e2e:write`). NOT covered: an organisation with no entitlement at all (ID's "Access is unavailable for this organisation" page is only described in `claude-code.mdx`), a wrong/absent capability, machine principals (the verifier rejects `subject_type != "user"`), a real external host (Claude Code was tried by hand only, see section 7), an expired-token refusal at the MCP (only "expired" string triggers client-side refresh), Host/Origin rejection against real ID (unit-tested only), concurrency/load. Timing: docs say "about ten seconds"; evidence records 8-13 s per run.

---

## 5. Test approach

- **Coverage gates**: WORKTREE adds `packages/auth/bunfig.toml` and `packages/mcp/bunfig.toml` with `coverageThreshold = { lines = 1, functions = 1 }` (100 %), `coverageSkipTestFiles`, lcov + text output; `packages/mcp` also ignores `../auth/**`. MAIN has no bunfig for either package (only `apps/id/bunfig.toml` enforces 100 %). `mcps/e2e` has no gate in either tree.
- **Runner**: MAIN root `mcp:test` = `bun test packages/auth/src packages/mcp-base/src mcps/e2e/src` (one Bun process, bunfig gates would not apply); WORKTREE `mcp:test` = `bun run --filter @answerable/auth --filter @answerable/mcp --filter @answerable/mcp-e2e test` (each package's own `bun test`, so the gates apply). `turbo.json`: `@answerable/mcp#test` (was `mcp-base`) and `@answerable/mcp-e2e#test` are `cache: false`, `dependsOn: ["^build"]`; `@answerable/auth#test` `cache: false`. `mcp:test:e2e` = `bun mcps/e2e/scripts/acceptance.ts`; `mcp:dev` = `bun --env-file=.env run --filter @answerable/mcp-e2e dev` (env `MCP_ID_ISSUER`, `MCP_RESOURCE_URL`, `MCP_PORT` declared on the `@answerable/mcp-e2e#dev` turbo task).
- **In-process transports (WORKTREE)**: the verifier takes `fetch` (jose `customFetch`), the test issuer is a `fetch` function (issuer `https://id.test`), and `createTestMcp` hands the official `StreamableHTTPClientTransport` a `fetch` that calls `server.fetch(request)` directly and sets `Host` from the URL. Result: auth, mcp and e2e unit suites bind no port (motivated by Codex's `workspace-write` sandbox, evidence report). Ports remain for `apps.test.ts` (host page + Chromium) and the acceptance.
- **Reference tests**: `mcps/e2e/src/mcp.test.ts` (section 4.3) is the template the README tells authors to copy. `packages/mcp/src/server.test.ts` covers: 401 challenge with `resource_metadata`, `Cache-Control: no-store`, `/health`, 404, metadata document; Host 403, Origin 403 (tool not executed), foreign-audience 401; per protocol era: scope filtering of tools and the view resource, `title` and `_meta.ui.resourceUri` in `tools/list`, concurrent clients keep separate organisations, invalid input never executes, `tool_failed`/`ToolError` shapes and redaction of messages (`private-*` never leaves), prompt/resource failure redaction ("Content could not be read"), scope-filtered prompts/resources; duplicate/conflict construction errors; metadata path variants; request abort propagates to `context.signal`; input transforms run once and output is minimised in both representations (2025 and 2026-07-28); `/health` accepts internal hosts while the endpoint rejects them. `definitions.test.ts` checks frozen data, direct `execute` calls without a server, and the `audited(tool, log)` wrapper (`defineTool({ ...tool, async execute(input, context) { log(...); return tool.execute(input, context) } })`) applied to tools of different shapes with a frozen `ToolContext`. `testing.test.ts` checks default scopes, `Host` handling and `close()` of failed clients. Evidence counts: auth 37, mcp 27, e2e 7 tests (71 total, up from 56 on MAIN).

---

## 6. Installed MCP SDK inventory (Bun isolated store)

Store: `node_modules/.bun/@modelcontextprotocol+<pkg>@<ver>/node_modules/@modelcontextprotocol/<pkg>`; workspaces symlink into it. MAIN links: `packages/mcp-base` -> client 2.1.0, core 2.1.0, ext-apps 2.0.0 (`+c70038da57791820`), server 2.1.0, **plus a stale `hono` -> `@modelcontextprotocol+hono@2.0.0+2cfc5f13f5b30400`** (symlink dated 16 Sep, not in any `package.json`; that hono copy itself links `server@2.0.0`); `mcps/e2e` -> client 2.1.0, core 2.1.0, ext-apps 2.0.0 (`+c959676530ae0f36`). MAIN's store also still holds `server@2.0.0`, `core@2.0.0`, `client@2.0.0` and five ext-apps peer-hash variants (orphans from earlier installs; `bun.lock` resolves only 2.1.0). `@modelcontextprotocol/sdk@1.30.0` (the v1 SDK) is present because `shadcn@4.19.0` depends on `^1.26.0` — nothing in the MCP foundation imports it. WORKTREE store: client/core/server 2.1.0, ext-apps 2.0.0 (two hashes), sdk 1.30.0 only. `server@2.1.0` depends on `core 2.1.0` and `zod ^4.2.0`; NOT installed: `@modelcontextprotocol/express`, `@modelcontextprotocol/node`.

Type files inspected: `server/dist/index.d.mts` (773 lines, auth + transport + handler surface), `server/dist/createMcpHandler-Bt6U_Fqb.d.mts` (4,145 lines, `Server`, `McpServer`, handler options, wire types), `core/dist/auth-YUQV3RRv.d.mts` (8,505 lines, zod schemas), `client/dist/index.d.mts`, `ext-apps/dist/src/server/index.d.ts`, `ext-apps/dist/src/spec.types.d.ts`.

### 6.1 Protocol versions and eras

- Core runtime (`core/dist/auth-CGP0BDVq.mjs:4-10`): `LATEST_PROTOCOL_VERSION = "2025-11-25"`, `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26"`, `SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]` — this is the **legacy `initialize` list**.
- Server internal (`server/dist/src-D-y6h4N7.mjs:567`, `:4182`): `FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28"`, `SUPPORTED_MODERN_PROTOCOL_VERSIONS = [FIRST_MODERN_PROTOCOL_VERSION]`, `MODERN_WIRE_REVISION = "2026-07-28"` — "deliberately NOT a public constant". The modern era is negotiated by `server/discover` and carries a per-request `_meta` envelope (protocol version, client info, client capabilities keys: `PROTOCOL_VERSION_META_KEY`, `CLIENT_INFO_META_KEY`, `CLIENT_CAPABILITIES_META_KEY`); every request is self-describing, so there is no session.
- Client (`client/dist/index.d.mts`): `ClientOptions.versionNegotiation?: { mode?: 'legacy' (default) | 'auto' | { pin: string }; probe? }`. Answerable's tests pin `"2026-07-28"` or leave the default (legacy 2025 handshake).

### 6.2 `createMcpHandler` and sessions (server bundle :3855-4144)

- `createMcpHandler(factory: McpServerFactory, options?: CreateMcpHandlerOptions): McpHttpHandler`; the factory gets `McpRequestContext { era: 'legacy' | 'modern'; authInfo?: AuthInfo; requestInfo?: Request }` and is called **once per HTTP request** ("multi-tenant servers keyed off `authInfo`" is the documented use). Options: `legacy?: 'stateless' | 'reject'` (default stateless: each 2025-era request served by a fresh instance over a transport with `sessionIdGenerator: undefined`; GET/DELETE answered `405`), `onerror?`, `responseMode?: 'auto' | 'sse' | 'json'` (json drops mid-call notifications), `bus?: ServerEventBus`, `maxSubscriptions?` (1024), `keepAliveMs?` (15000), `maxRequestBodySize?` (4 MiB -> 413). Returns `{ fetch(request, { authInfo?, parsedBody? }), close(), notify: ServerNotifier, bus }`. "The entry performs no token verification: `authInfo` given to `fetch` is passed through" and "the entry itself is deliberately validation-free" for Host/Origin.
- Stateful alternative: `WebStandardStreamableHTTPServerTransport` with options `sessionIdGenerator?`, `onsessioninitialized?`, `onsessionclosed?`, `enableJsonResponse?`, `eventStore?: EventStore` (resumability), deprecated `allowedHosts/allowedOrigins/enableDnsRebindingProtection`, `retryInterval?`, `keepAliveMs?`, `maxRequestBodySize?` (index.d.mts:467+). `EventStore`, `EventId`, `StreamId` types exported; `closeSSEStream`/`closeStandaloneSSEStream` only with the Node transport + event store. Also exported: `PerRequestHTTPServerTransport`, `isLegacyRequest`, `legacyStatelessFallback`, `classifyInboundRequest`, `isJsonContentType`, `readRequestBody`, `InMemoryTransport`.
- Answerable uses `createMcpHandler` with default options: stateless per request, no event store, no `Mcp-Session-Id` (0 hits in the server bundle types — sessions are a transport concern of the legacy path only).

### 6.3 Server-side feature inventory (present / absent)

| Feature | Found (identifier, file:line) | Notes |
| --- | --- | --- |
| Tool annotations | core `ToolAnnotationsSchema` (auth-*.d.mts:2322) with `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (:2324-2327); `registerTool` config `annotations?: ToolAnnotations` | Answerable passes them through |
| `_meta` on tools | `registerTool` config `_meta?: Record<string, unknown>`; core Tool schema has `_meta` | used for `ui.resourceUri` |
| `outputSchema` / `structuredContent` | core Tool `outputSchema` (:2349), CallToolResult `structuredContent: unknown` (:2570); `registerTool<OutputArgs extends StandardSchemaWithJSON>` | server validates output against schema |
| `title`, `icons` | `title?` on tools/prompts/resources/`Implementation`; `Icon`/`Icons`/`IconSchema` (core :456: `src`, `mimeType`, `sizes`, `theme`); `registerTool`/`registerResource`/`registerPrompt` accept `icons?: Icon[]`; `getDisplayName()` | Answerable exposes `title` only, no icons |
| Elicitation (form + url) | core `ElicitRequestFormParams`, `ElicitRequestURLParams` (`mode: "url"`, :5068-5084), `ElicitResult`, `ElicitationCompleteNotification`; `Server.elicitInput(params, options)` (bundle :3162) — **2025 era only**; on the 2026-07-28 era push requests throw and handlers must return `inputRequired({ inputRequests: { key: inputRequired.elicit({...}) \| inputRequired.elicitUrl({...}) \| .createMessage \| .listRoots } })`, then read `acceptedContent(ctx.mcpReq.inputResponses, key)` on the retry; `ServerOptions.inputRequired { maxRounds 8, roundTimeoutMs 600000, legacyShim true }`; `ServerOptions.requestState.verify` + `createRequestStateCodec` (HMAC) for integrity of echoed state; `UrlElicitationRequiredError` (-32042) legacy; client `getSupportedElicitationModes` | Answerable's handler wrapper returns only `{structuredContent, content}` and cannot surface `input_required` |
| Tasks | Only wire vocabulary: `TaskRequestMethod = 'tasks/get' \| 'tasks/result' \| 'tasks/list' \| 'tasks/cancel'`, `'notifications/tasks/status'` (bundle :729-730), `Task`, `TaskStatus`, `CreateTaskResult`, `TaskAugmentedRequestParams`, `isTaskAugmentedRequestParams`, `RELATED_TASK_META_KEY`; capabilities schema `tasks.{list,cancel,requests.tools.call}`; core Tool `execution.taskSupport` enum | **"Task methods are 2025-11-25 wire vocabulary with no SDK runtime"** (bundle :724-728); the 2026 codec strips `execution.taskSupport` and `capabilities.tasks`. ABSENT: `createTask`, `TaskStore`, `enableTaskSupport`, any `experimental` task API (0 hits in server types; `experimental` exists only as the capabilities record) |
| `tools/list` pagination | core `PaginatedRequestParams.cursor`, `PaginatedResult.nextCursor` (:1111); client auto-aggregates pages (`ListPaginationExceeded`) | `McpServer` exposes no server-side paging option (no `nextCursor` in server types); all registered tools are returned in one page |
| `notifications/*/list_changed` | `Server.sendToolListChanged/sendPromptListChanged/sendResourceListChanged()` (bundle :3208-3210), `McpServer` same (:3449-3462); on the modern era via `handler.notify.*` publishing `ServerEvent { kind: 'tools_list_changed' \| ... \| 'resource_updated' }` on a `ServerEventBus` to open `subscriptions/listen` streams (`SubscriptionsListenRequest`, `SUBSCRIPTION_ID_META_KEY`, `InMemoryServerEventBus`; multi-process deployments supply their own bus) | Answerable never advertises `listChanged` and never publishes |
| Sampling | `Server.createMessage(params)` 2025 era (:3127-3149) / `inputRequired.createMessage` 2026; `CreateMessageRequestParamsWithTools`, `ToolChoice`, `ModelPreferences` | unused |
| Logging | `sendLoggingMessage(params, sessionId?)` (:3207, :3449), `LoggingLevel`, `SetLevelRequest`, `LOG_LEVEL_META_KEY`; capability `logging` | unused; Answerable logs with `console.error` only |
| Completion | `completable(schema, cb)`, `CompletableSchema`, `CompleteRequest`, `assertCompleteRequestPrompt/ResourceTemplate`; capability `completions` | unused |
| Resource subscriptions / templates | `resources/subscribe`/`unsubscribe` in schema (:750-751), `Server.sendResourceUpdated` (:3208), `ResourceTemplate` + `registerResource(name, ResourceTemplate, ...)`, `ListResourcesCallback`, `CompleteResourceTemplateCallback`; capability `resources.subscribe` | Answerable registers fixed URIs only |
| Cache hints (2026) | `ServerOptions.cacheHints` per cacheable method (`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `server/discover`), `CacheHint { ttlMs, cacheScope }`, per-resource `cacheHint`; default `ttlMs: 0`, `cacheScope: 'private'` | unused (defaults) |
| Server identity stamping | `SERVER_INFO_META_KEY` = `io.modelcontextprotocol/serverInfo` stamped on 2026 results | automatic |
| `instructions` | `ServerOptions.instructions?: string` | Answerable sets none |
| Scope challenge per tool | `registerTool` config `scopeChallenge?: ScopeChallengeHandler` = `(ctx: { request: JSONRPCRequest; authInfo?: AuthInfo }) => ScopeChallenge { scopes: [string, ...]; errorDescription? } \| undefined`; helper `requireScopes(...scopes)` (bundle :2805-2814); `McpServer.resolveScopeChallenge` | unused: Answerable hides tools instead of challenging (`403 insufficient_scope` never emitted) |
| Bearer auth | `requireBearerAuth(options: BearerAuthOptions { verifier: OAuthTokenVerifier; requiredScopes?: string[]; resourceMetadataUrl?: string }): (request: Request) => Promise<AuthInfo \| Response>` (index.d.mts:153); `verifyBearerToken`, `bearerAuthChallengeResponse` (401 `invalid_token` / 403 `insufficient_scope`, both with `WWW-Authenticate: Bearer ... resource_metadata=`); verifier must set `AuthInfo.expiresAt` or the token is rejected; `AuthInfo { token, clientId, scopes, expiresAt?, resource?, resourceMetadataUrl?, extra? }` | used; `requiredScopes` not set |
| Protected-resource metadata | `getOAuthProtectedResourceMetadataUrl(serverUrl: URL): string` (:245; inserts `/.well-known/oauth-protected-resource` ahead of the path); `buildOAuthProtectedResourceMetadata(AuthMetadataOptions { resourceServerUrl, scopesSupported?, resourceName?, serviceDocumentationUrl?, dangerouslyAllowInsecureIssuerUrl?, ... })`; `oauthMetadataResponse(request, options)` (web-standard router for both `/.well-known/oauth-protected-resource[/path]` and `/.well-known/oauth-authorization-server`, with CORS/405/204); `checkResourceAllowed`, `resourceUrlFromServerUrl` | Answerable hand-writes the document (uses only the URL helper); `mcpAuthMetadataRouter` and the Express `requireBearerAuth` live in `@modelcontextprotocol/express` (NOT installed); `ProxyOAuthServerProvider`/`mcpAuthRouter` (authorisation-server side) are absent from `server` |
| Host / Origin | `hostHeaderValidationResponse(req, allowedHostnames)` (:184), `originValidationResponse(req, allowedOriginHostnames)` (:327), `validateHostHeader`, `validateOriginHeader`, `localhostAllowedHostnames()`, `localhostAllowedOrigins()` | used |
| Validators | `fromJsonSchema`, `jsonSchemaValidator` (`./validators/ajv`, `./validators/cf-worker` subpaths), `StandardSchemaWithJSON` (tools accept any Standard Schema with JSON output, not only zod) | zod only in Answerable |

ext-apps 2.0.0: exports `.`, `./app-with-deps`, `./react`, `./react-with-deps`, `./app-bridge`, `./server`, `./schema.json`; peers client/core/server `^2.0.0`, react 17-19, zod `^4.2.0`. `registerAppTool(server: Pick<McpServer,"registerTool">, name, config: McpUiAppToolConfig, cb)` where `_meta` is `{ ui: McpUiToolMeta { resourceUri?: string; visibility?: McpUiToolVisibility[] } } | { [RESOURCE_URI_META_KEY]?: string }`; `registerAppResource(server, name, uri, config: McpUiAppResourceConfig { _meta?: { ui?: McpUiResourceMeta { csp?, permissions?, domain?, prefersBorder? } } }, readCallback)`; `RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"`; `EXTENSION_ID = "io.modelcontextprotocol/ui"`; browser `App.callServerTool`, `App.ontoolresult`; host `AppBridge.oncalltool`, `sendToolInput`, `sendToolResult`, `onsizechange`. Answerable passes `{}` as the resource config (no CSP/permissions/domain).

---

## 7. Docs and evidence: what they promise or record

- `apps/web/content/docs/mcp/index.mdx`: status "Local foundation: implemented and tested"; "External hosts: Claude Code connects with a pre-registered client ... Claude.ai and hosted deployment: Not yet"; the four-step authorisation story (Host/Origin refusal, 401 + `resource_metadata`, verify iss/aud/`at+jwt`/exp/user+org claims, register only scope-covered definitions, answer in 2026-07-28 or 2025); limits: partial entitlements (entitled subset issued), offline revocation ("keep resource token lifetimes short"), pre-registered clients only (dynamic registration / CIMD "Not yet"). WORKTREE renames the package rows (`@answerable/mcp`, `createMcpServer`, `createTestMcp`).
- `authoring.mdx`: the quick start, workspace `package.json`, three env variables, scopes-decide-visibility rule, context fields, `ToolError` contract, prompts/resources rule ("Reading a prompt or resource must not change data"), views, `/health`, error table (`401 invalid_token`, `403` Host/Origin, unknown tool = missing scope, `tool_failed`, own codes, `Invalid MCP configuration`). WORKTREE adds: "Output" (server strips undeclared fields, sends `structuredContent` + same JSON as text, "Claude Code shows the model only the structured content"), "Dependencies" by closure, "Composition" with `audited()`, a "Test" section with the `createTestMcp` option table (`scopes` default = every advertised scope, `organizationId`/`userId` random, `protocol` default = client default or `"2026-07-28"`), and `/health` "whatever the Host header".
- `claude-code.mdx`: `claude mcp add --transport http answerable-e2e http://localhost:47500/mcp --client-id claude-code-local --callback-port 47700`; admin cURL for resource (`accessTokenTtl: 900`), client (`redirectUris: ["http://localhost:47700/callback"]`, `tokenEndpointAuthMethod: none`), link, capabilities (login pair + resource pair for both grant kinds), entitlements; "Lifetime: with 300 seconds Claude Code refreshed before every request; with 900 it did not"; "Every scope: Claude Code asks for every scope the MCP lists"; "A partial entitlement in Claude Code by hand: Not yet tested"; Claude.ai/Desktop connectors (`https://claude.ai/api/mcp/auth_callback`) "Not yet tested"; automatic registration "Not yet"; error table (`Access is unavailable for this organisation`, `invalid_redirect`, `invalid_target`, `invalid_client`, `401` after sign-in).
- `local-testing.mdx`: the ten proofs of the acceptance (matches section 4.5), port table, "about ten seconds", `mcp:test` "No Docker", limits ("does not certify an external host, a real company directory or a production deployment").
- `docs/07-mcp-platform-draft.md`: decisions — official SDK primitives; two settings; scopes decide visibility ("Advertised capabilities follow the definitions, not the caller"); offline verification; views in a separate process; acceptance through the real product; WORKTREE adds "Definitions are data" (no container), "Structured output" (Claude Code 2.1.282 shows only `structuredContent`), "Tests in-process". Not yet: automatic client registration (`Q-MCP-CLIENT-REGISTRATION`: CIMD needs `@better-auth/cimd`/Better Auth 1.7.6, or dynamic registration), machine principals, hosted deployment, Claude.ai against a public URL, the admin MCP.
- `reports/mcp-foundation-evidence.md`: 25 Sep 2026 rebuild — `mcp:test` 56 pass; acceptance ~10 s, three runs; ID suite 2,025 pass; Claude Code 2.1.281 signed in via local ID + Entra, called `identity_get`/created/listed a record "speaking protocol version 2026-07-28 without sessions"; 300 s TTL -> 15 refreshes in 70 s, 900 s -> one refresh for three calls. Scope-subset entry — acceptance 6 runs 10-13 s with three organisations (one timeout at load average 132); ID 2,040 pass; ID suite load-sensitive; three flaky tests in `user-oauth.integration.test.ts` also flaky on `main`. WORKTREE entry (PR #11) — auth 37 / mcp 27 / e2e 7 tests at 100 %; acceptance 9, 8, 9 s; findings: input transforms were parsed twice (fixed: SDK 2.1 passes parsed input), `/health` 403 on internal hosts (fixed), Claude Code 2.1.282 reads only `structuredContent` (three probe runs), output schema already dropped undeclared fields, Codex sandbox cannot bind ports (24 of 35 verifier tests failed there -> in-process issuer), **per-request server cost measured at 0.83 ms per tool call with 5 tools and 1.86 ms with 100 tools (in-process, including token verification, 200 calls) — "No caching is needed"**; source 658 -> 618 lines, tests 56 -> 71. Limits: local test issuers, pre-registered public client, loopback HTTP; no Claude.ai/other host/other directory/production certification.

---

## 8. Gaps and limitations relevant to a multi-tenant "hub"

1. **Per-request registration**: every HTTP request builds a new `McpServer` and re-registers every permitted definition (server.ts:67-119). Measured 0.83-1.86 ms per call for 5-100 tools; cost grows linearly with the catalogue and there is no memoisation keyed by scope set. Views are re-registered per request too.
2. **Authorisation = scope set only**: `permitted` is `definition.scopes ⊆ principal.scopes` (server.ts:72). No per-user, per-record, per-organisation-plan, time-bound or attribute policy; no deny rules; nothing consults `membershipId`/`grantId`/`clientId`; a tool cannot declare "any of" scopes. The SDK's per-tool `scopeChallenge`/`requireScopes` (403 `insufficient_scope`) is not used — hidden tools are the only signal, and `capabilities` are static.
3. **No tenant pinning in the verifier**: `createIdVerifier` has no expected-organisation parameter; the MCP relies on every handler filtering by `principal.organizationId`. `UserPrincipal` carries no organisation slug/name, no roles/groups, no email, no `sid`/`jti`, no `iat`. `cnf` is rejected (no DPoP/mTLS binding); machine principals (`subject_type != "user"`) are rejected outright.
4. **Offline verification only**: no introspection, no revocation list, no JWKS pre-warm; discovery is lazy on first request (5 s timeout) and JWKS misses are handled by jose; a disabled organisation keeps working until `exp` (60-900 s in practice).
5. **No idempotency / operation keys**: tools receive raw input and a principal; nothing de-duplicates retries (the 2026 era client may retry; `idempotentHint` is advisory only). No request id, correlation id or trace id reaches `execute` (SDK `TRACEPARENT_META_KEY`/`BAGGAGE_META_KEY` exist but are not surfaced).
6. **No audit or observability hooks**: the only sink is `console.error("[mcp] <kind> <name> failed")` on failures; successes are silent. No `onerror` handler is passed to `createMcpHandler`; the SDK `logging` capability is not advertised. The documented pattern is a hand-written `audited()` wrapper per tool (WORKTREE), i.e. audit is opt-in per definition, not a server-level interceptor.
7. **No elicitation, sampling, tasks, completion, subscriptions, list_changed, cache hints, `instructions`, icons**: the handler wrapper fixes the return shape to `{ structuredContent, content }` or `isError`, so a tool cannot return `input_required` (2026) nor call `elicitInput`/`createMessage` (2025). Long-running work has no task runtime in the SDK at all (wire types only). `ToolContext` exposes only `principal` and `signal`.
8. **Static catalogue**: tools/prompts/resources are fixed at construction (`unique()` checks); no dynamic or per-tenant catalogue, no resource templates, no pagination. Views are a single self-contained HTML string per tool, no CSP/permissions/domain metadata, no shared assets.
9. **No upstream credential store or token exchange**: nothing stores per-user third-party credentials, refresh tokens or performs RFC 8693 exchange (listed in `docs/02-plan.md` line 68 as future work; `IdJagTokenExchangeResponse` type exists in the SDK but is unused). Principal carries only ID's token claims.
10. **Deployment assumptions**: loopback-only `Bun.serve` in `server.ts`; Host allow-list defaults to the resource hostname only (proxies must preserve `Host`); HTTPS enforced except loopback; one resource URL = one audience = one server; no multi-resource/multi-audience routing; no `Mcp-Session-Id`, event store or resumability; SSE keep-alive/response mode left at SDK defaults; no rate limiting or body-size tuning (SDK default 4 MiB).
11. **Testing gaps**: no acceptance for a fully denied organisation, for external hosts other than manual Claude Code, for concurrency/load, or for Host/Origin against real ID; `mcps/e2e` has no coverage gate; MAIN's `mcp:test` runs everything in one Bun process without coverage.
12. **Client registration**: hosts need a pre-registered public client (`token_endpoint_auth_method: none` + PKCE); no dynamic registration or CIMD (`Q-MCP-CLIENT-REGISTRATION`), so onboarding a new host is an admin-API operation per client.
