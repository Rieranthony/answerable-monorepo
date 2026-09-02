# Answerable ID: Design Document

> Imported verbatim on 2026-09-01 from the team design document ("Answerable ID.md").
> This is the **canonical design for the identity service**; the rest of this repo's
> docs defer to it. It supersedes the identity/auth scope of the earlier
> `apps/platform` design (see [`docs/01-architecture.md`](01-architecture.md) for the
> reconciled picture).

## Problem

Our clients' employees log into our products using their corporate Microsoft or Google accounts. To make this work, each of our apps needs to be registered inside that client's identity system (Microsoft Entra ID or Google Workspace). Each registration comes with a client secret that expires on Microsoft's schedule.

This creates a scaling problem:

- **N apps × M clients = N×M registrations.** We have 63 SSO-configured client tenants today (74 total). Every new app we ship means emailing every client's IT team to create another registration, and managing another expiring secret per client.
- **We're about to start hosting MCP servers**, which makes this untenable. MCP servers are tool servers that give AI assistants capabilities like searching documents, querying databases, and running workflows. We're building both per-client servers (handling sensitive data) and shared ones (like the Omni Accelerator training tutor). These servers are used in two ways: by the AI assistant inside our chat product (OmniChat), and by clients connecting their own tools (Claude Code, Claude Desktop, etc.). The second case (external tools) requires the MCP server to support dynamic client registration (DCR), a standard that lets an AI tool register itself on the fly. Microsoft Entra doesn't support DCR, so Entra alone can't be our authorization server for MCP.
- **There's no unified user directory.** Each app has its own user records. The Omni Accelerator community (on Circle.so) requires its own separate Entra provisioning machinery.
- **We don't control upstream LibreChat** (the open-source project our chat product forks). Identity shouldn't live in LibreChat's database. Our apps should consume identity through a standard protocol (OIDC) so we're not coupled to upstream's schema.

## What We're Building

**Answerable ID** is a new Node/TypeScript service, built on the **Better Auth** library, with its own PostgreSQL database. It lives at `id.answerable.org` and does three things:

1. **Identity broker.** Each client org's corporate login system (Entra, Google, etc.) is connected to Answerable ID once. From then on, every app and MCP server we build works automatically for that client's users, with no further IT involvement.
2. **Login provider for all our apps.** OmniChat, Circle, and any future app authenticates users through Answerable ID using standard OIDC. The user sees their normal corporate login screen; Answerable ID is invisible in the middle.
3. **Authorization server for all hosted MCP servers.** When an AI tool needs to call one of our MCP servers on behalf of a user, Answerable ID handles the OAuth flow: verifying the user's identity, checking they're allowed to use that server, and issuing a short-lived token scoped to that one server.

Better Auth is a TypeScript library with plugins for organizations, SSO federation, user management, JWT signing, and an OAuth 2.1 provider. We embed it in a dedicated service rather than using a standalone identity appliance (like Keycloak), because identity becomes product code our team owns and extends in our own language. The user directory lives in our own Postgres; entitlements, provisioning, and admin features are ordinary TypeScript, not Java extensions or admin-API choreography.

**Version floor: `@better-auth/oauth-provider` ≥ 1.7.0.** Better Auth had a batch of 13 security advisories in June 2026, including a critical one where tokens weren't properly locked to their intended server. The fix for that requires version 1.7.0 or later. We pin versions, subscribe to advisories, and treat upgrades as carefully as we treat LibreChat rebases.

## Architecture

```text
Client Entra orgs ──(one multi-tenant app; per-org tenant-scoped issuer,
                     admin-consent, tid-pinned)──────────────────────────┐
Client Google orgs ─(one Google OIDC app, hd-pinned)─────────────────────┤
Odd IdPs (later) ──(per-org OIDC/SAML registration)──────────────────────┤
                                                                         ▼
                                            ┌────────────────────────────┐
                                            │       ANSWERABLE ID        │
                                            │   Node/TS + Better Auth    │
                                            │   + PostgreSQL (Civo)      │
                                            │                            │
                                            │  Organizations (per client)│
                                            │  Entitlements (our code)   │
                                            │  OIDC provider (apps)      │
                                            │  OAuth 2.1 AS (MCP)       │
                                            │  Public + tailnet listeners│
                                            └──┬──────┬──────┬──────┬────┘
                                               │      │      │      │
                                          OmniChat OmniTable Circle MCP
                                           cells   /OmniAdmin       servers
```

### How client organizations connect (upstream federation)

Today, each client's IT team creates a separate app registration in their Microsoft directory for each of our apps. Under this design, they do **one thing once**: admin-consent to a single multi-tenant Microsoft app registration that we own. That's a 5-minute click, the same process Omni Accelerator clients already follow.

Inside Answerable ID, each client organization gets its own configuration row pointing to that client's specific Microsoft directory. The row uses a **tenant-scoped issuer URL** (`https://login.microsoftonline.com/<their-directory-id>/v2.0`), which means a login from the wrong company's directory is rejected by Microsoft itself before it even reaches us. We also check the directory ID (`tid`) in the returned token as a backup.

Details on the Microsoft app registration:

- **Certificate credential, not a client secret.** We're abolishing the secret-expiry treadmill for clients; our own app shouldn't be on it either.
- **Publisher verification required.** Some enterprise clients block unverified third-party apps; budget for attestation questions from larger clients.
- **One credential fronts every client directory.** That's the deliberate trade: one well-guarded key instead of 63 scattered ones. It makes key custody (covered later in §Keys) non-negotiable.
- **Guest users are rejected by default** (users from a different Microsoft directory, or with a `Guest` account type) unless an organization explicitly opts in.
- **A read-only directory permission** (reading user account status) is part of the consent ask, so we can detect client-side offboarding for users who have background jobs running. See §Background work for why this is needed. It's directory metadata only, not access to mail, files, or SharePoint.

**Google Workspace clients** connect through one Google OIDC app. Each organization is pinned to its Google hosted domain (`hd` claim); tokens from personal Google accounts (no `hd` claim) are rejected.

**Other identity providers** can be added later per organization via the SSO plugin's OIDC or SAML support. SAML is the least mature part of Better Auth; Entra and Google both use OIDC.

**How organization binding works:** each SSO configuration row is locked to one organization. The token's organization comes from that binding plus the user's current membership, never from session state or a request parameter the user controls. If someone's email domain maps ambiguously to multiple organizations, the system fails closed and routes to manual resolution. Users who belong to multiple organizations (consultants, joint-venture staff) choose their org at login; the issued token always carries exactly one.

### How our apps connect (downstream)

Every app (OmniChat, Circle, future apps) is a standard OIDC client of Answerable ID. LibreChat needs a small patch (~3 lines) to pass an extra parameter in the login redirect so Answerable ID knows which organization's IdP to route to. The existing `OPENID_AUTO_REDIRECT=true` setting means users go straight to their corporate login screen without seeing an intermediate page.

Each app authenticates to Answerable ID using `private_key_jwt` where possible (a keypair-based method that avoids shared secrets and their rotation). Each cell gets its own credential, never shared between cells. Downstream credential management doesn't disappear, but it becomes ours to automate through Omni-Weaver.

### How MCP servers connect (downstream)

Each hosted MCP server publishes metadata (per RFC 9728) telling clients "Answerable ID is my authorization server." Tokens are locked to one specific server using the `resource` parameter (RFC 8707), which requires `@better-auth/oauth-provider` ≥ 1.7.0.

Bespoke MCP servers that only talk to their own client's OmniChat cell are deployed on the **tailnet only**. They have no public internet exposure and no registration surface to attack. Only servers that external tools need to reach get a public, Cloudflare-fronted endpoint.

## Organizations, Users, and Tokens

**Organizations.** One Answerable ID organization per client, with a slug matching the Omni-Weaver tenant ID where one exists. Each org stores the client's email domains (seeded from the existing tenant YAML configs) and display name.

**Entitlements.** Not every client gets every app or MCP server. Better Auth has no built-in way to say "org X can use app A but not app B," so we build this ourselves. It's a single authorization policy, a check against a table of `{org, user, client/resource, scopes, grant type, status}`, that runs **every time a token is produced**: at login, at refresh, at machine-to-machine grants, and at any future grant type. The check uses current state each time, not a snapshot from when the user first logged in. If the check fails, no token is issued. Registrations from external tools (via DCR/CIMD) can never grant themselves access to resources or privileged scopes; those links are server-owned.

**Users.** Answerable ID's Postgres is the canonical user directory. Apps keep their own local records (OmniChat keeps its MongoDB users with balances, conversations, and preferences) joined to Answerable ID by a stable user ID (`sub`), stored on the app side as `identityId`. Email addresses are display data; they're never used as join keys between systems.

**Migrating existing users (identity linking).** When we migrate a cell to Answerable ID, we bulk-import its users into the directory. These imported accounts start **inert** (they can't log in or be linked to an incoming identity) until the user actually signs in through their organization's pinned provider. At that point, linking uses immutable identifiers: `(tid, oid)` for Microsoft (the directory ID plus the user's object ID), or `(issuer, sub)` for Google. Email is only used as the correlation hint during import, never as the binding key. If there's ambiguity (duplicate emails, changed addresses, already-linked identities), the system fails closed and requires manual resolution. The cell's existing `openidId` field is preserved (as `legacyOpenidId`) so we can roll back to direct Entra login with a pure environment change.

**Tokens.** Answerable ID issues JWTs (JSON Web Tokens) and publishes its signing public keys (JWKS) so apps and MCP servers can verify tokens locally without calling back to Answerable ID on every request. Each token carries: the user ID (`sub`), the organization (slug and ID), the intended audience (`aud`, which is one specific app or MCP server), resource-specific authorization data, and the user's name and email. **All access tokens are short-lived**: 5 to 15 minutes for MCP audiences, up to 30 minutes for apps. There are no long-lived bearer tokens, even for "low-sensitivity" servers. Consumers cache tokens and re-obtain them when they expire. We'll also evaluate DPoP (RFC 9449, a standard for binding tokens to a specific client) for external MCP connections.

**Provisioning events.** We'll add a transactional outbox (a pattern where events are written to the database in the same transaction as the change, then delivered reliably) when there's a consumer that needs it. For now, offboarding (the most urgent lifecycle concern) is handled by the mechanisms in the next section.

## Lifecycle: Joiners, Movers, Leavers

Today, if a client disables a user in their Microsoft directory, that user's next login attempt to their OmniChat cell fails, because the cell talks directly to Microsoft, and Microsoft says no. Putting Answerable ID in the middle breaks that. Answerable ID holds its own sessions and refresh tokens, so a disabled Microsoft account doesn't immediately kill the Answerable ID session.

We reproduce the offboarding signal with these controls:

- **Bounded sessions.** There's a hard maximum on how long a session can last (no indefinite sliding renewal). On top of that, Answerable ID periodically **re-checks** with the upstream IdP (a silent `prompt=none` request to Microsoft/Google) to confirm the user is still active. If the check fails (because the user was disabled, removed, or their password was changed), the session ends. Rough targets: re-check every few hours; absolute session lifetime within a working week. These limits govern interactive browser sessions only. Background work (scheduled agent runs, deferred jobs) uses a separate, longer-lived delegation with its own controls, described under §Background work.
- **Refresh token rotation with reuse detection.** Each time a refresh token is used, a new one is issued and the old one is invalidated. If someone replays an old refresh token (a sign of theft), the entire token family is killed. Refresh tokens have short lifetimes and are stored encrypted server-side.
- **Back-channel logout.** When Answerable ID revokes a user's session, it notifies cells and apps directly so they drop their local sessions immediately.
- **Re-checks on every grant.** Every time a token is issued (at login, refresh, or any other grant), user status, org membership, and entitlements are re-evaluated against current state.
- **Admin kill switch.** Deactivating a user (via Omni Admin or `ocadmin deactivate-users`, which gains an Answerable ID integration) revokes their sessions and refresh token families immediately. The next attempt to get any kind of token fails.
- **Offboarding target.** No new tokens within 5 minutes of deprovisioning; all existing access tokens expired within 15–30 minutes.
- **Audit alerting** on "token issued after deprovision event."
- **SCIM** (a standard for automated user provisioning from client directories) is out of scope initially. The answer for now is short sessions plus frequent upstream re-checks.

## How MCP Authentication Works

There are two ways an MCP server gets called, and both end up with the same kind of token.

### External: clients' own AI tools (Claude Code, Claude Desktop, etc.)

The user opens their AI tool, which discovers the MCP server and sees it requires authentication. The tool opens the user's browser, the user types their work email on Answerable ID's login screen, Answerable ID routes them to their company's Microsoft or Google login, they authenticate, and a short-lived token locked to that one MCP server is sent back to the tool. Standard OAuth, works today.

### Internal: AI agents inside OmniChat cells

LibreChat already has per-user OAuth for MCP servers: a "connect" flow where the user's browser visits the authorization server. In our setup, the user already has a live Answerable ID session (that's how they logged into the cell), and the cell is registered as a trusted first-party client (so the consent screen is skipped). The connect step becomes a **silent redirect bounce**: the browser hops to Answerable ID, sees the existing session, issues a token, and bounces back. This happens once per user per server, and it's invisible after that. The cell stores the user's per-server token (encrypted) and attaches it to tool calls; refresh happens automatically with rotation.

We chose this approach because **Better Auth doesn't implement RFC 8693 token exchange** (the formal standard for one service requesting a token on behalf of a user, using the user's existing token as proof). Building that on the critical path would have meant writing custom, security-critical authorization-server code before the first MCP server ships. Instead, the internal path reuses the same stock OAuth flow as the external path, and MCP servers see one token shape regardless of who's calling.

- **Later, off the critical path:** we'll build the RFC 8693 token-exchange grant to a full security specification and contribute it upstream to Better Auth. We'll migrate the internal path to use it if its explicit delegation semantics (which record "this token was obtained by cell X on behalf of user Y") become needed.
- **Fallback:** if the fork's MCP OAuth support turns out to be missing or immature at validation time, we fall back to a refresh-token grant with `resource` narrowing. The cell is the client that performed the original login, so it can refresh for a token with a narrower audience. This requires a different auth-path change in the fork with its own set of controls.

### Background work: scheduled and deferred runs

OmniChat has a scheduling feature: a user sets up a recurring prompt, and an agent runs it on a cron cadence. The user isn't there when it fires, and there's no browser to redirect. Deferred work has the same shape: someone kicks off something long-running and closes their laptop.

These runs still need a user-subject token, because the agent is acting for that user, against that user's entitlements. The mechanism is the refresh token the cell already holds from the user's original connect flow. A refresh token is evidence of that user's own prior authentication, which is why this doesn't break the golden rule below: nothing is conjured from a bare user ID.

Two rules make it safe:

- **Background delegation deliberately outlives the browser session.** The session limits in the Lifecycle section govern how long someone can keep browsing without re-authenticating. They don't govern background delegation, which is a separate and longer-lived grant. Otherwise a two-week holiday would silently break someone's nightly job.
- **Every renewal re-checks.** Each time a background job uses its refresh token, Answerable ID re-evaluates that user's status, org membership, and entitlements against current state. An admin deactivation therefore stops every scheduled job for that user, at the next tick at the latest.

The harder case is a user disabled in the *client's* directory without anyone telling us. For interactive logins we catch that with the silent upstream re-check, but that needs a browser. For background work we have to ask Microsoft directly, which means a read-only directory permission (reading user account status) on the multi-tenant app, polled for users who hold active delegations. That's a real addition to what we ask clients to consent to, and it's the price of the guarantee. Without it, the fallback is a bounded delegation lifetime: a departed employee's jobs would keep running for at most that long. Microsoft's Continuous Access Evaluation is the standards-based version of this signal and is worth revisiting later.

**When a delegation does expire or get revoked, fail loudly.** Pause the schedule, show its state clearly in the UI, and notify the owner. A single login re-arms it. Silent failures at 3am are the worst possible outcome here.

### The golden rule

A token with a user's identity is only ever issued when that user's own authentication is presented as evidence: either the user present in a browser, or (in the fallback/RFC 8693 forms) their live token presented by the client that obtained it. Nothing in the system can create a "token for Alice" from just Alice's user ID. A compromised cell can only misuse the tokens of users who actually connected through it, and those tokens are bounded by lifetime, revocable per token family, and visible in anomaly alerting. Per-user MCP tokens stored by cells are encrypted at rest, and refresh rotation with reuse detection applies.

Machine-to-machine callers acting purely as themselves (the provisioning dispatcher, backup jobs, a service's own health checks) use client-credentials grants, which authenticate the *service itself*, not a user. They never receive user-subject tokens, and they never accept a user ID as a substitute for one. A service token plus "now act as Alice" is exactly the shortcut this design rejects; when a service acts for a person, it uses one of the paths above. Where a service-as-itself action is triggered by a person, such as an admin running a bulk operation, the requesting user is recorded in the audit trail as data, without that data conferring any authority.

## Registration Policy: How External Tools Connect

When an external AI tool (Claude Code, Copilot, etc.) connects to one of our MCP servers, it needs to register itself with Answerable ID first. This registration endpoint is the highest-risk new surface we're creating. It's internet-facing and fronts 70 corporate directories.

There are two registration mechanisms in the MCP spec. **CIMD** (Client ID Metadata Documents) is the newer, more controlled one: the client publishes a metadata document at a URL it controls, and the server fetches it. **DCR** (Dynamic Client Registration) is older and more permissive: any client can register on the fly by posting its details. We prefer CIMD and only allow open DCR where client compatibility requires it (tracking when Claude Code/Desktop adopt CIMD is a real scheduling dependency).

Concrete policy:

- **Three client classes:** known first-party (pre-registered, consent screen skipped), known AI tools (pre-vetted), unknown external (most restricted).
- **Public clients only via DCR.** PKCE S256 (a standard proof-of-possession mechanism) is mandatory everywhere, no exceptions. Allowed grant types, authentication methods, and redirect-URI patterns are spelled out per class. Redirect URIs use exact matching; CLI tools use loopback-only URIs. Registration metadata can never set consent bypasses or grant privileged scopes.
- **Per-org allowlisting** of which external clients can connect, via the entitlements table. Registration tokens expire and get cleaned up. Shared rate limiting across nodes. Quotas per org, per client, and per IP. Audit trails and anomaly alerts.
- **Hardened CIMD fetching:** reject private/internal addresses, pin DNS, cap response size, reject redirects, enforce timeouts and concurrency limits. This prevents SSRF (server-side request forgery) attacks where a malicious metadata URL points to our internal infrastructure.
- **The consent screen shows the client's name and origin verbatim.** It's the last line of defence against a malicious client pretending to be "Omni Admin" to phish a corporate login.
- **Route allowlisting, not denylisting.** Better Auth's plugins expose far more HTTP endpoints than just the OIDC/OAuth ones (org creation, invitations, account linking, impersonation, client management). We build an endpoint inventory for the exact version we're running, allowlist the routes that should be public (at both the application middleware and the ingress level), disable everything else, and re-run the check after every upgrade.

## Keys and Credential Custody (non-negotiable)

Answerable ID signs tokens with a private key. Any app or MCP server that trusts Answerable ID verifies tokens using the matching public key. This means the signing key is the single most sensitive secret in the system. **Anyone holding it can forge a valid token for any user, any org, any resource.**

By default, Better Auth stores the signing key in its database, encrypted with the application secret. If an attacker obtains a database backup and the app secret (which might live in adjacent systems like Doppler or a backup bucket), they can forge tokens offline, silently, with no trace.

To prevent this:

- **KMS-backed signing** where the key can be *used* but never *extracted*, if Better Auth's JWT plugin supports it reliably. Otherwise, a key-encryption key held **outside** Postgres and outside the app's general secret store, with the residual combined-compromise risk documented explicitly.
- **Defined key lifecycle:** generate → publish → activate → retire → revoke. When rotating keys, the old key stays in the published key set (JWKS) for at least the maximum token lifetime plus cache skew, so already-issued tokens keep validating.
- **Emergency rotation runbook, rehearsed.** Rotate keys, purge the Cloudflare edge cache automatically (so consumers fetch the new key set immediately), force consumer JWKS refresh, verify that old-key tokens are rejected. This is rehearsed alongside database restore drills. Key compromise is a scenario we practice, not a footnote.
- The Entra multi-tenant app's certificate credential gets the same custody treatment.

## Availability and Failure Modes

Today, no OmniChat cell depends on any central service we run. Each cell is an independent VM that talks directly to the client's Microsoft directory and their Atlas database. This design introduces a central service that becomes a critical pathway for every login and (as MCP adoption grows) every agent tool call across the fleet. Therefore:

- **HA from day one.** Two application nodes across availability zones behind a load balancer. But the service isn't stateless. **PostgreSQL is a critical dependency** for auth codes, sessions, refresh token rotation, consents, client registrations, and entitlements. HA Postgres with connection limits, tested failover, and load tests covering the burst patterns we'll see during tutor rollout waves.
- **What happens during an outage.** Apps and MCP servers verify tokens locally using cached public keys, so an Answerable ID outage blocks new logins, token refreshes, and MCP connect flows, but not active sessions or already-issued tokens. The grace period is the shorter of the cached token's remaining lifetime and the user's refresh window. We need to verify during the spike that each consumer library serves stale JWKS (cached public keys) on refresh failure rather than hard-failing.
- **Edge caching rules.** Only OIDC discovery documents and the JWKS (public keys) are cached at the Cloudflare edge, with a defined maximum stale time. Token endpoints, callbacks, userinfo, revocation, registration, and admin responses are never cached. Automated cache purge is part of the emergency key rotation procedure.
- **No global multi-region deployment.** Identity stays **off the per-request hot path**. That's a design rule. Tool calls and API requests verify tokens locally; they never call Answerable ID. Login redirects are dominated by the time spent on Microsoft's or Google's login page, not by our service's latency. So: single-region HA plus Cloudflare edge, which terminates TLS worldwide and caches the public keys. A second-region disaster recovery setup is deferred until we actually experience a Civo regional incident or take on a contractual RTO commitment. A rehearsed database restore (RTO ≤ 1 hour) is the day-one guarantee.
- **Headscale dependency.** The tailnet-only listeners (next section) raise headscale's criticality; its availability posture is reviewed alongside Answerable ID's.

## Hosting

Answerable ID runs on **Civo** (a UK cloud provider we already use for other central infrastructure). The service gets its own **isolated network, Kubernetes cluster, and managed PostgreSQL database**. It doesn't share any of these with our other Civo workloads. The reason: on Civo, anything inside the same network can talk directly to the database, bypassing firewall rules. If Answerable ID shared a network with something else, a compromise of that something else would give direct database access to the identity service. Separate network = separate blast radius.

Inside that network:

- **K3s** (lightweight Kubernetes) runs the Answerable ID application, two nodes across availability zones for HA.
- **Managed HA PostgreSQL** stores users, sessions, organizations, entitlements, client registrations, and refresh tokens. The database firewall blocks all external access by default; only the K3s cluster in the same network can reach it.
- **Admin access** (SSH, Kubernetes API, database emergency access) is only available through the tailnet. Nothing administrative is exposed to the public internet.
- **Public traffic** (user logins, MCP OAuth) comes through Cloudflare, which handles TLS termination, caching of public keys, and WAF protection.

**Backups.** We have an existing hourly backup pipeline that dumps the database, verifies the dump isn't corrupted, checksums it, and uploads it to immutable cloud storage with a heartbeat monitor so we know if a backup was missed. We reuse that pipeline here.

**Region:** London (LON1).

## Tailnet Hardening

The fleet already runs on a headscale tailnet (a private, encrypted mesh network connecting all our infrastructure). We use it here as defence in depth, an extra layer on top of token verification.

1. **Split listeners.** Answerable ID exposes two network interfaces. The **public** listener (behind Cloudflare) handles browser-based OIDC login and external MCP OAuth only. The **internal** listener (tailnet-only) handles per-user MCP connect/refresh for cells and the future RFC 8693 endpoint. This means exploiting the internal token surface requires tailnet presence, not just stolen credentials and internet access.
2. **ACL tiers.** Cells can reach the internal token listener. Only admin machines can reach the admin API. Nothing else can reach the database network at all.
3. **Internal-only MCP servers live on the tailnet only**, with no public internet exposure and no registration surface to attack.

## Security Posture

- **Public surface:** only allowlisted OIDC/OAuth endpoints, behind Cloudflare WAF and rate limits. Admin API and any admin UI: tailnet-only.
- **No cell-local passwords.** Corporate IdP login is the default. The 11 tenants that don't currently have SSO use **Answerable ID-hosted email+password with MFA available per org** (TOTP or passkeys), plus rate limits, brute-force protection, and breach-password checks. Their existing password hashes (bcrypt) are imported directly, so no password resets are needed. Magic-link or OTP login is available as a per-org option. Upgrading one of these tenants to SSO later is just the admin-consent flow. Internal (staff) accounts use passkeys or MFA.
- Exact redirect-URI matching. PKCE S256 mandatory. RFC 8707 resource binding enforced. DPoP evaluated for external MCP clients.
- **Audit log** of all token issuance, refresh, and connect events, retained at least 90 days. Alerts on: per-cell volume anomalies, tokens issued after a deprovision event, registration anomalies.
- **Threat scenarios** with containment plans (compromised Answerable ID, compromised cell, compromised MCP server, malicious external client, malicious tenant admin, leaked downstream credential, leaked signing key) are documented in the implementation plan.
- Each cell and Circle can **roll back** to its old issuer independently. This requires the old Entra app registrations to stay alive, tracked per tenant, not assumed.

## Omni Accelerator / Circle Consolidation

The Omni Accelerator community runs on Circle.so, which currently authenticates users through our Entra B2B guest machinery, a separate system involving Microsoft Graph API invitations, app-role assignments, and dedicated provisioning code.

Under this design, **Circle points its SSO at Answerable ID** like any other app, using the same OIDC mechanism it already uses against Entra.

It's a planned flag-day cutover (Circle has one community-wide SSO config). Rollback = point Circle's SSO back at Entra.

**Before scheduling: check how Circle matches returning members, by email or by `sub` (user ID).** If it matches by `sub`, then switching to Answerable ID (which issues different user IDs than Entra) would duplicate every member in the community.

Circle users will see Answerable ID's email-entry screen when logging in (since Circle is a shared community, we can't know which org's IdP to redirect to until the user tells us). After this cutover, the OA Entra directory has no remaining architectural role beyond our own corporate identity.

## Rollout

### 1. Validation spike (kill gate)

A local docker-compose environment that proves the full chain works. If anything here fails hard, we stop before building infrastructure.

- Real Entra admin-consent on the multi-tenant app; per-org tenant-scoped provider rows; confirm pinning works (own org accepted, foreign directory rejected, guest accounts rejected)
- OmniChat cell login through Answerable ID that's invisible to the user (extra-params patch works, auto-redirect works, OIDC endpoints conform to spec)
- **The make-or-break item: the fork's per-user MCP OAuth works.** The connect flow exists in our fork; the silent bounce works against a live Answerable ID session with consent skipped; per-user tokens are stored encrypted; refresh rotation works.
- External MCP connection from Claude Code end-to-end: RFC 9728 server discovery, DCR registration under the locked-down policy, corporate IdP login, audience-bound short-lived token
- Entitlement gate denies token issuance at authorize, refresh, and client-credentials grants; negative tests for cross-org access, audience swapping, and unentitled clients
- Identity linking: inert imports bind correctly on `(tid, oid)` at first login; ambiguous cases fail closed
- Lifecycle: upstream re-auth interval is enforced; deprovisioning scenarios deny within the SLA; back-channel logout drops a cell session
- Background delegation: a scheduled run still works after the owner's browser session has expired, and stops on the next tick once the owner is deprovisioned
- JWKS stale-serving verified in each consumer library; key rotation exercised end-to-end
- Endpoint inventory and public-route allowlist verified from the public side

### 2. Infrastructure

Provision the `answerable-id` network, cluster, and Postgres, plus CIDR registry, headscale ACLs, and subnet router. Set up Cloudflare fronting, monitoring, and the cloned backup pipeline. Rehearse both a database restore and a key rotation. Deploy Answerable ID in HA.

### 3. Dogfood

Migrate the `test` cell's login to Answerable ID. Stand up the tutor MCP server. Exercise both the internal (in-cell agent) and external (Claude Code) paths ourselves.

### 4. Circle cutover

After verifying how Circle matches returning members (the check described in §OA / Circle Consolidation).

### 5. Fleet migration in waves

The tutor rollout drives cell migration: for each wave, migrate the cell's login to Answerable ID, then enable the tutor for those users. New tenants are provisioned Answerable ID-first via a new Omni-Weaver env-schema cohort.

### 6. Steady state

New apps and MCP servers register as ordinary OIDC/OAuth clients of Answerable ID. Zero client IT involvement required. The RFC 8693 token-exchange grant is built off the critical path and contributed upstream.

### Per-cell migration mechanics

Bulk-import the cell's users as inert records in Answerable ID (correlated by email at import time; bound to the correct identity on first login via `(tid, oid)`; `identityId` set on the cell's MongoDB user record; existing `openidId` preserved as `legacyOpenidId`). The client org is either already federated or gets federated at this point. Repoint the cell's OIDC environment variables via Omni-Weaver (the tenant YAML's `openid` block and `tenant.schema.json` need a schema change for the org linkage and extra-params). Deploy during the tenant's configured rollout window. Rollback: repoint the environment at the old direct Entra registration (which is tracked as still alive).
