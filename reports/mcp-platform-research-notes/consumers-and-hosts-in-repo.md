# Consumers of Answerable's MCP servers and hub: what the repo says

Read-only survey of `/Users/anthonyriera/code/answerable` at `main` d55220d (2026-09-28). Every path below is absolute unless it is a documented URL. Duplicate checkouts under `.claude/worktrees/*` were excluded from the sweeps; two untracked scratch notes in those worktrees are cited once, clearly labelled, because they hold measured facts that exist nowhere else. Lines marked **Inference** are mine, not the repo's.

Companion files in this folder: `id-authz-model.md` (ID's capability/entitlement model) and `mcp-packages.md` (`packages/auth`, `packages/mcp-base`, `mcps/e2e`). This file does not repeat them.

## 0. The consumer landscape in one table

| Consumer | Role stated | State | Where |
| --- | --- | --- | --- |
| OmniChat cells (LibreChat fork, one deployment per client) | OIDC clients of ID; per-user MCP OAuth to hosted servers ("browser bounce"), then Bearer JWT `aud` = one server | Intended first internal consumer; **not validated against the actual fork** (gate E2) | `/Users/anthonyriera/code/answerable/docs/00-orientation.md`, `docs/01-architecture.md`, `docs/03-answerable-id.md:83-85`, `reports/answerable-id-release-decision-plan.md:38` |
| External AI tools (Claude Code, Claude Desktop, Claude.ai connectors; "OpenCode" named once) | OAuth clients of ID "under the registration policy"; PKCE, exact redirect URIs | Claude Code proven by hand with a pre-registered client; Claude.ai/Desktop and automatic registration: Not yet (gate E3, `Q-MCP-CLIENT-REGISTRATION`) | `docs/00-orientation.md:38`, `docs/03-answerable-id.md:79-81`, `reports/mcp-foundation-evidence.md`, `apps/web/content/docs/mcp/claude-code.mdx` |
| Omni Accelerator community on Circle.so | Points its community SSO at ID (flag-day cutover); also the data source of the tutor MCP | Not yet; gated by `Q-MEMBER-MATCH`, gate E8 | `docs/00-orientation.md:16,37`, `docs/03-answerable-id.md:127-129`, `docs/02-plan.md:60` |
| Tutor MCP (`apps/community-mcp`) | First hosted MCP server: OAuth resource server of ID wrapping Circle's headless API, called from inside OmniChat cells (v1) and by clients' own AI tools (v1.1) | **Parked 2026-09-02**, docs only | `apps/community-mcp/README.md` |
| `apps/web` `/oauth-test` | Development-only, independent confidential OIDC client of ID (login-only, no `resource`) | Working locally | `apps/web/lib/oauth-test/`, `apps/web/app/oauth-test/page.tsx` |
| `mcps/e2e` acceptance (official MCP SDK OAuth client + Chromium) | Stand-in for a real host | Passing locally | `mcps/e2e/scripts/acceptance.ts` |
| "The admin MCP" | Named as the planned second MCP consumer | Not yet | `docs/07-mcp-platform-draft.md:34` |

Consumers verify tokens **locally** against cached JWKS; an ID outage blocks new logins, refreshes and connects, not issued tokens (`docs/01-architecture.md:28`). Every MCP server "publishes RFC 9728 metadata naming Answerable ID as its authorization server and verifies JWTs locally via `packages/auth`. Per-client-sensitive servers live tailnet-only; shared ones are exposed over HTTPS at the ingress" (`docs/01-architecture.md:60-63`).

---

## 1. `apps/community-mcp`: the parked tutor MCP

### 1.1 What is actually there

Five Markdown files, one commit (2eb5ffe, 2026-09-02), never touched since:

- `/Users/anthonyriera/code/answerable/apps/community-mcp/README.md` — "Docs-only for now — no code, no `package.json`." Parked until ID ships; "resumes as the first OAuth resource server of Answerable ID".
- `docs/01-tutor-design.md` — scope, identity, flows, failure modes, state, layers, testing, secrets, env, capacity, ingress, deployment, rollout, operations, data protection, threat model.
- `docs/02-integration-facts.md` — verified LibreChat and Circle facts, each with a consequence and a source.
- `docs/03-tools-and-ui.md` — the six tools, authored checks, three UI cards, server instructions, errors, compatibility.
- `docs/04-community-control.md` — schema, credential custody, member-token minting, audit, interface.

Drift to note: the root `README.md:18` says "its docs and Circle mocks stay in that folder" and `01-tutor-design.md` says the Circle client is "Generated from `infra/circle-openapi/*.yaml`", but **no mocks or specs exist**; `infra/` holds only `postgres/init/*.sql`. The tutor docs also link to `docs/02-plan.md#local-environment`, `#backlog` (both exist) and `#cost-model-fill-in-from-q-cost-inputs` (no longer exists). `.env.example` and `default.env` carry none of the tutor variables (`AID_ISSUER`, `CIRCLE_*`, `ENVELOPE_MASTER_KEY`, `TUTOR_ORG_DENYLIST`, `MAU_ALLOWANCE`); they list only `MCP_ID_ISSUER`, `MCP_RESOURCE_URL`, `MCP_PORT` and `OAUTH_TEST_*`.

### 1.2 Intended shape

"A TypeScript streamable-http MCP server on Bun and Hono, and an OAuth resource server of Answerable ID. It is our own MCP wrapper around Circle's headless API — we build the bridge into chat, not the community. v1 callers are the AI agents inside OmniChat cells; clients' own AI tools follow in v1.1 with the same token shape." (`01-tutor-design.md:8`)

**v1 in:** search with citations · courses with per-member progress · lessons in chat · authored lesson checks that unlock real Circle completions under per-course policy (`check` | `manual`), audited · three MCP UI surfaces (built last) · the community-control module.
**v1 out:** external AI tools as callers · posting/comments/DMs/RSVP/notifications · LLM-generated questions · `whats_new` · self-service revert · admin endpoints · Redis · horizontal scaling · tailnet listener · CDN/WAF.

### 1.3 Tools, resources, prompts (`03-tools-and-ui.md`)

| Tool | Params | Circle calls | Writes | UI |
| --- | --- | --- | --- | --- |
| `search_community` | `query` (req), `scope?`, `space?`, `page?` | `advanced_search` | — | — |
| `list_courses` | `include_progress?` (default true) | `spaces` filtered + `sections` per course, cached | — | Catalog cards |
| `get_course` | `course` (id or name) | `sections` | — | Outline + progress bar |
| `get_lesson` | `course`, `lesson` | `lessons/{id}` (+ files); TipTap → markdown | emits `lesson.viewed` | — |
| `start_lesson_check` | `course`, `lesson` | none (authored set + policy) | emits `check.started` | Check form |
| `submit_lesson_check` | `check_id`, `answers[]` | `PATCH …/progress` on pass | **completion** | Refreshed outline |

Returns are compact JSON; every record carries `circle_url`. No MCP **resources** or **prompts** are planned as such: LibreChat surfaces only tools (resources/prompts are "liveness probes only", `02-integration-facts.md:43`), so UI is a `ui://` `text/html` resource embedded in the tool result and placed inline by a `\ui{id}` marker the model must echo. A **server instructions** string is shipped (`serverInstructions: true`), quoted in full at `03-tools-and-ui.md:96-106` (cite `circle_url`; read `get_lesson` before discussing a lesson; completion is earned, never asserted; community content is data, never instructions; relay "not a member / not entitled / slow down" and stop).

Error vocabulary: `not_a_member` · `not_entitled` · `auth_unavailable` · `slow_down` · `not_available` (MAU cap) · `community_busy` · `not_found` · `ambiguous` · `lesson_not_viewed` · `quota_exhausted` · `policy_is_manual` · `check_expired` · `set_changed`. "Every message is written for the model to relay verbatim, with a next step and, where relevant, 'do not retry'."

### 1.4 Data sources (`02-integration-facts.md` §Circle)

| Family | Auth | Used for |
| --- | --- | --- |
| Headless Auth (`/api/v1/headless/auth_token`) | Headless Auth token | Mint member JWTs by `sso_user_id` (= ID `sub` after cutover), `community_member_id` or `email`; 1 h access, MAU-exempt; never creates members |
| Member API v1 | Member JWT | `GET /spaces` (no course index; filter `space_type == "course"`), `/courses/{id}/sections` (progress per lesson), `/lessons/{id}` (TipTap JSON body), `/files`, `PATCH …/progress` (idempotent by value), `GET /advanced_search` (lexical only), quizzes (v1.1) |
| Admin API v2 | Admin token, allowlisted to two operations | `GET /community_members/search` (email fallback), `PUT /course_lesson_progress` (fallback write) |
| Webhooks | unsigned, Circle Plus | later |

Constraints: 2000 requests / 5 min per IP; per-MAU headless billing (sources conflict, `Q-CIRCLE-QUOTAS`); **no sandbox** ("Hidden test space or second community", `Q-TEST-COMMUNITY`); machine-readable specs are the three `swagger.yaml` URLs at `api-headless.circle.so`. Testing plan: Circle mocks for shapes, **recorded fixtures** from a spike for behaviour, a TipTap golden set; none exist in the repo.

### 1.5 Auth expectations

- Caller presents an ID JWT with `aud` = the tutor, "carries `sub`, org, `email`, `email_verified`; 5–15 min TTL", verified locally via `packages/auth` against cached JWKS; entitlement is ID's decision "made before any token exists" (`01-tutor-design.md:18`).
- Transport: `POST /mcp` (SDK streamable-http on Hono), `GET /healthz` (checks Postgres), `GET /.well-known/oauth-protected-resource` (RFC 9728). No auth headers in `librechat.yaml`; "OAuth is discovered from the server's RFC 9728 metadata" (`01-tutor-design.md:146-157`).
- 401 + `WWW-Authenticate` → the cell refreshes with rotation or re-runs connect; 403 for wrong audience / org not entitled ("belt-and-braces"); no introspection, so an entitlement revoke "takes up to one token TTL to bite" and `TUTOR_ORG_DENYLIST` is the instant kill switch.
- Circle identity: minted from `sub` after the Circle SSO cutover; **until then every member reaches Circle through an audited email-correlation fallback** requiring `email_verified === true`, an exact-email Admin search returning exactly one active member, once per member ever, failing closed (`04-community-control.md` §Minting). "Never write progress for a member reached by anything weaker."
- **Inference (gap):** ID's resource JWT today carries subject, tenant, membership, grant, client and resource identities; `packages/auth` exposes `{userId, organizationId, membershipId, grantId, clientId, scopes, expiresAt}` and the OAuth guide says profile and email come from UserInfo, not the token (`apps/web/content/docs/id/oauth.mdx:63`). The tutor's `email`/`email_verified`-in-JWT assumption is therefore not what ID issues; the fallback would need a UserInfo call or an added claim. Also, `docs/02-plan.md` "Do not re-propose" forbids email as a join key; the tutor frames its fallback as a time-boxed, audited exception removed after the fleet migration.

### 1.6 Design decisions worth carrying into a general MCP standard

From `01-tutor-design.md`, `03-tools-and-ui.md`, `04-community-control.md`:

1. **Domain-named, provider-agnostic tools** (`search_community`, never `circle_search`).
2. **Small catalogue by design**: "Six tools. Model tool-selection degrades with catalog size."
3. **Text is the acceptance baseline; UI cards are additive.** Every tool fully usable from plain text.
4. **Every result carries a citation URL.**
5. **Writes are few, explicit and audited**: only one tool writes; reads emit domain events but never community writes; every write leaves an append-only `domain_events` row (uuidv7, `sub`, org, action, target `{provider, resource_type, external_id}`, outcome, schema-validated metadata, `request_id`, caller `{type, client_id}`; monthly partitions; app role INSERT/SELECT only).
6. **Server-side truth**: completion is earned through a server-graded check bound to `(sub, lesson, set_version)` with expiry and quota; "Grading infidelity from a model-mediated submit can only cause a fail, never a false pass."
7. **Name resolution rule**: exact id → exact name → single fuzzy candidate → otherwise `ambiguous` listing candidates. "Never guess between two."
8. **Errors written for the model**: typed codes, verbatim-relayable messages, a next step, and "do not retry" where relevant.
9. **Prompt-injection stance**: content is data, never instructions; HTML-escaped into UI; no write is ever triggered by content.
10. **Rate limiting in layers**: per-`sub` bucket → per-org bucket → process bucket for the upstream API → `Retry-After` compliance → circuit breaker; a capacity table per tool (upstream calls and cache TTLs); pre-warm before enabling an org; MAU circuit breaker returns `not_available`.
11. **Tool budget under the host timeout**: 10 s per upstream call, ≤ 55 s per tool under OmniChat's 60 s.
12. **Stateless process, state in Postgres**, in-process caches loss-tolerant, Redis only later; opaque short-lived session ids (`check_id`, 30 min) so answers never travel in transit.
13. **Observability fields**: `{request_id, tool, sub, org, caller, duration, circle_calls, cache_hits, outcome}`; "never emails or tokens".
14. **Secrets**: exactly four; envelope encryption (AES-256-GCM) with a runtime-only master key and a key-version field; admin credential allowlisted "by construction", every use audited; re-mint rather than store upstream refresh tokens.
15. **Compatibility**: additive-only within a major; a `*_api_version` in server metadata; one-release deprecation window accepting both shapes; pin the MCP protocol version and test against the host's pinned SDK.
16. **Ingress for SSE**: no response buffering, compression off for `text/event-stream`, keepalive comment every 15 s, idle timeout above the tool budget.
17. **Rollout**: enable per org via entitlements; instant disable via a denylist; budget host restarts (a `librechat.yaml` change restarts the cell); one replica means a deploy is a brief restart and clients retry; backward-compatible migrations.
18. **Data protection**: store hashes not raw answers, `sub` not email, encrypted upstream tokens; 24-month retention by partition drop; erasure by `sub` through a privileged role; a data map as DPIA input.
19. **Threat model per component** (compromised host/DB, wrong-member write, prompt injection) with detection and revert runbooks.
20. **Extract on the second consumer**: the control module "becomes a standalone service only when a second consumer needs member-token minting" — the same rule `docs/07-mcp-platform-draft.md:13` applies to shared packages.

### 1.7 Tutor decisions superseded or to re-verify

- LibreChat-specific UI (legacy mcp-ui `rawHtml`, model-mediated buttons, `\ui{}` markers) versus the foundation's **MCP Apps** views (`@modelcontextprotocol/ext-apps`, `defineView`): the tutor facts were pinned to LibreChat `main` v0.8.8-rc1 and flagged "re-verify before adopting MCP Apps" (`02-integration-facts.md:50`).
- `Q-BUN-MCP-SDK` ("a Hono-native transport shim replaces the SDK server" if needed) is resolved by the foundation: the official SDK's `createMcpHandler` runs on Bun (`docs/07-mcp-platform-draft.md:19`).
- Token lifetime "5–15 min" versus the foundation's 60 s in acceptance and 900 s for Claude Code (`reports/mcp-foundation-evidence.md:22`).
- "No elicitation, no sampling" was a LibreChat limitation ("Everything is a tool"); not a general rule.
- Tutor-only open IDs that never entered `docs/02-plan.md`'s register: `Q-BUN-MCP-SDK`, `Q-INGRESS-STREAM`, `Q-FALLBACK-PREDICATE`, `Q-CIRCLE-PLAN`, `Q-CIRCLE-QUOTAS`, `Q-TEST-COMMUNITY`, `Q-DEEPLINK`, `Q-MEDIA-PATCH`, `Q-ADMIN-TRIGGERS`, `Q-COST-INPUTS`.

---

## 2. OmniChat: the LibreChat fork and its cells

### 2.1 Vocabulary and scale (`docs/00-orientation.md`)

- **OmniChat**: "Our chat product, a fork of the open-source LibreChat ('the fork')" (line 14).
- **Cell**: "One client's independent OmniChat deployment (own VM, own MongoDB). 74 tenants today, 63 with corporate SSO" (line 15). The backlog names "the 11 non-SSO tenants" needing hosted email+password login with MFA (`docs/02-plan.md:70`).
- **Omni-Weaver**: "Our tenant-provisioning system (per-cell configuration)" (line 24); organisation slugs share "the same grammar as the Omni-Weaver tenant id" (`apps/web/content/docs/id/onboard.mdx:231`).
- **OmniAdmin / OmniTable / `ocadmin`**: "Our admin surfaces and CLI for the fleet" (line 25). No other mention anywhere in the repo.
- Cast: "OmniChat cells | OIDC clients of Answerable ID; migrate cell by cell" (line 36). Success criterion 5: "A cell (or Circle) can roll back to its old issuer with a pure environment change."
- Problem: "identity must not live inside the fork's database" (line 43); do-not-re-propose: "Identity inside the fork's database — apps consume identity through standard OIDC" (`docs/02-plan.md:76`).

### 2.2 How a cell connects to ID and to MCP servers

- `docs/01-architecture.md:20-26` (diagram): `AID -- "OIDC login · private_key_jwt clients" --> CELL`; `CELL -. "per-user MCP OAuth (browser bounce) then Bearer JWT, aud = one server, 5–15 min" .-> MCP`.
- Secrets held by cells (`docs/01-architecture.md:40`): "Their own `private_key_jwt` client credential (one per cell, never shared); users' per-server MCP tokens, encrypted at rest".
- `docs/03-answerable-id.md:83-85` §Internal: "The intended cell uses OIDC login and per-user resource grants. Its fork must send `resource`, separate users' credentials, store them safely and handle rotation/reuse. **Not yet validated against the actual fork.**"
- Kill gates (`docs/02-plan.md:42`): "OmniChat login; per-user MCP silent first-party bounce, separate encrypted credentials and refresh rotation; … cell rollback. **Not yet validated.**"
- Gate **E2** (`reports/answerable-id-release-decision-plan.md:38`): inputs = "Actual OmniChat fork commit/config path, test cell, issuer/public/tailnet URLs, redirect/auth method, session/token-storage settings"; acceptance = "OIDC login/routing/another-email flow; state/nonce/PKCE and `private_key_jwt` where configured; per-user MCP `resource`, separate encrypted credentials, silent configured first-party bounce, refresh rotation; A/B exact-pair denials at code/refresh; tested cell rollback."
- `reports/id-production-oauth.md:260-262`: remaining "An actual OmniChat cell login and the fork's per-user MCP behaviour, including resource indicators, consent handling, encrypted token persistence, rotation, retries and delegation after browser-session expiry."
- Dogfood (`docs/03-answerable-id.md:143`): "Run the selected test cell using its actual version/configuration and verifier. A synthetic issuer test is insufficient."
- The "silent first-party bounce": the tutor flow diagram shows `/authorize` with "live session, first-party client, no consent screen" (`apps/community-mcp/docs/01-tutor-design.md:30`); ID implements this as a client registered with `skipConsent` (first-party class), which mints the code at organisation selection (`reports/mcp-foundation-evidence.md:49`, `docs/01-architecture.md:57`).

### 2.3 Open register rows that belong to the fork (`docs/02-plan.md:53-55`)

- `Q-AID-LISTENER`: "The design says the tailnet-only listener handles per-user MCP connect, but connect is a browser bounce — `/authorize` + callback must be public; only `/token`/refresh can be tailnet. The admin API is split the same way: tenant-tier routes (`x-tier: tenant`) are public, platform-tier routes (`x-tier: platform`) are tailnet-only." Related: `docs/03-answerable-id.md` §Tailnet hardening (`TRUSTED_PROXY_CIDRS`, `403 untrusted_ingress`, "Browser authorisation and callbacks must be reachable from the browser").
- `Q-RESOURCE-PARAM`: "Does the fork's MCP OAuth client send RFC 8707 `resource`?" Resolve by "Spike against the fork; else default the audience from the client↔server link."
- `Q-FORK-PATCHES`: "The living inventory of fork patches: extra-params, back-channel-logout receiver, refresh-grant fallback, whatever `Q-RESOURCE-PARAM` adds" — "List in the fork repo; link here". Upstream "has no back-channel-logout receiver" (`02-integration-facts.md:58`).

### 2.4 Verified LibreChat upstream facts the fork inherits (`apps/community-mcp/docs/02-integration-facts.md`, v0.8.8-rc1 / stable v0.8.7)

Configuration: servers live in `librechat.yaml` and changes restart the cell; `type: streamable-http` must be explicit (plain `http(s)://` infers legacy SSE); default tool `timeout` 30 000 ms, per-server configurable; `mcpSettings.allowedAddresses` needed for private hosts (private IP space is SSRF-blocked); tool keys `[A-Za-z0-9_.-]`, colliding normalised server names shadow each other.

Identity and OAuth: "Full MCP OAuth: Authorization Code + PKCE, **dynamic client registration**, per-user encrypted token storage, refresh rotation, callback `{DOMAIN}/api/mcp/{server}/oauth/callback`"; OAuth auto-detected from 401 + `WWW-Authenticate` / protected-resource metadata, `requiresOAuth` can force it; "Silent 401 recovery: one bounded refresh + reconnect per user and server"; per-user connections isolated when a server is OAuth-protected, idle disconnect after 15 min (`MCP_USER_CONNECTION_IDLE_TIMEOUT`); `{{LIBRECHAT_USER_*}}` header placeholders exist but are "Not used for identity"; "Servers with OAuth must be yaml-defined" → "Admin-managed yaml, per cell, via Omni-Weaver".

Capability surface: only tools are surfaced; client capabilities empty (no elicitation, no sampling); `serverInstructions: true` injects instructions; the chat dropdown toggles a whole server, per-tool toggles only in Agent Builder; "No per-user allowlist for yaml-defined servers" → "Authorization = Answerable ID entitlements + the tutor's own checks, never LibreChat visibility".

MCP UI: legacy mcp-ui `rawHtml` only (`externalUrl`/`remoteDom` dropped); iframe sandbox `allow-scripts` only, permissions stripped; `tool`/`intent`/`prompt` actions are model-mediated, `link`/`notify` ignored; inline placement needs the model to echo `\ui{resourceId}`.

**Inference:** LibreChat's MCP OAuth client registers dynamically, while ID exposes no registration endpoint and DCR/CIMD are "Not yet" (`docs/03-answerable-id.md:81,99`). Either the fork is patched to present a pre-registered client per cell (a `Q-FORK-PATCHES` item) or ID implements `Q-MCP-CLIENT-REGISTRATION`. The repo does not state this conflict explicitly.

### 2.5 The registration shape the docs already assume for a cell

- `apps/web/content/docs/id/onboard.mdx:311-337`: resource `https://tutor.answerable.org` with `allowedScopes: ["tutor:read"]`; client `omnichat-contoso` with `organizationId`, `tokenEndpointAuthMethod: "private_key_jwt"`, grants `authorization_code` + `refresh_token`, scopes `openid profile email offline_access tutor:read`, `requirePKCE: true`, `redirectUris: ["https://contoso.omnichat.example/oauth/callback"]`, `jwksUri: "https://contoso.omnichat.example/.well-known/jwks.json"`; then `PUT /clients/{clientId}/resources/{resource}` ("A registering client can never link itself"); entitlements for login scopes and for the `(omnichat-contoso, https://tutor.answerable.org)` pair, optionally narrowed to a group with `validFrom`/`validUntil`.
- `apps/web/content/docs/id/manage.mdx:713-720`: capability `{"clientId":"omnichat","resource":"https://mcp.example.com","grantKind":"authorization_code","scopes":["tool:read"]}` and the four-row table (app login, app reaching a server, login renewal, renewal of that server grant).
- Tests model the same: `apps/id/src/auth/user-oauth.integration.test.ts:52-75` (client `omnichat`, `client_secret_basic`, resource `https://m365.example/mcp`, scopes `openid email offline_access mail:read`) and `apps/id/src/db/schema.integration.test.ts:120-126` (`omnichat-test-cell`).
- `docs/05-id-enterprise-foundation.md:43`: "Required truth table: A allows OmniChat→M365 and denies OpenCode→M365; B may independently approve OpenCode." (OpenCode = a second external AI tool, named only here.)
- Bulk import of an existing cell's users and tested cell rollback: Not yet (`onboard.mdx:438`, `docs/02-plan.md:34`).

---

## 3. External AI tools (Claude Code, Claude Desktop, Claude.ai connectors)

### 3.1 Policy statements

- `docs/00-orientation.md:23`: "DCR / CIMD — The two ways an external AI tool registers with an OAuth server; CIMD preferred, DCR restricted by policy". Line 43: "Entra can't be an MCP authorization server; it lacks dynamic client registration."
- `docs/01-architecture.md:18,24,41`: `EXT["External AI tools: Claude Code · Claude Desktop (planned)"]`; `AID -. "OAuth 2.1 · DCR/CIMD policy (planned)" .-> EXT`; they hold "Their own short-lived, audience-bound OAuth tokens (PKCE mandatory)".
- `docs/03-answerable-id.md:79-81`: "The implemented path uses an administratively registered client, PKCE and explicit consent. DCR, CIMD, device flow, PAR and introspection are closed. A tool requiring these cannot be declared compatible without implementation or an explicitly supported pre-registration configuration." Line 99: "Registration is platform administration, not permission… No public registration endpoint is exposed."
- `docs/02-plan.md:62` `Q-MCP-CLIENT-REGISTRATION`: "Hosts need a pre-registered client today. Claude Code and Claude.ai prefer client ID metadata documents (`@better-auth/cimd`, which needs Better Auth 1.7.6) and fall back to dynamic registration. Decide which to support and how an organisation approves such a client" — gates "Claude.ai connectors without manual client setup". ID is pinned to Better Auth 1.7.2 (`docs/02-plan.md:11`).
- Build order step 5 (`docs/02-plan.md:33`): "Not yet: DCR/CIMD and resource-server metadata/integration; prove external Claude path."
- Gate **E3** (`reports/answerable-id-release-decision-plan.md:39`): "Actual Claude Code version/config and MCP resource metadata/verifier; supported registration path → External discovery, registration or explicitly supported pre-registration, truthful consent, bound token and resource call. DCR/CIMD and resource-server integration are Not yet here; a client requiring them remains blocked."
- Backlog: "DPoP for external MCP clients" (`docs/02-plan.md:70`).

### 3.2 What was verified (`/Users/anthonyriera/code/answerable/reports/mcp-foundation-evidence.md`)

Versions: Bun 1.3.1; MCP TypeScript SDK (server, client, core) 2.1.0; MCP Apps 2.0.0; JOSE 6.2.12; Zod 4.6.5; Playwright 1.63.0 Chromium; Better Auth 1.7.2.

- Acceptance (official SDK OAuth client + Chromium, two then three organisations): discovered ID from the MCP's 401; PKCE S256; the MCP URL as `resource`; ID's `iss` in the callback (RFC 9207); audience-bound tokens with the resource's 60-second lifetime; 2025 and 2026-07-28 clients both reach tools, prompt and resource; records stay within the organisation; a second MCP refuses the token; the client refreshes by itself; disabling the organisation stops refresh while the issued token lasts. Partial entitlement (`mcp-gamma`): consent page names `e2e:write` as not approved; token `scope` = the entitled subset; only covered tools listed; refresh keeps the subset. Asserted in `mcps/e2e/scripts/acceptance.ts:143-149,181,229-230,272`.
- **Claude Code, by hand**: "Claude Code 2.1.281, added with `--client-id claude-code-local --callback-port 47700`, signed the owner in through local ID and the Answerable Microsoft Entra tenant. It called `identity_get`, created a record and listed it, speaking protocol version 2026-07-28 without sessions. ID's audit log shows one authorisation and one code exchange for the resource `http://localhost:47500/mcp`. With a 300-second lifetime, Claude Code then refreshed before every request (15 refreshes in 70 seconds). With 900 seconds, it made three calls after one refresh." Resources used from Claude Code are registered with `accessTokenTtl: 900`.
- Not yet tried: a partial entitlement in Claude Code by hand. Limits: local test issuers, a pre-registered public client, loopback HTTP; "does not certify Claude.ai, another host, another company directory or a production deployment".

### 3.3 Registration recipe for Claude Code (`apps/web/content/docs/mcp/claude-code.mdx`)

- `claude mcp add --transport http answerable-e2e http://localhost:47500/mcp --client-id claude-code-local --callback-port 47700`; then `/mcp` → Authenticate.
- Resource: `classification: "platform_shared"`, `organizationId: null`, `identifier` = the MCP URL ("It must match `MCP_RESOURCE_URL` exactly: `localhost` and `127.0.0.1` are different resources"), `allowedScopes` including `offline_access`, `accessTokenTtl: 900`.
- Client: `tokenEndpointAuthMethod: "none"` ("Claude Code runs on your machine, so it has no secret; PKCE protects the code"), grants `authorization_code` + `refresh_token`, `redirectUris: ["http://localhost:47700/callback"]` ("must match `--callback-port` exactly"), scopes `openid offline_access` + the MCP scopes; then the client→resource link.
- Per organisation: capabilities for both grant kinds, login (`resource: null`, `openid offline_access`) and pair (`resource` = MCP, MCP scopes), plus the two entitlements.
- "Claude Code asks for every scope the MCP lists. ID issues the ones the organisation is entitled to, and Claude Code sees only the tools they cover."
- Claude.ai and Claude Desktop connectors: "They connect from Anthropic's servers, so they cannot reach `localhost`. Register `https://claude.ai/api/mcp/auth_callback` as the redirect URI and enter the client ID under the connector's advanced settings once the MCP has a public URL: Not yet tested." Automatic registration: "ID supports neither: Not yet."
- Errors: "Access is unavailable for this organisation" (missing capability/entitlement), `invalid_redirect` (callback port), `invalid_target` (resource unknown/unlinked/spelled differently), `invalid_client`, `401` after sign-in (issuer/resource mismatch).

### 3.4 Protocol versions and what the model sees

- The base "serves both the 2026-07-28 and 2025 protocol versions" (`packages/mcp-base/README.md:13`; `docs/07-mcp-platform-draft.md:19`: "One definition serves the 2026-07-28 revision and falls back to stateless 2025 serving"). Tests pin `2026-07-28` via `versionNegotiation: { mode: { pin } }` (`packages/mcp-base/src/testing.ts:5`, `mcps/e2e/scripts/acceptance.ts:121-126`).
- Tool results on `main`: `{ structuredContent: data, content: [{ type: "text", text: result.text }] }` (`packages/mcp-base/src/definitions.ts:88`); errors `{ isError, content: "code: message", _meta: { code } }`. Authoring guide: "`execute` returns `data` (checked against `output`) and `text` for hosts that ignore structured content" (`apps/web/content/docs/mcp/authoring.mdx:66`).
- **Measured, untracked note** (`/Users/anthonyriera/code/answerable/.claude/worktrees/mcp-sdk-dx/findings.md`, H5): three probes with Claude Code 2.1.282 showed "Claude Code shows the model ONLY structuredContent when present; the author's required `text` is invisible there." The same note records: `/health` sits behind the Host check (403 for a pod-IP probe, H4); the SDK already parses input before the handler so a second parse breaks non-idempotent transforms (H6); output parsing strips undeclared keys (P5, kept as data minimisation); SDK request bodies cap at 4 MiB. These fixes and the API reshape (`@answerable/mcp`, `createMcpServer`, execute returns output, base sends structuredContent plus JSON text, in-process test client) are on **open PR #11** (branch `claude/mcp-sdk-dx`, head 7af150b), not on `main`.
- SDK client behaviour (`.claude/worktrees/id-scope-subset/findings.md`, untracked): "MCP SDK client 2.1.0: requests PRM scopes + offline_access; adds `prompt=consent` when offline_access is requested; saves the token response as-is (no scope check); refresh sends no `scope`."

### 3.5 Token contract a consumer must honour

- `packages/auth/README.md`: keys from the issuer's RFC 8414 metadata, `jwks_uri` on the issuer's origin, never from a token; `at+jwt` signed EdDSA/ES256/RS256; resource URL in `aud`; unexpired; ID user and organisation claims; no `cnf`; HTTPS or loopback HTTP; every rejection is a detail-free `AuthenticationError` answered with a 401 challenge; verification is offline, so "an issued token stays valid until it expires. Constrain every query by `organizationId`."
- `apps/web/content/docs/id/oauth.mdx:63-75`: login-only access tokens are opaque; service tokens are JWTs whose `aud` includes the resource; an ID token is not a service token; `subject_type` `user` or `client`; `resource_instance`; native TTL from provider defaults and configured resource lifetimes; the grant context expires after 30 days. Line 114: revocation does not reach issued JWTs; "the server must verify its signature, issuer, audience, expiry, user subject and tenant claims, and enforce its own current-authority contract."
- Gate E5 asks for "actual consumer JWKS cache settings" and rotation/outage behaviour "with each real verifier"; `reports/id-production-oauth.md:263-265` lists "JWKS caching/stale-serving behaviour in each consumer library". ID's own JWKS cache is five minutes (`docs/06-deploying-answerable-id.md:14`).

---

## 4. `apps/web` `/oauth-test`: the dev-only OAuth consumer (brief)

Files: `/Users/anthonyriera/code/answerable/apps/web/lib/oauth-test/client.ts` (the client), `handler.ts` (route logic), `runtime.ts` (env + singleton), `apps/web/app/oauth-test/page.tsx`, `apps/web/app/api/oauth-test/[action]/route.ts`; documented in `apps/web/README.md:18-35`.

What it demonstrates:

- A **confidential** OIDC client (`client_secret_basic`, client `answerable-web-local`, `skipConsent` false) that discovers ID at `/.well-known/openid-configuration`, checks `issuer` equality and that every endpoint shares the issuer origin, and never reads ID cookies, root credentials or the ID database.
- Authorisation-code flow with PKCE S256, `state` and `nonce`; scopes fixed at `openid profile email offline_access` — **login-only, no `resource` parameter**, so it does not exercise MCP/service tokens.
- ID-token verification against ID's JWKS (RS256/ES256/EdDSA, `aud` = client id, `azp` check, nonce at code exchange only), `iss` check on the callback, refresh with rotation (a failed refresh drops both tokens and is never retried), revocation (refresh then access, with `token_type_hint`), and local logout that leaves the ID browser session alone.
- Operational shape: tokens only in bounded server memory (1000 entries; pending 10 min, session 1 h), opaque HttpOnly cookies, origin checks on POSTs, 404 in production, provider responses never reach page or logs.
- Env: `OAUTH_TEST_ISSUER`, `OAUTH_TEST_CLIENT_ID`, `OAUTH_TEST_CLIENT_SECRET`, `OAUTH_TEST_REDIRECT_URI` (`http://localhost:47100/api/oauth-test/callback`); listed in `default.env:70-73`.
- `docs/07-mcp-platform-draft.md:13`: "the app sign-in client in `apps/web/lib/oauth-test` has one consumer, so it stays there." Browser acceptance recorded in `reports/id-production-oauth.md:210-215`.

---

## 5. Documentation conventions the new design documents must match

### 5.1 Docs site (`apps/web/content/docs`, Fumadocs at `/docs`)

- Navigation is `meta.json` per folder. Root `meta.json`: `{"title":"Docs","pages":["index","id","mcp"]}`. `mcp/meta.json`: `{"title":"MCP servers","pages":["index","authoring","local-testing","claude-code"]}`. `id/meta.json`: `index, sign-in, oauth, manage, onboard, api, admin-api`. A new page must be added to `pages`.
- Frontmatter `title` and `description` are mandatory and enforced at build in `/Users/anthonyriera/code/answerable/apps/web/lib/source.ts:12`: `schema: pageSchema.extend({ description: z.string().min(1) })`. The description becomes the canonical tag and the OG image (`getPageImageUrl`); OpenAPI pages get a fallback description.
- `/llms.txt` is `llms(source).index()`, `/llms-full.txt` joins `getLLMText` over every page, and `app/llms.mdx/docs/[[...slug]]/route.ts` serves each page as Markdown; all are derived from the source, so a new MDX page is picked up automatically, while a new non-docs route needs the AGENTS.md check.
- Page pattern (`mcp/index.mdx`, `mcp/claude-code.mdx`, `mcp/local-testing.mdx`): frontmatter → **a copy-pasteable command block first** → one paragraph on what it does → `## Status` or numbered "How a request is authorised" → tables (`| Package | Responsibility |`) → `## Limits` → `## Errors` table with columns `Error | Meaning | What to do` → a closing "Continue with …" line. Bold lead terms open paragraphs (`**Resource.** …`, `**Lifetime.** …`). "Not yet." is literal, often followed by "tested" or a link to the plan. Sentence-case headings, British spelling, cURL before prose, no images.

### 5.2 `docs/` house style

- The TL;DR block appears in `docs/00-orientation.md`, `docs/01-architecture.md`, `docs/06-deploying-answerable-id.md` and all four tutor docs; `docs/02`, `03`, `04`, `05`, `07` open with a plain paragraph instead. Exact blocks:

`docs/00-orientation.md` lines 3-6:

```
> **TL;DR**
> - **Decides:** what the words mean, who the actors are, and the problem Answerable ID solves.
> - **Rule:** one identity for every product and every client; `sub` is the only join key.
> - **Not here:** how it fits together (`01-architecture.md`), how we build it (`02-plan.md`), the design itself (`03-answerable-id.md`).
```

`docs/01-architecture.md` lines 3-6:

```
> **TL;DR**
> - **Decides:** how the pieces fit, the golden rule every service obeys, and the stack.
> - **Rule:** Answerable ID mints identity; nothing else does.
> - **Not here:** the design itself ([`03-answerable-id.md`](03-answerable-id.md)) — this page is the map, that document is the territory.
```

- `docs/07-mcp-platform-draft.md` (the closest precedent for an MCP design doc) is structured `## Purpose` → `## Packages` (table `Workspace | Responsibility`) → `## Decisions` (paragraphs each opening with a bold decision name, for example `**Official SDK primitives.**`, `**Two settings.**`, `**Scopes decide visibility.**`, `**Offline verification.**`, `**Views.**`, `**Acceptance through the real product.**`) → `## Not yet` (bullets linking `Q-` IDs).
- Other conventions: **Not yet.** in bold, present tense only for what exists (`docs/03` uses "Not yet validated", "Not yet" 8 times); open questions carry stable `Q-` IDs in the register table (`ID | Question | Gates | Resolve by`), "never renumber", resolve into the design and delete the row; a "Do not re-propose" list; "Dates and headcount in the docs — order, not time" (`docs/02-plan.md:80`), the only date being `Last updated 2026-09-25` on the plan; Mermaid `sequenceDiagram`/`flowchart TB` blocks in 00/01 and the tutor docs; tables for facts with a `Consequence` and `Source` column (`02-integration-facts.md`); reports use dated `##` sections, a `Check | Result` table, then "What the acceptance proved", "Found by testing", "Not yet tried", "Limits" (`reports/mcp-foundation-evidence.md`).
- Style: Prettier without semicolons in `apps/web`, `packages/ui`, `packages/countries`; with semicolons in `apps/id`. Commit messages imperative, sentence case, no prefix, no trailing period.

---

## 6. Sweep for named concepts

| Term | Hits outside `.claude/worktrees` | Verdict |
| --- | --- | --- |
| Palantir | none | Absent |
| Toolbox | none | Absent |
| capability catalogue / catalog | none as a phrase. "Catalogue" appears only for the migration catalogue (`docs/04-answerable-id-schema.md:7`, `apps/id/src/__tests__/migration-catalog.json`); "Tool catalog" / "Keep the catalog small" in `apps/community-mcp/docs/03-tools-and-ui.md:14,17` and `02-integration-facts.md:46` | Related idea (small tool catalogue) but not the phrase |
| Executor | only the Drizzle database executor type `export type Executor` at `apps/id/src/db/client.ts:50` (211 TS files import it) | Unrelated |
| ToolHive | none | Absent |
| Temporal | none | Absent |
| "Answerable Control" | none; nearest is the "community-control module" (`apps/community-mcp/docs/04-community-control.md`) | Absent |
| sandbox | iframe `sandbox="allow-scripts"` (LibreChat renderer, `02-integration-facts.md:52`; `mcps/e2e/src/apps.test.ts:23`); Circle "Sandbox: None" (`02-integration-facts.md:124`); Codex/Turbo run sandboxes in `reports/id-operations.md:129`, `reports/id-production-oauth.md:253`, `reports/id-release-acceptance.md:65` | No code-execution sandbox concept |
| run_code | none | Absent |
| prepared mutation | none; nearest are "49 mutations require idempotency keys" and the operation journal (`docs/03-answerable-id.md:119`, `reports/answerable-id-mutation-inventory.md`) | Absent |
| approval | many hits, all meaning platform approval of capability ceilings ("Registration is not approval", `apps/web/content/docs/id/manage.mdx:688`; "Only platform writers approve ceilings", `docs/04-answerable-id-schema.md:170`; "One approval does not approve another", line 178) | No human-in-the-loop tool-call approval concept |
| GraphQL | none | Absent |

---

## 7. Requirements a consumer-facing architecture can cite directly

1. Every hosted MCP is an OAuth resource server of ID: RFC 9728 metadata, 401 challenge with `resource_metadata`, local `at+jwt` verification against ID's JWKS, exact `aud` = the registered resource URL, queries constrained by `organizationId` (`docs/01-architecture.md:60-63`, `packages/auth/README.md`, `apps/web/content/docs/mcp/index.mdx:19-25`).
2. Hosts today need a **pre-registered client**; automatic registration is `Q-MCP-CLIENT-REGISTRATION`. Claude Code: public client, `none` auth, PKCE, loopback redirect on a fixed port, 900 s access tokens. Claude.ai/Desktop: redirect `https://claude.ai/api/mcp/auth_callback`, public URL required, untested. OmniChat: one `private_key_jwt` client per cell with a `jwksUri`, per-user MCP OAuth with a silent first-party bounce, `resource` sent by the fork (unverified), per-user encrypted token storage and refresh rotation in the cell.
3. Scopes decide visibility: ID issues the entitled subset; the server lists only covered definitions; organisation admins, not end users, control entitlements (`docs/07-mcp-platform-draft.md:23`).
4. Revocation reaches consumers only through token expiry (offline verification); keep lifetimes short; a denylist-style instant kill switch is the tutor's answer to that gap.
5. Hosts differ in what reaches the model: LibreChat surfaces tools only (no resources/prompts/elicitation/sampling; legacy mcp-ui HTML), Claude Code shows `structuredContent` only when present, the SDK client asks for every PRM scope plus `offline_access` and adds `prompt=consent`.
6. Fork-side timeouts (30 s default, 60 s configured) and idle disconnects (15 min) bound tool budgets; SSE needs unbuffered ingress with keepalives.
7. The named external gates before any of this is "validated": E2 (actual fork and test cell), E3 (actual Claude Code and supported registration path), E5 (real verifier caches, rotation, outage), E8 (Circle matching, only if Circle cuts over).
