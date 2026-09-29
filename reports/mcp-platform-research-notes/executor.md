# Executor (UsefulSoftwareCo) — research findings

Date: 2026-09-28. Source snapshot: `git clone --depth 1 https://github.com/UsefulSoftwareCo/executor`, HEAD `a0b0d915ef721efa0a4dc82df3081bebc9004d6f` (2026-09-24, "Test organization settings MFA and ordinary access (#2120)"), kept at `scratchpad/research/src/executor`. Docs scraped to `scratchpad/research/pages/`. File paths below are relative to the clone unless stated. Each item is marked VERIFIED (file/URL) or INFERRED.

---

## Summary

Executor is a TypeScript monorepo (Bun + Turborepo, Effect 4 beta) that ships one integration layer in six packagings: an in-process SDK, a CLI daemon, an Electron desktop app, a Docker self-host server, a Cloudflare Worker self-host, and a YC-backed SaaS ("Executor Cloud"). Its marketing line today is "Executor is an MCP gateway." It ingests OpenAPI specs, GraphQL endpoints and upstream MCP servers into one catalogue of tools addressed `tools.<integration>.<owner>.<connection>.<tool>`, holds credentials out of the agent's reach, gates every call with allow / require-approval / block policies, and exposes the catalogue to any MCP client through one streamable-HTTP endpoint.

The important correction to the public narrative: the vision document describes `search + describe + execute + run_code` meta-tools, scope stacks, a Run/audit model, workflows and skills. The shipped code exposes **one code-mode tool called `execute`** (the model writes TypeScript that calls `tools.search()`, `tools.describe.tool()` and `tools.<path>()` inside a QuickJS or Cloudflare Dynamic Worker sandbox), plus `skills` and `resume`, with an optional **passthrough mode** (`integrations` / `search` / `invoke`) for clients that want plain tools. There is no `run_code`, no durable run log, no scope stack (only `org | user`), and policies are a global glob list the author plans to replace. Tool search is a hand-written lexical scorer over the whole catalogue, not embeddings.

It is MIT-licensed, very actively developed (224 commits in 30 days, 127 releases) and effectively single-maintainer (Rhys Sullivan, 2,660 of ~2,930 commits). A 2.0.0-beta line is in flight, and the repo's own plans call the current plugin system "a fiction" to be removed. For a Bun/TypeScript shop the reusable parts are the small kernel packages (`@executor-js/codemode-core`, `@executor-js/runtime-quickjs`), the execution engine's pause/resume design, the OpenAPI/GraphQL extraction code, and several data-model decisions; the 34k-line `@executor-js/sdk` core and its FumaDB storage layer are not something to embed.

---

## Verified facts

### Identity, licence, maturity
- GitHub `UsefulSoftwareCo/executor`: 3,991 stars, 335 forks, 165 open issues+PRs (75 issues, 90 PRs via search API), 6 watchers, language TypeScript, licence MIT, created 2026-02-07, first commit 2026-02-06T01:40Z, pushed 2026-09-28T07:47Z, not archived. VERIFIED (`gh api repos/UsefulSoftwareCo/executor`, `gh api search/issues`).
- Org `UsefulSoftwareCo` created 2026-05-10, 15 public repos, no description. The docs and Docker image still point at `github.com/RhysSullivan/executor` and `ghcr.io/rhyssullivan/executor-selfhost`. VERIFIED (`gh api orgs/UsefulSoftwareCo`; https://executor.sh/docs/hosted/docker).
- LICENSE: MIT, "Copyright (c) 2026 Rhys Sullivan". All published `@executor-js/*` packages declare MIT; `@executor-js/host-mcp` (the MCP tool server) is `private: true` and unpublished. VERIFIED (LICENSE; `packages/*/package.json`).
- Contributors: RhysSullivan 2,660; github-actions[bot] 60; aryasaatvik 47; GeiserX 17; mrzmyr 14; baggiiiie 13; long tail ≤8. ~2,933 commits on main. VERIFIED (`gh api .../contributors`, commit pagination).
- Cadence: 224 commits in the 30 days to 2026-09-28; weekly counts for the last 8 weeks [28, 7, 88, 152, 16, 10, 73, 7]. 127 GitHub releases. Latest stable `v1.6.10` (2026-09-18); prerelease `executor@2.0.0-beta.4` (2026-09-27). VERIFIED (`gh api .../commits`, `.../stats/participation`, `.../releases`).
- npm: `executor` 1.6.10 (latest), `beta` 2.0.0-beta.4, with per-platform binary dist-tags (`darwin-arm64`, `linux-x64-musl`, `windows-x64`, ...) so the CLI ships as compiled binaries; `@executor-js/sdk`, `execution`, `codemode-core`, `runtime-quickjs`, `plugin-openapi|mcp|graphql|keychain|onepassword|file-secrets`, `config`, `fumadb` 1.5.8, `emulate` 0.14.2, `mcporter` 0.11.4 all published. VERIFIED (`npm view`, `npm search`).
- Who: Rhys Sullivan (founder; `rhys@executor.sh`, @RhysSullivan); home page badges "Open source ★ 4k" and "Backed by Y Combinator"; headline "Executor is an MCP gateway." VERIFIED (firecrawl scrape of https://executor.sh, 2026-09-28).
- Size: 1,126 non-test TS/TSX source files; 686 test files; 84 e2e scenario files; `packages/core/sdk/src` is 33,846 non-test lines, `executor.ts` alone 7,336 lines. VERIFIED (`find | wc`).
- Sample of open issues (2026-09-19..28): Gmail base64url via `atob` failing, Miro MCP OAuth `jwt_alg` failure, MCP `tools/call` stuck at the SDK's 60 s timeout, cloud "WorkOS Vault secret write failed", self-host MCP OAuth failing when clients omit `resource`, Cloudflare bot challenges misread as rejected credentials, D1 32 MiB batch cap, stale catalogue syncs retried without backoff. VERIFIED (`gh issue list`).

### Product shape and stack
- Root `package.json`: `executor-workspace` 1.4.0-beta.0, "Local AI executor with a CLI, local API server, and web UI."; `packageManager: bun@1.3.11`; catalog pins `effect 4.0.0-beta.59`, `drizzle-orm ^0.45`, `@libsql/client`, `quickjs-emscripten ^0.31` + `@jitl/quickjs-wasmfile-release-sync`, `@tanstack/react-start`, `vite 8`, `tailwindcss 4`, `@effect/opentelemetry`. Patched deps: `@1password/sdk-core`, `postgres`, `@cloudflare/vite-plugin`, `agents@0.17.3`, `libsql`, `@electric-sql/pglite-socket`, `@modelcontextprotocol/client@2.0.0`. VERIFIED (package.json).
- Apps: `cli` (npm `executor`), `desktop` (Electron), `local` (runtime shared by CLI/desktop), `cloud` (SaaS: WorkOS auth, Postgres via postgres.js, Cloudflare Workers + Durable Objects, Autumn billing, Sentry, OTel→Axiom), `host-selfhost` (Docker: Better Auth + libSQL), `host-cloudflare` (Worker + D1 + Cloudflare Access), `marketing` (Astro), `docs` (Mintlify). VERIFIED (README "Project layout"; `apps/*`; https://executor.sh/docs/hosted/*).
- Packages: `core/{sdk, api, cli, config, execution, fumadb, integrations-registry, analytics, test-servers, vite-plugin}`, `kernel/{core (codemode-core), ir, runtime-quickjs, runtime-deno-subprocess, runtime-dynamic-worker, runtime-workerd-subprocess}`, `hosts/{mcp, cloudflare, mcp-apps-shell}`, `plugins/{openapi, graphql, mcp, toolkits, keychain, onepassword, file-secrets, encrypted-secrets, workos-vault, desktop-settings, example, provider-service-split}`, `react`, `app`. VERIFIED (`ls packages/*`).
- Runtime requirement for the CLI: Node.js 20+ (`npm install -g executor`; `executor install` registers a launchd/systemd service; web UI + MCP at `http://127.0.0.1:4788`). VERIFIED (https://executor.sh/docs/local/cli; README).
- Docker self-host: one container, libSQL file `/data/data.db`, QuickJS execution in-process, Better Auth (`BETTER_AUTH_SECRET`), `EXECUTOR_SECRET_KEY` master key for stored secrets, one org (`EXECUTOR_ORG_NAME/SLUG`), invite-only after the first owner, `EXECUTOR_ALLOW_LOCAL_NETWORK=false` by default, `/mcp` streamable HTTP. VERIFIED (https://executor.sh/docs/hosted/docker).
- Cloudflare self-host: single Worker, D1, Cloudflare Access for auth (single-tenant), QuickJS inside the Worker (or Dynamic Worker when a `LOADER` binding exists), MCP clients authenticate through Access Managed OAuth or service tokens. VERIFIED (https://executor.sh/docs/hosted/cloudflare; `apps/host-cloudflare/src/execution.ts:38`).
- Telemetry: CLI/desktop/self-host send anonymous PostHog events (`execution_completed{ok,plane,toolkit}`, `integration_added/removed{plugin_key}`, `artifact_*{via}`); opt out with `DO_NOT_TRACK` or `EXECUTOR_DISABLE_ANALYTICS`; typed catalogue at `packages/core/analytics/src/events.ts`. VERIFIED (TELEMETRY.md).
- Docs site pages: Introduction, MCP Proxy, CLI, Desktop, Cloud, Docker, Cloudflare, Concepts (Integrations, Connections, Policies); `/docs/llms.txt` exists. The docs are thin (concept pages are 3–6 paragraphs); there is no API reference or meta-tool reference online. VERIFIED (scrapes; `pages/llms.txt`).

### Vision vs shipped (the gaps matter)
- vision.md promises: meta-tools `search + describe + execute + run_code`; ordered scope stacks; policies attached to integration/connection records; toolkits feeding consent screens; a Run model collapsing audit/approvals/workflow runs; workflows + cron/event triggers; file-backed skills; git-backed artifact storage; remotes ("cores"); V8 isolates locally. It also says the current codebase "collapsed scopes to fixed org/user". VERIFIED (vision.md).
- Shipped at a0b0d91: no `run_code` anywhere in `packages/` or `apps/` (grep); scopes are exactly `org | user` (`owner-policy.ts`); policies are a global glob list per owner (`policies.ts`); no run/audit table (`core-schema.ts`); no workflows or triggers; `skills` is a fixed hand-curated set of three markdown docs (`execution/skills.ts`); artifacts (generative UI) do exist; local sandbox is QuickJS WASM, not V8 isolates. VERIFIED.
- `plans/kill-plugin-system.md` (decision dated 2026-07-27): "The plugin system is a fiction." — closed set of three protocol plugins, ~850-line `PluginSpec`, a rework repo (`executor-rework`) abandoned, in-place migration planned: data model (subject table) first, then plugin removal, then an "apps"/concept-package model (`defineApp`/`defineTool`), then a minimal SDK split. VERIFIED (plans/kill-plugin-system.md).

---

## Architecture notes

### A. What an MCP client actually sees (VERIFIED: `packages/hosts/mcp/src/tool-server.ts`, `browser-approval.ts`, `in-memory-session-store.ts`)

Session options are query parameters on the MCP URL: `?mode=codemode|passthrough` (default codemode), `?elicitation_mode=browser|model|native` (default `model`), `?search_tools=true`, `?artifacts=false`. Toolkit-scoped endpoints are paths: `/mcp/toolkits/<slug>` (local/self-host), and cloud additionally pins an org with `/org_xxx/mcp`.

| Mode | Tools registered (name → input schema) |
|---|---|
| **codemode** (default) | `execute` `{ code: string }` — description "Execute TypeScript in a sandboxed runtime." plus a live `## Available integrations` list (≤50 slugs); `skills` `{ name?: string }` — returns one of a fixed set of markdown guides (`execute`, `create-artifact`, `artifact-style`; `search-invoke` in passthrough); `resume` — `{ executionId }` in browser mode, `{ executionId, action: accept\|decline\|cancel, content?: json string, persist?: string }` in model mode, absent in native mode; opt-in `search_<integration>` `{ query?: string }` one per connected integration (≤50, name-only payload to nudge the model); artifact tools `create-artifact`, `edit-artifact`, `list-artifacts`, `show-artifact`, `execute-action` (MCP Apps via `@modelcontextprotocol/ext-apps`) |
| **passthrough** | `integrations` `{ integration?, owner?: org\|user, limit ≤50, offset }` → accounts with health; `search` `{ query 1–500 chars, integration?, owner?, connection?, limit ≤20, offset }` → `{ items: [{ id, name, integration, owner, connection, description, inputSchema (full JSON Schema), annotations }], total, hasMore, nextOffset }`; `invoke` `{ tool: id, arguments: object }` (annotated `destructiveHint: true`, args validated with `@cfworker/json-schema` against the stored schema); `skills` |

Inside the `execute` sandbox the model has a lazy `tools` Proxy and built-ins (VERIFIED: `packages/core/execution/src/engine.ts makeFullInvoker`, `tool-invoker.ts BUILTIN_TOOL_DESCRIPTIONS`, `runtime-quickjs/src/index.ts buildExecutionSource`):

```ts
const { items, total, hasMore, nextOffset } =
  await tools.search({ query, namespace?, limit? = 12, offset? });     // {path,name,description?,integration,score}[]
const d = await tools.describe.tool({ path });                          // compact TS shapes, see C
await tools.executor.integrations.list({ query?, limit?, offset? });
await tools.executor.coreTools.connections.list({});
const r = await tools.github.org.work.issues.create(args);               // { ok:true, data, http? } | { ok:false, error }
emit(value);                                                             // user-visible MCP content / ToolFile
return value;                                                            // goes back to the model (preview ≤30,000 chars)
```
`fetch` throws; there is no `Buffer`, `atob`, `TextDecoder`; TypeScript syntax is stripped with sucrase before evaluation; enumerating `tools` throws with a hint to call `tools.search`.

### B. Discovery: lexical scoring, no embeddings, no BM25, no LLM (VERIFIED: `tool-invoker.ts:496-750`)
- Every search calls `executor.tools.list({ includeAnnotations: false })` (all tool rows the caller can see) and scores in memory.
- Normalisation: camelCase → spaces, `[_./:-]` → space, lowercase; tokens split on non-alphanumerics.
- Field weights path 12, name 10, integration 8, description 5. Per field: whole-field equality w×14, prefix w×9, phrase containment w×6; per query token: exact token w×4, token-prefix w×2, substring w×1.
- Coverage gate: ≤2 query tokens must all match, otherwise ≥60% (an exact phrase match overrides). Bonuses: full coverage +25, partial `round(coverage×10)`, first token matches first path/name token +8, exact path/name +20.
- `namespace` = token-prefix match on integration slug or path; empty query + namespace = enumeration sorted by path; empty query alone = empty result.
- `describe` on a miss re-runs search on the last address segment (namespace-scoped, then global) to return ≤5 `suggestions`.
- The MCP passthrough `search` reuses the same scorer and then loads each hit's full schema (concurrency 4).

### C. Describe: lazy, compiled-to-TypeScript schemas (VERIFIED: `executor.ts:5900-5975`, `schema-types.ts`, `shape-inference.ts`, `shape-memory.ts`)
- Tool rows are stored with `input_schema` / `output_schema` JSON and shared `$defs` in a `definition` table per connection. Hot paths select `TOOL_INVOCATION_COLUMNS` (no schemas).
- `tools.schema(address)` (what `describe` calls) loads the one tool row, collects only the referenced `$defs` subgraph, and compiles input/output to TypeScript with a vendored `json-schema-to-typescript` (`MAX_PREVIEW_SCHEMA_NODES = 50_000`), on demand and uncached per call (wrapped in `Effect.option` so a compile failure degrades to JSON only).
- Output types are wrapped as `{ ok: true; data: T; http?: { status; headers } } | { ok: false; error: ToolError }` with `ToolError`, `ToolHttpMeta`, `ToolFile` definitions appended.
- **Observed output shapes**: when a tool declares no output schema, successful results are folded into a bounded structural shape (depth 6, 5 array samples, 24 keys, 4-way unions; values never stored) persisted in `plugin_storage` under `executor.shape-memory`, and `describe` renders it with `outputSchemaSource: "observed"`, an observation count and a note that fields may be incomplete.

### D. Execute/invoke pipeline (VERIFIED: `executor.ts:6360-6790`, `execution/engine.ts`)
1. `parseToolAddress` (5 segments; owner must be `org|user`); static tools (`executor.coreTools.*`, plugin extensions) resolve from an in-memory map.
2. Concurrently: load tool row, active policy rule set, connection row.
3. Policy: `resolveEffectivePolicy(toolId, rules, ownerRank, annotations.requiresApproval)`; `block` → `ToolBlockedError`.
4. If not `approve`: `plugin.resolveAnnotations` (fresh annotations) and, only when a pause is imminent, `plugin.validateToolArgs` (side-effect free) so a doomed call never burns a human approval.
5. `enforceApproval`: emits a `FormElicitation` with message `Approve <address>? (matched policy: <pattern>)` + an argument preview; the elicitation handler either answers inline (native MCP elicitation / `accept-all`) or pauses the fibre (`executeWithPause`).
6. Resolve credential values via the connection's provider (`CredentialProvider.get(item_id)`), refreshing OAuth if expired; failures map to `oauth_reauth_required` / `oauth_refresh_failed`.
7. `plugin.invokeTool({ ctx, toolRow, credential: { owner, integration, connection, template, value, values, config, grantedScopes }, args, elicit })`.
8. Exactly one retry after a forced refresh when the upstream answered 401 with a refresh token on hand; then `healPersistedHealthOnUse` updates `connection.last_health`.
9. Engine-level: sandbox runs as a detached Effect fibre; a pause returns `{ status: "waiting_for_interaction", executionId: "exec_<uuid>", interaction: { kind: url|form, message, address, args, requestedSchema?, meta? }, expiresAt, ttlMs }`; `resume` is idempotent (64-entry settled-outcome cache, 1,024 ids, in-flight de-duplication) because MCP clients retry lost responses; `shutdown` interrupts live fibres before a request-scoped DB handle closes.
10. Errors: expected failures (`tool_not_found` with suggestions, `tool_blocked`, `invalid_tool_arguments` with issues, OpenAPI pre-flight messages, binding errors, auth failures) reach the sandbox as `{ ok: false, error }`; anything else is replaced by `Internal tool error [<8-hex id>]` and logged with that id.

```
MCP client ──/mcp──▶ host-mcp tool-server ──execute(code)──▶ ExecutionEngine ──▶ CodeExecutor (QuickJS | Dynamic Worker)
                                                              ▲   │ tools.* proxy → SandboxToolInvoker.invoke(path,args)
                                                              │   ▼
                                    pause/resume (Deferred) ◀─┴─ executor.execute(address,args) → policy → approval → credential → plugin.invokeTool → upstream
```

### E. Data model (VERIFIED: `packages/core/sdk/src/core-schema.ts`; FumaDB schema DSL → drizzle → libSQL | Postgres | D1 | memory)

| Table | Partition | Columns of note |
|---|---|---|
| `integration` | tenant | `slug`, `plugin_id` (openapi\|graphql\|mcp\|…), `name`, `description`, `config` (opaque plugin JSON: spec pointer, auth templates, MCP endpoint), `health_check`, `config_revised_at`, `can_remove`, `can_refresh` |
| `subject` | tenant | `external_id` (host principal: WorkOS account id, Better Auth user, or `"local"`), `last_seen_at`, `status` — a join to host identity, not an identity system |
| `connection` | tenant, owner ∈ {org,user}, subject | `integration`, `name` (required account label), `template` (auth template slug), `provider` (credential provider key), `item_ids` (variable → opaque provider item id), `identity_label`, `description` (agent-visible), `last_health`, `tools_synced_at`, `oauth_client`, `oauth_client_owner`, `refresh_item_id`, `expires_at`, `oauth_scope`, `oauth_token_url`, `provider_state` |
| `oauth_client` | owned | `authorization_url`, `token_url`, `grant`, `client_id`, `client_secret_item_id` (provider ref), `token_endpoint_auth_method`, `resource` (RFC 8707), `origin_kind/integration/issuer/redirect_uri` (DCR) |
| `oauth_session` | owned | `state`, `pkce_verifier`, `redirect_url`, `payload`, `expires_at` |
| `tool` | owned | `integration`, `connection`, `plugin_id`, `name`, `description`, `input_schema`, `output_schema`, `annotations` — **tools are materialised per connection** at connect/refresh (`resolveTools`) and rebuilt lazily when `config_revised_at > tools_synced_at` or after `toolsSyncTtlMs` (default 15 min) for remote catalogues |
| `definition` | owned | shared JSON-schema `$defs` per connection |
| `tool_policy` | owned | `pattern`, `action` ∈ {approve, require_approval, block}, `position` (fractional index) |
| `artifact` | owned | generative-UI JSX `code`, role → connection `bindings`, `preview` |
| `plugin_storage` | owned | generic KV per plugin/collection (toolkits, shape memory, encrypted secrets) |
| `blob` | unscoped (namespace) | specs, pending approvals |

Row-level policy callbacks inject `tenant = ?` and owner visibility (`org` rows ∪ own `user` rows) on every read/write; an executor instance is bound to `{ tenant, subject }`; `reach: "tenant"` gives a read-only admin view, `writes: "denied" | "delete-only"` guard mutations (`owner-policy.ts`).

### F. Policies (VERIFIED: `policies.ts`)
- Pattern grammar over the address: `*`, exact `vercel.dns.create`, subtree `vercel.dns.*`, mid-segment `vercel.*.*.dns.create` (each non-trailing `*` = exactly one segment; partial wildcards rejected).
- Per owner the first matching rule by position wins; across owners the most restrictive wins (block > require_approval > approve), so a user rule cannot weaken an org rule. No rule → plugin default (`annotations.requiresApproval`: OpenAPI non-GET, MCP `destructiveHint`, mutating static tools).
- New rules are auto-positioned below any more specific existing rule (`positionForNewPattern`).
- `DynamicToolScope` lets an allowlist provider narrow which tool rows are loaded.

### G. Plugin seam (VERIFIED: `plugin.ts PluginSpec`)
`storage`, `pluginStorage`, `integrationPresets`, `extension` (→ `executor[plugin.id]`), `staticIntegrations` (inline tools), `routes`/`handlers` (Effect `HttpApiGroup`), `toolPolicyProvider` (≤1), **`resolveTools(input) → { tools: ToolDef[], definitions?, incomplete?, health? }`**, `remoteToolCatalog`, `projectToolSchema`, **`invokeTool(...)`**, `validateToolArgs`, `resolveAnnotations`, `removeConnection`/`removeIntegration` (inside core's transaction; `ctx.afterCommit` for external side effects), `integrationConfigure`, `describeAuthMethods`, `describeIntegrationDisplay`, `listHealthCheckCandidates`/`checkHealth`, `detect` (URL autodetect), `credentialProviders`, `close`. Tool input/output schemas at the authoring boundary are Standard Schema (`@standard-schema/spec`), not Effect Schema.

### H. Adapters (VERIFIED)
- **OpenAPI** (`packages/plugins/openapi/src/sdk`, ~16k lines incl. Google Discovery and Microsoft Graph converters): parse → `split.ts` (byte-range index so multi-MB specs are stored in the blob store and read partially) → `extract.ts` (`ExtractedOperation`: method, path template, parameters with location/style/explode, request-body media bindings incl. multipart/file hints, response bodies incl. NDJSON, servers) → `definitions.ts planToolPaths` (tool path = `<group>.<leaf>`: group from first tag or path, leaf from `operationId` or method+path, collision resolution, version segment) → per-connection `tool` rows. `derive-auth.ts` maps security schemes to stored templates: header presets → `apikey` with `placements: [{ carrier: header|query|cookie, name, prefix?: "Bearer ", variable }]`; oauth2 presets → `oauth2` with endpoints/scopes/resource. `invoke.ts` builds an Effect `HttpClientRequest` (path/query/header/cookie params, JSON/form/multipart/base64 bodies, `ToolFile` parts), renders the credential placements, sets a default User-Agent, enforces response-header and body timeouts, and returns `data` plus `http: { status, headers }`.
- **GraphQL** (`packages/plugins/graphql`): introspection → one tool per root query/mutation field, INPUT_OBJECT/ENUM → shared `$defs`; invoke POSTs `{ query, variables }` with a default scalar-leaf selection, a `select` control argument can override it; 110 s timeout (below Cloudflare's 125 s subrequest cap); auth = resolved headers/query params.
- **MCP** (`packages/plugins/mcp`): remote (streamable HTTP / SSE, auto-detected) or stdio (requires `dangerouslyAllowStdioMCP: true`; cloud never enables it); `resolveTools` = `tools/list`, each tool persisted with upstream annotations and `_meta` stamped into `annotations.mcp`; `destructiveHint === true` → `requiresApproval`; `remoteToolCatalog: true` so core re-lists after the TTL; `notifications/tools/list_changed` marks the connection stale; per-connection connection pooling; upstream OAuth (DCR, PKCE, RFC 8707, insufficient-scope detection) handled by core's OAuth service; CallToolResult envelope decoded, `isError` → typed failure.
- **Custom JS functions**: not a shipped integration kind at a0b0d91. `staticIntegrations` allow plugin-authored inline tools (used for `executor.coreTools.*`, `executor.openapi.addIntegration`, etc.). The plans describe an "apps"/custom-tools model (`defineApp`/`defineTool`, a ~6.8k-line `packages/plugins/apps`) that is not in this tree; issue #2108 refers to "v2 `apps/mcp`". INFERRED: custom tools live on the 2.0 branch.

### I. Secrets and auth (VERIFIED)
- `CredentialProvider { key, writable, get(id), has?, set?, delete?, list? }` (`sdk/provider.ts`). Providers: `file-secrets` (plaintext `auth.json` in the XDG data dir; single user), `keychain` (OS keyring), `onepassword` (read-only via op CLI/SDK), `encrypted-secrets` (AES-256-GCM in `plugin_storage`, key from `EXECUTOR_SECRET_KEY`; self-host default), `workos-vault` (cloud). Core stores only `provider` + `item_ids`; even the OAuth client secret is a provider item id.
- Per-user OAuth: org-shared or BYO `oauth_client`, `oauth_session` with PKCE, per-connection scope/expiry/refresh token, proactive and reactive refresh, dead-grant recording. Multiple accounts per integration per user via distinct connection `name`s.
- Credentials never enter the sandbox: the sandbox has only the `tools` proxy; the host resolves the value and the plugin renders it onto the outbound request.
- Egress guard (`sdk/hosted-http-client.ts`): blocks metadata hostnames, loopback/private ranges (including DNS-resolved addresses and IPv4-mapped IPv6), optional TLS requirement, strips `Authorization`/`Cookie` on redirects; `EXECUTOR_ALLOW_LOCAL_NETWORK` relaxes it.

### J. Multi-tenancy and per-user tool filtering (VERIFIED)
- Tenancy is row-level (`tenant`, `owner`, `subject`) with an executor bound per request to `{ tenant, subject }`; cloud maps WorkOS organisations → tenant and account ids → subject; self-host has one org (Better Auth `organization`, `admin`, `apiKey`, `bearer`, `mcp` plugins); local hashes the working directory into a tenant and uses subject `"local"`.
- Per-agent filtering: the **toolkits** plugin — a toolkit (owner, slug, name) holds `connections` (access patterns) and `policies` (pattern → action); when a session is served from `/mcp/toolkits/<slug>` the executor's `toolPolicyProvider` becomes that allowlist (unmatched tools are blocked, and `connections.list` is filtered too) and `DynamicToolScope` limits row loading. HTTP CRUD at `/toolkits*`.
- Cloud extras: org API keys and per-user API keys (`/account/api-keys`, `/account/org-api-keys`), WorkOS AuthKit JWT bearer for MCP with a cached JWKS, org pinned in the URL re-checked against a membership mirror.

### K. Sandboxes (VERIFIED)

| Runtime | Package | Used by | Limits | Bridge |
|---|---|---|---|---|
| QuickJS (quickjs-emscripten, sync WASM variant) | `@executor-js/runtime-quickjs` | `apps/local` (CLI + desktop), `host-selfhost`, `host-cloudflare` fallback | timeout 5 min default (interrupt handler; the deadline clock pauses while a tool call is in flight), memory 64 MiB, stack 1 MiB; `fetch` disabled | host functions `__executor_invokeTool(path, args)` → QuickJS promise resolved with a JSON string; `__executor_log`; result read back via a settled-state object after draining pending jobs |
| Cloudflare Dynamic Worker (Worker Loader) | `@executor-js/runtime-dynamic-worker` | `apps/cloud`, `host-cloudflare` when `LOADER` is bound | 5 min + 30 s host watchdog; `globalOutbound: null` (fetch/connect throw) | Workers RPC: a `ToolDispatcher` `RpcTarget` passed into the worker's `evaluate()` |
| Deno subprocess | `@executor-js/runtime-deno-subprocess` 0.0.5 | no app wires it (grep) — INFERRED experimental | 5 min; Deno permission flags | line-delimited stdio IPC with a nonce |
| workerd subprocess | `@executor-js/runtime-workerd-subprocess` 0.0.25 (workerd 1.20260708.1) | referenced by the CLI build | 5 min + 30 s; `globalOutbound: blocked \| internet` | loopback HTTP with a host token |

Results: `ExecuteResult { result, output?: (file|content)[], error?, errorKind?, logs?, toolPaths? }`; the MCP host truncates the text preview at 30,000 chars and reports `emitted` counts.

### L. Storage, config, registration, API, MCP server mode (VERIFIED)
- Storage: FumaDB (`@executor-js/fumadb`, MIT fork of fuma-nama/fumadb) with drizzle adapters over libSQL/SQLite (local `~/.executor`, self-host `/data/data.db`), Postgres (cloud; PGlite in dev), D1 (Cloudflare host) and an in-memory adapter (SDK default). Runtime schema bring-up is `CREATE TABLE IF NOT EXISTS` + additive nullable ALTERs; cloud keeps a hand-mirrored drizzle schema and migrations (plans note this as a constraint).
- Config: a static `executor.config.ts` (`defineExecutorConfig({ plugins: (deps) => [...] })`) per host, optionally merged with `executor.jsonc#plugins` for local installs; presets (Google/Microsoft catalogues) and spec-format adapters are passed to `openApiHttpPlugin`.
- Registration paths: web UI "Add Integration" (URL autodetect), CLI `executor call executor openapi addIntegration '{...}'`, HTTP `POST /openapi/specs | /mcp/servers | /graphql/integrations`, SDK `executor.openapi.addSpec(...)` / `executor.mcp.addServer(...)` / `executor.graphql.addIntegration(...)`, then `connections.create({ owner, name, integration, template, value })`. Public registry fetch from `integrations.sh` (`packages/core/integrations-registry`).
- HTTP API (Effect `HttpApi`): `/integrations`, `/connections/:owner/:integration/:name` (+ `/health`, `/refresh`, `/validate`), `/tools`, `/tools/schema`, `/policies`, `/providers/:key/items`, `/oauth/{start,complete,cancel,probe,callback,clients,register-dynamic}`, `/executions` (POST execute, GET paused, POST resume), `/artifacts`, `/account/*` (members, roles, API keys), `/admin/users*`, plus plugin groups (`/openapi/*`, `/mcp/*`, `/graphql/*`, `/onepassword/*`, `/toolkits/*`).
- MCP server mode: yes. Streamable HTTP at `/mcp` (`WebStandardStreamableHTTPServerTransport`, session id header), stdio via `executor mcp` (bridges to the local HTTP endpoint), toolkit paths, org paths. Auth: self-host = Better Auth `mcp()` OAuth authorisation server with forced consent screen + `.well-known/oauth-protected-resource` re-emitted at the origin, or session cookie / API key; cloud = WorkOS AuthKit JWT or API keys; Cloudflare host = Cloudflare Access. Sessions: in-memory store (local/self-host), or one hibernatable SQLite-backed Durable Object per MCP session (cloud, Cloudflare host) that also builds the engine and meters usage.

### M. Observability, audit, mutation safety, rate limits (VERIFIED)
- Tracing: Effect spans on every hop (`mcp.execute`, `mcp.tool.dispatch`, `executor.tools.search`, `executor.code.exec.quickjs`, plugin HTTP spans) with content-free attributes (sizes, kinds, outcome, `executor.correlation_id`); cloud exports via `@effect/opentelemetry` (`apps/cloud/src/observability/telemetry.ts`, Axiom per code comments) and captures errors with `@sentry/cloudflare`, correlating Sentry events with OTel trace ids; self-host has a console `ErrorCapture`; HTTP errors are opaque `InternalError({ traceId })`.
- Audit: **no durable execution/run log in core**. `execution_completed` is only an anonymous PostHog counter; cloud tracks usage counts for billing (`execution-usage.ts`). Paused executions live in engine memory; the one durable pause record is `PendingApprovalStore` (blob table, 15-min TTL, single-use) for artifact actions on request-scoped hosts. Connection `last_health` is the only persisted per-connection outcome.
- Mutation safety: three-state policy with spec-derived defaults; approval prompt carries the address, matched pattern and an argument preview; `validateToolArgs` before pausing; single-use approvals; upstream-offered `persist` scopes (`session`/`always`) are surfaced and only accepted when offered; passthrough `invoke` is annotated destructive so the client's own confirmation applies; `execute` `autoApprove` is only for the operator's Run panel and never bypasses `block`. There is **no prepare/confirm two-phase protocol, no dry-run, and no idempotency keys** on upstream calls; idempotency exists only for `resume`.
- Rate limits: cloud only — a per-org fixed-window counter Durable Object at 10,000 `execute` calls/hour for free-plan orgs (paid plans exempt), failing open on counter errors; an Autumn balance gate; member seat limits (3 on free). Self-host has Better Auth's login rate limit behind `authRateLimit`. No per-tool or per-upstream rate limiting; the sandbox result exposes upstream rate-limit headers via `result.http.headers`.

---

## Patterns worth adopting (for a Bun/TypeScript equivalent)

1. **Address grammar with the account in the path** — `tools.<integration>.<owner>.<connection>.<tool>` removes "which account?" ambiguity from every call and makes glob policies and toolkits trivial. (executor.ts:288-340)
2. **Connection = credential, born wired** — one row per (owner, integration, name) with a `template` + `provider` + `item_ids`; secrets live only behind a `CredentialProvider.get(id)`; OAuth client secrets are provider refs too. (core-schema.ts, provider.ts)
3. **Materialise tools per connection** with `tools_synced_at` vs `config_revised_at` staleness and a TTL for live remote catalogues; keep schemas out of the hot-path projection. (core-schema.ts `tool`, executor.ts `DEFAULT_TOOLS_SYNC_TTL_MS`)
4. **Two tool surfaces from one engine**: code mode by default, passthrough `search`/`invoke` for clients that cannot run code, selected by a query parameter. (browser-approval.ts `readToolMode`)
5. **Skinny always-loaded descriptions, fat docs behind a `skills` tool** — the `execute` description carries only the live integration inventory. (description.ts, skills.ts)
6. **`search_<integration>` name-only nudge tools** — put integration names into the client's tool list cheaply. (tool-server.ts:2196)
7. **Describe renders compact TypeScript** from only the referenced `$defs` subgraph, and **observed output shapes** fill in undeclared response types with an explicit provenance note. (executor.ts:5940, shape-inference.ts, shape-memory.ts)
8. **Uniform result envelope** `{ ok, data, http? } | { ok, error }` with an `emit()` channel for user-visible content and `ToolFile` for bytes. (skills.ts, tool-invoker.ts)
9. **Pause/resume as a first-class engine primitive** with idempotent resume, TTL, and pending-approval records that survive request scopes. (engine.ts, pending-approval.ts)
10. **Validate before you ask a human** (`validateToolArgs` only when a pause is imminent) and **show the arguments** in the approval prompt. (executor.ts:6377-6400, 6667)
11. **Most-restrictive-wins across owner layers**; spec-derived defaults (`GET` allowed, `destructiveHint` gated). (policies.ts)
12. **Opaque errors with correlation ids** so upstream URLs/tokens never leak through `Error.message` into the model. (tool-invoker.ts:354-375)
13. **Egress guard** for SSRF: block metadata hosts, private ranges, resolved addresses, strip auth headers on redirect. (hosted-http-client.ts)
14. **`removeConnection` inside the transaction + `afterCommit` for external revocation.** (plugin.ts)
15. **Emulators over mocks** for OAuth/API tests (`@executor-js/emulate`, separate repo). (AGENTS.md)

## Anti-patterns / risks

- **Search is O(catalogue) per call with no index** — every `tools.search` lists all tool rows (with descriptions) and scores them in memory; fine for hundreds, not for tens of thousands. Add an inverted index or embeddings if catalogues are large. (tool-invoker.ts:705)
- **Global glob policy list** — the author's own vision says to kill it; structural targeting (integration/connection records) is cleaner. (vision.md "Policies")
- **The plugin contract** (~20 optional hooks, HttpApi groups, React clients, Vite virtual modules) is judged "a fiction" by the maintainer and is being removed; do not copy `definePlugin`. (plans/kill-plugin-system.md)
- **Scopes hard-wired to `org | user`**; no team/environment level; hard-delete disconnect leaves no record. (owner-policy.ts, plans)
- **No run/audit log**; observability is spans + counters. If audit matters, design a Run table from day one (the vision's Run model is a good spec).
- **Pause state is in-memory** (except artifact approvals); a host restart loses paused executions.
- **Sandbox execution is synchronous WASM on the host thread** in the QuickJS runtime (`drainJobs` loop with `executePendingJobs`), so a CPU-heavy script blocks the event loop of a single-process self-host; the 5-minute default budget makes that worse. INFERRED from the sync WASM variant and the drain loop; cloud avoids it with Dynamic Workers.
- **Effect 4 beta everywhere** (`effect@4.0.0-beta.59`) plus seven patched npm dependencies and a FumaDB fork with a hand-mirrored cloud drizzle schema — heavy to adopt and to keep in step.
- **Bus factor of one** and a 2.0 beta rewrite in progress; vision.md openly calls the docs and RUNNING.md drift-prone.
- **Plaintext `file-secrets` provider** and opt-in stdio MCP on shared hosts are footguns; the repo gates them, copy the gating.
- **`host-mcp` is unpublished/private**, so the MCP tool server must be vendored (MIT permits it) rather than depended on.
- Licence: everything is MIT; nothing copyleft in Executor itself. Comparable Speakeasy Gram is AGPL-3.0 (do not copy code from it).

### Reuse verdict for a Bun/TypeScript shop
- **Embed as-is** (small, MIT, published, few deps): `@executor-js/codemode-core` (types, `stripTypeScript`, code recovery, error kinds), `@executor-js/runtime-quickjs` (a complete QuickJS executor with tool bridge; ~800 lines), the lexical `searchTools` and `describeTool` functions from `@executor-js/execution` (copy them; the package depends on the SDK types), `schema-types.ts` + `shape-inference.ts` (copy).
- **Copy the design, not the code**: engine pause/resume, policy resolution, address parsing, connection/provider model, egress guard, MCP session option scheme.
- **Do not embed**: `@executor-js/sdk` (34k lines, Effect-only, FumaDB-coupled, mid-rewrite), `@executor-js/api`, the React app, the plugin system.
- **Consider reusing the OpenAPI extraction** (`extract.ts`, `definitions.ts`, `split.ts`, `derive-auth.ts`) — it is the most battle-tested part (Google Discovery, 37 MB Graph specs, multipart, NDJSON) but it is written against Effect and the plugin storage seam.

---

## Comparable projects (1 line each, VERIFIED via `gh api` / fetched posts)
- **Composio** (ComposioHQ/composio, 30.3k stars, MIT): hosted "toolkits" + auth + tool search + sandboxed workbench; the SaaS-first incumbent in this niche.
- **Arcade** (ArcadeAI/arcade-mcp, 1.0k stars, MIT): MCP server framework plus a hosted tool platform with per-user auth for agents.
- **Speakeasy Gram** (speakeasy-api/gram, 271 stars, AGPL-3.0): OpenAPI → curated MCP toolsets with an enterprise gateway for connect/secure/observe/distribute.
- **Cloudflare Code Mode** (blog, 2025-09-26): one execute tool, MCP schemas turned into a TypeScript API, code run in Worker Loader V8 isolates with no general internet access — the direct ancestor of Executor's `execute`.
- **Anthropic "Code execution with MCP"** (2025-11-04): MCP servers presented as a code API on a filesystem with progressive disclosure; cites a 150,000 → 2,000 token example (98.7% saving).
- **MetaMCP** (metatool-ai/metamcp, 2.7k stars, MIT, last push 2026-06-22): Docker MCP aggregator/gateway with namespaces and middleware, no code mode.
- Also adjacent: cloudflare/agents (5.7k, MIT; the Agents SDK Executor patches) and the official MCP TypeScript SDK (13.5k) that Executor builds on.

---

## Unverified / open questions
- What the `2.0.0-beta.x` line changes (custom tools / "apps", plugin removal, subject model) — only inferable from `plans/*.md` and issue titles; the beta branch was not examined.
- Whether `run_code` or a separate "describe" MCP tool ever existed in earlier releases (v1.5/1.6 tags not diffed).
- Deno and workerd runtimes: presence in the tree but no app wiring found; production status unknown.
- Cloud pricing and plan limits beyond the constants in `apps/cloud/src/extensions/billing/plans.ts` (free: 3 members, 3 orgs/user, 10k executions/hour).
- Real-world performance of lexical search on large catalogues (Microsoft Graph produces thousands of tools) — not measured.
- Whether `executor.jsonc` plugin loading is documented anywhere public (the plan calls it vestigial; `apps/local` still loads it).
- DeepWiki summary (https://deepwiki.com/UsefulSoftwareCo/executor) not consulted.

---

## Sources
- Repository clone: https://github.com/UsefulSoftwareCo/executor @ a0b0d915ef721efa0a4dc82df3081bebc9004d6f — files cited: `vision.md`, `README.md`, `AGENTS.md`, `RUNNING.md`, `TELEMETRY.md`, `LICENSE`, `package.json`, `plans/kill-plugin-system.md`, `plans/openapi-provider-catalog-design.md`, `plans/artifacts.md`, `packages/hosts/mcp/src/{tool-server,browser-approval,in-memory-session-store,seams}.ts`, `packages/core/execution/src/{engine,tool-invoker,description,skills,provided-globals}.ts`, `packages/core/sdk/src/{core-schema,policies,plugin,executor,owner-policy,provider,credential-item-reference,elicitation,pending-approval,hosted-http-client,schema-types,shape-inference,shape-memory}.ts`, `packages/kernel/{core/src/types.ts,runtime-quickjs/src/index.ts,runtime-deno-subprocess/src/index.ts,runtime-dynamic-worker/src/executor.ts,runtime-workerd-subprocess/src/index.ts}`, `packages/plugins/{openapi,graphql,mcp,toolkits,file-secrets,encrypted-secrets}/src/**`, `packages/core/api/src/**` (route list), `apps/{local,cloud,host-selfhost,host-cloudflare}/src/**`, `examples/promise-sdk/src/main.ts`.
- GitHub API: `gh api repos/UsefulSoftwareCo/executor`, `/releases`, `/tags`, `/contributors`, `/commits`, `/stats/participation`, `orgs/UsefulSoftwareCo`, `search/issues`, `gh issue list` (2026-09-28).
- npm: `npm view executor`, `npm view @executor-js/sdk`, `npm search @executor-js` (2026-09-28).
- https://executor.sh (home), https://executor.sh/docs, /docs/mcp-proxy, /docs/local/cli, /docs/hosted/cloud, /docs/hosted/docker, /docs/hosted/cloudflare, /docs/concepts/{integrations,connections,policies}, /docs/llms.txt (firecrawl scrapes, 2026-09-28).
- https://blog.cloudflare.com/code-mode/ (2025-09-26); https://www.anthropic.com/engineering/code-execution-with-mcp (2025-11-04).
- Comparables: `gh api repos/{ComposioHQ/composio, ArcadeAI/arcade-mcp, speakeasy-api/gram, metatool-ai/metamcp, cloudflare/agents, modelcontextprotocol/typescript-sdk}`.
