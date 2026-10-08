# The admin MCP

> **TL;DR**
> - **Decides:** the staff-only MCP through which Answerable staff onboard and manage organisations in Answerable ID and enable the Toolbox for them: who may use which tool, how the server acts on ID and the Toolbox, and what it records.
> - **Rule:** a person's role is read from Answerable ID on every request and never kept; the server acts on ID with its own machine client only after that role allowed the tool; every write is a prepared intent the person confirms, sent to ID once with the intent's own idempotency key.
> - **Not here:** the Toolbox and the capability platform ([`08-capability-platform.md`](08-capability-platform.md)), the rules every MCP follows ([`09-mcp-design-standard.md`](09-mcp-design-standard.md)), what comes next ([`10-capability-platform-plan.md`](10-capability-platform-plan.md#after-the-goal)), the pages for staff ([`/docs/admin`](../apps/web/content/docs/admin/index.mdx), [`/docs/admin/setup`](../apps/web/content/docs/admin/setup.mdx)), the measurements ([evidence](../reports/mcp-foundation-evidence.md)).

Built in `mcps/admin` and accepted locally: `bun run mcp:test:e2e` runs staff through it against real ID with a browser and the official MCP OAuth client (journeys A1 to A8). The facts it rests on, with how each was verified, are in [the goal's findings](goals/admin-mcp/findings.md) (F-numbers); the choices in [its decisions](goals/admin-mcp/decisions.md) (D-numbers). "Not yet." marks what is not built.

## Purpose

Answerable staff create client organisations in Answerable ID, route their email domains, connect their directories, enable the Toolbox for them, grant their people access, read their members and audit trail, and disable them. Without this server that is cURL against ID's admin API ([`/docs/id/onboard`](../apps/web/content/docs/id/onboard.mdx)). The admin MCP gives the same work to an AI host such as Claude Code: a staff member signs in with their Answerable account, sees exactly the tools their role allows, and every change is prepared, previewed, confirmed, committed once and recorded.

It serves Answerable staff only. An admin MCP for an organisation's own administrators: Not yet (below).

## Glossary

| Term | Meaning |
| --- | --- |
| **Platform organisation** | The organisation ID binds in `system_bindings` at start (`answerable` locally). Its members are Answerable staff, and only they get any tool. |
| **Role** | `team` (reads), `admin` (reads and ordinary writes) or `owner` (everything, including the critical operations and who is staff). The highest held counts. |
| **Role string** | The entitlement scope that confers a role on the admin MCP's resource: `answerable-team`, `answerable-admin`, `answerable-owner`, and no other string. Held through a group of the platform organisation; the group's slug confers nothing. |
| **Critical operation** | A write only an owner with a recent directory sign-in may prepare and commit: disabling or enabling an organisation, granting or revoking a staff role, and every write to the platform organisation. |
| **Freshness window** | `ADMIN_FRESH_SECONDS` (1,800 by default): how old the token's `upstream_auth_time`, the person's last sign-in at their company's directory, may be for a critical operation. |
| **Execution id** | The UUIDv7 the SDK mints per call. Every call to ID carries it as `x-request-id`, which ID stores as the audit row's `requestId`. |
| **Intent key** | The intent's id, a UUIDv7 the SDK mints at prepare and hands to `commit`. Every write of the commit sends it to ID as `Idempotency-Key`. |

## Architecture

```text
Claude Code (public client, PKCE) --OAuth 2.1, audience = the admin MCP--> mcps/admin (Bun, @answerable/mcp)
                                                                              |-- verifies the person's token offline (@answerable/auth)
                                                                              |-- reads the person's role from ID, once per request (machine client, platform:read)
                                                                              |-- writes to ID's admin API (platform:read platform:write) or the Toolbox's (toolbox:admin)
                                                                              |-- keeps intents and evidence in its own Postgres (answerable_admin)
```

| Piece | Where | Job |
| --- | --- | --- |
| The server | `mcps/admin` (`@answerable/mcp-admin`), provider `admin`, port 47520 | `createAdminMcp`: `createMcpServer` with `allow` (the authority below), every mutation controlled class, intents in Postgres, evidence for every call and refusal, `GET /health` from the database. Its README maps each file |
| The ID client | `packages/id-admin` (`@answerable/id-admin`), extracted from the Toolbox | `createIdAdmin`: `platform:read` tokens for reads, `platform:read platform:write` for writes, `withToken` for another audience; `x-request-id`, a caller-chosen `Idempotency-Key`, `If-Match` and `If-None-Match`; a 401 renewed once; 5 seconds per call. `@answerable/id-admin/testing` is the fake ID both servers test against |
| Intents and evidence | `packages/mcp-postgres` (`@answerable/mcp-postgres`), extracted from the Toolbox | The Postgres intent store, the hash-chained evidence and the migrator. The admin MCP has no tables of its own |
| The sign-in time | `packages/auth` 0.5.0 | `UserPrincipal.upstreamAuthTime`, the token's `upstream_auth_time` |
| The proof | `packages/acceptance` | `src/admin-mcp.ts` registers the admin MCP and the Toolbox in a real ID as the setup page does; the admin journeys and the admin lane start from it |

**Its registrations in ID** ([setup](../apps/web/content/docs/admin/setup.mdx#register-the-admin-mcp), each call run by the journeys): the resource (allowed scopes `admin`, `offline_access` and the three role strings; 900-second tokens); a public host client per host (`claude-code-admin`, scopes `openid offline_access admin`); the platform organisation's capabilities and organisation-wide entitlements for that client, carrying `admin`, which lets every staff member sign in and confers no role; one group per role holding its role string on the resource; and one machine client, owned by the platform organisation, linked to ID's admin resource (`platform:read platform:write`) and to the Toolbox's admin resource (`toolbox:admin`). One machine client serving two audiences was proven against real ID before the writes were built.

**Two facts shape it.** ID refuses a person's token at its admin API (F1), so the server acts with its own machine client and enforces the person's authority itself ([`08`](08-capability-platform.md#providers-and-adapters), "Upstream identity"; R28). And ID's five-minute freshness rule does not reach a machine client (F4), so the server has a freshness rule of its own for critical operations.

**Standalone and hand-written** (D1). Each tool is one semantic operation with its own preview and targets; roles are its only authority. It is not mounted in the Toolbox, whose authority is per-capability grant strings per organisation, and it is not generated by the OpenAPI adapter, which is Not yet.

## Roles and authority

On every request that lists or calls tools, in this order (`src/roles.ts`, `src/admin.ts`):

1. **Token.** `@answerable/auth` verifies it offline: issuer, audience (the admin MCP's URL), type, expiry, user claims. Every tool needs the `admin` scope (refusal `missing_scope`). The token never carries a role.
2. **Platform organisation.** The token's organisation must be the platform organisation, whose id the server learns once at start from ID's `GET /me` as its machine client: the client's own organisation, which ID must mark `isPlatform` (F3). A machine client of any other organisation stops the server at start. Anyone else gets no tool, not even `admin_whoami`, and ID is not asked (refusal `not_platform`).
3. **Role, live.** One read of `GET /organizations/{platform}/members/{membershipId}/access`, shared by every decision of that request through a `WeakMap` on the principal, which the SDK makes per request. Only a target of kind `resource` whose id is the admin MCP's resource counts: a role entitlement limited to one client confers nothing. Its scopes are matched against the three role strings exactly; a member ID no longer knows has no role. Nothing is kept between requests, so a role granted or removed in ID applies to the next request with the same token (A1).
4. **Fail closed.** When ID does not answer that read, `tools/list` fails and every call answers `UPSTREAM_UNAVAILABLE`. Nothing is served from memory.
5. **Tool minimum.** Each tool is registered with its least role; `allow` serves it when the role is at or above it, and refuses it as the protocol's unknown-tool error otherwise (refusal `role_below_minimum`, with `held` and `needed`). The commit tools come with the first mutation a role may prepare. The SDK runs `allow` again on a commit, so a person demoted since prepare gets `PERMISSION_DENIED`, or no commit tool at all (F20).
6. **The escalation guard.** A write whose organisation is the platform organisation is a critical operation whatever the tool's own minimum (`src/writes.ts`, `guard`): an admin gets `PERMISSION_DENIED` and nothing is written (A4), because otherwise an admin could add themselves to the owner group. `organisations_disable` refuses the platform organisation outright.
7. **Freshness.** A critical operation needs `upstreamAuthTime` within the freshness window; `null` counts as stale. It is checked at prepare and again at commit, which re-runs prepare, so an intent prepared in time cannot commit once the window has passed. Otherwise `ADMIN_REAUTHENTICATION_REQUIRED` (retry `after_state_change`, `details.upstream_auth_time` and `details.max_age_seconds`), recorded as `capability.denied` with reason `stale_authentication`.

**The freshness remedy, as built and proven (A6).** ID takes `upstream_auth_time` from the browser session when it creates an authorisation and keeps it for every token of that grant, refreshed ones included (`apps/id/src/auth/grant-authentication.ts`, F2). Authorising again through the same browser session gives the same `sid` and the same time. So the error's message names two steps, in order: in the browser that holds the ID session, open `<issuer>/security` and choose **Verify sign-in** (ID's `/auth/sso/reauthenticate` with `prompt=login` and `max_age=0`, which accepts only a directory `auth_time` at or after the flow's start and within 300 seconds and makes a new session, `apps/id/src/auth/verified-sso.ts`); then, in the host, clear the server's authentication and authenticate again. The new authorisation carries the new time. Measured against a 10-second window: 0.9 to 1.0 seconds for the two steps and the committed critical tool.

**What it costs.** One round trip to ID per request. Against real ID, 25 `tools/list` requests with one token took a median of 31.3 to 34.3 ms and a maximum of 35.2 to 50.7 ms in five runs; the access reads inside them a median of 26.7 to 29.8 ms.

### Tools by domain

Identities are `admin/<domain>.<operation>`, and wire names replace `.` with `_`. They are Answerable's own names, in British spelling; every field and value that mirrors ID keeps ID's spelling (`organizationId`, the principal kind `organization`). The full list, with each tool's contract, is rendered from the committed manifest on [`/docs/admin`](../apps/web/content/docs/admin/index.mdx#tools).

| Domain | Reads (`team`) | Ordinary writes (`admin`) | Critical writes (`owner`) |
| --- | --- | --- | --- |
| `admin` | `whoami` (any platform member with `admin`, role or not) | | |
| `organisations` | `list`, `get` | `create`, `update` | `disable`, `enable` |
| `domains` | | `add` | |
| `sso` | `test` | `set` | |
| `members` | `list`, `get` | | |
| `groups` | `list` | `create`, `addmember`, `dropmember` | |
| `access` | `list` | `grant`, `revoke`, `enable` | |
| `audit` | `list` | | |
| `staff` | `list` | | `grant`, `revoke` |
| `toolbox` | | `enable` | |

With the two commit tools, a role lists 1 tool with no role, 10 as `team`, 23 as `admin` and 27 as `owner` (A1).

## Writes

Every mutation is `risk: "normal"` and the server fixes its policy class to `controlled`: the host shows the preview and commits with `admin_commit_confirmed` and the summary word for word; `admin_commit` answers `APPROVAL_REQUIRED`. Prepare changes nothing and refuses, before anything is recorded, a write that would change nothing or that ID would refuse.

- **Targets.** Prepare reads what the write acts on and binds ID's `ETag` as the target's version. Commit re-runs prepare and answers `INTENT_STALE` with both ETags when a target moved (A4). Where ID takes a precondition, the write sends the bound ETag as `If-Match`, or `If-None-Match: *` for a first SSO provider or a new group membership, and ID's `412` also answers `INTENT_STALE`. Where ID takes none (creates, disable and enable, removing a group member), the preview says so in its warnings.
- **One key per intent.** Commit receives the intent's id, the same on every attempt (R25). Every write sends it as `Idempotency-Key`, as `<intent id>.<step>` when one commit writes more than once (`staff_revoke` out of several groups). A write ID does not answer, or answers with a `5xx`, is sent once more with the same key, and ID replays what it did the first time, if it did (F10); a `401` is sent again with a new token and the same key. A commit repeated after it succeeded answers the stored receipt with `idempotent_replay: true` without calling ID; two at once give one receipt and one `COMMIT_IN_PROGRESS` (A5).
- **Receipts.** `results.operationId` (`operationIds` for `staff_revoke`) is ID's `Operation-Id`, which `audit_list` filters by.
- **The re-grant rule.** ID keeps one entitlement per principal and target, whatever its status. `access_revoke` disables one, reversibly; `access_enable` enables it again; `access_grant` refuses a principal and target that already have one and names `access_enable` with its id, or ID's `updateEntitlement` for other scopes. Deletion is Not yet.
- **Some tools, not all.** A grant string may name one capability (`e2e/records.list`) and be held through a group or by one member: `access_grant` writes it as any other scope the resource allows, `groups_addmember` and `groups_dropmember` move people, and the Toolbox applies the change to the person's current token within its cache window (A8). Grants add up and nothing denies, so an organisation-wide grant covers every tool whatever else is granted. Because of the re-grant rule, changing which tools a group holds is ID's `updateEntitlement` by cURL (Not yet below); with today's tools the pattern is one group per set of tools.
- **SSO.** `sso_set` sets Answerable's own Microsoft or Google application only: an Entra tenant issuer `https://login.microsoftonline.com/<tenant>/v2.0` or `https://accounts.google.com` (F13). Any other issuer answers `INVALID_INPUT` naming the cURL workaround, because a directory with its own credentials needs a client secret and no tool takes one (R29). The preview warns that ID revokes every grant of the organisation when its provider changes.
- **Staff.** `staff_grant` and `staff_revoke` find the role groups by their entitlement on the admin MCP's resource (active, no client, held by a group), never by slug. Grant adds the member to the group that confers the least beyond the role, with `If-None-Match: *`, and binds that entitlement's ETag. Revoke removes the member from every group that carries the role; it refuses a role held only through an entitlement that is not a group's, and warns when no other owner remains, when the person removes their own role, and when it is not atomic.

## How it calls Answerable ID

- **One machine client** of the platform organisation for reads and writes; tokens are reused until 30 seconds before expiry and renewed once on `401`. The role read and the tools' reads use `platform:read`, writes `platform:read platform:write`. Through it ID's audit names the machine client as actor (D13); the person is in the admin MCP's evidence.
- **Correlation.** Every call carries the execution id as `x-request-id`; ID stores it on the audit row of a write (F9). A7 found exactly one ID audit row per committed write, each joined by `requestId` to the `capability.completed` row of its commit call.
- **Errors.** No answer, a `5xx` or `409 operation_in_progress` (a write with the same key still running) is `UPSTREAM_UNAVAILABLE`, retried after ID's `Retry-After` when it sends one (`503 database_busy` says 1 second), else after 1 second; ID's `404` for a named resource is `NOT_FOUND`, any other refusal `UPSTREAM_REJECTED` with ID's status and code; a source failure is never an empty success. A write that meets `operation_in_progress` is not sent again: the commit says ID may or may not have applied it. The admin lane once saw ID answer `503 database_busy` to a read of an organisation's SSO provider while a write to it was in progress.

## How it calls the Toolbox

Only `toolbox_enable`, through the Toolbox's platform-tier admin API: a `client_credentials` token for `ADMIN_TOOLBOX_ADMIN_RESOURCE` with `toolbox:admin`, from the same machine client, renewed once on `401`. Prepare reads the Toolbox's providers and the organisation's catalogue and checks each host client exists in ID; commit posts the enable call, which makes in ID what is missing for each host client and enables the providers in the catalogue, and answers what it made and what it found. The Toolbox stays the owner of its catalogue and makes those ID writes with its own machine client. The call is not atomic and is safe to repeat; it takes no idempotency key. Without `ADMIN_TOOLBOX_ADMIN_RESOURCE` the tool stays listed and answers `PRECONDITION_FAILED` saying what to set.

Until some `toolbox_enable` names a host client, that client is not linked to the Toolbox's resource, and ID answers a person signing in through it with `invalid_target` instead of the organisation chooser's refusal. The journeys enable an existing organisation first and the lane links the client up front.

## Evidence

One hash-chained chain, the platform organisation's, in `answerable_admin` (`@answerable/mcp-postgres`, as the Toolbox's):

| Kind | When | Carries |
| --- | --- | --- |
| `capability.completed` | A call ran: a read, a prepare or a commit | `outcome`, `error_code`, `execution_id`, `request_id`, `upstream`: `toolbox` for `toolbox_enable`'s prepare, otherwise `id` |
| `capability.denied` | A tool was refused, or a critical operation found the sign-in too old | `reason`: `not_platform`, `missing_scope`, `role_below_minimum` or `stale_authentication`, with what decided it |
| `intent.prepared`, `intent.committed`, `receipt.issued`, `intent.stale`, `intent.expired` | The intent's transitions | `intent_id`, `receipt_id`; the preview as an erasable payload |

Each row names the person (`actor_id`, their user id) and the host (`client_id`). Inputs and results are not recorded. The chain verifies with `createEvidence(db).verify(platformOrganisationId)`; A7 verified 108 to 109 events in three runs. Two gaps, both in the SDK (`Q-SDK-ALLOW-EVIDENCE`): a call refused because ID did not answer the role read leaves no row, since the SDK answers it before `wrapCall`; and a commit call's row names `upstream: "id"` whichever tool the intent is for, since `wrapCall` cannot tell.

## Security invariants

1. A token is accepted only for the admin MCP's audience and never forwarded; the server acts upstream with its own machine client.
2. Only members of the platform organisation, known by ID's system binding and never by slug, get any tool; everyone else gets none, and ID is not asked.
3. Authority is read from ID on every request and kept no longer than the request; a failed read serves nothing.
4. A role is exactly one of three strings, on an entitlement to the admin MCP's resource itself; the token never carries it, and the server holds no permission table.
5. The machine client is used only after the person's role allowed the tool (R28).
6. Every write is a controlled-class intent: previewed, confirmed with the summary, committed once under one key, refused when a target moved.
7. A critical operation, which includes every write to the platform organisation, needs the owner role and a directory sign-in within the freshness window, at prepare and at commit; a refresh never renews it.
8. No tool takes a secret (R29).
9. Every call that runs, every refusal of a tool and every intent transition is evidence, append-only and chained; ID's audit holds each write with the same request id.
10. The admin MCP imports nothing from `apps/id`: it consumes ID's tokens and admin API.

**What holds each.** Measured by the test audit of 3 October 2026, which broke the code one guard at a time (probes) and recorded what failed; the unit tests are in `mcps/admin/src` against the fake ID, the journeys in `packages/acceptance` against real ID.

| Invariant | Unit tests | Journeys |
| --- | --- | --- |
| 1. Audience | `@answerable/auth`'s audience test and `@answerable/mcp`'s server test refuse a token for another audience; no `mcps/admin` test fails without the check | A3: the admin MCP answers `401` to the person's Toolbox token |
| 2. Platform members only | `admin.test` (another organisation's token: no tool, ID not asked); `platform.test` (`isPlatform`) | A4: a client organisation's member |
| 3. Read every request | `admin.test`: a role change on the next request, ID not answering, a demotion between prepare and commit | A1: `staff_grant` and `staff_revoke` change a colleague's tools on their next call, the only place ID computes the role from real groups |
| 4. Three strings, resource target | `admin.test`: the highest role, another resource, one client, an unknown string | A1 |
| 5. Machine client after the role | `admin.test`: another organisation's call reaches no ID route | None explicit: the SDK runs `allow` before a handler |
| 6. Controlled intent, once, one key | `admin.test` commit and lost answer; `writes.test`; `calls.test` (ID's `412`); the conformance kit's `commit_rejects_stale` | A2, A4 (`INTENT_STALE` with real ETags), A5 |
| 7. Critical operations | `admin.test`'s two tables: each of the 12 tools that take an organisation, on the platform organisation, refused to an admin and to an owner with a stale sign-in; each of the 4 critical tools refused with a stale or no sign-in, at prepare and at commit | A4 (`groups_addmember` as an admin), A6 |
| 8. No tool takes a secret | `writes.test`: `sso_set` refuses another issuer; the manifest snapshot is the only check on the input schemas | A2: `sso_set` refuses the spare's issuer |
| 9. Evidence | `admin.test`: refusals, calls, transitions and the `x-request-id` join | A7: one ID audit row per committed write |
| 10. No import from `apps/id` | `admin.test` reads every import of the workspace | None |

## Configuration

`ADMIN_ID_ISSUER`, `ADMIN_RESOURCE_URL`, `ADMIN_PORT` (47520), `ADMIN_DATABASE_URL`, `ADMIN_TEST_DATABASE_URL`, `ADMIN_ID_CLIENT_ID`, `ADMIN_ID_CLIENT_SECRET`, `ADMIN_ID_ADMIN_RESOURCE`, `ADMIN_TOOLBOX_ADMIN_RESOURCE` (optional) and `ADMIN_FRESH_SECONDS` (optional, 1,800): listed in `default.env`, with local values in `.env.example` and meanings on [`/docs/admin`](../apps/web/content/docs/admin/index.mdx#environment). `bun run admin:dev` serves it; the databases `answerable_admin` and `answerable_admin_test` come from `infra/postgres/init/004-create-mcp-databases.sql`. The acceptance serves it on 47606 with `answerable_admin_acceptance`; `bun packages/acceptance/scripts/admin-lane.ts` keeps ID, the admin MCP and the Toolbox up for Claude Code by hand.

## Not yet

| Item | Meanwhile | Trigger to build it |
| --- | --- | --- |
| An admin MCP for an organisation's own administrators | [Manage your organisation](../apps/web/content/docs/id/manage.mdx) | ID's tenant-tier writes for groups, group members and entitlements ([`10`](10-capability-platform-plan.md#after-the-goal), item 2) |
| SSO providers with the organisation's own credentials through a tool | cURL ([`/docs/id/onboard`](../apps/web/content/docs/id/onboard.mdx#connect-the-directory)) | `Q-ADMIN-SSO-SECRETS` resolved |
| A fresh sign-in the host can ask for itself | Verify sign-in on ID's Security page, then a new authorisation | `Q-ADMIN-REAUTH` resolved |
| Human approval and erasure (organisations, groups, users, entitlements) | Owner-only critical operations with freshness; `organisations_disable` and `access_revoke` are the reversible forms | Approval pages for the human class ([`10`](10-capability-platform-plan.md#after-the-goal), item 1) |
| Inviting a person before their first sign-in | Grant the organisation or a group; the person is a member at first sign-in; then `groups_addmember` | ID gains an invitation route (F7) |
| Changing an entitlement's scopes (`access_update`) | ID's `updateEntitlement` by cURL, or one group per set of tools | `Q-ADMIN-ACCESS-UPDATE` resolved |
| Registering clients and resources, users, sessions, domain disable, member windows and removal | cURL | A staff need the reads and writes above do not meet |
| Generating this provider with the OpenAPI adapter, or mounting it in the Toolbox | Hand-written and served alone | The adapter exists, and staff tools need the hub |
| An evidence verification route, spans, rate limits, hosted deployment | `verify` through the database; the acceptance proves the chain | A second reader of the evidence, or a hosted ID |
| Claude Code asking before `admin_commit_confirmed`, in a session with a model; `sso_set` against a real Entra tenant | A1 asserts that `admin_commit_confirmed` alone carries `anthropic/requiresUserInteraction`; unit tests against the fake ID cover `sso_set` | The owner's hand demo |

## Decision summary

> **Admin MCP rule**
> ID decides who is staff; the admin MCP asks on every request and never remembers. Its machine client acts only after the person's role allowed it, every change is previewed and confirmed before it is written once, and the platform organisation itself is the owner's alone.
