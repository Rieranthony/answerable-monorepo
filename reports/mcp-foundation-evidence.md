# MCP foundation evidence

## Acceptance boundary

The shared foundation and permanent e2e consumer have passed local acceptance. No remote CI run, external chat-host certification or production deployment is claimed. The 95% setup target is an architectural aim, not a measured percentage.

See the [foundation design](../docs/07-mcp-platform-draft.md), [authoring guide](../apps/web/content/docs/mcp/authoring.mdx) and [e2e commands](../mcps/e2e/README.md).

## Verified behaviour

| Boundary | Evidence |
| --- | --- |
| Shared authentication | Signed-token/network JWKS tests reject incorrect issuer, audience, resource UUID, kind, claims and times; exercise maximum lifetime, rotation, cache and outage denial |
| MCP protocol | Official SDK client over Hono discovers tools, prompts and resources; validates schemas, scopes, registration conflicts and safe errors |
| Request isolation | Concurrent principals remain distinct; deadlines and HTTP abort propagate; request logs contain only bounded metadata |
| Reusable definitions | A second fixture composition uses the same read tools and omits write tools, which remain uncallable even with write scope |
| Domain writes | Tenant-owned SQLite records and transactional receipts survive reopen; a dropped create response followed by UI retry produces exactly one record |
| MCP Apps | Chromium renders the actual HTML resource through the official bridge; allowed create/delete and denied write work without exposing bearer tokens to the iframe |
| Real ID | Browser login, organisation selection, consent and PKCE produce actual ID resource tokens for two tenants; the client follows the MCP challenge and ID discovery metadata |
| Lifecycle | Wrong-resource and cross-tenant requests fail; refresh succeeds before organisation disable and fails afterwards; offline access lasts until actual 60-second fixture expiry, then returns 401 |
| Cleanup | SIGTERM during startup and browser login releases the fixture container and all reserved ports |

The real-ID fixture uses production migrations, bootstrap and app factories with a restricted database role in a disposable PostgreSQL container. Local upstream issuers simulate corporate authentication. Successful e2e authentication uses no injected ID sessions or substitute resource tokens.

## Runtime and compatibility

Installed versions exercised locally: Bun 1.3.1; MCP SDK and Apps 2.0.0; Hono 4.13.8; JOSE 6.2.12; Zod 4.6.5; React/React DOM 19.3.0; Playwright 1.63.0. Workspace manifests and the lockfile are authoritative.

The shared browser builder uses a separate Bun process. Same-process browser/server imports reproduced a Bun 1.3.1 module-cache failure; an isolated build passed. The scripts-only iframe invokes Apps actions directly rather than submitting native forms.

## Host compatibility

| Client/host | Tested version | Registration and network | Observed result |
| --- | --- | --- | --- |
| Official MCP TypeScript client | 2.0.0 | Pre-registered public client, PKCE; loopback HTTP with explicit development opt-in | Real ID login, tools, prompts/resources, refresh, refresh denial and expiry pass |
| Local Apps harness | AppBridge 2.0.0, Playwright 1.63.0 Chromium | Authenticated MCP client; sandboxed iframe receives no bearer | Render, create/delete, denied write and uncertain-response retry pass |
| External chat host | Not selected | Not yet tested | Not yet tested |

For external acceptance, record the product and exact version, registration mode, reachable MCP/ID origins, OAuth result, text fallback, Apps rendering and allowed/denied actions. UI support alone does not establish MCP Apps compatibility. The harness is `mcps/e2e/src/testing/host.ts`; assertions live in `src/apps.test.ts` and `scripts/id-e2e.ts` in that workspace.

## Verification record

Before simplification, root typecheck, lint and build passed. Existing suites also passed: web 71 tests, countries 5 tests, ID 1,949 tests with 100% line/function coverage, and the ID migration-installation gate. Those historical results are not fresh runs for this revision.

Post-simplification verification on 17 September 2026:

| Check | Result |
| --- | --- |
| `bun run mcp:test` | 42 tests pass, 119 assertions; generator and readiness tests removed |
| `bun run typecheck` and `bun run lint` | All seven workspaces pass |
| `bun run build` | All three build targets pass |
| `bun run mcp:test:e2e` | Real-ID lifecycle, startup interruption and browser-login interruption all pass; command exits 0 |
| Documentation | Local links checked in ten edited documents; production MCP pages, explicit/negotiated Markdown and both agent indexes return expected content |
| Removal audit | No remaining references to the deleted command, readiness API or separate compatibility report; `git diff --check` passes |

The sandbox initially blocked fixture listeners and Turbopack worker processes. The same checks passed with the required local networking/process permissions; no source workaround was added.

## Main integration validation

After integrating main’s move of browser pages into Answerable ID, the fixture runs from the ID workspace so it uses Hono’s JSX configuration. The e2e runner uses ID’s `/login` directly; the separate Next.js process, output configuration and reserved web port are removed. MCP configuration is listed in `default.env`.

Fresh checks pass: 42 MCP tests (119 assertions), 63 web tests (180 assertions), root typecheck/lint/build, production documentation routes and the full real-ID journey with both interruption checks. Stale generated Next.js files from the previous runner were removed locally; no compatibility workaround was added to the application.

## Remaining limits

Offline verification does not revoke already-issued access tokens before expiry. Cancellation is cooperative, does not undo committed effects and has no cross-request registry in this stateless transport. Real corporate providers, external hosts, machine principals, production deployment and the future admin MCP need separate acceptance.

Workspace generation is deferred until a second real consumer demonstrates what repeats. The authoring guide and e2e workspace are the current starting points.
