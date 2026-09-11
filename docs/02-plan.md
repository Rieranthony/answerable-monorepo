# Plan

This is the dependency order, not a deployment claim. The [design](03-answerable-id.md) is current behaviour; the [foundation acceptance](../reports/id-release-acceptance.md) and [release decision](../reports/answerable-id-release-decision-plan.md) hold evidence and the remaining gates.

Last updated 2026-09-11.

## How we build

- Bun 1.3.1, Hono, Postgres and pinned Better Auth 1.7.2; Redis is reserved for later.
- Admin API first, typed OpenAPI and explicit authentication-route allowlisting.
- Behaviour changes need meaningful regression/fault tests. ID requires 100% application line/function coverage.
- Bun in production, TLS at ingress, no CDN/WAF for now.
- No opportunistic hardening loop. Reproduce an existing invariant violation before adding runtime work.

## Local environment

`bun dev` starts the compose services and apps. Web: 47100; ID: 47300; Postgres: 47432; Redis: 47379. Test reset targets only the guarded `answerable_id_test` database. See [ID commands](../apps/id/README.md#commands).

## Build order

| Step     | Current state                                                                             | Exit evidence still needed                                                                                         |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0        | Code location and pinned runtime settled                                                  | Publisher verification, secret-store/operator and real tenant references.                                          |
| 1, 2a    | Final schema and exactly one initial migration implemented                                | Intended-environment installation/recovery.                                                                        |
| 2        | Federation, own-tenant admission, immutable linking and five-minute freshness implemented | Real Entra consent/claims and multi-provider journey.                                                              |
| 2b, 2b.1 | Admin platform, 49 journalled mutations, F0–F6 local mechanisms integrated                | Local acceptance passed; external evidence below remains required.                                      |
| 2c       | Tenant membership administration exists                                                   | **Not yet:** broader self-service, DNS verification, guest opt-in and tenant rate policy.                          |
| 3        | Production code/refresh/OIDC, selection and consent implemented                           | Actual OmniChat configuration/verifier acceptance.                                                                 |
| 3a       | Login, selection, consent and security pages exist                                        | **Not yet:** full administrative console.                                                                          |
| 4        | Exact-pair policy, capability ceilings and truthful access views implemented              | Actual consumer A/B denial matrix.                                                                                 |
| 5        | Resource-bound user/machine tokens implemented                                            | **Not yet:** DCR/CIMD and resource-server metadata/integration; prove external Claude path.                        |
| 6        | Explicit verified linking and inert identity-binding rules implemented                    | **Not yet:** bulk import/cell migration tooling and tested cell rollback.                                          |
| 7        | Local revocation, terminal product deletion and native refresh delegation implemented     | **Not yet:** bounded upstream-disable detection and downstream logout delivery; real background/offboarding proof. |
| 8        | Separate encryption rings, custody preflight and replay retention implemented             | Production custody, key lifecycle/rotation and consumer cache/outage rehearsal.                                    |
| 9        | Synthetic two-process load and fresh-cluster restore complete with disclosed limits       | Actual topology/ingress, budgets, backup system, RTO/RPO and independent reconciliation source.                    |
| 10       | No production rollout                                                                     | Dogfood and kill gates; Circle matching before Circle; then deliberate fleet waves.                                |

## Validation spike (steps 0–1, against a real tenant)

Retain the original kill gates: real Entra consent/pinning; OmniChat login; per-user MCP silent first-party bounce, separate encrypted credentials and refresh rotation; external Claude Code; exact-pair denials; bounded upstream offboarding, downstream logout and background delegation; key rotation/outage; recovery and cell rollback. **Not yet validated.** Missing runtime capabilities are distinguished from missing configuration/evidence in the [single external checklist](../reports/answerable-id-release-decision-plan.md#external-input-and-test-checklist).

## Open register

Stable IDs; never renumber. Resolve into the design doc or this page and delete the row.

| ID                         | Question                                                                                                                                                                                                                                                                                                                                  | Gates                               | Resolve by                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `Q-PUBLISHER-VERIFICATION` | Microsoft publisher verification for the multi-tenant app — weeks of process                                                                                                                                                                                                                                                              | The validation spike's first bullet | Start now (MPN + domain verification)                                         |
| `Q-ENTRA-CLAIMS`           | Confirm on a real tenant which guest signal is authoritative (`idp` / `acct`), whether `email` or `preferred_username` is the stable login display address, and how `xms_edov` affects verification                                                                                                                                       | Step 2 sign-off                     | Validation spike against a real tenant                                        |
| `Q-AID-LISTENER`           | The design says the tailnet-only listener handles per-user MCP connect, but connect is a browser bounce — `/authorize` + callback must be public; only `/token`/refresh can be tailnet. The admin API is split the same way: tenant-tier routes (`x-tier: tenant`) are public, platform-tier routes (`x-tier: platform`) are tailnet-only | Steps 5, 9                          | Decide in the skeleton's route layout                                         |
| `Q-RESOURCE-PARAM`         | Does the fork's MCP OAuth client send RFC 8707 `resource`?                                                                                                                                                                                                                                                                                | Step 5                              | Spike against the fork; else default the audience from the client↔server link |
| `Q-FORK-PATCHES`           | The living inventory of fork patches: extra-params, back-channel-logout receiver, refresh-grant fallback, whatever `Q-RESOURCE-PARAM` adds                                                                                                                                                                                                | Rebase burden visibility            | List in the fork repo; link here                                              |
| `Q-AID-RECHECK`            | Hidden-iframe `prompt=none` re-checks fail under third-party-cookie blocking (Safari/Firefox) → top-level redirect, or upstream refresh-token probes (`offline_access`; Entra RT redemption fails `AADSTS50057` for disabled accounts)                                                                                                    | Step 7                              | Decide before step 7                                                          |
| `Q-AID-GRAPH`              | The read-only directory permission for background-delegation offboarding — some client IT will refuse; make it per-org optional with a bounded delegation lifetime as the fallback; revisit Continuous Access Evaluation                                                                                                                  | Step 7, consent ask                 | Product + step 7                                                              |
| `Q-AID-KMS`                | Does Better Auth's JWT plugin support KMS-backed signing reliably? If not, a KEK outside Postgres with the residual risk documented                                                                                                                                                                                                       | Step 8                              | Spike                                                                         |
| `Q-AID-HA`                 | "HA from day one" vs starting single-node for the first migrated cell                                                                                                                                                                                                                                                                     | Step 9                              | Owners' call                                                                  |
| `Q-MEMBER-MATCH`           | Does Circle SSO match returning members by email or `sub`? If `sub`, the cutover duplicates every member                                                                                                                                                                                                                                  | The Circle cutover in step 10       | One test account on a trial/staging community                                 |
| `Q-SECRET-STORE`           | Doppler / 1Password / Infisical for runtime secrets                                                                                                                                                                                                                                                                                       | Steps 1, 8                          | Ops preference                                                                |

Resolved into the current design: Bun/native production integration, user/machine token claims, exact-pair machine ceilings, no-CDN posture and encrypted Google/upstream token storage. Secret delivery and recovery remain operational inputs. Own-tenant SSO, verified linking, five-minute sensitive-command freshness and terminal `deletedAt` are accepted decisions. UUID audit history needs no named-recovery feature; physical product purge and its duration are deferred.

## Backlog (after the fleet migrates)

RFC 8693 token exchange (built off the critical path, contributed upstream) · SCIM provisioning · DPoP for external MCP clients · second-region disaster recovery · transactional outbox for provisioning events · Redis session cache · SAML for odd IdPs · **hosted email+password login with MFA for the 11 non-SSO tenants** (needs an email provider first) · **the tutor MCP** (parked in `apps/community-mcp/`).

## Do not re-propose

- Email as a join key between systems, or as a linking key at login (automatic email linking is off; verified linking is explicit) — `sub` / `(issuer, sub)` only.
- Identity inside the fork's database — apps consume identity through standard OIDC.
- Per-app registrations in client directories — one multi-tenant app, one consent per org.
- A standalone identity appliance (Keycloak) or a hosted IdP of record — Better Auth in our own service, our own Postgres.
- Client secrets on the multi-tenant app — certificate credential.
- Node in production, or a CDN/WAF in front, for now — Bun everywhere; TLS at the ingress.
- Dates and headcount in the docs — order, not time.
- Seed accounts, password-based administrators, or a bootstrap CLI — the platform is seeded at startup and the root secret is the only break-glass.
- Impersonation or personal access tokens for the admin API — machines are OAuth clients; a person is a session or, later, a user-delegated token.
