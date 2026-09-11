# Answerable ID: design document

Answerable ID is a Bun/TypeScript identity broker and OAuth provider built on Hono, Better Auth 1.7.2 and Postgres. It has never shipped to production. The integrated foundation is implemented; real tenant, consumer and deployment acceptance remains open in the [release decision](../reports/answerable-id-release-decision-plan.md).

This is the current design. The [schema](04-answerable-id-schema.md) defines storage, the [foundation specification](05-id-enterprise-foundation.md) defines invariants, and the [build plan](02-plan.md) separates implementation from rollout.

## Problem

Applications need stable identity and common permission decisions across corporate directories. Consumer databases must not become the identity authority. Email, display names and organisation slugs can change and cannot identify security principals.

## What we're building

Upstream OIDC SSO, a global user directory, tenant memberships, OIDC login, user resource grants, machine grants and an administrative API are implemented. Browser pages live in `apps/web`; identity state lives in `apps/id`.

The [public guides](../apps/web/content/docs/id/index.mdx) document reachable behaviour. External registration, directory polling, remote logout delivery and a fleet cutover are **Not yet.** They remain in the [plan](02-plan.md).

## Architecture

Corporate IdP → Answerable ID → registered application or resource. Postgres owns sessions, native OAuth state, policy, audit and command receipts. Redis is reserved for later caching. Better Auth verifies the protocol; Answerable plugins bind verified state to current tenant policy.

Only allowlisted authentication routes are public. Administrative routes use typed Hono contracts, service contexts and transactionally rechecked authority. Schema owners, runtime processes and replay-retention jobs use separate database roles.

### How client organizations connect (upstream federation)

Platform staff configure domains and providers. Entra uses a tenant-specific issuer and verified `tid`; guest signals are rejected. Google requires the configured hosted domain and verified email. Generic OIDC requires the configured issuer and verified email/domain. DNS self-verification, guest opt-in and self-service provider configuration are **Not yet.**

A session records its exact account, provider UUID/revision, authenticated tenant and verified upstream authentication time. That tuple is immutable. Missing upstream `auth_time` remains unknown; broker creation time is not substituted.

A human can exercise tenant authority only after that tenant's own current SSO. Membership alone conveys no trust in another tenant's login. Platform staff authenticate through platform SSO and need explicit platform permissions to administer other tenants.

Verified linking at `POST /auth/sso/link` requires fresh source and independent target proofs. It binds an unowned upstream identity to the existing global user UUID. It never merges by email, transfers an already bound identity, adopts an imported identity or silently restores revoked membership. See [sign-in](../apps/web/content/docs/id/sign-in.mdx).

### How our apps connect (downstream)

Registered applications use authorisation code with PKCE. Discovery is at the issuer's root; JWKS is at `/auth/jwks`. Public, shared-secret and `private_key_jwt` clients use their configured authentication method.

Each browser flow has one server-owned reference, canonical request and terminal state. Selection binds one immutable grant context. Each new flow requests consent unless staff explicitly configure the first-party `skipConsent` bypass. Concurrent tabs cannot change each other's context.

### How MCP servers connect (downstream)

A resource request supplies its exact registered RFC 8707 `resource` identifier. A resource access JWT carries that audience, tenant UUID and immutable subject/client/resource/grant identities. The resource must validate signature, issuer, allowed algorithm, token kind, time, audience and its own tenant routing. A platform tenant claim is not a universal resource-data bypass.

Resource-server metadata and actual MCP client compatibility are consumer work. Local issuer tests do not certify Claude Code or OmniChat.

## Organizations, users, and tokens

| Identity | Current contract                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| User     | Global UUID; public user `sub`. Email is display/routing data.                                                   |
| Member   | UUID joining a user to one tenant; status, validity and revocation govern eligibility.                           |
| Client   | Immutable instance UUID, public client ID, owner and authorisation version. Retired identifiers remain reserved. |
| Resource | Immutable instance UUID, identifier, shared/private classification and owner.                                    |
| Grant    | Immutable user/member/tenant/client/resource and authentication snapshot; revocation retained.                   |
| System   | Persisted platform organisation, admin resource and staff group binding; slugs confer no privilege.              |

Login-only access tokens are opaque. Resource access tokens require `typ: at+jwt`; `aud` can be an array containing the resource. ID tokens require `openid`, are for the client audience and cannot serve as resource bearer tokens. Code-flow ID tokens carry the request nonce; refresh does not repeat it. `auth_time` is broker authentication time, while nullable `upstream_auth_time` is verified IdP evidence.

Permission intersects live identities, own-tenant authentication, effective membership, registration, exact links, capability ceilings, matching assignments and requested scopes. Login and resource permission are separate. Refresh requires its own matching ceiling, including login-only grants. Unrelated assignments cannot create a new pair.

The default grant lifetime is 30 days and browser flow lifetime is ten minutes. Token lifetimes follow the pinned provider's configured bounds; consumers use the returned expiry. Optional refresh reuse is bounded by `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS` (default zero) and rechecks current policy before returning cached tokens. See [OAuth](../apps/web/content/docs/id/oauth.mdx).

## Lifecycle: joiners, movers, leavers

| Action                            | Local effect                                                                           | Separate exposure                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Browser expiry/sign-out           | Ends the browser session                                                               | Previously authorised refresh delegation can continue.            |
| Administrative session revocation | Revokes selected session and bound stored grants/tokens                                | Offline JWTs and downstream sessions have separate checks/expiry. |
| Tenant member removal             | Revokes membership, removes assignments and revokes its grants                         | Other tenants and the global user survive.                        |
| Explicit reinstatement            | Can restore an eligible revoked membership                                             | Removed assignments and revoked grants stay removed/revoked.      |
| Global user disable               | Denies new authority and reconciles remaining local credentials/grants                 | Remote session termination is not implied.                        |
| Product deletion                  | Terminal `deletedAt`, credential clearing/revocation, ordinary read/eligibility denial | Historical data remains; physical purge is deferred.              |

Deleted product rows cannot be re-enabled, rebound or reinstated. Replacement relationships receive fresh UUIDs where live uniqueness permits. User deletion retires email and retains profile/account bindings; this is not anonymisation. Organisation deletion preserves global people and browser sessions, clearing its session selection. Audit remains attributable by UUID. No named-identity recovery feature or purge-duration approval is required.

## How MCP authentication works

### External: clients' own AI tools (Claude Code, Claude Desktop, etc.)

The implemented path uses an administratively registered client, PKCE and explicit consent. DCR, CIMD, device flow, PAR and introspection are closed. A tool requiring these cannot be declared compatible without implementation or an explicitly supported pre-registration configuration.

### Internal: AI agents inside OmniChat cells

The intended cell uses OIDC login and per-user resource grants. Its fork must send `resource`, separate users' credentials, store them safely and handle rotation/reuse. **Not yet validated against the actual fork.** The [consumer checklist](../reports/answerable-id-release-decision-plan.md#external-input-and-test-checklist) retains this gate.

### Background work: scheduled and deferred runs

Refresh grants can survive ordinary browser sign-out. Their immutable snapshot still requires a live account, current provider revision, effective membership and current policy. A grant cannot silently move tenant or resource.

**Not yet:** Graph polling or another bounded upstream-disable detector, durable downstream logout delivery and a separately managed background-delegation product. Current refresh behaviour does not establish five-minute upstream-disable detection.

### The golden rule

Local revocation, offline JWT expiry and downstream application session termination are three different observations. Measure each in consumer acceptance.

## Registration policy: how external tools connect

Registration is platform administration, not permission. Clients require configured redirect/authentication policy and independent capability/assignment approval. No public registration endpoint is exposed. The broader external registration policy remains **Not yet** in the [plan](02-plan.md).

## Keys and credential custody (non-negotiable)

Retained signing keys use Better Auth application-secret encryption. Upstream tokens and secret-bearing operation results use separate key rings. Secrets never belong in audit evidence.

The [operations runbook](../apps/id/OPERATIONS.md) covers custody preflight, retained-key dependencies, replay cipher expiry and negative recovery verification. External secret delivery and emergency rotation require the intended deployment. No KMS-backed signing or secret-store operator has been selected here.

## Availability and failure modes

Handlers and public authentication have admission bounds; pool checkout, statements and request bodies have limits. Successful effects, audit, subjects and receipts share the local transaction. Failed commit cannot produce a valid success.

Bounds are not fairness guarantees. T4's synthetic saturation caused tenant B OAuth to return 503; dense global deletion caused one B read to return 503. These are disclosed limits, not accepted production budgets. See [capacity evidence](../reports/id-operations.md).

## Hosting

Bun runs in production, with TLS at ingress and no CDN/WAF for now. `https://id.answerable.org` is the documented configuration example, not evidence of a deployed issuer. Topology, replica count, databases, URLs and listener policy remain external inputs.

## Tailnet hardening

The service must be reachable only through the ingress proxies listed in `TRUSTED_PROXY_CIDRS` (comma-separated IPv4/IPv6 networks). Network rules must refuse traffic that does not arrive through those proxies. The ingress supplies `x-forwarded-for`; Better Auth walks it from the right, skips listed proxies and selects the first untrusted address. The same resolver supplies rate-limit keys, session IPs and administrative/sign-in audit IPs. In production, unresolved addresses on `/auth/*` and `/api/admin/*` receive `403 {"error":"untrusted_ingress"}`, `Cache-Control: no-store` and a request ID before authentication, with no audit event. Health and readiness remain reachable. The header resolver cannot verify the socket peer; the network restriction is required.

Browser authorisation and callbacks must be reachable from the browser. Public/tailnet exposure must be tested at actual ingress; an in-process allowlist does not prove network isolation. No particular ACL or split-listener deployment is certified.

## Security posture

Sensitive human commands and linking require verified upstream authentication within five minutes. Reauthentication uses `POST /auth/sso/reauthenticate` with native `prompt=login`, `max_age=0`. Authority/freshness is checked before replay and after relevant waits. Ordinary display edits and reads follow route metadata; machines/root retain their own authority contracts.

All 49 mutations require idempotency keys. Conditional changes require current revisions. Replay still requires current authority. Audit covers successful effects and bounded rejection facts without attributing unverified client claims. See the [mutation inventory](../reports/answerable-id-mutation-inventory.md).

## Omni Accelerator / Circle consolidation

**Not yet.** Circle matching and rollback must be tested before its cutover. This is not a prerequisite for an unrelated first consumer.

## Rollout

### 1. Validation spike (kill gate)

Use one candidate and real tenant. Prove Entra consent/pinning, OmniChat login, per-user MCP credentials/refresh, external Claude Code, exact-pair denials, upstream/local offboarding, downstream session termination, keys and recovery. Required upstream-disable → new-grant refusal is at most five minutes; the selected access-exposure target is 15–30 minutes. These are requirements, not measurements.

### 2. Infrastructure

Supply topology, ingress, capacity/latency budgets, custody operator, backups, RTO/RPO and an independent source of post-snapshot acknowledgements. Rehearse before admitting traffic.

### 3. Dogfood

Run the selected test cell using its actual version/configuration and verifier. A synthetic issuer test is insufficient.

### 4. Circle cutover

Requires matching evidence and tested rollback. This document authorises no cutover.

### 5. Fleet migration in waves

Requires earlier gates and per-cell identity mapping. ID itself needs no legacy production database conversion: it has never shipped.

### 6. Steady state

After deployment use forward migrations, bounded operational signals and retained-key recovery rehearsals.

### Per-cell migration mechanics

Bulk import tooling and actual cell rollback are **Not yet validated**. Immutable upstream identity is the join key. Do not derive directory `oid` from a pairwise client `sub` or merge by email. Consumer mapping is separate from installing the initial ID database.
