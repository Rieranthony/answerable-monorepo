# MCP foundation

## Purpose

Any MCP server we build signs people in with Answerable ID and needs almost no setup: two URLs, its tools and a port. These packages are written to become the public SDK for building on Answerable. `mcps/e2e` proves the whole path against real ID. How-to guides live at [`/docs/mcp`](../apps/web/content/docs/mcp/index.mdx); results live in the [evidence](../reports/mcp-foundation-evidence.md).

## Packages

| Workspace | Responsibility |
| --- | --- |
| `packages/auth` | Verify an ID access token for any service; an in-process test issuer |
| `packages/mcp` | An MCP server from definitions, on the official SDK; view builds; in-process tests |
| `mcps/e2e` | Reference server and the real-ID acceptance |

MCPs live in `mcps/*`. Better Auth stays in ID; an MCP never creates accounts or sessions, and never reads ID's database. Extract a shared package only when a second consumer needs it: the app sign-in client in `apps/web/lib/oauth-test` has one consumer, so it stays there.

## Decisions

**Official SDK primitives.** `requireBearerAuth`, `createMcpHandler` and the SDK's host and origin checks do the protocol work. One definition serves the 2026-07-28 revision and falls back to stateless 2025 serving. We write only the Answerable parts: the verifier, scope-aware registration and the definitions API.

**Two settings.** The verifier needs the issuer and the resource URL. Keys come from the issuer's metadata. HTTP is allowed only on loopback addresses, so production cannot drift onto it. The audience already binds a token to one MCP, so there is no resource UUID pin; ID owns token lifetimes, so there is no second cap. An optional `fetch` replaces the HTTP client for discovery and keys; tests pass the in-process issuer's.

**Scopes decide visibility.** ID issues the entitled subset of what the host asks for. A token lists only the tools, prompts and resources whose scopes it carries. Organisation admins, not end users, control entitlements, so a scope a person lacks is not something the host can obtain for them by re-authorising; hiding it keeps the model from trying. Advertised capabilities follow the definitions, not the caller.

**Offline verification.** An MCP checks tokens against ID's published keys and never calls ID per request. A disabled organisation's issued token works until it expires; refresh stops at once. Keep resource lifetimes short (the acceptance uses 60 seconds).

**Views.** MCP Apps views are built into one HTML resource in a separate Bun process, because an in-process build breaks the test suite on Bun 1.3.1. Views call tools through the host with the same scope and organisation checks and never see a token.

**Definitions are data.** `defineTool`, `definePrompt` and `defineResource` validate and freeze plain objects, and `createMcpServer` registers them for each request. Dependencies come from closures, so there is no container. Composition is ordinary code: arrays of tools, wrappers around `execute`, direct `execute` calls in unit tests.

**Structured output.** `execute` returns the output. The server sends it as `structuredContent` and as the same JSON in text, as the MCP specification asks of structured tools. Claude Code 2.1.282 shows the model only `structuredContent`, so a separate summary would never be read. The output schema drops undeclared fields before anything leaves the server.

**Tests in-process.** `createTestMcp` drives the official MCP client against the server's fetch handler, and the verifier fetches keys from an in-process test issuer. MCP unit tests open no port, so they also run in sandboxes that cannot bind one, such as Codex's.

**Acceptance through the real product.** The fixture runs ID from production migrations and its restricted runtime role, and provisions everything through the admin API with the root secret, as an operator would. The journey uses the SDK's own OAuth client, as hosts do, and a real browser on ID's pages. Company directories are local test issuers.

## Not yet

- Automatic client registration for hosts (client ID metadata documents or dynamic registration): [`Q-MCP-CLIENT-REGISTRATION`](02-plan.md#open-register).
- Machine principals, a hosted deployment, Claude.ai against a public URL, and the admin MCP.
