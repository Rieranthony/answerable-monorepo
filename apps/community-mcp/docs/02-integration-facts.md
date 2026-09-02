# Integration facts

> **TL;DR**
> - **Decides:** the verified external reality — what LibreChat (our fork's upstream) and Circle actually do — and the consequence of each fact.
> - **Rule:** facts here are sourced; anything unverified is an open item in [`02-plan.md`](../../../docs/02-plan.md), not a silent assumption.
> - **Not here:** our design choices ([`01-tutor-design.md`](01-tutor-design.md)); this file is rewritten by the M0 spikes.

Verified against LibreChat docs and source at `main` (v0.8.8-rc1; stable v0.8.7) and Circle's official OpenAPI 3.0.1 specs. The fork (OmniChat) may diverge from upstream — that divergence is what the Answerable ID spike checks.

## LibreChat (upstream of OmniChat)

Sources: [mcp_servers config](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers) · [MCP feature docs](https://www.librechat.ai/docs/features/mcp) · [mcp_settings](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_settings) · source files linked per row.

### Configuration and transport

| Fact | Consequence | Source |
| --- | --- | --- |
| MCP servers are defined in `librechat.yaml`; changes require a restart | Adding the tutor to a cell = a cell restart; budget it per wave | [mcp_servers](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers) |
| `type` must be explicit: an `http(s)://` URL with no `type` infers **legacy SSE** | Always `type: streamable-http` | same |
| Streamable-http recommended for production; SSE discouraged | We ship streamable-http only | [MCP feature docs](https://www.librechat.ai/docs/features/mcp) |
| Default tool `timeout` 30 000 ms, per-server configurable | `timeout: 60000`; tools budget ≤ 55 s | [mcp_servers](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers) |
| `mcpSettings.allowedAddresses` must list private hosts; private IP space is SSRF-blocked | Not needed for the public endpoint; required if a tailnet address is ever used | [mcp_settings](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_settings) |
| Tool keys allow `[A-Za-z0-9_.-]`; colliding normalized server names shadow each other | Server key `tutor`, snake_case tool names | [MCP feature docs](https://www.librechat.ai/docs/features/mcp) |

### Identity and OAuth

| Fact | Consequence | Source |
| --- | --- | --- |
| Full MCP OAuth: Authorization Code + PKCE, dynamic client registration, per-user encrypted token storage, refresh rotation, callback `{DOMAIN}/api/mcp/{server}/oauth/callback` | **The production path** — cells connect per user via OAuth against Answerable ID; the tutor receives only Answerable ID tokens | [MCP feature docs](https://www.librechat.ai/docs/features/mcp) |
| OAuth is auto-detected from the server (401 + `WWW-Authenticate` / protected-resource metadata); `requiresOAuth` can force it | The tutor publishes RFC 9728 metadata; no auth headers in yaml | same |
| Silent 401 recovery: one bounded refresh + reconnect per user and server | Expired tutor tokens refresh transparently | same |
| Per-user connections are isolated when a server is OAuth-protected; idle disconnect after 15 min (`MCP_USER_CONNECTION_IDLE_TIMEOUT`) | Stateless process; check sessions and member tokens live in Postgres | [`mcp/mcpConfig.ts`](https://github.com/danny-avila/LibreChat/blob/main/packages/api/src/mcp/mcpConfig.ts) |
| User-field header placeholders (`{{LIBRECHAT_USER_*}}`) exist for yaml-defined servers | Not used for identity — identity arrives in the OAuth token | [`env.ts`](https://github.com/danny-avila/LibreChat/blob/main/packages/api/src/utils/env.ts) |
| Servers with OAuth must be yaml-defined (UI-created servers can't carry these settings) | Admin-managed yaml, per cell, via Omni-Weaver | [MCP feature docs](https://www.librechat.ai/docs/features/mcp) |

### Capability surface

| Fact | Consequence | Source |
| --- | --- | --- |
| Only MCP **tools** are surfaced; resources/prompts are liveness probes only; client capabilities are empty — **no elicitation, no sampling** | Everything is a tool; user input arrives only via chat or model-mediated UI actions | [`mcp/connection.ts`](https://github.com/danny-avila/LibreChat/blob/main/packages/api/src/mcp/connection.ts) |
| `serverInstructions: true` injects the server's instructions for the agent | We ship the instructions string in [`03-tools-and-ui.md`](03-tools-and-ui.md#server-instructions) | [mcp_servers](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers) |
| Chat dropdown toggles a whole server; per-tool toggles exist only in Agent Builder | Keep the catalog small and safe by default | [MCP feature docs](https://www.librechat.ai/docs/features/mcp) |
| No per-user allowlist for yaml-defined servers | Authorization = Answerable ID entitlements + the tutor's own checks, never LibreChat visibility | [interface docs](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/interface) |

### MCP UI

| Fact | Consequence | Source |
| --- | --- | --- |
| Ships since v0.8.0; no enabling config | Available on any current deployment | [changelog v0.8.0-rc4](https://www.librechat.ai/changelog/v0.8.0-rc4) |
| **Only legacy mcp-ui `rawHtml`** (`ui://` resource, `mimeType: text/html`) renders; `externalUrl` and `remoteDom` are silently dropped | All UI is self-contained inline HTML | [`Renderer.tsx`](https://github.com/danny-avila/LibreChat/blob/main/client/src/components/MCPUIResource/Renderer.tsx) |
| mcpui.dev lists LibreChat as an "MCP Apps" host — inaccurate at `main` (legacy renderer, `@mcp-ui/client@^5.7.0`) | Target legacy mcp-ui; re-verify before adopting MCP Apps | [mcpui.dev hosts](https://mcpui.dev/guide/supported-hosts) |
| Sandbox `allow-scripts` only (opaque origin); requested permissions stripped; auto-resize on | Inline CSS/JS only; **links live in chat text, never in iframes** | Renderer.tsx |
| UI actions `tool`/`intent`/`prompt` are **model-mediated** (synthesized user message; the model decides); `link`/`notify` ignored | Buttons are conveniences; the server re-validates everything; every action has a chat fallback | [`handleUIAction`](https://github.com/danny-avila/LibreChat/blob/main/client/src/utils/index.ts) |
| Inline placement needs the model to echo a `\ui{resourceId}` marker; the resource always renders in the tool-call panel | Results end with an explicit marker line; the panel is the fallback | [`plugin.ts`](https://github.com/danny-avila/LibreChat/blob/main/client/src/components/MCPUIResource/plugin.ts) |

### Verify in the fork (spike items)

`Q-RESOURCE-PARAM` (does the OAuth client send RFC 8707 `resource`?) · `Q-FORK-PATCHES` (upstream has no back-channel-logout receiver) · whether UI renders identically in Agents vs plain chat · how reliably models echo `\ui{}` markers.

## Circle

Machine-readable specs (codegen the client from these): [Headless Auth](https://api-headless.circle.so/api/headless_auth/swagger.yaml) · [Member API v1](https://api-headless.circle.so/api/headless_client/v1/swagger.yaml) · [Admin API v2](https://api-headless.circle.so/api/admin/v2/swagger.yaml). Docs portal: <https://api.circle.so> (append `.md` to any page).

### API families and plan gating

| Family | Base | Auth | Plan | Used by |
| --- | --- | --- | --- | --- |
| Headless Auth | `https://app.circle.so/api/v1/headless/…` | Headless Auth token | Business+ | Control module (mint member JWTs) |
| Headless Member API | `https://app.circle.so/api/headless/v1/…` | Member JWT | Business+ | Tutor (member-scoped reads and completion writes) |
| Admin API v2 | `https://app.circle.so/api/admin/v2/…` | Admin token | Business+ | Control module only (fallback member search, fallback write) |
| Webhooks | Workflows UI action, **unsigned** | — | Circle Plus | Later (event ingestion; payloads re-verified via API) |

Our plan tier is `Q-CIRCLE-PLAN`. Sources: [admin quick start](https://api.circle.so/apis/admin-api/quick-start.md) · [headless docs](https://api.circle.so/apis/headless.md) · [webhooks help](https://help.circle.so/p/workflows/workflow-setup/configure-automation-workflows-to-send-webhooks) · [pricing](https://circle.so/pricing).

### Headless auth

```bash
curl -X POST "https://app.circle.so/api/v1/headless/auth_token" \
  -H "Authorization: Bearer $HEADLESS_AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"sso_user_id": "<answerable-id sub>"}'   # or {"community_member_id": 123} / {"email": "…"}
```

- Exactly one of `sso_user_id` (**preferred** — equals the Answerable ID `sub` after the Circle SSO cutover), `community_member_id`, or `email`.
- Response: `access_token` (**1 h**), `refresh_token` (1 month), `community_member_id`, `community_id`. Unknown identity ⇒ 404 `member_not_found`; the API never creates members.
- Auth endpoints are **MAU-exempt**; content endpoints bill. We re-mint rather than store refresh tokens.
- Post-cutover, `sso_user_id` resolves only for members who re-logged-in through Answerable ID — hence the fallback in [`04-community-control.md`](04-community-control.md).

Source: [headless quick start](https://api.circle.so/apis/headless/quick-start.md).

### Member API — endpoints we use

The member JWT means Circle enforces the member's own visibility (private/secret spaces, drip, paywalls) on every call — the reason all reads are member-scoped.

| Endpoint | Gives us | Notes |
| --- | --- | --- |
| `GET /spaces` | Course discovery | No course index exists: filter `space_type == "course"`; space id = `course_id`; `policies{}` per space |
| `GET /courses/{course_id}/sections` | Structure **with** per-lesson `progress.status` + drip/lock flags | Course % is computed by us |
| `GET /courses/{course_id}/lessons/{id}` | Lesson content | `rich_text_body.body` is TipTap JSON; `featured_media` (video, captions, chapters); `enforce_featured_media_completion` flag |
| `GET /courses/{c}/lessons/{l}/files` | Attachments | |
| `PATCH /courses/{c}/lessons/{l}/progress` | **Mark complete / revert** (`{"status": "completed" \| "incomplete"}`) | Called by the control module as the member; idempotent by value; Circle derives section/course completion and fires its triggers |
| `GET /advanced_search` | Search | `query` required; `type ∈ general\|posts\|comments\|spaces\|lessons\|events\|members`; space/topic filters; highlighted snippets; **lexical only** |
| `POST/GET/PUT /quizzes/{id}/attempts` | Circle-native quizzes | v1.1 `native_quiz` policy |

Pagination: `page`/`per_page` (default 10) with `{has_next_page, count, records[]}`. Member-API 401 messages are enumerated: "expired" → re-mint and retry; others → re-auth.

### Admin API v2 — control module only

| Endpoint | Purpose |
| --- | --- |
| `GET /community_members/search` | Fallback member lookup on the exact verified email |
| `PUT /course_lesson_progress` `{lesson_id, member_email, status}` | Fallback progress write only (`Q-ADMIN-TRIGGERS`). Circle's API is addressed by email here — that is Circle's shape, not our join rule |

`POST /community_members` exists; the tutor never provisions. The admin token never leaves the control module's allowlist.

### Constraints

| Constraint | Value | Consequence |
| --- | --- | --- |
| Rate limit | 2000 requests / 5 min **per IP**, all APIs | One replica; process bucket 4 r/s; per-user/org limits; caches — [capacity math](01-tutor-design.md#capacity-and-rate-limits). Source: [usage & limits](https://api.circle.so/apis/admin-api/usage-and-limits.md) |
| Headless billing | Per MAU (unique members touching content APIs per month); allowance and overage conflict across Circle's sources (`Q-CIRCLE-QUOTAS`) | MAU circuit breaker in the [plan](../../../docs/02-plan.md#cost-model-fill-in-from-q-cost-inputs). Source: [headless usage & limits](https://api.circle.so/apis/headless/usage-and-limits.md) |
| Admin quota | 5k–250k requests/month by plan (sources conflict) | Fallback lookups once per member ever |
| Member JWT TTL | 1 h | Stored encrypted in `member_tokens` (reused ~55 min); Redis cache later |
| Lesson bodies | TipTap JSON | Transform with fallback + golden files |
| Sandbox | **None** | Hidden test space or second community (`Q-TEST-COMMUNITY`) |
| Webhooks | Unsigned, UI-configured, Circle Plus | Future ingestion re-verifies via API. Beware: `developers.circle.com` is a different company |

### Gaps and workarounds

| Want | Status | Workaround |
| --- | --- | --- |
| List a member's courses | No `/courses` index | `GET /spaces` filtered by `space_type` |
| Course-level % | No aggregate | Compute from `/sections` |
| Semantic search | Lexical only | Later: our own index |
| Event stream | Circle Plus only | Later: webhooks or polling |
| Lesson deep-link shape | Unverified | `Q-DEEPLINK`; prefer URL/slug fields on records, else `COMMUNITY_BASE_URL` + space slug |

### Circle SSO cutover

Owned by the Answerable ID rollout ([`03-answerable-id.md` §Omni Accelerator / Circle Consolidation](../../../docs/03-answerable-id.md#omni-accelerator--circle-consolidation)). The tutor-relevant fact: after the flag day, minting keys on `sso_user_id` = `sub`; before it, and for members who haven't re-logged-in, the fallback applies. `Q-MEMBER-MATCH` gates the date.
