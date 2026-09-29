# Answerable ID: authorisation and entitlement model (as of main d55220d, 2026-09-28)

Read-only survey of `apps/id` for the Toolbox hub architecture report. Every fact cites `path:line`. Sections are filled in as files are read.

## Status (sections appear in the order 1, 2, 3, 4, 7, 5, 6, 8)
- [x] 1 Schema
- [x] 2 Policy evaluation
- [x] 3 Tokens
- [x] 4 Admin API
- [x] 5 Access views
- [x] 6 Audit
- [x] 7 Registering an MCP server today
- [x] 8 Constraints and "Not yet" items

---

## 1. Schema (`apps/id/src/db/schema/*`)

Base: `/Users/anthonyriera/code/answerable/apps/id/src/db/schema/`. Shared column helpers in `columns.ts`: `id()` = app-generated UUIDv7 PK with no DB default (`columns.ts:8`); `timestamps()` = created_at/updated_at (`:18-24`); `effectiveWindow()` = `valid_from`/`valid_until` nullable timestamptz (`:26-29`) with `windowCheck` = `valid_from < valid_until` (`:31-35`); `slugCheck` = `^[a-z0-9]+(-[a-z0-9]+)*$` (`:61-62`). Vocabularies (`vocabulary.ts`): `userStatuses` = inert|active|disabled (`:6`), `membershipStatuses` = active|revoked (`:9`), `lifecycleStatuses` = active|disabled (`:11`), `auditActorTypes` = user|client|system (`:24`), `auditOutcomes` = success|failure|denied (`:28`).

### 1.1 organizations (`auth.ts:64-99`)
Columns: deleted_at, id, name, slug (unique, slugCheck), logo, metadata (text), status active|disabled, disabled_at, created_at/updated_at, `authorization_version` int >0 default 1 (`:78`), `revision` int >0 default 1 (`:79`). No RLS on this table.

### 1.2 users (`auth.ts:36-62`)
deleted_at, id, name, email (unique, must be lower(btrim)), email_verified, image, status inert|active|disabled (default **inert**: "imported, cannot log in until bound to an upstream identity", `vocabulary.ts:5`), disabled_at, retired_email, timestamps.

### 1.3 members (`auth.ts:196-239`)
deleted_at, id, revision, organization_id (FK orgs cascade), user_id (FK users cascade), `role` text default 'member' ("Confers no authority in Answerable ID, where entitlements decide access", `:208-210`), status active|revoked, revoked_at (must agree with status, `:222-225`), `valid_from`/`valid_until` (effectiveWindow, `:215`, windowCheck `:237`), created_at. Unique (organization_id, user_id) `:226`; unique (organization_id, id) `:232` so entitlements can FK the pair. RLS via `membershipPolicies` (`tenant-policies.ts:23-44`).

### 1.4 sessions (`auth.ts:101-143`)
id, expires_at, token, authentication_organization_id/provider_id/provider_revision/account_id (historical origin), `upstream_auth_time` (only from validated upstream ID token, `:112-113`), timestamps, ip_address, user_agent, user_id, active_organization_id ("Never an authorization input: the token's organization comes from membership", `:120-121`).

### 1.5 groups (`authorization.ts:74-111`)
deleted_at, id, organization_id (FK cascade), slug (slugCheck), name, `external_id` (upstream directory group id, e.g. Entra object id, `:84-85`), status active|disabled, timestamps, revision. Unique (org, slug) `:95`; unique (org, id) `:101` (for composite FKs); unique (org, external_id) where not null `:105`. RLS `tenantPolicies`.

### 1.6 group_members (`authorization.ts:117-156`)
deleted_at, organization_id, group_id, member_id, `valid_from`/`valid_until` (`:124`, windowCheck `:150`), created_at, id (PK), revision. Composite FKs (org, group_id)->groups and (org, member_id)->members, both cascade, "so a group can only ever contain members of its own organization" (`:113-116`). Unique live (group_id, member_id) where deleted_at is null `:131`. No status column: liveness = not soft-deleted + window. RLS `tenantPolicies`.

### 1.7 oauth_clients (`oauth.ts:35-96`) — Better Auth oauth-provider 1.7.2 owned
deleted_at, id (row uuid), `client_id` text unique (`:40`), client_secret, client_discovery_id, reference_id, name, uri, icon, contacts[], tos, policy, software_*, `redirect_uris[]` not null, post_logout_redirect_uris, backchannel_logout_*, token_endpoint_auth_method, application_type, jwks, jwks_uri, grant_types[], response_types[], require_pkce, `dpop_bound_access_tokens` bool default false (`:66`), subject_type, `scopes[]` (`:70`), `client_credentials_scopes[]` ("Server-owned ceiling for client_credentials; null or empty denies machine tokens", `:71-72`), skip_consent, enable_end_session, disabled, user_id, `organization_id` (FK orgs restrict, `:79` = owner org, nullable), metadata jsonb, timestamps, revision, `authorization_version` (`:85`). No RLS. Note: the client has **no capabilities column**; capabilities live in `organization_capabilities`.

### 1.8 oauth_resources (`oauth.ts:98-143`)
deleted_at, id (row uuid), `classification` platform_shared|tenant_owned default platform_shared (`:104-108`), organization_id (FK restrict; must be null iff platform_shared, `:131-134`), `identifier` text unique = "The RFC 8707 resource indicator and the `aud` claim value" (`:112-113`), name, `access_token_ttl` int (`:115`), `refresh_token_ttl` int (`:116`), signing_algorithm, signing_key_id, `allowed_scopes[]` (`:119`), `custom_claims` jsonb (`:120`; CHECK forbids keys client_instance, organization_id, authorization_version, organization_authorization_version, subject_type, membership_id, grant_id, resource_instance, upstream_auth_time, `:137-141`), `dpop_bound_access_tokens_required` bool default false (`:121`), disabled, revision, `policy_version` int default 1 (`:126`), metadata, timestamps. No RLS.

### 1.9 oauth_client_resources (`oauth.ts:145-172`)
"Server-owned link: which clients may request tokens for which resources." deleted_at, id, client_id (FK cascade), `resource_id` = the resource **identifier** string (`:154-155`), metadata, created_at. Unique live (client_id, resource_id).

### 1.10 oauth_refresh_tokens / oauth_access_tokens / oauth_consents / oauth_client_assertions (`oauth.ts:174-294`)
- refresh: token unique, client_id, session_id (set null), user_id, reference_id, authorization_code_id, resources[], scopes[] not null, expires_at not null, revoked, `rotated_at`, `rotation_replay_response`, `rotation_replay_expires_at` (`:198-200`), auth_time, confirmation jsonb.
- access: `token` unique **nullable** ("Set for opaque tokens only; JWT access tokens are verified by signature", `:219`), client_id, session_id, user_id nullable, resources[], refresh_id, scopes[], expires_at, revoked, confirmation.
- consents: client_id, user_id, resources[], scopes[], timestamps.
- client_assertions: single-use private_key_jwt `jti` digests (`:280-294`).
- jwks (`:22-32`): id = kid, public_key, private_key (encrypted), alg, crv, expires_at.

### 1.11 organization_capabilities (`capabilities.ts:31-106`) — "Platform-approved ceilings are separate from tenant assignments."
Columns (`:35-51`):
| column | type / constraint |
|---|---|
| deleted_at | timestamptz nullable |
| id | uuid PK |
| organization_id | uuid not null FK organizations cascade |
| client_id | text nullable FK oauth_clients.client_id **restrict** |
| resource | text nullable FK oauth_resources.identifier **restrict** (`:54-58`) |
| grant_kind | text not null, one of `admin_session`, `authorization_code`, `refresh_token`, `client_credentials` (`:24-29`) |
| scopes | text[] not null; cardinality > 0, no '' and no null (`:84-87`) |
| status | active|disabled default active |
| valid_from / valid_until | nullable, `valid_from < valid_until` (`:88-92`) |
| created_at / updated_at | |
| revision | int > 0 default 1 |

Constraints:
- Unique live row per (organization_id, client_id, resource, grant_kind) with NULLS NOT DISTINCT (added in SQL migration; `:59-62`).
- `organization_capabilities_target_check` (`:77-83`): `admin_session` => client_id null AND resource not null; `authorization_code`/`refresh_token` => client_id not null (resource nullable); `client_credentials` => client_id AND resource both not null.
- RLS (`:93-104`): write only when `answerable.scope = 'platform-write'`; read for platform-read/write, tenant-read/write of own org, `policy-user` (org where the subject is an active in-window member), `policy-root` (org in system_bindings).
So a capability row = (org, grant_kind, optional client, optional resource) -> scope ceiling. It is a **platform** decision (only platform tier can write it).

### 1.12 entitlements (`authorization.ts:158-237`)
Doc comment (`:158-166`): "Principal: the whole organization (member_id and group_id null), one group, or one member. Target: a client, a resource, or an exact client/resource pair. Resource-only assignments cannot grant OAuth service access. Grants are additive within the same exact target: a person is entitled when any active row matches them for the target."
Columns (`:170-189`):
| column | type / constraint |
|---|---|
| deleted_at | timestamptz nullable |
| id | uuid PK |
| organization_id | uuid not null FK organizations cascade |
| member_id | uuid nullable; composite FK (org, member_id) -> members (`:194-198`) cascade |
| group_id | uuid nullable; composite FK (org, group_id) -> groups (`:199-203`) cascade |
| client_id | text nullable FK oauth_clients.client_id restrict |
| resource | text nullable FK oauth_resources.identifier restrict |
| scopes | text[] not null; cardinality > 0 and no '' (`:232-235`; unlike capabilities, null elements are not checked here) |
| status | active|disabled default active |
| valid_from / valid_until | nullable, windowCheck (`:231`) |
| created_at / updated_at | |
| revision | int > 0 default 1 |

Constraints:
- `entitlements_principal_check`: `num_nonnulls(member_id, group_id) <= 1` (`:218-221`) => principal is **org-wide, one group, or one member (a single user in that org)**. Yes, individual users can be targeted directly (via their member row).
- `entitlements_target_check`: `num_nonnulls(client_id, resource) >= 1` (`:222-225`) => target is client-only, resource-only, or exact (client, resource) pair.
- Unique live (org, member_id, group_id, client_id, resource) NULLS NOT DISTINCT (`:204-215`): one live row per principal x target shape; scopes are a set on that one row.
- RLS `tenantPolicies` (`:192`): tenant-write of own org or platform-write may write. So **tenant admins can write entitlements** (unlike capabilities).

### 1.13 grant_contexts (`grant-contexts.ts:16-93`)
"One immutable authority context per user authorisation, shared by its rotations." id, organization_id, member_id, user_id, `client_instance_id` (FK oauth_clients.id row uuid), `resource_instance_id` (FK oauth_resources.id, nullable), authorization_code_id unique, authentication_session_id, auth_time, authentication jsonb (GrantAuthentication), `requested_scopes[]`, created_at, expires_at, revoked_at. RLS: insert only platform-write or `grant-admission` mode by the subject's own session; read includes `grant-client` (the client that owns it).

### 1.14 audit_events / audit_event_subjects (`audit.ts:21-107`)
audit_events: id, occurred_at, actor_type user|client|system, actor_id text, organization_id (nullable, no FK), action text, target_type text, target_id text nullable, outcome success|failure|denied, reason, `request_id` text (`:34`), ip, user_agent, data jsonb, `operation_id` FK admin_operations restrict (`:38`), schema_version int default 1. Indexes: (org, id), operation_id, (action, occurred_at), actor_id, (target_type, target_id). RLS `auditPolicies` (`tenant-policies.ts:62-72`): insert always; read platform-* or tenant of own org.
audit_event_subjects: (event_id, entity_type, entity_id, relationship) PK, organization_id, provenance recorded|legacy_derived.

### 1.15 admin_operations (`operations.ts:5-33`)
"Permanent command reservations": id, actor_instance, authority_scope, name, key_digest, fingerprint, outcome applied|noop, status_code, result_reference {type,id} jsonb, committed_at. Unique (actor_instance, authority_scope, name, key_digest) = idempotency-key reservation.

### 1.16 system_bindings (`system-bindings.ts:8-28`)
Single row `name='platform'` -> organization_id, resource_id (the platform admin-API resource), group_id (platform-admins group).

### 1.17 tenant boundary: RLS modes (`tenant-policies.ts`)
`answerable.scope` settings seen: `platform-write`, `platform-read`, `platform-users`, `tenant-write`, `tenant-read`, `policy-user`, `policy-root`, `protocol`, `grant-admission`, `grant-client`. Tenant is `answerable.tenant`, subject `answerable.subject`, session `answerable.session`, client `answerable.client`.

---

## 2. Policy evaluation

Base: `/Users/anthonyriera/code/answerable/apps/id/src/`.

### 2.1 Scope arithmetic (`auth/grant-scopes.ts`)
- `grantScopes(requested, ceilings)` (`:2-13`): `allowed` = intersection of ALL ceilings (starting from `ceilings[0]`); if `requested` is undefined, selected = allowed; else selected = dedup+sorted requested. Returns `null` unless selected is non-empty AND every selected scope is in `allowed`. => an explicit request with any scope outside the intersection is refused outright (no silent narrowing).
- `narrowScopes(requested, ceilings)` (`:16-28`): keeps only requested scopes present in every ceiling; `null` if none survive. Used only at browser authorisation (`narrow: true`), see 2.4.
- `identityScopes` (`:30-37`) = openid, profile, email, offline_access, address, phone. These are handled by the client-login decision, never by resource ceilings.

### 2.2 Effective-window and principal matching (`db/queries/effective.ts`)
- `isEffective(table)` (`:11-26`): `deleted_at is null` (if column exists) AND `status = 'active'` (if column exists) AND `(valid_from is null or valid_from <= statement_timestamp()) and (valid_until is null or valid_until > statement_timestamp())`. Evaluated at statement time.
- `matchingEntitlements(executor)` (`:28-52`): entitlement rows in the member's org that are effective AND (org-wide: member_id null and group_id null) OR (member_id = this member) OR (group_id IN groups the member belongs to via `group_members` where the group is `status='active'`, not deleted, and the group_members row is effective (not deleted + window)). => group membership resolves through `group_members`; one level, no nested groups; a member's direct row and any group rows are unioned.

### 2.3 Fact collection (`auth/member-permission.ts:42-150`, `memberPermissionFields`)
One SQL statement gathers, for a (member, client, resource) triple:
- `activeMember` (`:46-52`): member effective (status active + window + not deleted), user status active and not deleted, org active and not deleted.
- `loginEligible` (`:54-61`): activeMember AND client not disabled/deleted AND client `grant_types @> ['authorization_code']`.
- `resourceEligible` (`:62-69`): resource not disabled/deleted AND (classification platform_shared OR resource.organization_id = member's org). **A tenant_owned resource is only reachable by its owning org's members.**
- `eligible` (`:95`): loginEligible AND resourceEligible AND a live `oauth_client_resources` row links this client to this resource.
- `refreshEnabled` (`:96-98`): client grant_types contains refresh_token.
- `client.scopeCeiling` = `oauth_clients.scopes` (`:83`); `resource.scopeCeiling` = `oauth_resources.allowed_scopes` (`:90`).
- `capabilities` (`:106-121`): `organization_capabilities` rows of the member's org where `client_id IS NOT DISTINCT FROM <this client>` (so client-less rows only match when evaluating without a client) and (`resource is null` OR `resource = this resource`) and effective.
- `assignments` (`:122-148`): `entitlements` rows via `matchingEntitlements` with `client_id IS NOT DISTINCT FROM <this client>` and (`resource is null` OR `resource = this resource`), each carrying the `groupMembership` evidence (group_members id/revision, group revision, window).
- `evaluatedAt` = `statement_timestamp()`; `organization.authorizationVersion`, `client.authorizationVersion`, revisions of client/resource/membership are captured as evidence.

### 2.4 Decisions
**(a) Client login** `evaluateClientLoginPermission` (`:234-299`): requires `loginEligible`; capability = org capability row with `resource IS NULL` and `grant_kind='authorization_code'` for this client (`:251-253`); assignments = entitlement rows with `resource IS NULL` for this client (`:254-256`); for refresh also needs a `refresh_token` capability with resource null (`:257-261`). Requested scopes beyond the original request → `login` denial (`:263-268`). Ceilings (`:269-275`) = [client.scopes, capability.scopes, union of assignment scopes, originalScopes (if any), renewal.scopes (refresh)]. Scopes = `narrowScopes` when `narrow` else `grantScopes`. Denial reasons: `context`, `capability`, `login`.

**(b) Admin session** `evaluateAdminPermission` (`:302-331`): resource-only; requires `adminEligible` and an `admin_session` capability; ceilings = [resource.allowed_scopes, capability.scopes, union of assignment scopes]; `grantScopes(undefined, ...)` => the granted set is the full intersection. Used for the platform admin API session (resource-only entitlements "authorise direct sessions only at the bound admin resource", `:301`).

**(c) User resource token** `evaluateUserResourcePermission` (`:336-436`): requires `eligible` (+ refreshEnabled for refresh); scopes outside `originalScopes` → `scope` denial (`:358-362`); the **client-login decision must itself pass** (`:363-364`); then the **exact pair** capability = `organization_capabilities` row with `resource === input.resource` AND `grant_kind='authorization_code'` (and matching client, from the SQL filter) (`:365-368`); refresh additionally needs the pair `refresh_token` capability (`:369-372`, `:383-384`); `pairAssignments` = entitlement rows with `resource === input.resource` (and client matched in SQL; `:373-375`) — i.e. entitlements whose target is the **exact (client, resource) pair**. Non-narrowed requests asking identity scopes not granted at login → `login` denial (`:376-382`). Ceilings (`:385-394`) = [client.scopes, resource.allowed_scopes minus identity scopes, pairCapability.scopes, union of pairAssignments scopes, originalScopes (if defined), renewal.scopes (refresh)]. Identity scopes are stripped from the request before the resource arithmetic (`:395-397`); on success the granted set adds back the identity scopes approved at login (`:407-418`).

So, in code, **"capability ceiling"** = the org's platform-approved `organization_capabilities.scopes` for the exact (org, client, resource, grant_kind), intersected with the client's `scopes` and the resource's `allowed_scopes`; **"exact pair"** = the entitlement/capability row must name both this client_id and this resource identifier — a client-only or resource-only row does not contribute to a resource token (the SQL filter `resource is null or resource = X` returns the client-only rows too, but `pairAssignments`/`pairCapability` then filter to `resource === input.resource`; the client-only rows only feed the login decision). Effective granted scopes = requested ∩ client.scopes ∩ resource.allowed_scopes ∩ pairCapability.scopes ∩ (∪ scopes of all matching pair entitlements: org-wide + member + groups) ∩ originalScopes.

### 2.5 Entry point at token time (`auth/user-resource-policy.ts:20-95`)
Looks up the `grant_contexts` row by id → user; runs under RLS mode `policy-user` for that user (`:37-40`); one statement joins grant_contexts→members (same member/org/user)→users→organizations→oauth_clients (by row uuid `client_instance_id`)→oauth_resources (by `resource_instance_id`), requiring `revoked_at is null` and `expires_at > statement_timestamp()` (`:70-79`). Then `evaluateClientLoginPermission` (no resource) or `evaluateUserResourcePermission`, with `originalScopes = grant.requestedScopes`. Header comment: "Narrow only in browser authorisation; native issuance uses stored code or refresh-token scopes."

### 2.6 Machine (client_credentials) (`auth/machine-capability.ts:6-74`)
`findMachineCapability(tx, {organizationId, clientId, resource})` (see queries/capabilities.ts) → if no row: `unauthorized_client`. Scopes = `grantScopes(requested, [client.client_credentials_scopes minus identity scopes, capability.scopes, resource.allowed_scopes])` (`:28-34`); failure → `invalid_scope`. Entitlements play **no part** for machine tokens (no member principal).

### 2.7 Access views (`db/queries/access.ts`)
- `memberAccess(context, memberId)` (`:53-166`) → `{ effective: boolean, targets: [{ kind: 'client'|'resource'|'client_resource', id, resource?, permission: {allowed, reason} | approved view, scopes: union of entitlement scopes for that target, via: [{entitlementId, principal: 'organization'|'group'|'member', groupId}] }] }`. NB: `scopes` here is the **union of entitlement scopes** (`:152`), NOT the intersected granted set — `memberPermissionView` strips `grantedScopes` (`:223-231`), and the approved view carries `scopes` (the intersected set computed by `grantScopes(undefined, ceilings)` = full intersection) plus evidence.
- `targetAccess(context, target, page)` (`:167-252`) → paginated members entitled to an exact target `{clientId?, resource?}` (exact null matching, `:192-197`), each with `memberId, userId, email, name, scopes (distinct union of entitlement scopes), permission`.

---

## 3. Tokens

### 3.1 User resource access token (authorization_code / refresh_token)
Minted by the installed `@better-auth/oauth-provider` (bundled in `apps/id/dist/server.js`, `createJwtAccessToken` at `dist/server.js:79186-79211`) with Answerable's claims extension (`src/auth/user-token-boundary.ts:60-80`, `identity()`), then **re-asserted** after minting by `src/auth/user-token-assertions.ts:122-149`.

| claim | value | source |
|---|---|---|
| header `typ` | `at+jwt` | provider `JWT_ACCESS_TOKEN_TYPE`; asserted `user-token-assertions.ts:134`; verifier requires it (`packages/auth/src/index.ts:77`) |
| `alg` | EdDSA (JWKS from `jwt` plugin; admin verifier pins `["EdDSA"]` `http/principal.ts:92`; MCP verifier accepts EdDSA/ES256/RS256 `packages/auth/src/index.ts:76`) | |
| `iss` | `BETTER_AUTH_URL` bare origin (`src/auth.ts:271`, e.g. `https://id.answerable.org`) | asserted `:136` |
| `sub` | the **user id** (UUIDv7) | asserted `:135` |
| `aud` | the resource `identifier` string; plus `${baseURL}/oauth2/userinfo` when `openid` was requested (array then) | `user-token-assertions.ts:124-132`; provider `dist/server.js:78705-78708` (single string when one audience, else array; provider constant `MAX_AUD_VALUES = 64` but ID enforces **exactly one resource** per grant: `user-oauth-flow.ts:185-188`, `user-token-boundary.ts:274`, `machine-provider.ts:81-91`) |
| `client_id` and `azp` | the OAuth `client_id` | asserted `:137-138` |
| `scope` | space-joined granted scopes (sorted, deduped) | `:143` |
| `iat`, `exp` | `exp` = resource `access_token_ttl` when set (min across resources, `dist/server.js:78671-78677`), else provider `accessTokenExpiresIn` default **3600 s** (`dist/server.js:79959`, `:79613`); ID sets no override, so **the resource row's `access_token_ttl` is the only knob** (the e2e fixture uses 60) | |
| `jti` | random 32 chars | `dist/server.js:79207` |
| `sid` | provider session id override; **for user resource tokens ID rejects it as an admin credential** (`http/principal.ts:295-298`: "User-delegated tokens are not admin credentials.") | |
| `subject_type` | `"user"` | `user-token-boundary.ts:62` |
| `organization_id` | `grant_contexts.organization_id` — **the tenant claim name is `organization_id`** | `:63` |
| `membership_id` | `grant_contexts.member_id` | `:64` |
| `grant_id` | `grant_contexts.id` | `:65` |
| `client_instance` | `oauth_clients.id` row uuid | `:66` |
| `resource_instance` | `oauth_resources.id` row uuid (or null) | `:67` |
| `organization_authorization_version` / `authorization_version` | org / client versions at issuance | `:68-70` |
| `upstream_auth_time` | epoch seconds from the SSO ID token, or `null` | `:71-78` |
| `cnf` | only if DPoP-bound (`cnf.jkt`); the MCP verifier **rejects** any `cnf` (`packages/auth/src/index.ts:38` `cnf: z.never().optional()`) | |
| resource `custom_claims` | merged after extension claims; CHECK forbids overriding identity claims (`db/schema/oauth.ts:137-141`) | |

There is **no `auth_time` in the access token** (it is in the ID token, `user-token-assertions.ts:175`), **no `act`/delegation claim, no `tenant`/`org` short name, no group or role claims**. Refresh reuse interval: `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS` default 0 (`src/env.ts:92-97`); refresh TTL = resource `refresh_token_ttl` else 2 592 000 s (30 d, `dist/server.js:79361`); grant context lifetime = `options.refreshTokenExpiresIn ?? 2_592_000` (`user-oauth-flow.ts:218`). Refresh **rotates** (provider `rotated_at`, `rotation_replay_response` columns; `withNativeRefreshFamily`); every refresh re-runs `userResourcePolicy` with `grantType: "refresh_token"` (`user-token-boundary.ts:310-317`) so entitlement changes take effect at the next refresh and a disabled org/member stops refresh at once (docs/07 "Offline verification": "A disabled organisation's issued token works until it expires; refresh stops at once").

Narrowing: at browser authorisation the flow calls `userResourcePolicy(..., narrow: true)` (`user-oauth-flow.ts:231-238`) and rewrites the authorization code to the granted subset (`narrow-authorization-code.ts`), so the code and every later token carry only the entitled subset ("Issue the entitled subset (RFC 6749 §3.3); issuance then checks it exactly", `:230`). At the token endpoint scopes beyond the stored code/refresh scopes are `invalid_scope` (`user-token-boundary.ts:291-292`).

### 3.2 Machine token (client_credentials) (`src/auth/machine-provider.ts`, `machine-identity.ts`)
Requires **exactly one `resource`** form field (`machine-provider.ts:80-91`, `invalid_target`); identity scopes refused (`:108-109`); client must have `client_credentials` in `grant_types` (`:100-103`); client must be owned by an org (`clientSchema.organizationId` uuid, `machine-identity.ts:21-27`); a `tenant_owned` resource must belong to that org (`:57-61`). Claims (`machine-identity.ts:119-125`): `sub` = `client_id` (asserted `machine-audit.ts:38`), `client_id`, `azp`, `aud` = resource identifier (single), `scope`, `iat`, `exp` (resource TTL else `m2mAccessTokenExpiresIn ?? 3600`, `dist/server.js:79613`), `jti`, plus `client_instance`, `organization_id`, `organization_authorization_version`, `authorization_version`, `subject_type: "client"`. No `sid`, no `grant_id`, no `membership_id`. Machine tokens are stateless JWTs; there is no refresh token for client_credentials.

### 3.3 Revocation (`src/auth/user-token-revocation.ts`)
RFC 7009 `/auth/oauth2/revoke` with client authentication; a refresh-token revocation revokes the whole family and sets `grant_contexts.revoked_at` (`:136-146`); an access-token revocation only marks the stored row (JWT access tokens are verified offline so they keep working until `exp`). Audit `oauth.user.revoked`. Admin-side: `revokeUserSessions`/`revokeUserSession` (platform:users) and member removal revoke grants (docs/04 "Membership revocation").

### 3.4 Discovery / JWKS / introspection
`publicOAuthMetadata` (`src/http/oauth-metadata.ts:5-37`) serves `/.well-known/oauth-authorization-server` from the provider's OpenID config but **deletes** `introspection_endpoint*`, `registration_endpoint`, `end_session_endpoint`, `backchannel_logout_*`, `dpop_signing_alg_values_supported`; advertises `grant_types_supported` = authorization_code, refresh_token, client_credentials and `token_endpoint_auth_methods_supported` = none, client_secret_basic, client_secret_post, private_key_jwt. The MCP verifier reads `jwks_uri` from that document and requires it to share the issuer origin (`packages/auth/src/index.ts:59-68`). **No introspection is reachable, no RFC 8693 token exchange, no DCR, no `act` claim** (grep over `apps/id/src` non-test: only the metadata deletions and schema flags match). DPoP: schema flags exist (`oauth_clients.dpop_bound_access_tokens`, `oauth_resources.dpop_bound_access_tokens_required`) and the provider can mint `cnf`, but metadata hides DPoP and the MCP verifier rejects `cnf`, so treat DPoP as **not offered**.

---

## 4. Admin API (`apps/id/src/http/admin/*`, `apps/id/openapi.admin.json`)

### 4.1 Authentication of a principal (`src/http/principal.ts:193-401`)
Three principal types (`:30-44`): `root` (the `ROOT_ADMIN_SECRET` bearer, locked once a platform writer exists unless `ROOT_ADMIN_BREAK_GLASS=true`, `:216-245`), `user` (Better Auth **session cookie**, `:325-368`; user must be `active`; browser `Origin` must be trusted, and non-GET requests must send `Origin`), and `client` (a **client_credentials JWT** whose `aud` is the admin resource identifier `ADMIN_RESOURCE_IDENTIFIER` default `${BETTER_AUTH_URL}/api/admin`, `src/env.ts:221-224`; verified with `typ at+jwt`, EdDSA, issuer, audience `:87-94`; `sub === client_id`, `azp` must match; identity claims must equal the current client row and org versions `:287-294`). **User-delegated (authorization_code) tokens are rejected**: any token carrying `sid` fails with "User-delegated tokens are not admin credentials." (`:295-298`); and the machine identity schema requires `subject_type: "client"` (`machine-identity.ts:13-19`), so a `subject_type: "user"` token fails `machineIdentitySchema.parse` (`:103`) → `invalid_token`.
Grants: a user's grants come from `effectiveGrants` (`db/queries/grants.ts:26-129`) = for each org membership (restricted to the session's `authentication_organization_id`), `evaluateAdminPermission` against the admin resource (resource-only entitlements + `admin_session` capability); `isPlatform` = org in `system_bindings`. A client's grant = its `client_credentials_scopes ∩ resource allowed scopes ∩ token scopes ∩ adminScopes` for its **own org only** (`:300-323`).
Admin scopes (`admin/scopes.ts:1-8`): `platform:read`, `platform:users`, `platform:write`, `org:read`, `org:users`, `org:write`.

### 4.2 Tiers and authorisation (`src/http/authorize.ts:67-100`, `admin/route-table.ts:35-37`)
`tierOf(route)` = `tenant` when the route has an `orgScope` (or is `open`), else `platform`. `authorize()`: root → platform tier; a platform grant with the route's `platformScope` → platform tier; else, for routes with `orgScope` and an `{organizationId}` path param, a grant for that org with `orgScope` → tenant tier; otherwise 403 `insufficient_scope` (or 404 `not_found` when the principal has no grant for the org and no platform grant). NB: `org:write` is defined but **no route in `openapi.admin.json` uses it** (see 4.4). The docs/AGENTS "platform tailnet-only" tier: the OpenAPI marks `x-tier` only; network restriction is deployment (docs/06), not code in `apps/id/src/http`.

### 4.3 Mutation contract
- **Idempotency**: every write requires `Idempotency-Key` (fixture sends `crypto.randomUUID()` on each call, `scripts/mcp-e2e-fixture.ts:80`); reservations are permanent rows in `admin_operations` keyed by (actor_instance, authority_scope, name, key_digest) (`db/schema/operations.ts:21-27`); replays return the receipt `{operationId, outcome: applied|noop, statusCode, resultReference}` (`admin/schemas.ts:7-12`) at the original status; "Matching retries require current authority ... mismatches conflict" (docs/04 "Completed administrative operations"). `GET /operations/{operationId}` reads a receipt (platform:read).
- **Revisions**: PATCH/PUT accept `If-Match: "<id>:<revision>"` strong ETag (`admin/revision.ts:8-22`); GETs return `ETag`; PUT accepts `If-None-Match: *` for expected absence (`:40-54`).
- **confirm**: erase/remove routes take `?confirm=<target id>` ("Must equal the target id.", `admin/schemas.ts:31-38`).
- **Fresh authentication**: `x-fresh-authentication: true` on sensitive human commands (five-minute freshness, docs/04 "Native SSO session origin"); some PATCHes exempt display-only fields (`unlessOnly`).
- `x-kind`: read | write | erase.

### 4.4 Operations touching capabilities, entitlements, groups, group members, access views, resources, clients (from `openapi.admin.json`)
Prefix `/api/admin/v1`. Format: METHOD path — operationId — kind/tier — scopes.
**Capabilities** (Tag Entitlements/…): GET `/organizations/{organizationId}/capabilities` — listCapabilities — read/tenant — platform:read | org:read · POST same — createCapability — write/**platform** — platform:write ("Approve an organisation capability") · GET/PATCH/DELETE `/organizations/{organizationId}/capabilities/{capabilityId}` — getCapability (read/tenant, platform:read|org:read), updateCapability (write/platform, platform:write), removeCapability (write/platform, platform:write).
**Entitlements**: GET `/entitlements` — listAllEntitlements — read/platform — platform:read · GET `/organizations/{organizationId}/entitlements` — listEntitlements — read/tenant — platform:read | org:read · POST same — createEntitlement — write/**platform** — platform:write · GET/PATCH/DELETE `/organizations/{organizationId}/entitlements/{entitlementId}` — getEntitlement (read/tenant), updateEntitlement (write/platform), removeEntitlement (write/platform) · POST `.../entitlements/{entitlementId}/disable|enable` — write/platform — platform:write.
**Groups**: GET `/organizations/{organizationId}/groups` — listGroups — read/tenant · POST — createGroup — write/platform · GET/PATCH/DELETE `.../groups/{groupId}` — getGroup (read/tenant), updateGroup (write/platform, fresh unless only `name`), eraseGroup (erase/platform) · POST `.../groups/{groupId}/disable|enable` — write/platform.
**Group members**: GET `.../groups/{groupId}/members` — listGroupMembers — read/tenant · GET/PUT/DELETE `.../groups/{groupId}/members/{memberId}` — getGroupMember (read/tenant), putGroupMember ("Add or update a group member", write/platform), removeGroupMember (write/platform).
**Members**: GET `/organizations/{organizationId}/members` — listMembers — read/tenant · GET `.../members/{memberId}` — getMember — read/tenant · PATCH `.../members/{memberId}` — updateMember ("Update a member window") — write/**tenant** — platform:users | org:users · DELETE — removeMember — write/tenant — platform:users | org:users · POST `.../reinstate` — write/tenant · GET `.../members/{memberId}/configuration` — read/tenant — platform:users | org:users.
**Access views**: GET `/organizations/{organizationId}/members/{memberId}/access` — getMemberAccess ("Inspect a member's assignments and permissions") — read/tenant — platform:read | **org:users** · GET `/organizations/{organizationId}/access` — listTargetAccess ("List assigned members and current permissions") — read/tenant — platform:read | org:read.
**Resources**: GET/POST `/resources` — listResources/createResource — platform (read: platform:read; write: platform:write) · GET/PATCH/DELETE `/resources/{resource}` (URL-encoded identifier) — getResource/updateResource/eraseResource — platform · POST `/resources/{resource}/disable|enable` — platform:write.
**Clients**: GET/POST `/clients`; GET/PATCH/DELETE `/clients/{clientId}`; POST `.../disable|enable|rotate-secret`; PUT `.../owner` ("Verify unchanged client owner"); PUT/DELETE `/clients/{clientId}/resources/{resource}` — linkClientResource/unlinkClientResource — all platform tier, platform:write (reads platform:read).
**Me**: GET `/me` — getAdminMe — open (any authenticated principal) — "Get the current principal and grants".
**Audit**: GET `/audit-events` (platform:read), GET `/organizations/{organizationId}/audit-events` (read/tenant, platform:read | org:read), GET `/users/{userId}/audit-events` (platform:read).

**Decision-relevant**: in the shipped API an organisation admin (tenant tier) can only **read** capabilities, entitlements, groups and group members, and can only **write member windows / remove / reinstate members**. Every entitlement, capability, group and group-membership mutation is platform-only (`platform:write`). This matches docs/04 "Only platform writers approve ceilings" for capabilities, but for entitlements the schema RLS (`tenantPolicies`, tenant-write) and the table comment ("Enterprise customers assign access by group") anticipate tenant writes that the HTTP layer does not yet expose (`createEntitlement` requires `PlatformWriteContext`, `db/queries/entitlements.ts:35-39`).

---

## 7. Registering a new MCP server today (`apps/id/scripts/mcp-e2e-fixture.ts:93-167`)
"The same registration an operator performs for a new MCP server." All calls go to `/api/admin/v1` with a bearer (root secret in the fixture) and a fresh `Idempotency-Key` per call:
1. `POST /resources` `{ classification: "platform_shared", organizationId: null, identifier: "http://127.0.0.1:47602/mcp", name, allowedScopes: ["e2e:identity","e2e:read","e2e:write","offline_access"], accessTokenTtl: 60 }` (`:94-101`). The identifier is the MCP's URL and becomes `aud`.
2. `POST /clients` `{ clientId: "mcp-e2e-browser", name, tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code","refresh_token"], redirectUris: [callback], scopes: ["openid","offline_access", ...scopes] }` (`:102-109`) — one public client per MCP host app.
3. `PUT /clients/{clientId}/resources/{resource}` — link client to resource (`:110-113`).
Then **per organisation** (after org, domain and SSO provider exist):
4. Four capability rows (`:143-156`): for `grantKind` in `authorization_code`, `refresh_token`: one with `resource: null` and scopes `["openid","offline_access"]` (client login ceiling) and one with `resource: <mcp url>` and the resource scopes (exact pair ceiling).
5. Two entitlement rows (`:157-167`): org-wide `{ clientId, scopes: ["openid","offline_access"] }` (client login) and org-wide `{ clientId, resource, scopes: entitledScopes }` (exact pair; `mcp-gamma` gets only `["e2e:identity","e2e:read"]` to prove the subset).
Total: 3 platform calls per MCP + 6 platform calls per organisation (4 capabilities + 2 entitlements), all `platform:write`. Scope strings are free-form (`e2e:read`); nothing in ID parses a prefix. Entitlements here are org-wide; a member- or group-scoped variant adds `memberId` or `groupId` to the same body (`db/queries/entitlements.ts:24-33`).

---

## 5. Access views (effective grants) and change notification

### 5.1 Endpoints
- `GET /api/admin/v1/organizations/{organizationId}/members/{memberId}/access` — `getMemberAccess` (`http/admin/access.ts:131-153`), tier tenant, scopes `platform:read` | `org:users`; service `services/access.ts:15-22` → `db/queries/access.ts:53-166` `memberAccess`.
- `GET /api/admin/v1/organizations/{organizationId}/access?clientId=&resource=` — `listTargetAccess` (`:154-183`), tier tenant, `platform:read` | `org:read`; exact-null matching on the omitted field (`db/queries/access.ts:192-197`); cursor-paginated (`limit` 1..200, default 50, `http/pagination.ts:6`).
There is **no endpoint keyed by user id across organisations**, no "all resources for this org" summary, and no endpoint an MCP could call with a bearer for the MCP's own resource (all reads require an admin principal with admin scopes for the admin resource audience).

### 5.2 Exact shapes (`http/admin/access.ts:20-129`)
memberAccess response:
```
{ effective: boolean,
  targets: [ { kind: "client" | "resource", id: string }
           | { kind: "client_resource", id: <clientId>, resource: <url> }
           & { scopes: string[],            // UNION of the matching entitlement rows' scopes ("assignment projections")
               permission: { allowed: false, reason: "context"|"login"|"capability"|"scope" }
                         | { allowed: true, reason: "approved", grantType, subjectType: "user",
                             organization: {id, authorizationVersion}, subject: {userId, memberId},
                             client: {id, clientId, revision, authorizationVersion, scopeCeiling} | null,
                             resource: {id, identifier, revision, scopeCeiling} | null,
                             requestedScopes: null,
                             scopes: string[],          // the INTERSECTED, actually grantable set
                             evidence: { policyVersion, evaluatedAt, membership: {id, revision, validFrom, validUntil},
                                         capabilities: [{id, revision, resource, grantKind, scopes, validFrom, validUntil}],
                                         assignments: [{id, revision, resource, scopes, validFrom, validUntil, memberId, groupId,
                                                        groupMembership: {id, revision, groupRevision, validFrom, validUntil} | null}] } },
               via: [{ entitlementId, principal: "organization"|"group"|"member", groupId }] } ] }
```
targetAccess response: `{ items: [{ memberId, userId, email, name, scopes: string[] (union), permission: <same union> }], nextCursor }`. Denied members stay in the page (route description `:160`).
Route description (`:137`): "Permission is not authentication, consent, refresh approval or a promise that a token can be issued. Top-level scopes remain assignment projections; permission.scopes contains the approved scopes."

### 5.3 Per-request use vs cache/event
- Every read opens a transaction, takes a `FOR SHARE` lock on the organisation row (`services/tenant-context.ts:125-129`) and re-authorises the caller; `Cache-Control: no-store` (`admin/tenant-read.ts:13`). It is designed for access reviews, not a hot path.
- **No webhook, outbox, change feed, LISTEN/NOTIFY or ETag on the access views.** Only the audit log is append-only and pollable (`GET /organizations/{org}/audit-events?action=entitlement.updated&from=...`, cursor by event id). docs/05 §7: "No second authorisation framework, generic workflow engine, speculative outbox ... is required"; docs/02-plan "Not yet" list includes "transactional outbox for provisioning events".
- Revisions that a hub could use as change markers: `entitlements.revision`, `groups.revision`, `group_members.revision`, `members.revision`, `organization_capabilities.revision`, `oauth_resources.revision`/`policy_version`, `oauth_clients.revision`, and `organizations.authorization_version` / `oauth_clients.authorization_version` (bumped on security transitions and embedded in every token, `docs/04` "Organisation authorization version"). There is no single per-org "entitlements changed" counter.
- The token itself is the designed per-request signal: an MCP never calls ID per request (docs/07 "Offline verification"); the token's `scope` is already the entitled intersection at issuance, re-evaluated on every refresh; access-token lifetime is bounded at 60..3600 s by the admin API (`http/admin/resources.ts:47`).

---

## 6. Audit

### 6.1 Columns (`db/schema/audit.ts:21-66`)
`id` (uuidv7, also the cursor), `occurred_at`, `actor_type` user|client|system, `actor_id` (user id, client_id, or "root"/"anonymous"/"oauth-client-authentication"), `organization_id` (nullable, no FK), `action`, `target_type`, `target_id`, `outcome` success|failure|denied, `reason`, `request_id` (from the `x-request-id` header the caller sent; ID's own request id is set in `http/context.ts` `requestId` and used for admin denials), `ip`, `user_agent`, `data` jsonb, `operation_id` (FK to `admin_operations`; every journalled mutation's events carry it), `schema_version` (1..4; "Action plus schema version defines a payload", docs/04). Companion `audit_event_subjects` (event_id, entity_type, entity_id, relationship, organization_id, provenance) is trigger-owned and powers `GET /users/{userId}/audit-events` (`db/queries/audit.ts:171-217`).

### 6.2 Events relevant to a hub (writers in non-test code)
- Sign-in: `auth.signin.succeeded`, `auth.signin.rejected` (`http/signin-audit.ts`, `auth/verified-sso.ts`), `auth.signout` (`auth/audit-hooks.ts:34`), `identity.linked`.
- User OAuth (`auth/user-oauth-audit.ts:10-15`, schemaVersion 4, target_type `grant_context`, target_id = grant id, data includes `decision` evidence and the authentication snapshot): `oauth.user.authorized` (browser consent complete), `oauth.user.denied` (outcome denied), `oauth.user.issued` (code exchange or refresh; data `{grantType, scopes, decision}`), `oauth.user.replayed`, `oauth.user.revoked` (data `{effect: refresh_family|access_token}` or `{reason: <kind>_replay}`).
- Machine tokens (`auth/machine-audit.ts`): `oauth.token.issued` (actor client, target_type `access_token`, target_id = `jti`, data `{decision, issuedAt, expiresAt}`, schemaVersion 2) and `oauth.token.rejected` (outcome denied for 4xx protocol errors else failure; reason ∈ access_denied, invalid_client, invalid_target, invalid_scope, unauthorized_client, invalid_request, temporarily_unavailable, request_rejected, authentication_failed, issuance_failed). An audit-insert failure turns issuance into `temporarily_unavailable` + `Retry-After: 1` (`:69-79`).
- Admin API: `admin.root_request` (every root call), `admin.auth_failed` (reason = problem code), `admin.denied` (reason not_found|insufficient_scope, target = operationId) (`http/principal.ts`, `http/authorize.ts`).
- Mutations (data `{before, after}` and, for entitlements, `audience` = the member/group-member rows affected when the principal is org-wide or a group, `services/entitlements.ts:53-61`): `entitlement.created|updated|update_unchanged|enabled|disabled|enable_unchanged|disable_unchanged|removed`; `capability.created|updated|update_unchanged|removed`; `group.created|updated|update_unchanged|enabled|disabled|…|erased`; `group_member.added|updated|update_unchanged|removed`; `member.updated|removed|removal_unchanged|reinstated|reinstatement_unchanged`; `client.*` (created, updated, disabled, enabled, secret_rotated, resource_linked, resource_unlinked, grants_revoked, grants_erased, erased…); `resource.created|updated|disabled|enabled|erased`; `organization.*`; `user.disabled|enabled|email_retired|erased`; `session.revoked|revoked_all`; `bootstrap.applied`.
### 6.3 Correlation
Downstream services correlate by: the token's `jti` (machine: audit target_id) or `grant_id` (user: audit target_id of every `oauth.user.*` row), `organization_id`, `client_id`, and the `x-request-id` header if the client sent one (`request_id`). Admin mutations correlate by `Operation-Id` response header = `audit_events.operation_id` (`http/admin/command.ts:122`). Reads: platform `GET /audit-events` (filters operationId, organizationId, actorId, action, outcome, targetType, targetId, from, to; `db/queries/audit.ts:76-86`) and tenant `GET /organizations/{org}/audit-events` (same minus organizationId; hides legacy link payloads `:107-116`).

---

## 8. Constraints and invariants that matter for a hub

- **Scope strings**: free-form non-empty strings without whitespace. Admin API: `z.array(z.string().min(1)).min(1)` for entitlements (`http/admin/entitlements.ts:60`), capabilities (`http/admin/capabilities.ts:37`), resources `allowedScopes` (`http/admin/resources.ts:49`), clients `scopes`/`clientCredentialsScopes` (`http/admin/clients.ts:66`). DB: non-empty array, no `''` (`entitlements_scopes_check`, `organization_capabilities_scopes_check`). MCP side: `packages/mcp-base/src/definitions.ts:63,112` rejects empty or whitespace-containing scopes. Identity scopes (`openid profile email offline_access address phone`) are reserved for client-login rows and must not appear on a resource capability (`services/capabilities.ts:162`). No prefix grammar, no wildcard, no hierarchy: `e2e:read` is just a string. **No count limit** on scopes per resource/entitlement/token other than the 256 KiB body limit (`http/request-limits.ts:4`) and the JWT size.
- **Client id**: `^[a-z0-9][a-z0-9-]{2,63}$` (`http/admin/clients.ts:68-71`); name ≤ 200; `tokenEndpointAuthMethod` ∈ client_secret_basic | private_key_jwt | none; `grantTypes` ⊆ {client_credentials, authorization_code, refresh_token}; `redirectUris` must be URLs.
- **Resource**: `identifier` must be a URL (`resources.ts:57`) and unique; `accessTokenTtl` int **60..3600** (`:47`), `refreshTokenTtl` int ≥ 60 (`:48`); effective access-token `exp` = min(3600, resource TTL) (`dist/server.js:79424-79432`); refresh = min(resource refresh TTL, 30 d). `signingAlgorithm` ∈ EdDSA|ES256|RS256. `classification` platform_shared (org null) or tenant_owned (org required); tenant_owned resources are reachable only by that org's members/clients (`member-permission.ts:62-69`, `machine-identity.ts:57-61`).
- **One audience per token**: ID enforces exactly one `resource` per authorisation, exchange, refresh and machine request (`user-oauth-flow.ts:185-188`; `user-token-boundary.ts:274-286`; `machine-provider.ts:80-91`); `aud` is a string, or an array only when `openid` adds the userinfo audience. Multiple MCPs → multiple authorisations (docs `oauth.mdx`: "Multiple resources require separate authorisations"). A hub therefore cannot obtain one token covering several MCP audiences.
- **Entitlement principal granularity**: org-wide, one group, or **one member** (`entitlements_principal_check`); target: client-only, resource-only, or exact pair (`entitlements_target_check`); one live row per (principal, target) (`entitlements_principal_target_unique`, NULLS NOT DISTINCT) so per-user overrides are a separate row that is **unioned** with org/group rows, never subtractive. Denials are only possible by removing/disabling rows or windows; there is no "deny" row.
- **Capability ceiling is per org and platform-owned**: `organization_capabilities` (RLS write = platform-write only, `capabilities.ts:93-97`; API `platform:write`); one row per (org, client, resource, grant_kind); user access needs the client-login capability AND the exact-pair capability (and `refresh_token` twins for renewal). A hub that provisions a tool for an org needs platform authority for the capability rows; a tenant admin cannot approve their own ceiling (docs manage.mdx "a tenant administrator cannot approve their own ceiling").
- **Platform tenant claim is not a data bypass**: a platform-org client's token gives `isPlatform: true` grants only via `system_bindings` membership (`db/client-principal.ts:76`, `db/queries/grants.ts:94`), and platform reads are still authorised per route scope; entitlements/capabilities are always evaluated for `members.organizationId` = the token's org (`member-permission.ts:118,146`; RLS `policy-user` limits reads to the subject's own orgs, `tenant-policies.ts:12-14`). Resource-only pair scopes "cannot satisfy direct administrative grants or designate a platform writer" (manage.mdx). `platform:` scopes on an `admin_session` capability are refused outside the bound platform org (`services/capabilities.ts:121-136`).
- **MCP runtime contract**: an MCP verifies offline with `createIdVerifier` (`packages/auth/src/index.ts:54-93`: discovery → `jwks_uri` on the issuer origin → `jwtVerify` with `typ at+jwt`, `aud` = its resource URL, required `exp iat sub`, `subject_type: "user"`, uuid `organization_id`/`membership_id`/`grant_id`, rejects `cnf`); tools/prompts/resources are registered per request only when `definition.scopes ⊆ principal.scopes` (`packages/mcp-base/src/index.ts:76-82`); the protected-resource metadata advertises `scopes_supported` = union of definition scopes (`:96-99`). The verifier only accepts `subject_type: "user"`, so **machine tokens cannot call an MCP built on mcp-base today**. "An MCP never calls ID per request" (docs/07). Nothing in `packages/auth` or `mcp-base` calls the admin API.
- **Admin API accepts only session cookies or client_credentials JWTs**; user-delegated tokens are rejected (`principal.ts:295-298`; manage.mdx:223 "accepting user OAuth tokens at that API is Not yet"). A hub acting for a person cannot forward the person's MCP token to ID's admin API; it would need its own machine client with `client_credentials_scopes` and an exact machine capability for the admin resource (`onboard.mdx` "Get a staff token").
- **Authorisation versions**: `organizations.authorization_version` and `oauth_clients.authorization_version` are in every token and rechecked on admin bearer use (`principal.ts:287-294`); offline resource servers only observe them at expiry ("Offline resource servers require expiry or an online check to observe a changed authorization version", manage.mdx:429).
- **Evaluation time**: windows use `statement_timestamp()` of the evaluating statement (`effective.ts:18`; manage.mdx "Evaluation time").
- **"Not yet" items relevant to a hub** (docs/02-plan.md:29-35,62,68; docs/03:81,99; docs/07:31-34; onboard.mdx:488-497; manage.mdx:37,223,229-233,429): DCR and CIMD (`Q-MCP-CLIENT-REGISTRATION`, needs Better Auth 1.7.6 for `@better-auth/cimd`); RFC 8693 token exchange ("built off the critical path, contributed upstream"); DPoP for external MCP clients; SCIM provisioning; transactional outbox for provisioning events; introspection (closed); device flow, PAR (closed); tenant self-service for groups, group membership, entitlements, domains and SSO (`org:write` reserved, unused); accepting user OAuth tokens at the admin API; tenant session/delegation views; machine principals for MCPs, hosted deployment, Claude.ai against a public URL and the admin MCP (docs/07); bounded upstream-disable detection and downstream logout delivery; full administrative console.

### Docs vs code
- `docs/04` says "28 tables ... eleven RLS-enabled tables" and lists RLS on groups, group_members, entitlements, organization_capabilities, grant_contexts, members, invitations, organization_domains, sso_providers, audit_events, audit_event_subjects — matches the schema files read (all `.enableRLS()`).
- Table comment on `groups` ("Enterprise customers assign access by group") and `tenantPolicies` RLS allow tenant writes on entitlements/groups, but the HTTP layer exposes those writes only at platform tier; manage.mdx:229-233 states this honestly ("Manage groups or group membership: Not yet", "Assign apps through entitlements: Not yet"). No disagreement, but the schema is ahead of the API.
- oauth.mdx "Issued scopes ... drops the rest" matches `narrow: true` at authorisation (`user-oauth-flow.ts:237`) and the `access_denied` when nothing survives (`:239-247`).
- The `docs/07` claim "ID owns token lifetimes" is true only within 60..3600 s for access tokens; the fixture's 60 s is the floor.
- manage.mdx:37 says `org:write` is "Reserved"; code confirms no route uses it (`openapi.admin.json`).
