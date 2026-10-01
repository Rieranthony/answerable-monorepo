# The Answerable admin MCP (draft of `docs/11-admin-mcp.md`)

> **TL;DR**
> - **Decides:** the staff-only MCP that onboards and manages organisations in Answerable ID through tools, who may use which tool, how it acts on ID and the Toolbox, and what it records.
> - **Rule:** a person's role is read from Answerable ID on every call; the server acts on ID with its own credential and never beyond that role; every write is a prepared intent whose id is the idempotency key upstream.
> - **Not here:** the Toolbox ([`08-capability-platform.md`](../../08-capability-platform.md)), the rules every MCP follows ([`09-mcp-design-standard.md`](../../09-mcp-design-standard.md)), the build order ([`task_plan.md`](task_plan.md)).

Every fact below is in [`findings.md`](findings.md) (F-numbers) with how it was verified.

## Purpose

Answerable staff onboard client organisations into Answerable ID and manage them: create the organisation, route its email domains, connect its directory, enable the Toolbox for it, grant its people access, read its members and its audit trail, and disable it. Today that is cURL against the admin API with a staff token ([`/docs/id/onboard`](../../../apps/web/content/docs/id/onboard.mdx)). The admin MCP gives the same work to an AI host such as Claude Code, with the same care: a person signs in with their Answerable account, sees exactly the tools their role allows, and every change is prepared, previewed, confirmed, committed once and recorded.

It is for Answerable staff only. An organisation's own administrators get a different MCP later (Not yet).

## Glossary

| Term | Meaning |
| --- | --- |
| **Platform organisation** | The organisation ID binds in `system_bindings` at startup (`answerable` locally). Its members are Answerable staff. Only its members can use the admin MCP at all (F3, F8). |
| **Role** | What a staff member may do through the admin MCP: `team` (read), `admin` (read and ordinary writes) or `owner` (everything, including the critical operations and who is staff). Roles are additive; the highest held counts. |
| **Role grant string** | The entitlement scope that confers a role on the admin MCP resource: `answerable-team`, `answerable-admin`, `answerable-owner`. Held by a group of the platform organisation (by convention the groups have the same slugs; the slug confers nothing, the entitlement does). |
| **Critical operation** | A mutation only an owner may prepare and commit, and only with a fresh upstream authentication: disabling or enabling an organisation, and granting or revoking a staff role. |
| **Execution id** | The UUIDv7 the SDK mints per call. It travels to ID as `x-request-id`, so ID's audit row names it (F9). |
| **Intent** | A prepared mutation, as in the Toolbox: preview, targets with versions, single-use commit token, policy class. Its id is the `Idempotency-Key` of the ID write it commits (F10). |

## Architecture

```text
Claude Code (public client, PKCE) --OAuth 2.1, audience = the admin MCP--> mcps/admin (Bun, @answerable/mcp)
                                                                              |-- verifies the person's token offline (packages/auth)
                                                                              |-- reads the person's role from ID per call (machine client, platform:read)
                                                                              |-- performs the change on ID (machine client, platform:write) or on the Toolbox's admin API (toolbox:admin)
                                                                              |-- keeps intents and evidence in its own Postgres (answerable_admin)
```

| Piece | Where | Role |
| --- | --- | --- |
| The server | `mcps/admin` (`@answerable/mcp-admin`), provider id `admin`, port 47520 locally | `createMcpServer({ provider, auth, allow, policyClass, intents, wrapCall })` with the tools below |
| The ID client | `@answerable/id-admin` (extracted from `mcps/toolbox/src/id.ts`) | `createIdAdmin`: `platform:read` for reads, `platform:read platform:write` for writes, `x-request-id` and a caller-chosen `Idempotency-Key` per call, `If-Match`, 401 renewed once; the fake ID for tests |
| Intents and evidence | `@answerable/evidence` (extracted from the Toolbox's `intents.ts`, `intent-evidence.ts`, `evidence.ts`, `db/migrate.ts`, migrations 0002 and 0004) | The Postgres intent store, the hash-chained evidence, the migrator; shared with the Toolbox |
| Its databases | `answerable_admin`, `answerable_admin_test` (`infra/postgres/init/004-create-admin-databases.sql`) | Intents and evidence |
| Its registrations in ID | Resource `http://localhost:47520/mcp` (allowed scopes `admin`, `offline_access` and the three role grant strings; 900 s tokens for Claude Code); public client `claude-code-admin` (`openid offline_access admin`, redirect `http://localhost:47700/callback`); the platform organisation's login and `admin` capabilities and organisation-wide entitlements for that client; machine client `admin-mcp` of the platform organisation with `platform:read platform:write` on ID's admin resource and `toolbox:admin` on the Toolbox's admin resource (A1); groups `answerable-team`, `answerable-admin`, `answerable-owner`, each with one entitlement on the resource carrying its role grant string | Everything ID needs to issue the person's token and to tell the server the person's role |

Two deployment facts shape it. **ID refuses a person's token at its admin API** (F1), so the server acts with its own machine credential and enforces the person's authority itself (docs/08 "Upstream identity", R28). **A machine client bypasses ID's five-minute freshness rule** (F4), so the server has its own freshness rule for critical operations.

## Roles and permissions

| Role | Grant string | May |
| --- | --- | --- |
| none (any platform member with the `admin` scope) | — | `admin_whoami` only: who they are and that they hold no role |
| team | `answerable-team` | Every read tool |
| admin | `answerable-admin` | Reads and the ordinary writes: create and update organisations, add domains, set the SSO provider, create groups and set group membership, grant and revoke access, enable the Toolbox |
| owner | `answerable-owner` | Everything, plus the critical operations: disable and enable an organisation, grant and revoke a staff role |

Where they live: in ID, as entitlements of groups of the platform organisation whose target is the admin MCP resource (F5). Changing who is staff is a group membership change (`staff.grant`, `staff.revoke`, owner only, or ID's API by root during the first run). A role change reaches the person on their next call: no re-authorisation, no cache (below). A client organisation can never pass: the server checks the token's organisation against the platform organisation's id, learned at boot from `GET /me` as its machine client (`grants[].isPlatform`, F3), and treats everyone else as having no tools at all.

Not a second permission store: the server holds no table of who may do what. It interprets three strings from ID's member access view and maps them to tools in code (the table below). ID's `allowedScopes` accepts any string (F6), so the server accepts exactly these three and ignores the rest.

## Authority model

Per request, in order:

1. **Token.** `packages/auth` verifies the token offline: issuer, audience = the admin MCP's resource, `at+jwt`, expiry, user claims. The token's scopes are `admin` and `offline_access`; they never carry a role (docs/02: tool-level permissions never live in the token).
2. **Platform organisation.** `principal.organizationId` must equal the platform organisation's id. Otherwise `allow` is false for every tool: `tools/list` is empty and every call is the unknown-tool error, as the Toolbox answers a grant the person lacks.
3. **Role, live.** One read of `GET /organizations/{platform}/members/{membershipId}/access` per request, shared by every `allow` decision of that request (a `WeakMap` on the principal, as the Toolbox does): the scopes of the target whose resource is the admin MCP, intersected with the three role grant strings. Measured: 32 ms median, 49 ms max (F5). No 60-second cache and no audit poller: staff-only traffic is small, and a revoked owner must lose the tools on the next call. ID unavailable: `tools/list` fails and a call answers `UPSTREAM_UNAVAILABLE`; nothing is served from memory (fail closed).
4. **Tool minimum.** `allow(principal, tool, called)` is `role ≥ tool.minimumRole`; a refused call is recorded as `capability.denied` evidence. The SDK re-runs `allow` on commit requests (F20), so a commit re-checks the role.
5. **Policy class.** Every mutation is `controlled`: the host shows the person the preview and commits with `admin_commit_confirmed` and the summary word for word. `human` is Not yet (no approval page); `agent` is not used.
6. **Freshness, critical operations only.** `prepare` of a critical tool requires `upstream_auth_time` (F2, exposed as `principal.upstreamAuthTime`) within `ADMIN_FRESH_SECONDS` (default 1,800). Older answers `ADMIN_REAUTHENTICATION_REQUIRED` (retry `after_state_change`; `details.upstream_auth_time`, `details.max_age_seconds`; the message says to sign in again from the host, `/mcp` then Authenticate in Claude Code). Commit re-runs `prepare` (F20), so a stale session cannot commit an intent prepared when fresh. A refreshed token keeps the original `upstream_auth_time` (F2), so a refresh never counts as a sign-in.

`admin_whoami` answers for every platform member: user, membership, organisation, host client, grants, role, `upstream_auth_time`, the tools they may use, and, when the role is none, the sentence to ask an owner.

## Tools

Identity `admin/<domain>.<operation>`; wire names replace `.` with `_`. Every list takes `limit` (default 20, at most 100) and `cursor` and returns `items`, `next_cursor`, `has_more`; identifiers are ID's UUIDs; times are ISO 8601. Every mutation is a prepare tool plus the shared `admin_commit` and `admin_commit_confirmed`. Effects use the SDK vocabulary (`permission_change`, `publication` for a new organisation, `cascade_delete` for disable).

| Identity | Kind | Risk → class | Minimum role | What it does, and the ID operations it uses |
| --- | --- | --- | --- | --- |
| `admin.whoami` | read | — | none | Who you are to the admin MCP (above) |
| `organisations.list` | read | — | team | `q`, `status` → `listOrganizations` |
| `organisations.get` | read | — | team | The organisation, its domains and its SSO provider summary (issuer, domain, credentials, `hasClientSecret`) → `getOrganization`, `listOrganizationDomains`, `getSsoProvider` (404 → `null`) |
| `members.list` | read | — | team | `email`, `q`, `effective` → `listMembers` |
| `members.get` | read | — | team | The member, their groups and their access targets → `getMember`, `getMemberAccess` |
| `groups.list` | read | — | team | → `listGroups` |
| `access.list` | read | — | team | The organisation's entitlements: principal (organisation, group, member), target (client, resource), scopes, status, window → `listEntitlements` |
| `audit.list` | read | — | team | `organisationId?`, `action?`, `actorId?`, `from?`, `to?` → `listAuditEvents` or `listOrganizationAuditEvents`; items carry `requestId` and `operationId` |
| `sso.test` | read | — | team | ID's connectivity test of the organisation's provider → `testSsoProvider` (it refuses loopback HTTP issuers, F13) |
| `staff.list` | read | — | team | The platform organisation's members with their roles → `listMembers`, `listGroupMembers` of the three role groups (found by their entitlement, not their slug) |
| `organisations.create` | mutate | normal → controlled | admin | `slug`, `name`. Prepare: the slug is free (`listOrganizations?q=`). Targets: none. Commit: `createOrganization`. Effects: `publication` |
| `organisations.update` | mutate | normal → controlled | admin | `name`, `logo`, `metadata`. Target: the organisation (ETag). Commit: `updateOrganization` with `If-Match` |
| `domains.add` | mutate | normal → controlled | admin | `domain`. Target: the organisation. Commit: `createOrganizationDomain` |
| `sso.set` | mutate | normal → controlled | admin | `issuer`, `domain`, platform credentials only (Google or Microsoft issuers, F13; a generic issuer answers `INVALID_INPUT` naming the cURL workaround, because a secret never enters a tool, R29, and ID needs one, F-probe 3/4). Target: the current provider (ETag) or none. Preview warns that replacing a provider revokes the organisation's existing grants. Commit: `putSsoProvider` with `If-Match` or `If-None-Match: *` |
| `groups.create` | mutate | normal → controlled | admin | `slug`, `name`. Target: the organisation. Commit: `createGroup` |
| `groups.addmember` | mutate | normal → controlled | admin | `groupId`, `memberId`, `validUntil?`. Target: the group member row (ETag) or none. Commit: `putGroupMember`. Effects: `permission_change` |
| `groups.dropmember` | mutate | normal → controlled | admin | Target: the group member row. Commit: `removeGroupMember`. Effects: `permission_change` |
| `access.grant` | mutate | normal → controlled | admin | `principal: { kind: organisation \| group \| member, id? }`, `resource?`, `clientId?`, `scopes`. Prepare: every scope is in the resource's `allowedScopes` (else `INVALID_INPUT` naming them) and no identical active row exists (`PRECONDITION_FAILED`). Targets: the organisation and the resource. Commit: `createEntitlement`. Effects: `permission_change` |
| `access.revoke` | mutate | normal → controlled | admin | `entitlementId`. Target: the entitlement (ETag). Commit: `disableEntitlement` (reversible; deletion is Not yet). Effects: `permission_change` |
| `toolbox.enable` | mutate | normal → controlled | admin | `organisationId`, `hostClientIds`, `providers`. Prepare: the Toolbox's `GET /admin/v1/providers` names the providers; target: the organisation. Commit: the Toolbox's enable operation (`POST /admin/v1/organisations/{id}/enable`), which makes the capabilities, entitlements and catalogue rows and reports `created` and `existing`. Effects: `permission_change`, `external_call` |
| `organisations.disable` | mutate | normal → controlled, critical | owner | Target: the organisation. Commit: `disableOrganization`. Effects: `cascade_delete` (refresh stops at once, issued tokens live out their lifetime, F14) |
| `organisations.enable` | mutate | normal → controlled, critical | owner | Target: the organisation. Commit: `enableOrganization` |
| `staff.grant` | mutate | normal → controlled, critical | owner | `memberId`, `role`. Prepare: an effective member of the platform organisation. Target: the role group's member row or none. Commit: `putGroupMember`. Effects: `permission_change` |
| `staff.revoke` | mutate | normal → controlled, critical | owner | Target: the role group's member row. Commit: `removeGroupMember`. Effects: `permission_change` |

The hub-mounted version of this provider is Not yet: it is served alone at its own resource, so the Toolbox's catalogue and grant strings never apply to it.

## How it calls Answerable ID

- **Credential.** One machine client owned by the platform organisation, linked to ID's admin resource with `platform:read platform:write` (reads use a `platform:read` token, writes a `platform:read platform:write` token, each renewed once on 401, as the Toolbox does) and to the Toolbox's admin resource with `toolbox:admin` (A1).
- **Correlation.** Every call carries `x-request-id: <execution id>`; ID stores it on the audit row and echoes it (F9). The receipt's `results` carry ID's `Operation-Id`(s), so a reviewer joins the admin MCP's evidence to ID's audit in either direction (`audit.list` filters by `operationId`).
- **Idempotency.** Every write carries `Idempotency-Key: <intent id>`; a commit that performs several writes uses `<intent id>.<step>`. ID replays an identical retry and refuses a changed one (F10), so a lost answer is retried safely and never applied twice (R25). The SDK's own replay returns the stored receipt without calling ID again.
- **Versions.** `prepare` reads each target and binds its ETag as `version: { kind: "etag", value }`; commit re-runs `prepare` and refuses a moved target with `INTENT_STALE` (F20); then the write carries `If-Match` where ID takes it (F11), closing the gap between the comparison and the write. Creates, disable and enable take no precondition at ID; for them the SDK's comparison is the only guard, and the preview says so under warnings.
- **Timeouts.** 5 s per ID call, 25 s per tool (SDK default); the enable operation is one call and well under it (11 ID calls, measured for the Toolbox).

## How it calls the Toolbox

Only `toolbox.enable`, through the Toolbox's platform-tier admin API with a `toolbox:admin` token for `<toolbox origin>/admin` (A2). The Toolbox stays the owner of its catalogue; the admin MCP never writes `organisation_catalogue` rows itself. `ADMIN_TOOLBOX_ADMIN_RESOURCE` unset makes `toolbox.enable` answer `PRECONDITION_FAILED` saying so, and the tool is still listed.

## Evidence and audit

- **Evidence**, in `answerable_admin`: one chain per organisation of the caller, which is always the platform organisation; `target_type` and `target_id` name the organisation, group, member or entitlement acted on; `upstream: "id"` or `"toolbox"`; `request_id` = execution id; `intent_id`, `receipt_id`; `actor_type: "user"`, `actor_id` = the staff member's user id, `client_id` = the host. Kinds as the Toolbox: `capability.completed`, `capability.denied` (with the reason: not platform, role below minimum, stale authentication), `intent.prepared` (preview as an erasable payload), `intent.committed`, `intent.stale`, `intent.expired`, `receipt.issued`. The chain verifies with `createEvidence(db).verify(platformOrganisationId)`; a `GET /admin/v1/evidence/verify`-style route is Not yet (the acceptance verifies through the database).
- **ID's audit** names the machine client as actor; the person is in the admin MCP's evidence; the join key is `requestId` (= execution id) and `Operation-Id` (F9). `audit.list` exposes both fields so a staff member can follow a change from either side.
- **Spans**: Not yet (standalone servers carry no OpenTelemetry today; the Toolbox does).

## Security invariants

1. A token is accepted only for the admin MCP's audience; the person's token is never forwarded to ID or the Toolbox.
2. Only members of the platform organisation (by `system_bindings`, never by slug) get any tool; everyone else gets none, including `admin_whoami`.
3. Authority is read from ID on every request; nothing is cached and a failed read serves nothing.
4. A role is an entitlement scope of the admin MCP resource held through a group of the platform organisation; the token never carries it; the server never writes its own permission rows.
5. The server's machine credential is used only after the person's role allowed the tool (R28), and only for the operations the tool names.
6. Every write is a controlled-class intent: previewed, confirmed with the summary, committed once, idempotent at ID by intent id, refused when a target moved.
7. Critical operations need the owner role and an upstream authentication younger than the freshness window; a token refresh does not renew it.
8. No tool takes a secret (R29); SSO providers are set with Answerable's platform credentials only.
9. Every call, refusal and intent transition is evidence, append-only and hash-chained; ID's audit holds the mirror with the same request id.
10. Nothing identity-related leaves `apps/id`; the admin MCP is a consumer of its tokens and admin API.

## Configuration

| Variable | Meaning | Local value |
| --- | --- | --- |
| `ADMIN_ID_ISSUER` | ID's origin | `http://localhost:47300` |
| `ADMIN_RESOURCE_URL` | The admin MCP's URL, the token audience | `http://localhost:47520/mcp` |
| `ADMIN_PORT` | Port | `47520` |
| `ADMIN_DATABASE_URL`, `ADMIN_TEST_DATABASE_URL` | Intents and evidence | `postgres://answerable:answerable@localhost:47432/answerable_admin`, `…/answerable_admin_test` |
| `ADMIN_ID_CLIENT_ID`, `ADMIN_ID_CLIENT_SECRET` | The machine client | `admin-mcp`, secret shown once |
| `ADMIN_ID_ADMIN_RESOURCE` | ID's admin resource | `http://localhost:47300/api/admin` |
| `ADMIN_TOOLBOX_ADMIN_RESOURCE` | The Toolbox's admin resource; optional | `http://localhost:47400/admin` |
| `ADMIN_FRESH_SECONDS` | Freshness window of critical operations | `1800` |

Ports: 47520 (development), 47606 (the acceptance's admin MCP; the acceptance's Toolbox stays on 47604 and ID on 47600). Commands: `bun run admin:dev`, `bun --env-file=.env run --filter @answerable/mcp-admin db:migrate`, `bun run mcp:check @answerable/mcp-admin`.

## Not yet

| Item | Why, and the workaround |
| --- | --- |
| Inviting a person before their first sign-in | ID has no invitation route (F7). Grant the organisation or a group; the person appears at first sign-in; then `groups.addmember` |
| SSO providers with own credentials (generic OIDC, a secret) | A tool never takes a secret; ID needs one for own credentials (probes 3 and 4). Staff set them with cURL ([`/docs/id/onboard`](../../../apps/web/content/docs/id/onboard.mdx)) |
| Erasing an organisation, a group or a user; deleting an entitlement | Irreversible: waits for the human class and its approval page. `organisations.disable` and `access.revoke` are the reversible forms |
| Human policy class and approval pages | Not yet in the platform (docs/10 "After the goal", item 1); the critical tools are owner-only and freshness-bound meanwhile |
| Client and resource registration, users, sessions, domain disable/enable, member windows and removal | Rare; cURL ([`/docs/id/manage`](../../../apps/web/content/docs/id/manage.mdx)) |
| Spans, rate limits, budgets | As for every standalone server |
| An admin MCP for an organisation's own administrators | Needs tenant-tier writes in ID (docs/10 "After the goal", item 2) |
| Mounting the provider in the Toolbox | A different authority model (grant strings per capability); the standalone form is what staff need |
