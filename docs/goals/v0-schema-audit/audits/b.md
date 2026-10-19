# Audit B: tenant separation and the scope model (v0 schema audit, 19 October 2026)

Auditor B (Opus 5.5). Worktree at main 9833960 after `bun install --frozen-lockfile`. Postgres `audit-pg-b` on 47434 (PostgreSQL 17.9, `postgres:17-alpine`). Probes in `$S/probes/b/` (`$S` = the session scratchpad); the throwaway test and script files lived in the worktree as `apps/id/src/http/admin/zz-probe-b-*.integration.test.ts` and `apps/id/scripts/zz-probe-b-*.ts`, are copied into the probes directory, and were never committed. Host load 6 to 8 (`uptime`, four audits running): every timing is an on/off pair taken in the order on, off, off, on, and only deltas are claimed.

## 1. Summary

1. **No leak.** 372 admin API calls as tenant A (a browser admin and a machine bearer, both holding `org:read org:users org:write`) against tenant B's organisation, children, filters and every platform route: 0 bodies with any of B's identifiers, 0 unexpected statuses (404 on all 66 tenant-route probes, 403 on all 236 platform-route calls). Same result with the vocabulary collapsed (probe 08).
2. **One configuration gap (fix).** A platform administrator can approve tenant A's `authorization_code`/`refresh_token` capabilities and entitlements for tenant B's *own* client; the real `createResourceGrant` then admits A's member and `userResourcePolicy` returns `allowed`. ID already refuses the same for `client_credentials` and for another tenant's resource. Fix: a capability's client must be unowned or the capability's organisation's (one predicate in `protect_capability_target`).
3. **Scope vocabulary: 10 modes → 7.** Delete `policy-root` (→ platform-read), `platform-users` (→ platform-write), `grant-admission` (→ policy-user with a session). Spike: 651 of 654 tests pass; the 3 failures assert the old vocabulary, not a boundary. `protocol` stays: moving two helpers off it silently dropped their `FOR SHARE` on SSO providers (RLS filters lock targets through the UPDATE policy) and 3 lock-order tests failed.
4. **Routing reads are not backed in tenant scope (fix).** `routing_read` is `true`, so a tenant transaction with a wrong organisation id reads another tenant's SSO provider (probe 09: 1 row; RLS tables: 0). One predicate restricts tenant scopes to their own rows; the spike ran it with no failure beyond the test asserting the old design.
5. **RLS on the hot path: keep.** +1.24 ms per `effectiveGrants` (wall), of which +0.84 ms is planning and +0.46 ms execution; the membership subselect itself costs +0.002 to +0.27 ms by rows returned.
6. **`protect_grant_context` insert branch: delete (narrow the trigger to its UPDATE branch).** Every check is made by the issuing transaction under locks it holds; the branch costs +0.072 ms per grant and adds one lock: with a member row held 2.5 s, 50/50 admissions time out with it and 50/50 succeed (p50 128 ms) without it. No real writer of a member row lacks a conflicting organisation or user lock.
7. **`users.email` unique: keep.** Real sign-in: same email through another tenant's provider → `domain_not_allowed`; after a domain move → `email_conflict`; same (issuer, sub) through a second tenant's provider → `account_provider_conflict`. Never a silent link or a second user. "One person, two memberships" through one identity does not exist today; it is verified linking.
8. **Runtime role on PostgreSQL 17: keep.** Temp table, schema and table creation refused (`42501`); the shadowing attack fails even for the owner (qualified names); `assertRuntimeRole` accepts the live grants and refuses each of 7 widened ones. Unneeded grants: UPDATE/DELETE on `jwks`, UPDATE on `oauth_client_assertions` (optional trim).
9. **Small fix:** `GET /organizations/A/access?clientId=` answers 200 for another tenant's client and 404 for a missing one (an existence oracle); resources already answer 404 for both.

## 2. Verdict table

| Item | Today | Evidence | Verdict | Change | What is lost or risked |
|---|---|---|---|---|---|
| Tenant separation through the admin API | 22 tenant-tier and 59 platform-tier routes, typed contexts, RLS, composite FKs | 04: 372 calls, 0 leaks, 0 unexpected; 08: same under the spike | keep | none | none |
| Client ownership on user-grant capabilities | `validateTarget` and `protect_capability_target` check client ownership only for `client_credentials` | 04 C: 4 × 201; 04b: grant admitted, policy `allowed=true` scopes `["read"]` | fix | refuse a capability whose client has an `organization_id` other than the capability's (trigger line, and the service's message) | cross-tenant sharing of a tenant-owned app, if ever wanted (open question 1) |
| `policy-root` mode | 1 call site (`hasPlatformWriter`), a branch in 5 read policies | call-site map; spike 08: no failure except the test naming the kind | delete | `hasPlatformWriter` runs under platform-read | nothing: `platform:*` scopes exist only in the platform organisation's capabilities (`protect_capability_target`), so a wider read cannot produce a writer |
| `platform-users` mode | 1 call site (`authorizePlatformMutation` for users), a branch in 5 policies | spike 08: 1 failure, `runtime-role.integration.test.ts:410` asserting it cannot read groups, entitlements, capabilities | delete | platform:users commands run under platform-write; the scope split stays in `authorizeCommand` | a database-level stop on a users-command bug writing tenant configuration (no tenant boundary; RLS covers 10 of 25 tables anyway) |
| `grant-admission` mode | 1 call site (`createResourceGrant`), branches in 3 policies | spike 08: 1 failure (admission with another session saw the same user's grants); 08 SQL: merged insert binding refuses other session and no session (`42501` ×2) | simplify | policy-user takes an optional `sessionId`; grant INSERT requires subject and session | admission reads the subject's other grants and its organisations' policy rows (same user) |
| `protocol` mode | Better Auth transactions, `tenantAuthentication`, `currentGrantAuthentication`, link start | 09: writes any tenant's member and SSO provider; spike 1: removing it from two helpers silently dropped their provider locks, 3 lock tests failed | keep | none (see open question 3) | n/a |
| `tenant-read`/`tenant-write`, `platform-read`/`platform-write` splits | 2 + 3 call sites each | `begin read only` + `FOR SHARE`: "cannot execute SELECT FOR SHARE in a read-only transaction" | keep | none | n/a |
| `grant-client` mode | token and revocation endpoints | the refresh-token lookup is by hash only (`user-token-boundary.ts:244`); the policy hides other clients' grants; `user-oauth` RLS test passes in baseline and spike | keep | none | n/a |
| `routing_read = true` on `organization_domains`, `sso_providers` | readable in every scope | 09: tenant-read for org 2 reads org 1's provider (1 row) while groups, entitlements, members, capabilities return 0 | fix | `coalesce(scope,'') not in ('tenant-read','tenant-write') or organization_id = tenant` | none measured (spike 08: only the test asserting "routing is public to all scopes" fails) |
| `findClientForAccess` existence oracle | tenant `GET access?clientId=` finds any client | 04c: B's client 200, missing client 404 | fix | add `organization_id is null or = context.organizationId` like `findResourceForAccess` | none |
| RLS on the policy path | 10 tables, 20 policies | 06: `effectiveGrants` +1.24 ms wall; planning +0.84 ms, execution +0.46 ms; subselect +0.002 to +0.27 ms | keep | (optimise later: prepared statements remove most planning) | n/a |
| `protect_grant_context` INSERT branch | SECURITY DEFINER, re-checks member, organisation, user, session, client, resource, `FOR SHARE OF m, s` | 07: +0.072 ms per grant; member row held 2.5 s: 50/50 timeouts on, 50/50 admitted off (p50 128 ms); every check made by `createResourceGrant` under its own locks | simplify | delete the INSERT branch; optionally replace the `member_id` FK with `(organization_id, member_id) → members (organization_id, id)` (the unique exists); the function then needs no SECURITY DEFINER | forged grant rows written outside `createResourceGrant` (RLS already restricts inserts to the admission binding or platform-write, which no code uses) |
| `protect_grant_context` UPDATE branch | immutability, irreversible revocation and code binding | not re-measured (audit D owns column privileges vs triggers) | keep | none here | n/a |
| `users.email` globally unique | `users_email_unique` | 05: E2 `domain_not_allowed`, E3 `email_conflict`, E4 `account_provider_conflict`, E5 success | keep | document the recovery (retire the old email) for domain moves and directory changes | n/a |
| Runtime role and `assertRuntimeRole` | `runtime-role.ts` | 01: 10 attempts refused; 01b: owner shadowing refused; 02b: accepted live, refused 7 widenings | keep | optional: revoke UPDATE, DELETE on `jwks` and UPDATE on `oauth_client_assertions` | nothing used (Better Auth `jwt/adapter.mjs` only reads and creates keys; `authorize-BmTe2VYG.mjs:1431-1446` creates and finds markers) |
| GUC scopes as a boundary | `set_config('answerable.scope', …)` | 01 #6c: the runtime role sets `platform-read` itself and reads B's group | keep (state it) | docs/04: RLS protects against query mistakes in ID's code, not against SQL run as the runtime role | n/a |

## 3. Probes

Re-running: SQL files run with `psql` against 47434 as named in each heading. The `zz-probe-b-*.ts` scripts go back into `apps/id/scripts/` and the `*.test.ts` probes into `apps/id/src/http/admin/` as `zz-probe-b-*.integration.test.ts` (they import from the app by relative path), then `TEST_DATABASE_URL=postgres://answerable:answerable@localhost:47434/answerable_id_test bun test --timeout 120000 <file>`. The worktree was left clean.

### 01 Runtime role on PostgreSQL 17 (`01-runtime-role.sql`, `01b-shadow-as-owner.sql`, `02-privilege-census.sql`, `zz-probe-b-assert.ts` → `02b-assert-runtime-role.log`)

Ran as `answerable_id_runtime` on `answerable_id` after `01-runtime-role-seed.sql` (tenants A and B; B owns `https://b.example/mcp` and `probe-b-client`).

| # | Attempt as the runtime role | Result |
|---|---|---|
| 1 | `create temp table oauth_resources (...)` | `42501 permission denied to create temporary tables in database "answerable_id"` |
| 2 | `create schema probe_shadow` | `42501 permission denied for database` |
| 3 | `create table public.probe_shadow` | `42501 permission denied for schema public` |
| 4 | tenant-write for A, insert an entitlement naming B's `tenant_owned` resource | `23503 Private resource belongs to another organisation` |
| 5 | tenant-write for A, insert a group of B | `42501 new row violates row-level security policy for table "groups"` |
| 6a/b | no scope; tenant-read for A: B's group | 0 rows; 0 rows |
| 6c | `set_config('answerable.scope','platform-read',true)`, B's group | **1 row**: the scope is a GUC any session may set |
| 7 | `delete from organizations` | `42501` |
| 8 | insert `audit_event_users`; update `audit_events`, `system_bindings`, `admin_operations` | `42501` ×4 |
| 9 | `select public.capture_audit_subjects()` | `42501` (`try_uuid` executes: PUBLIC default, immutable, harmless) |
| 10 | `truncate sessions` | `42501` |

As the owner (who still has TEMP), with `search_path = pg_temp, public` and a temp `oauth_resources` claiming B's resource is `platform_shared`: an unqualified lookup sees the temp row, but the trigger still refuses the cross-tenant entitlement and the cross-tenant capability (`23503` both). All 15 functions carry `search_path=pg_catalog, public, pg_temp`.

Census (`02-privilege-census.log`): the runtime role is `nosuperuser noinherit nocreaterole nocreatedb noreplication nobypassrls`, no memberships, no TEMP, no CREATE on the database or `public`. Per table: SELECT, INSERT, UPDATE everywhere; DELETE only on `sessions`, `verifications`, `jwks`, `oauth_access_tokens`, `oauth_refresh_tokens`, `oauth_client_assertions`; no UPDATE on `audit_events`, `system_bindings`, `admin_operations`; only SELECT on `audit_event_users`; no TRUNCATE, REFERENCES or TRIGGER. `assertRuntimeRole` against the live login: accepted. With each of these granted in turn it refuses: DELETE on `members`, UPDATE on `audit_events`, INSERT on `audit_event_users`, UPDATE on `system_bindings`, UPDATE on `admin_operations`, TEMP on the database, RLS disabled on `grant_contexts` (7 of 7). DELETE on `jwks` is accepted (not a protected table). The local owner `answerable` is a superuser with BYPASSRLS (local only).

### 03 Statement census (`03-census.ts`, `03-census.log`, tests in `03-census-tests.log`)

`pg_stat_statements` reset, then the 52 test files that serve the app on a restricted runtime login (1,076 pass, 0 fail, 287 s), then every statement whose role is not the owner classified by table and command: 4,657 distinct statements, 131,879 calls. Caveats: 51 entries were evicted (`pg_stat_statements.max` 5,000) and many protocol tests seed tokens as the owner, so an absent pair is not proof of disuse. Every grant the census did not exercise was then read in the installed libraries:

- `jwks` UPDATE and DELETE: Better Auth's JWT adapter only `findMany`s and creates (`better-auth@1.7.2/dist/plugins/jwt/adapter.mjs:7-56`); ID only reads `jwks` (`operations/preflight.ts:36`). Not needed.
- `oauth_client_assertions` UPDATE: the provider creates and finds markers (`@better-auth/oauth-provider@1.7.2/dist/authorize-BmTe2VYG.mjs:1431-1446`); the sweep deletes. Not needed.
- Every other grant has a writer in the census or in code.

### 04 The separation matrix (`04-separation-matrix.test.ts`, full table `04-separation-matrix.md`, 372 calls)

One test file on `createAdminFixture({}, { restrictedRole: true })` (the app serves on a fresh runtime login, RLS on). Tenant A = the fixture's `tenant`, B = `outsider`. Two tenant-A principals hold every tenant scope: `tenantAdmin` (a browser session after A's SSO) and a tenant-A machine bearer (an A-owned client with a client_credentials capability). B's rows were created through the API as the platform administrator: a group, an assignment, an entitlement on B's private resource, B's capability, domain, SSO provider, audit events, an operation, B's own user-facing client and private resource. Every response body was searched for every B identifier (organisation, member, user, email, group, assignment, entitlement, capability, domain, provider, every B audit-event id, operation id, client id and instance, resource identifier and instance) the request itself did not carry.

| Section | What | Calls | Statuses | B data in a body |
|---|---|---|---|---|
| T1 | the 21 tenant-tier routes with an `organizationId` path: B's organisation and B's child ids | 42 | 404 ×42 | 0 |
| T2 | tenant-tier routes under A's path with exactly one child id of B | 24 | 404 ×24 | 0 |
| T3 | A's list routes filtered by B's ids, sign-in diagnosis for B's email, `/me` | 40 | 200 ×34, 404 ×6 | 0 |
| P1 | the 59 platform-tier routes, A's principals, A's own ids, the route's example body | 118 | 403 ×118 | 0 |
| P2 | the same with B's ids | 118 | 403 ×118 | 0 |
| P3 | a B machine bearer on A's three member commands | 3 | 404 ×3 | 0 |
| C | entitlements and capabilities in A naming B's private resource or client | 27 | below | 0 |

The separation matrix (route × case × status; both tenant-A principals agree in every cell):

| Route (tenant tier) | B org + B ids | A path + one B child | A list filtered by B ids |
|---|---|---|---|
| GET capabilities | 404 | n/a | 200, no B rows (`cursor`) |
| GET capabilities/{id} | 404 | 404 (capabilityId) | n/a |
| GET sign-in-diagnosis | 404 | n/a | 200, `user: null` (B's email; another B-domain email) |
| GET me | n/a | n/a | 200, A's grants only |
| GET entitlements | 404 | n/a | 200, empty (`memberId`, `groupId`, `clientId`, `resource`) |
| GET entitlements/{id} | 404 | 404 | n/a |
| GET members/{id}/access | 404 | 404 | n/a |
| GET access | 404 | n/a | 404 (`clientId`, `resource`, both; the route example's unknown resource was in the query, see 04c for `clientId` alone) |
| GET groups | 404 | n/a | 200, empty (`q=b-group`) |
| GET groups/{id} | 404 | 404 | n/a |
| GET groups/{id}/members | 404 | 404 | n/a |
| GET groups/{id}/members/{memberId} | 404 | 404 (group), 404 (member) | n/a |
| GET members/{id}/configuration | 404 | 404 | n/a |
| POST members/{id}/reinstate | 404 | 404 | n/a |
| GET members | 404 | n/a | 200, empty (`email`, `q=outsider`, `cursor`) |
| GET, PATCH, DELETE members/{id} | 404 each | 404 each | n/a |
| GET domains | 404 | n/a | n/a |
| GET sso-provider | 404 | n/a | n/a |
| GET organization | 404 | n/a | n/a |
| GET audit-events | 404 | n/a | 200, no B events (`targetId` member and user, `actorId`, `operationId`, `cursor`) |
| every platform-tier route (59) | 403 (P2) | 403 with A's own ids (P1) | n/a |

Constraint cases (C) by the platform administrator in tenant A (both tenant principals: 403 on all 18):

| Request in tenant A | Platform administrator |
|---|---|
| entitlement → B's private resource | 409 `reference_violation` (trigger 23503) |
| entitlement → B's client + B's resource | 409 `reference_violation` |
| capability `authorization_code` → B's client + B's resource | 400 "Capability target belongs to another organisation" |
| capability `client_credentials` → B's client | 400, same |
| capability `admin_session` → B's private resource | 400, same |
| **entitlement → B's client (login only)** | **201** |
| **entitlement, A member → B's client + A's resource** | **201** |
| **capability `authorization_code` → B's client** | **201** |
| **capability `refresh_token` → B's client** | **201** |

### 04b A tenant's member through another tenant's own client (`04b-cross-tenant-client.test.ts`, `.log`)

B registers its own user-facing app (`organizationId` B, authorization code). The platform administrator approves A's `authorization_code` capabilities and A's organisation-wide entitlements for B's client on a platform-shared resource: four 201s. Then A's member access view lists B's client as allowed; `GET /organizations/A/access?clientId=<B's client>` returns A's members with `allowed: true`; the real `createResourceGrant` (runtime role) admits A's member through B's client; the real `userResourcePolicy` under policy-user returns `allowed=true`, scopes `["read"]`. Tokens for A's people can thus go to B's redirect URIs after two platform commands. The capability service refuses another tenant's client only for `client_credentials` and another tenant's resource for every kind (`services/capabilities.ts:99-108`); `protect_capability_target` holds the `client_credentials` case; `createResourceGrant` checks resource ownership only (`create-resource-grant.ts:155-161`). Host clients are registered with no organisation (`packages/acceptance/src/admin.ts:34`), so "a capability's client is unowned or the capability's own organisation's" keeps every acceptance path.

### 04c Client existence oracle (`04c-existence-oracle.test.ts`, `.log`)

As tenant A's administrator: `GET /organizations/A/access?clientId=<B's machine client>` → 200 `{"items":[]}`; `?clientId=no-such-client` → 404; `?resource=<B's private resource>` → 404; `?resource=<missing>` → 404. `findClientForAccess` (`db/queries/oauth-clients.ts:109-121`) has no organisation predicate; `findResourceForAccess` (`oauth-resources.ts:81-100`) has one.

### 05 `users.email` unique across tenants (`05-email-uniqueness.test.ts`, `.log`)

Real sign-in through `signInThroughIdp` on the restricted runtime role. Issuer I1 serves tenants A (`tenant`) and B (`outsider`); a second issuer I2 serves a new tenant C.

| Step | Request | Outcome |
|---|---|---|
| E1 | A's provider (I1), `alice@tenant.example.com`, sub `alice-1` | 302 to the callback; one user, account (I1, alice-1, provider `tenant`), member of A |
| E2 | C's provider (I2), same email, sub `alice-2`; the domain is A's | 302 to the error page, `error=domain_not_allowed`; nothing written |
| E3 | domain moved (A's row disabled, C adds it); C's provider, sub `alice-2` | 302, `error=email_conflict`; no second user, no link |
| E4 | domain moved to B; B's provider (same issuer I1), same sub `alice-1` | 302, `error=account_provider_conflict` (Better Auth `oauth2/link-account.mjs:37-42`: the account is bound to provider `tenant`); no membership in B |
| E4b | A's provider again, A no longer holds the domain | 302, `error=domain_not_allowed` |
| E5 | B's provider, new person `bob@tenant.example.com` | 302 to the callback; new user, member of B |

An email reaches ID only through a provider whose organisation holds its active domain, and an active domain belongs to one organisation (`organization_domains_active_domain_idx`). A cross-tenant collision therefore needs a domain move or a directory change (E3), and it fails closed; staff recover by retiring the old email or disabling the old user (`services/federation.ts:225-240`). Per-issuer uniqueness would need the email on `accounts`; no uniqueness would turn E3 into two active users with one address and would make admin lookups by email ambiguous. Neither buys a case that works today.

### 06 RLS cost on the hot path (`06-rls-seed.sql`, `zz-probe-b-rls.ts`, `zz-probe-b-rls-plan.ts`, `06-*.log`)

Seed: 50 organisations × 200 users (10,000 users and members), 10 groups and 20 entitlements per organisation (10 group, 9 member, 1 organisation-wide), every user in 2 groups (20,000 assignments), one `admin_session` capability per organisation on a resource bound as the admin resource. 500 calls per pass, the same users in the same order; runtime role (RLS on, policy-user) against the owner (superuser, RLS bypassed).

| Measure | RLS on | RLS bypassed | Delta |
|---|---|---|---|
| `effectiveGrants` wall time, mean (two pairs) | 7.07 / 6.14 ms | 5.82 / 4.91 ms | +1.24 ms |
| its 3 statements, EXPLAIN ANALYZE planning (200 runs each) | 1.24 / 1.31 ms | 0.44 / 0.44 ms | +0.84 ms |
| its 3 statements, execution | 0.74 / 0.77 ms | 0.29 / 0.30 ms | +0.46 ms |
| main permission statement, server mean (`pg_stat_statements`) | 0.289 ms | 0.180 ms | +0.109 ms |
| membership lock statement, server mean | 0.035 ms | 0.033 ms | +0.002 ms |
| policy-user read of `groups` / `entitlements` / `organization_capabilities` / `group_members` (400 rows), server mean | 0.039 / 0.093 / 0.023 / 1.090 ms | 0.018 / 0.061 / 0.007 / 0.823 ms | +0.02 / +0.03 / +0.02 / +0.27 ms |

The membership subselect runs once per statement (hashed) and costs little; RLS's cost is mostly planning, because node-postgres sends unnamed statements and each policy adds OR branches with subselects to five joined tables. Extrapolated, not measured on `userResourcePolicy`: at the scale model's 900 s tokens (10,000 users × 3 hosts × 32 refreshes a working day ≈ 33/s) +1.3 ms is about 4% of one core; at the Toolbox's 60 s registration (≈ 500/s) about 0.65 of a core.

### 07 `protect_grant_context` (`07-grant-seed.sql`, `zz-probe-b-grant-trigger.ts`, `07-grant-trigger.log`)

The real `createResourceGrant` as the runtime role, 1,000 sequential admissions per pass, trigger enabled versus disabled.

| Pass | INSERT…SELECT server mean | createResourceGrant wall mean |
|---|---|---|
| on | 0.2303 ms | 12.34 ms |
| off | 0.1600 ms | 11.06 ms |
| off | 0.1577 ms | 12.04 ms |
| on | 0.2324 ms | 13.58 ms |

+0.072 ms per grant (45% of the insert, under 1% of an admission). Grants are made once per authorisation, about 1,000 a day at the scale model, so cost is not the argument.

50 concurrent admissions of one user, `lock_timeout` 2 s, an owner connection holding an UPDATE on one row for 2.5 s:

| Row held | Trigger on | Trigger off |
|---|---|---|
| the user's `users` row | 0/50, 50 × `temporarily_unavailable` at 2,062 ms | 0/50, 50 × at 2,041 ms |
| the session's `sessions` row | 0/50, 50 × at 2,068 ms | 0/50, 50 × at 2,069 ms |
| the member's `members` row | **0/50, 50 × at 2,137 ms** | **50/50 admitted, p50 128 ms** |

The user and session waits are the transaction's own locks (`lockUser` share; `tenantAuthentication` `FOR SHARE OF accounts, sessions`). The trigger adds one lock, `FOR SHARE OF m`. Every writer of a member row already holds a lock that conflicts with the admission's: member commands lock the organisation `FOR UPDATE` (`services/tenant-context.ts:52`, default mode in `db/locks.ts:19`), organisation erasure locks the organisation, user erasure locks the user (`services/users.ts:159`); the five `update(members)` sites are `db/queries/organizations.ts:197`, `members.ts:121,135,153`, `users.ts:257`. Check by check:

| Trigger check (`0001_invariants.sql`) | Made by the issuing transaction | Lock it holds |
|---|---|---|
| member, organisation, user match | the insert-select takes `organization_id`, `member_id`, `user_id` from the joined rows (`create-resource-grant.ts:85-87`) | organisation, user `FOR SHARE` |
| member active, not deleted | `isEffective(members)`, which also checks the validity window the trigger ignores | organisation `FOR SHARE` |
| organisation, user active and not deleted | insert-select where clause | `FOR SHARE` on both (`lockResourceGrantTargets`) |
| session live, `created_at` = `auth_time`, account, provider, revision, upstream time | copied from the joined session row; `expires_at > statement_timestamp()` | session, account `FOR SHARE` (`tenantAuthentication`) |
| session's authentication organisation = grant organisation | `tenantAuthentication` in the same transaction | session `FOR SHARE` |
| client live and enabled, scopes ⊆ client scopes | insert-select where clause | client `FOR SHARE` |
| resource available to the tenant | insert-select where clause | resource `FOR SHARE` |

The branch's remaining value is against a writer other than `createResourceGrant`; RLS admits grant inserts only under platform-write (no platform command inserts one; the only inserter outside tests is `create-resource-grant.ts:80`) or the admission binding. The one test of the branch forges rows as the owner (`auth/user-oauth.integration.test.ts:2716-2737`).

### 08 The scope vocabulary spike (`08-spike-apply.ts`, `08-spike.diff`, `08-spike-migration.diff`, `08-run-spike-tests.ts`, logs `08-*`)

Test set (`08-spike-tests.txt`, 25 files): the runtime-role policy, isolation and role tests, `queries/grants`, the catalogue-equivalence test, tenant authentication, user OAuth, grant locks, platform-users context, root policy lock, command authority, federation, the admin route tests for members, entitlements, groups, access, directory and platform-directory context, audit events, users, sessions, capabilities, user-erasure audit and `/me`, and the separation matrix. The test database was reset with each run's regenerated migrations (`bun run db:regenerate`, then `db:test:migrate`).

| Run | Change | Result |
|---|---|---|
| baseline | none | 654 pass, 0 fail, 185 s; matrix 0 leaks |
| spike 1 | delete `policy-root`, `platform-users`, `grant-admission`; routing restricted to the tenant in tenant scopes; **also** `tenantAuthentication` runs in its caller's scope and `currentGrantAuthentication` under policy-user instead of protocol | 648 pass, 6 fail; matrix 0 leaks |
| spike 2 | spike 1 without the two helper changes; 5 test sites renamed to the merged kinds | 651 pass, 3 fail; matrix 0 leaks, 0 unexpected |

Typecheck of spike 1: production code clean; 5 test sites named removed kinds.

Failures and what they protect:

| Run | Test | Cause | Real protection or vocabulary |
|---|---|---|---|
| 1 | three lock-order tests (`grant admission rechecks expiry after waiting for the native provider lock`, `human admission …`, `human permissions expiring during a provider lock wait …`) | "Expected the admission and provider writer to block each other": under policy-user, `SELECT … FOR SHARE` on `sso_providers` is filtered through `routing_write`'s USING clause, which does not admit policy-user, so the lock silently took no row | **real**: protocol is load-bearing wherever ID locks provider rows; reverted |
| 1 | `independently verified B account evidence admits the same global user to B` | the test opened the removed `grant-admission` kind | vocabulary |
| 1, 2 | `RLS denies missing/read-only context …` (`runtime-role.integration.test.ts:410`) | platform:users commands, now platform-write, can read groups, entitlements, capabilities | vocabulary (least privilege inside the platform tier; no tenant boundary) |
| 1, 2 | `administrative RLS isolates rows while retaining routing …` (`runtime-role-policy.integration.test.ts:393-398`) | asserts "routing is intentionally public to all database scopes" | the design the fix changes |
| 2 | `grant RLS scopes isolate tenants, clients and admission sessions …` (`user-oauth.integration.test.ts:2876-2881`) | admission with another session of the same user now reads that user's grants | vocabulary (same user); the insert binding re-proved below |

`08-spike-insert-binding.sql` on the spiked test database, runtime role, provenance trigger disabled so only RLS decides: policy-user with matching subject and session inserts 1 row; another session `42501`; no session GUC (the token path) `42501`.

Note on spike 1: `currentGrantAuthentication` also lost its provider and account locks under policy-user and no test failed; see open question 2.

### 09 Reads the database does not back (`09-unbacked-reads.sql`, `.log`)

Runtime role, tenant-read for Q5 organisation 2, asking for organisation 1's rows: groups 0, entitlements 0, members 0, capabilities 0 (RLS); `sso_providers` **1** (`routing_read = true`); users 10,000, sessions 1, accounts 1, clients 2, organisations 52 (no RLS). Under protocol: inserting a membership into organisation 2 succeeds; rewriting organisation 1's SSO provider issuer succeeds (revision 1 → 2), both rolled back.

## Scope vocabulary: call sites

The 24 call sites of `setDatabaseScope`/`withDatabaseScope` outside test files (22 in production code, 2 in `__tests__/capabilities.ts`). RLS tables in bold.

| # | Call site | Mode | What it reads and writes | Policies hit | Broader mode admitting nothing new for these queries |
|---|---|---|---|---|---|
| 1 | `bootstrap.ts:113` provision | tenant-write (platform org) | oauth_resources, system_bindings (no RLS); insert **groups**, **entitlements** | `tenant_write` on groups, entitlements | platform-write (all rows are the platform organisation's) |
| 2 | `bootstrap.ts:154` | platform-write | insert **organization_capabilities** | `capability_write` | none (only mode that writes capabilities) |
| 3 | `bootstrap.ts:165` | tenant-write | insert **audit_events** | `audit_insert` (true) | any |
| 4 | `bootstrap.ts:195` verify | tenant-write | oauth_resources, organizations, audit | `audit_insert` | any |
| 5 | `auth/database-adapter.ts:115` | protocol | every Better Auth transaction: sessions, accounts, users, verifications, tokens, consents, clients; insert **members** at sign-in (`sso-origin.ts:95`); no-op UPDATE lock of **sso_providers** (SSO plugin `lockSSOProviderRow`, `@better-auth/sso/dist/index.mjs:2042-2054`); **organization_domains** read | `tenant_write` (members, protocol branch), `routing_write` (sso, protocol branch), `routing_read` | none: unique (members and provider writes with no tenant known) |
| 6 | `auth/user-oauth-flow.ts:203` | policy-user | verifications; then #8 | none directly | none |
| 7 | `auth/user-resource-policy.ts:37` | policy-user | **grant_contexts**, **members**, permission subqueries on **organization_capabilities**, **entitlements**, **group_members**, **groups** | `grant_read`, members `tenant_read`, `tenant_read` ×3, `capability_read` (policy-user branches) | none |
| 8 | `auth/create-resource-grant.ts:43` | grant-admission | **members** (subject), clients, resources, sessions; insert **grant_contexts** | members `tenant_read`, `grant_insert`, `grant_read` (admission branches) | policy-user with the session (same user; adds reads of the subject's own policy rows) |
| 9 | `auth/tenant-authentication.ts:42` | protocol | `FOR SHARE` on **sso_providers**, accounts, sessions; **members** ⨝ … | `routing_write` USING (the lock), members `tenant_write` | none: the provider lock needs a mode in `routing_write` (spike 1) |
| 10 | `auth/grant-authentication.ts:22` | protocol | `FOR SHARE` on **sso_providers**, accounts; **members** ⨝ … | same as #9 | none, for the same reason |
| 11 | `auth/machine-identity.ts:62` | tenant-read (client's org) | oauth_clients; **organization_capabilities**; insert **audit_events** | `capability_read`, `audit_insert` | none |
| 12 | `auth/verified-sso.ts:302` | protocol | lockUser, sessions, **sso_providers** read, organizations; #9 | `routing_read`; via #9 | none needed |
| 13 | `auth/user-token-boundary.ts:88` | policy-user | **grant_contexts** (subject); #10; #7 | `grant_read` | none |
| 14 | `auth/user-token-boundary.ts:191` | grant-client | verifications, refresh tokens (no RLS, looked up by hash only); **grant_contexts** `FOR UPDATE`, code binding; insert **audit_events** | `grant_read`, `grant_update` (client branch) | none: unique (client-bound grant updates) |
| 15 | `auth/user-token-revocation.ts:32` | grant-client | tokens (client-filtered); **grant_contexts** `FOR UPDATE`, revoke | same | none |
| 16 | `db/client-principal.ts:105` | tenant-read (client's org) | **organization_capabilities** | `capability_read` | none |
| 17 | `db/queries/grants.ts:32` `effectiveGrants` | policy-user | sessions, users (no RLS); **members** ⨝ organizations `FOR SHARE OF organizations`; permission subqueries | members `tenant_read`, `tenant_read` ×3, `capability_read` | none |
| 18 | `db/queries/grants.ts:131` `hasPlatformWriter` | policy-root | organizations ⨝ system_bindings `FOR UPDATE`; **members** and permission subqueries for the bound organisation | `policy-root` branches ×5 | **platform-read**: the query filters to bound organisations, and only the platform organisation can hold `platform:*` |
| 19 | `services/platform-context.ts:39` | platform-read | platform read services | platform-read branches | none |
| 20 | `services/platform-context.ts:70` (users) | platform-users | users, sessions, tokens; **members** read; **grant_contexts** revoke; audit read | members `tenant_read`, `grant_update`, `audit_read`, `audit_users_read` | **platform-write** (admits more, which these commands never touch) |
| 21 | `services/platform-context.ts:70` (write) | platform-write | everything | platform-write branches | none |
| 22 | `services/tenant-context.ts:66` | tenant-write (T) | **members**, **group_members**, **entitlements** soft deletes, **grant_contexts** revoke, audit | `tenant_write` ×3, `grant_update` | none |
| 23 | `services/tenant-context.ts:119` | tenant-read (T) | tenant read services | tenant-read branches, `routing_read` | none |
| t1, t2 | `__tests__/capabilities.ts:17,32` | platform-write | fixture capabilities | `capability_write` | n/a |

What each mode admits that no other mode admits (platform-write admits every row of every RLS table, so "other" means every mode but platform-write):

| Mode | Unique admission |
|---|---|
| protocol | members INSERT/UPDATE and SSO provider UPDATE with no tenant bound; the only non-platform mode that can lock provider rows |
| platform-write | capability writes; grant inserts without a session binding; every write |
| platform-read | nothing platform-write lacks; all-tenant reads without writes |
| platform-users | nothing platform-write lacks; grant updates across tenants without platform-write's other writes |
| tenant-write | nothing platform-write lacks; writes bound to one tenant |
| tenant-read | nothing tenant-write (same T) or platform-read lacks |
| policy-user | nothing platform-read lacks; rows of the subject's effective organisations |
| policy-root | nothing platform-read lacks |
| grant-client | nothing platform-write lacks; grant updates bound to the authenticated client |
| grant-admission | nothing platform-write lacks; grant inserts bound to subject and session |

Proposed vocabulary, before and after, with the policies each mode keeps:

| Mode | Today | After | Policies it appears in after |
|---|---|---|---|
| protocol | members ALL, SSO provider write, routing read | unchanged | members `tenant_write`; sso_providers `routing_write`; `routing_read` |
| platform-read | SELECT on all 10 | unchanged, also `hasPlatformWriter` | every read policy |
| platform-write | everything | unchanged, also platform:users commands | every write policy, `capability_read`, `audit_read`, `audit_users_read`, `grant_read` |
| platform-users | members, grants, audit reads; grant updates | **deleted** → platform-write | none |
| tenant-read | SELECT where organisation = T | unchanged; routing restricted to T | `tenant_read` ×4, `capability_read`, `grant_read`, `audit_read`, `routing_read` |
| tenant-write | ALL where organisation = T (8 tables), reads of capabilities and audit | unchanged; routing restricted to T | `tenant_write` ×4, `routing_write` ×2, `capability_read`, `grant_read`, `grant_update`, `audit_read`, `routing_read` |
| policy-user | subject's organisations' policy rows; subject's members and grants | **plus** grant INSERT when subject and session match | `tenant_read` ×4, `capability_read`, `grant_read`, `grant_insert` |
| policy-root | the platform organisation's policy rows | **deleted** → platform-read | none |
| grant-client | the client's grants, read and update | unchanged | `grant_read`, `grant_update` |
| grant-admission | subject's members; subject-and-session grants, read and insert | **deleted** → policy-user with `sessionId` | none |

Net: 10 modes → 7; 20 policies stay 20; branches removed: policy-root ×5, platform-users ×5, grant-admission ×3; `routing_read` ×2 changed. Code: 11 files, +25 −33 lines (`08-spike.diff`), migration +13 −18 lines.

## Broker tables without RLS (question 3)

`organizations` has no RLS either; it is added below.

| Table | Read by (transaction, scope) | Why a tenant principal cannot reach another tenant's rows |
|---|---|---|
| sessions | `authorizeCommand` (unscoped, by the principal's own session id and user, `command-authority.ts:36-47`); `effectiveGrants` (policy-user, same ids); `tenantAuthentication` (protocol); Better Auth by token hash (protocol); platform session routes (platform-users) | no tenant route reads sessions except the caller's own; tenant APIs cannot list them (docs/04 "Global session boundary") |
| accounts | `tenantAuthentication`, `currentGrantAuthentication` (protocol, by the session's or grant's account id); federation by (issuer, account id); platform user detail | no tenant route; ids come from the authenticated session or grant |
| users | tenant routes join users only through **members**, which RLS bounds to T (matrix T1–T3: no B user id); platform user routes | the members join; `listMembers` with B's email → empty |
| verifications | Better Auth flows by hashed identifier; the user OAuth flow `FOR UPDATE` by flow id and identifier (`user-oauth-flow.ts:181-192`) | lookups by secret-derived keys bound to the browser session (`flow.userId` must equal the session's user) |
| jwks | key reads for signing and JWKS | public keys; no tenant data |
| oauth_clients | platform routes; `findClientPrincipal` by the bearer's client id; `findClientForAccess` (tenant-read) | every authority check uses the authenticated client; **but** `findClientForAccess` has no organisation predicate (04c existence oracle) |
| oauth_resources | `findResourceForAccess` (shared or own), permission joins | ownership predicate in every tenant query (04c: 404 for B's) |
| oauth_client_resources | permission joins (`memberPermissionFields` eligibility) | links are global configuration; a tenant reads them only joined to its own entitlements |
| oauth_consents | Better Auth consent (user × client) | no tenant route |
| oauth_access_tokens, oauth_refresh_tokens | token endpoint and revocation under grant-client | the refresh lookup is by hash only (`user-token-boundary.ts:244`), but the grant it names is visible only if it is the authenticated client's (`grant_read` client branch); revocation adds a client filter (`user-token-revocation.ts:42-51`) |
| oauth_client_assertions | replay markers by jti digest | no tenant data |
| admin_operations | `executeOperation` by (actor instance, authority scope, name, key digest); `getOperationStatus` is platform-only | a tenant principal's replay lookup is keyed by its own actor instance |
| system_bindings | `effectiveGrants` (isPlatform), `hasPlatformWriter`, bootstrap | platform binding, no tenant data |
| organizations | `withTenantRead` locks the path organisation before authorising; `getOrganization` by context id | the authorisation middleware hides organisations the principal holds no grant for (T1: 404, same as an unknown id) |

The query a wrong `organization_id` would let read across tenants unchecked by the database: **`providerQuery`** (`db/queries/sso-providers.ts:114`, used by `readSsoProvider` for `GET /organizations/{id}/sso-provider` under tenant-read): `sso_providers` has `routing_read = true`, so the tenant filter in the service is the only filter (probe 09: 1 row of another tenant). `listOrganizationDomains` (`organization-domains.ts:80`) is in the same position. Every RLS table returned 0 rows in the same probe. The `routing_read` fix above closes both.

## 4. Considered and kept

- **Typed service contexts** (`tenant-context.ts`, `platform-context.ts`): every tenant read and command takes its organisation from the context; the matrix found no route that crosses it. Their runtime form is a settled "do not re-propose" item (V0 cleanup).
- **Composite foreign keys carrying `organization_id`** (`group_members`, `entitlements`): T2 (A's group with B's member) answers 404 at the service, and probe 01 #5 shows RLS refusing the write beneath it.
- **`protect_private_resource_assignment` and `protect_capability_target`**: refused every cross-tenant resource case (01 #4, 01b, 04 C) including with a shadowing temp table as the owner.
- **The read/write split** (tenant and platform): it is the only database-level read-only guard for the tenant-tier GET routes, which face the internet (`Q-AID-LISTENER`); `SET TRANSACTION READ ONLY` cannot replace it because the read contexts take `FOR SHARE` locks (measured error).
- **`grant-client`**: the one mode that binds token-endpoint grant reads and updates to the authenticated client, and the refresh-token lookup relies on it.
- **`protocol`**: wide (09) but load-bearing for provider locks (spike 1) and sign-in provisioning.
- **Audit RLS**: tenant audit reads return only the tenant's events under every filter (T3); `audit_event_users` is platform-only.
- **`users.email` unique**: consistent with one active domain per organisation; fails closed (05).
- **Runtime role**: grants, attributes and `assertRuntimeRole` hold on PostgreSQL 17 (01, 02b); the temp-table fix holds twice (privilege and qualified names).
- **RLS itself**: +1.24 ms per policy evaluation, mostly planning; it backs every tenant table the matrix touched.
- **`protect_grant_context` UPDATE branch**: not re-measured here; column privileges versus triggers belong to audit D.

## 5. Open questions

1. **Cross-tenant use of a tenant-owned app.** Is there a product case where tenant B's own user-facing app may sign in tenant A's people (a vendor tenant)? If yes, it needs an explicit "shared" marker on clients like `platform_shared` on resources; if no, the fix in the verdict table applies. Settles: the owner's word.
2. **`currentGrantAuthentication`'s locks.** In spike 1 its provider and account `FOR SHARE` locks silently took no row under policy-user and no test failed. Either the refresh path is already serialised through the grant row `FOR UPDATE` (`user-token-boundary.ts:285`) and those two locks can go, or a test is missing. Settles: a refresh racing an SSO provider update, with and without the locks.
3. **Narrowing protocol on `members`.** Sign-in provisioning only inserts (`sso-origin.ts:95`, `onConflictDoNothing`). Splitting the members write policy so protocol may INSERT but not UPDATE would stop a broker-path bug from rewriting another tenant's memberships (09). Not verified: whether any Better Auth path updates `members` under protocol.
4. **RLS planning at a 60 s token lifetime.** The +1.3 ms is extrapolated from `effectiveGrants`; `userResourcePolicy` on the refresh path, and the effect of named prepared statements, were not measured.
5. **`grant_insert`'s platform-write branch** has no caller outside test fixtures (which insert as the owner). Removing it leaves the admission binding as the only way to create a grant. Not verified by a run.
6. **Recovery after a domain move or directory change** (05 E3): the runbook step (retire the old user's email or disable the old user) is not in the onboarding docs I read.

## 6. Blast radius

Counts by grep on 9833960.

| Change | Tables / policies | Functions / triggers | Code files | Tests | Docs | Consumers |
|---|---|---|---|---|---|---|
| Delete `policy-root` | 5 read policies lose a branch (groups, group_members, entitlements, members, organization_capabilities) | none | `db/isolation.ts`, `db/schema/tenant-policies.ts`, `db/schema/capabilities.ts`, `db/queries/grants.ts` | `db/runtime-role.integration.test.ts:554` | `reports/answerable-id-isolation-inventory.md` (lines 14, 39, 53) | none |
| Delete `platform-users` mode | 5 policies (members read, grant read and update, audit read, audit-users read) | none | `db/isolation.ts`, `services/platform-context.ts`, `db/schema/tenant-policies.ts`, `db/schema/audit.ts`, `db/schema/grant-contexts.ts` | `db/runtime-role.integration.test.ts:407-410` | isolation inventory line 43 | none (the `platform:users` scope stays) |
| Merge `grant-admission` into policy-user | 3 policies (members read, grant read, grant insert) | none | `db/isolation.ts`, `auth/create-resource-grant.ts`, `db/schema/tenant-policies.ts`, `db/schema/grant-contexts.ts` | `auth/tenant-authentication.integration.test.ts:267`, `auth/user-oauth.integration.test.ts:2878,2905,2924` (one assertion changes) | docs/04 line 131 ("grant admission"), isolation inventory | none |
| Restrict `routing_read` in tenant scopes | 2 policies | none | `db/schema/tenant-policies.ts` | `db/runtime-role-policy.integration.test.ts:393-398` | docs/04 line 131 ("Routing SELECT … remain available without scope" stays true), isolation inventory line 45 | none |
| Capability client ownership | `organization_capabilities` | `protect_capability_target` (one condition) | `services/capabilities.ts:99-108` | add one case | docs/03 registration policy | acceptance registers unowned host clients: unaffected |
| `findClientForAccess` predicate | none | none | `db/queries/oauth-clients.ts:109-121` | add one case | none | admin MCP access tools: unaffected for unowned and own clients |
| Delete `protect_grant_context` INSERT branch | `grant_contexts` (optional composite FK onto `members (organization_id, id)`) | `protect_grant_context` loses ~35 lines; SECURITY DEFINER and its REVOKE line become unnecessary if only the UPDATE branch remains | `drizzle/0001_invariants.sql` | `auth/user-oauth.integration.test.ts:2716-2737` (forged inserts) | docs/04 "User grant context" (the insert-trigger sentence), isolation inventory | none |
| Optional: revoke `jwks` UPDATE/DELETE, `oauth_client_assertions` UPDATE | 2 tables | none | `db/runtime-role.ts` | runtime-role census assertions if any | docs/04 "Runtime database permissions" | none |

Every migration change above regenerates `0000_initial.sql` (`bun run db:regenerate`) and is covered by the catalogue-equivalence test, which passed in both spike runs.
