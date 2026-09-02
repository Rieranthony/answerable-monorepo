# Plan

> **TL;DR**
> - **Decides:** how we build Answerable ID, in what order, and what is still open.
> - **Rule:** order, not time — nothing ships without a failing test first and full coverage; the design doc is canonical, this page is the build sheet.
> - **Not here:** the design ([`03-answerable-id.md`](03-answerable-id.md)); the parked tutor MCP (`apps/community-mcp/`).

Last updated 2026-09-02. This is the only file that carries dates.

## How we build

- **AI writes the code, test-first.** Every change starts from a failing test (`bun test`); CI enforces **full coverage of our own code** via `bun test --coverage` thresholds. No human timeline — this plan is a dependency order.
- **Bun everywhere, including production**; **Hono**; **Postgres for all state**, sessions included; **Redis** as a read cache later.
- **Admin API first.** Organizations, domains, groups, clients, resources, entitlements, and users are managed through typed Hono routes under `/api/admin`, backed by services and grouped query modules. OpenAPI is the supported contract; Better Auth's organization mutation routes are not.
- **No CDN/WAF** in front of our services for now; TLS at the ingress.
- **Better Auth is the base.** Version floor `@better-auth/oauth-provider` ≥ 1.7.0, pinned; advisories subscribed; upgrades treated like fork rebases. House behavior = custom plugins.
- **Route allowlisting, not denylisting.** Better Auth exposes far more endpoints than we use; an endpoint inventory + public allowlist is a test that runs on every upgrade.

## Local environment

`bun dev` starts [`docker-compose.yml`](../docker-compose.yml) — Postgres (47432; `answerable_id` + `answerable_id_test`) and Redis (47379; reserved) — then the apps. Answerable ID runs on the host at `http://localhost:47300`. Env template: [`.env.example`](../.env.example). Upstream IdPs are stubbed inside the test suite (an in-process OIDC issuer signing tokens with the claims federation pins on: `tid`, `hd`, `email_verified`); Entra-specific process (admin-consent, publisher verification, Graph) is only provable in the validation spike against a real tenant.

## Build order

Dependency order with exit criteria; no dates. Steps map to the design doc's §Rollout: step 0–1 = its phase 1 (validation spike), steps 2–8 = the build, step 9 = phase 2 (infrastructure), step 10 = phases 3–5.

| Step | Work | Exit criteria |
| --- | --- | --- |
| 0 | **Decisions + procurement** | Code location resolved to `apps/id`; `Q-PUBLISHER-VERIFICATION` started now; `Q-SECRET-STORE` chosen; Better Auth pinned |
| 1 | **Schema foundation** | Bun + Hono + Better Auth 1.7.2 + Drizzle skeleton; UUIDv7 schema in [`04-answerable-id-schema.md`](04-answerable-id-schema.md); `/healthz`, `/readyz`, admin OpenAPI infrastructure, disposable-database schema push, full-coverage tests, and a deny-by-default Better Auth HTTP allowlist. Production migration and admin write routes follow schema approval |
| 2 | **Organizations + upstream federation** | SSO plugin; per-org tenant-scoped issuer rows; against the in-test IdP stub: own org accepted, foreign directory rejected (issuer + `tid`), guests rejected by default, personal Google (no `hd`) rejected; ambiguous email-domain mapping fails closed; multi-org users choose at login and the token carries exactly one org |
| 3 | **OIDC provider for apps** | First-party clients with `private_key_jwt`; the extra-param that routes a login to the org's IdP; auto-redirect; discovery + JWKS conformance tests; a stub "cell" logs in end to end |
| 4 | **Entitlements** | The `{org, group or user, client or resource, scopes, status}` table from [`04-answerable-id-schema.md`](04-answerable-id-schema.md); the single policy runs at authorize, refresh, and client-credentials; negative tests for cross-org access, audience swapping, unentitled clients, registration-granted scopes |
| 5 | **OAuth 2.1 AS for MCP servers** | RFC 8707 `resource` binding; RFC 9728 metadata for resource servers; registration policy (three client classes, CIMD preferred, DCR restricted, PKCE S256 everywhere, exact redirect URIs, loopback for CLIs, hardened CIMD fetching, consent screen shows name + origin verbatim); a stub resource server verifies tokens via `packages/auth`; `Q-RESOURCE-PARAM` + `Q-FORK-PATCHES` answered against the fork |
| 6 | **Identity linking + migration** | Bulk import as inert records; binding on `(tid, oid)` / `(issuer, sub)` at first login; duplicates/changed emails fail closed; `legacyOpenidId` preserved; rollback = environment change, tested |
| 7 | **Lifecycle** | Bounded sessions; upstream re-check as a **top-level redirect** (not an iframe — `Q-AID-RECHECK`); refresh rotation with reuse detection (family kill); back-channel logout emission; admin kill switch (`ocadmin deactivate-users`); background delegation that outlives the browser session and re-checks at every renewal; audit log + "token after deprovision" alert; the offboarding targets (no new tokens ≤ 5 min, all access expired ≤ 15–30 min) as tests |
| 8 | **Keys + custody** | KMS-backed signing or a KEK outside Postgres (`Q-AID-KMS`); key lifecycle generate → publish → activate → retire → revoke with JWKS overlap; emergency rotation runbook rehearsed; `private_key_jwt` client credentials per cell |
| 9 | **Infrastructure** | Civo isolated network, K3s, managed Postgres, backups via the existing hourly pipeline + rehearsed restore, headscale ACLs, split listeners with `/authorize` public (`Q-AID-LISTENER`); single node first or HA day one (`Q-AID-HA`); no CDN (`Q-AID-CDN`) |
| 10 | **Dogfood → cutover → waves** | `test` cell migrated; Circle SSO cutover only after `Q-MEMBER-MATCH`; fleet migration in waves with the old Entra registrations kept alive per tenant; the tutor MCP un-parks as the first resource server |

## Validation spike (steps 0–1, against a real tenant)

The design doc's kill gate, verbatim in intent: real Entra admin-consent on the multi-tenant app with pinning proven; an OmniChat cell login through Answerable ID invisible to the user; **the fork's per-user MCP OAuth works** (silent bounce, encrypted per-user tokens, refresh rotation); external Claude Code end to end; entitlement denials at every grant; inert imports bind on `(tid, oid)`; lifecycle denials within the SLA; background delegation survives browser-session expiry and stops on deprovision; JWKS stale-serving in each consumer library; endpoint inventory verified from the public side.

## Open register

Stable IDs; never renumber. Resolve into the design doc or this page and delete the row.

| ID | Question | Gates | Resolve by |
| --- | --- | --- | --- |
| `Q-PUBLISHER-VERIFICATION` | Microsoft publisher verification for the multi-tenant app — weeks of process | The validation spike's first bullet | Start now (MPN + domain verification) |
| `Q-BUN-BETTER-AUTH` | Better Auth + its OAuth-provider, SSO, JWT, and organization plugins run correctly on Bun | Step 1 | First tests in the skeleton |
| `Q-AID-LISTENER` | The design says the tailnet-only listener handles per-user MCP connect, but connect is a browser bounce — `/authorize` + callback must be public; only `/token`/refresh can be tailnet | Steps 5, 9 | Decide in the skeleton's route layout |
| `Q-JWT-CONTRACT` | The claim contract for resource servers: `sub` is `public` (not pairwise); `email_verified` present; the entitlement claim name; whether back-channel logout reaches resource servers | Step 5 | Write it down in the design doc |
| `Q-RESOURCE-PARAM` | Does the fork's MCP OAuth client send RFC 8707 `resource`? | Step 5 | Spike against the fork; else default the audience from the client↔server link |
| `Q-FORK-PATCHES` | The living inventory of fork patches: extra-params, back-channel-logout receiver, refresh-grant fallback, whatever `Q-RESOURCE-PARAM` adds | Rebase burden visibility | List in the fork repo; link here |
| `Q-AID-RECHECK` | Hidden-iframe `prompt=none` re-checks fail under third-party-cookie blocking (Safari/Firefox) → top-level redirect, or upstream refresh-token probes (`offline_access`; Entra RT redemption fails `AADSTS50057` for disabled accounts) | Step 7 | Decide before step 7 |
| `Q-AID-GRAPH` | The read-only directory permission for background-delegation offboarding — some client IT will refuse; make it per-org optional with a bounded delegation lifetime as the fallback; revisit Continuous Access Evaluation | Step 7, consent ask | Product + step 7 |
| `Q-AID-KMS` | Does Better Auth's JWT plugin support KMS-backed signing reliably? If not, a KEK outside Postgres with the residual risk documented | Step 8 | Spike |
| `Q-AID-HA` | "HA from day one" vs starting single-node for the first migrated cell | Step 9 | Owners' call |
| `Q-AID-CDN` | The design fronts the public listener with Cloudflare; we run without a CDN/WAF for now — confirm the posture (JWKS/discovery caching, WAF) or its replacement at the ingress | Step 9 | Decide before step 9 |
| `Q-MEMBER-MATCH` | Does Circle SSO match returning members by email or `sub`? If `sub`, the cutover duplicates every member | The Circle cutover in step 10 | One test account on a trial/staging community |
| `Q-SECRET-STORE` | Doppler / 1Password / Infisical for runtime secrets | Steps 1, 8 | Ops preference |

## Backlog (after the fleet migrates)

RFC 8693 token exchange (built off the critical path, contributed upstream) · SCIM provisioning · DPoP for external MCP clients · second-region disaster recovery · transactional outbox for provisioning events · Redis session cache · SAML for odd IdPs · **the tutor MCP** (parked in `apps/community-mcp/`).

## Do not re-propose

- Email as a join key between systems — `sub` only.
- Identity inside the fork's database — apps consume identity through standard OIDC.
- Per-app registrations in client directories — one multi-tenant app, one consent per org.
- A standalone identity appliance (Keycloak) or a hosted IdP of record — Better Auth in our own service, our own Postgres.
- Client secrets on the multi-tenant app — certificate credential.
- Node in production, or a CDN/WAF in front, for now — Bun everywhere; TLS at the ingress.
- Dates and headcount in the docs — order, not time.
