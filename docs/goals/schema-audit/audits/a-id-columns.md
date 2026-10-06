# Audit A: Answerable ID tables, columns, vocabularies and dead logic

## Summary

- Audited all 26 ID tables (312 columns), every CHECK vocabulary, the audit `schema_version` dispatch in `capture_audit_subjects`/`record_user_oauth_subjects`, and every column's writers and readers in `apps/id/src` and in the installed Better Auth 1.7.2, `@better-auth/sso` and `@better-auth/oauth-provider` sources; a write census over the whole suite (73,097 row images) measured what is actually stored.
- The deciding fact: ID serves only 18 Better Auth routes (`http/auth-allowlist.ts:29-182`; everything else 404s at `app.ts:214-217`). Client registration, organisation/invitation routes, SSO provider routes, end-session and SAML are unreachable, so columns only they write are dead for ID.
- **Delete**: `oauth_clients.user_id` with its owned-client erasure and locking logic; `sso_providers.user_id` with its "attribution" erasure block; `sso_providers.saml_config`; 14 never-written `oauth_clients` columns (null or default in all 1,650 census images); `post_logout_redirect_uris` and `backchannel_logout_uri` (a hidden, half-live remote-logout feature); `oauth_resources.policy_version`, `signing_key_id`, `custom_claims` (+ its CHECK), `metadata`, `dpop_bound_access_tokens_required`; `oauth_client_resources.metadata`; `groups.external_id` (directory groups nothing syncs); `audit_event_subjects.provenance`/`legacy_derived`; 8 unreachable schema-version branches of the subject trigger, which only 34 hand-inserted test events reach.
- **Simplify**: one payload version per action; the subject table narrowed to `(user_id, event_id)`, the only thing its only reader asks for (today 14.24 subject rows per token issuance, 1 used; 7,189 vs 124 bytes per event in probe 06); `grant_contexts.authentication` (10 JSON keys, 5 duplicated, 1 unread, NULL only in fixtures) into 4 typed NOT NULL columns with one insert trigger instead of two; `sessions.active_organization_id`, equal to `authentication_organization_id` in every app-written session, dropped; Answerable additions to the always-empty `invitations` table removed; stale "legacy" wording in the audit API.
- **Keep** the rest: the Answerable policy tables, revisions, deletion markers, vocabularies and plugin token/verification columns are written and read on reachable paths. `members.role` and `invitations` stay while the SSO plugin provisions memberships (Q1).
- Clean suite on 47433: `1422 pass, 39 fail, 5 errors` in 2,406.90 s (load failures; one test fails in both runs). My first probe 06 filled the shared Docker disk at 13:45 (see Did not get to).

## Method

- Read `AGENTS.md`, `docs/00-orientation.md`, `docs/04-answerable-id-schema.md`, `docs/02-plan.md` (Do not re-propose), `reports/id-soft-deletion.md` (lines 25-33), `apps/id/drizzle/0000_initial.sql`, all of `apps/id/src/db/schema/*.ts`, `src/auth.ts`, `src/auth/answerable-schema.ts`, and the writers/readers named in each finding.
- Installed sources read: `better-auth@1.7.2` (`plugins/organization/organization.mjs`, `db/internal-adapter.mjs`), `@better-auth/core@1.7.2` (`db/adapter/factory.mjs` `transformInput`), `@better-auth/drizzle-adapter@1.7.2` (`checkMissingFields`), `@better-auth/sso@1.7.2` (`assignOrganization`), `@better-auth/oauth-provider@1.7.2` (`resolveResourcePolicy`, back-channel logout plan, client schema), all under `node_modules/.bun/`.
- Probes in `scratchpad/probes/a/`:
  - `01-suite-clean.out`: the ID suite against `answerable_id_test` on 47433, no root `.env`.
  - `02-census-install.sql` + `02-census-suite.out`: an AFTER INSERT/UPDATE trigger on all 26 tables logging every row image (and the changed keys on update) to an unlogged `census.log`, then the whole suite again. Captures fixture writes too, so "never non-null" is conclusive and "non-null" needs the grep to say who wrote it.
  - `03-column-grep.ts|out`: for each of the 312 columns, the non-test files outside `db/schema` that name its property or SQL name.
  - `04-census-report.sql|out`: the census queries (never-non-null columns, single-valued columns, updated columns, vocabularies, action × version, subject composition).
  - `02b-census-rerun.out`: the two files that failed during the disk-full window, re-run under the census.
  - `05-leftover-census.sql|out`: `pg_stat_user_tables` after the clean run (the leftover-row null census is empty: the suite truncates).
  - `06-subject-cost.sql|out`: storage and lookup cost of today's subject shape versus `(user_id, event_id)`, on synthetic rows in a throwaway schema of `answerable_id` on 47433.

## Findings

### A. Dead columns and the logic that serves them

| # | Object | What it does today | Evidence | Verdict | Why |
| --- | --- | --- | --- | --- | --- |
| A1 | `oauth_clients.user_id` + "owned client" logic | Nullable FK to users; user erasure revokes grants, deletes tokens, soft-deletes consents/links/clients "owned" by the user; grant locking reads it as `ownerUserId` | No writer: clients are created only by `db/queries/oauth-clients.ts:154` from `services/clients.ts:266-290`, whose input (`http/admin/clients.ts:67-92`) has no `userId`; `/auth/oauth2/register` is not on the allowlist. Readers: `db/queries/users.ts:237,259,439-446` (+ `ownedClientIds` uses at 264, 275, 311, 424), `db/queries/grant-contexts.ts:50-80`, `auth/create-resource-grant.ts:56`, `auth/lock-resource-grant-policy.ts:20-29,57`. Census: 28 of 1,650 client row images carry a `user_id`, all from test fixtures that insert clients directly (10 test files, e.g. `http/admin/user-erasure-race.integration.test.ts`) | **delete** column, index `oauth_clients_user_id_idx`, the owned-client branches of user erasure and `ownerUserId` locking | Ownership is `organization_id`; personal clients cannot be created |
| A2 | `sso_providers.user_id` + "SSO attribution" clearing | User erasure locks providers with `user_id = $user`, sets it null, which bumps `revision` through `protect_sso_provider_revision` and is reported as `detachedSsoProviders` | No writer: `db/queries/sso-providers.ts:101-113` omits it; the plugin's register route is unreachable. Reader/writer only at `db/queries/users.ts:504-540`. Census: 3 of 4,654 provider images carry a `user_id`, all from direct test inserts (`db/runtime-role-policy.integration.test.ts:369,439`, `db/schema.integration.test.ts:570`) | **delete** column, FK, relation and the erasure block | A revision bump on a never-set column is the only effect it could have |
| A3 | `sso_providers.saml_config` | Cleared on deletion; checked by `protect_product_deletion` | No writer (insert writes only `oidc_config`, `sso-providers.ts:111`); SAML is backlog (`docs/02-plan.md` Backlog). Census: 0 of 4,654 images | **delete** column and its clause in `protect_product_deletion` | SAML routes are unreachable |
| A4 | `oauth_clients`: `client_discovery_id`, `reference_id`, `icon`, `tos`, `policy`, `software_id`, `software_version`, `software_statement`, `application_type`, `subject_type`, `enable_end_session`, `backchannel_logout_session_required`, `dpop_bound_access_tokens`, `metadata` | Echoed by the admin API (`http/admin/clients.ts:32-64`) and the OpenAPI contract | No writer: not in create/patch schemas (`clients.ts:67-111`); only DCR (unreachable) writes them (`oauth-provider/dist/authorize-BmTe2VYG.mjs:2190-2228`). Plugin reads treat undefined as null (`subjectType === "pairwise"` needs `pairwiseSecret`, unset; `enableEndSession` only emits `sid` and gates end-session). Census: all 13 nullable columns null in all 1,650 images; `dpop_bound_access_tokens` false in all 1,650 | **delete** columns and API fields | 14 always-null fields in every client response |
| A5 | `oauth_clients.post_logout_redirect_uris`, `backchannel_logout_uri` | Writable by PATCH (`clients.ts:99,105`) | `post_logout_redirect_uris` is read only by end-session (`authorize-BmTe2VYG.mjs:560`), not on the allowlist. `backchannel_logout_uri` IS live: the plugin's session-delete hook (`authorize-BmTe2VYG.mjs:4419`, plan at 231-275) posts logout tokens on sign-out, while ID hides `backchannel_logout_supported` (`http/oauth-metadata.ts:19-20`) and docs/04 "Deferred" says remote logout delivery is outside the baseline | **delete** both (or, if remote logout is wanted, un-hide it and document it) | A deferred feature that half-works: settable, delivered, undocumented |
| A6 | `oauth_resources.policy_version` | Default 1; echoed by the admin API and the resource audit snapshot | No writer (grep: only `services/resources.ts:36`, `http/admin/resources.ts:40` read it); `revision` is what changes. The `policyVersion: 1` literals in `auth/member-permission.ts:204,287,322,420` and `auth/machine-capability.ts:26,41` are a decision-payload version, unrelated. Census: `policy_version = 1` in all 1,612 resource images | **delete** | A second counter that never moves; the name collides with the decision field |
| A7 | `oauth_resources.signing_key_id`, `custom_claims` (+ CHECK `oauth_resources_identity_claims_check`), `metadata` | Echoed by the admin API | No writer (create schema `http/admin/resources.ts:51-70` has `signingAlgorithm` only). The plugin treats undefined like null (`introspect-C6P1zrTr.mjs:500-517`). The CHECK guards a column nothing writes. Census: `signing_key_id` and `metadata` null in all 1,612 images; `custom_claims` set once, by a test (`auth/user-oauth.integration.test.ts:544`, `http/token-identity.integration.test.ts:128-134`) | **delete** columns and the CHECK | |
| A8 | `oauth_resources.dpop_bound_access_tokens_required` | Default false, echoed | No writer; plugin tests `=== true` (`introspect:518`). DPoP is backlog. Census: true in 0 of 1,612 images | **delete** | Re-add with DPoP |
| A9 | `oauth_client_resources.metadata` | — | No writer: links are written by ID (`db/queries/oauth-clients.ts`), never by the plugin. Census: set in 2 of 714 images, by a test fixture (`{"note": "unchanged visible link"}`) | **delete** | |
| A10 | `groups.external_id` (+ unique index `groups_organization_id_external_id_idx`, `requireManual`) | Marks a group "directory-managed": manual membership edits return 409 `group_directory_managed` (`services/groups.ts:233-239`) | Nothing syncs directory membership (SCIM is backlog; no writer of `group_members` other than the manual path). A directory group is therefore permanently empty and any entitlement on it grants nothing | **delete** until directory sync exists | A feature flag for a feature that does not exist; "Not yet" belongs in docs |
| A11 | `organizations.logo`, `organizations.metadata` | Admin API create/patch/echo (`http/admin/organizations.ts:38-39,54-61`) | No other reader (no page renders a logo; grep `http/pages`). Plugin fields without defaults (`organization.mjs`), and organisations are inserted by ID, not the plugin | **delete** (low priority) | Free-text annotation with no consumer |
| A12 | `accounts.access_token`, `refresh_token`, `id_token`, `*_expires_at`, `scope` | Written encrypted by the SSO callback (`sso/dist/index.mjs:3991-3999`, `auth/upstream-token-storage.ts`) | The only ID readers clear them on erasure (`db/queries/users.ts:475-477`) and check them in `protect_product_deletion`. No ID code calls an upstream API | **not verified** whether the SSO plugin can skip storing; see Q3 | Encrypted storage is a recorded decision; its cost is retained upstream refresh tokens with no consumer |
| A13 | `accounts.password` | Cleared on erasure; deletion guard | No writer (no email/password sign-in). Core field with no default, so BA never inserts it | **keep** | Backlog "hosted email+password login"; zero cost |
| A14 | `members.role` | Always `'member'` | Written by `auth/verified-sso.ts:242` and the SSO plugin's provisioning (`sso/dist/index.mjs:267-276`, `auth.ts:43`); no reachable reader (org routes unreachable). The plugin declares it required with default `"member"` (`organization.mjs:765-771`), `transformInput` always sends it (`core/dist/db/adapter/factory.mjs:113`) and the Drizzle adapter throws on a missing column (`drizzle-adapter/dist/index.mjs:251-264`). Census: `'member'` in 4,242 images, `'owner'` in 3 (test fixtures) | **keep** while the plugin creates members (Q1) | Confers nothing; mandated by the plugin |
| A15 | `invitations` (whole table) and its Answerable additions (`deleted_at`, 2 RLS policies, `invitations_deletion_guard`, `zz_invitations_present_parents`, the `inviter_id` branch of `protect_product_parents`, erasure updates in `queries/users.ts:489-503`, `queries/organizations.ts:347-361`) | Always empty | No reachable writer (invite routes 404). The SSO plugin reads it on every first sign-in to an organisation (`sso/dist/index.mjs:240-261`), so the table must exist while plugin provisioning is on. `pg_stat_user_tables`: 9 inserts in the whole suite, all from tests (probe 05) | **simplify**: keep the bare plugin table; delete the Answerable additions. Delete the table if Q1 moves provisioning into ID | Guards and erasure manifests for rows that cannot exist |
| A16 | `sessions.active_organization_id` (+ index, `clearedSessionSelections` manifest, trigger lines 771 and 809-810) | Set at session creation to `authentication_organization_id` (`auth/sso-origin.ts:170` vs `:173`); read for the sign-out audit organisation (`auth/audit-hooks.ts:19`) and the sessions API; cleared on organisation erasure (`queries/organizations.ts:363-366`) | Census: equal at insert in 3,446 of 3,449 sessions (the 3 others are direct test inserts); 35 of the 36 updates that touch it set it to null (organisation erasure). The plugin route that changes it (`set-active`) is unreachable. `authentication_organization_id` is immutable (`protect_session_authentication_origin`) | **simplify**: drop the column; read `authentication_organization_id`; drop the clearing step and its manifest | Two columns hold the same value; one needs clearing logic, the other cannot change |
| A17 | `jwks.crv`, `oauth_*_tokens.requested_user_info_claims`, `oauth_consents.requested_user_info_claims`, `oauth_access_tokens.resources` | Plugin columns, no or defensive ID reference (probe 03) | Plugin writes them on reachable token/consent paths (`introspect-C6P1zrTr.mjs:1457-1478,1559,1832`). Census: `jwks.alg`/`crv` are `EdDSA`/`Ed25519` in all 124 images; `requested_user_info_claims` is null in all 158 access-token and 371 refresh-token images and `[]` in all 146 consent images (the OIDC `claims` request path is untested); `oauth_access_tokens.resources` is null in all 158 images because ID issues resource tokens as JWTs (allowlist description, `http/auth-allowlist.ts:114`) | **keep** | Plugin-owned and reachable; the `claims` request and DPoP paths are untested, not dead |
| A18 | `oauth_refresh_tokens.rotated_at`, `rotation_replay_response`, `rotation_replay_expires_at`, `auth_time`; `*.confirmation` | Plugin refresh rotation, replay cache, DPoP `cnf` | Replay columns written only when `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS > 0` (`introspect:1572-1578,1733`; default 0, `env.ts:92-97`), exercised at 60 s in `user-oauth.integration.test.ts:708,1309`. `confirmation` and `auth_time` are read by ID (`auth/user-token-assertions.ts:150-164`). Census: `rotation_replay_response` set in 10 of 371 refresh images; `confirmation` null in all access (158) and refresh (371) images: the DPoP path is untested | **keep** | Configurable, tested feature |

### B. Audit schema versions and audit subjects

**B1. Versions written today** (code, confirmed by census section 6–7 of probe 04):

| Action(s) | Version(s) written | Writer | Trigger branch that extracts affected users |
| --- | --- | --- | --- |
| `user.erased` | 3 only (always `deletionMode: "soft"`) | `services/users.ts:51-57,203-209` | 755-764 (v3). **Unreachable**: 792-802 (v2), 852-853 (v1) |
| `user.disabled`, `user.disable_unchanged` | 2 | `services/users.ts:51-57` | none (target user only) |
| other `user.*` | 1 | same | none |
| `organization.erased` | 3 only | `services/organizations.ts:51,213-217` | 765-771 (v3). **Unreachable**: 803-812 (v2), 864-866 (v1) |
| `organization.disabled` | 1 | same | 861-863 (v1) |
| `group.erased` | 3 only | `services/groups.ts:63-68,212-217` | 772-775 (v3). **Unreachable**: 813-816 (v2) |
| `group.enabled`, `group.disabled` | 2 | same | 817-820 |
| `group_member.removed` | 3; other `group_member.*` 1 | `services/groups.ts:345-358` | member target lookup (730-733) |
| `client.grants_erased` | 3 only | `services/clients.ts:169-172` | 776-783 (v3). **Unreachable**: 841-850 (v2), 854-856 (v1) |
| `client.grants_revoked` | 2 | same | 832-840 (v2). **Unreachable**: 854-856 (v1) |
| `client.resource_linked/unlinked/unchanged` | 3 only | `services/clients.ts:110-133` | none |
| `client.erased` | 3; other `client.*` 1 | `services/clients.ts:580-595` | none |
| `resource.erased` | 2 only | `services/resources.ts:69,238-243` | 784-787 (v2). **Unreachable**: 859-860 (v1) |
| `resource.disabled` | 1 | same | 857-858 |
| `sso_provider.deleted` | 2 only | `services/sso-providers.ts:64,197-207` | 788-791 (v2). **Unreachable**: `sso_provider.deleted` in 867-869 (v1) |
| `sso_provider.created/updated` | 1 | same | 867-869 |
| `entitlement.created/updated/enabled/disabled` | 1 (member principal) **or** 2 (group/organisation principal) | `services/entitlements.ts:52-70` | 734-745 (v1), 821-831 (v2) |
| `entitlement.*_unchanged` | 1 | same | 734-745 |
| `entitlement.removed` | 3 only | `services/entitlements.ts:257-261` | 734 and 821 (both via the v3 special case) |
| `domain.deleted`, `capability.removed` | 2; other `domain.*`/`capability.*` 1 | `services/domains.ts:51`, `services/capabilities.ts:178,296-304` | none |
| `member.removed`, `member.removal_unchanged` | 3; other `member.*` 2 | `services/members.ts:40-43` | member target lookup |
| `session.revoked`, `session.revoked_all` | 2 | `services/sessions.ts:43` | session lookup (746-749) |
| `oauth.token.issued` | 2 | `auth/machine-audit.ts:58` | none |
| `oauth.token.rejected` | 2 (client authenticated) **or** 3 (not) | `auth/machine-audit.ts:126` | none |
| `auth.signin.succeeded`, `auth.signin.rejected` | 2 | `auth/sso-origin.ts:145`, `http/signin-audit.ts:35` | session lookup |
| `oauth.user.*` (5 actions) | 4 | `auth/user-oauth-audit.ts:25` | `record_user_oauth_subjects` (1239-1278) |
| everything else (`identity.linked`, `auth.signout`, `admin.*`, bootstrap) | 1 (default) | `queries/audit.ts:62` | — |

Measured census of action × version: probe 04 sections 6-7. Every pair in the table above was observed. The census also shows 34 events at versions no writer emits (`user.erased` v0 ×1 and v1 ×7, `client.grants_erased` v1 ×2 and v2 ×7, `client.resource_*` v0/v1/v4 ×9, `client.erased` v2, `client.grants_revoked` v1, `organization.erased` v1, `resource.erased` v1, `user.disabled` v1, `member.updated` v1, `oauth.token.issued` v1, `oauth.token.rejected` v1): test fixtures that insert old shapes directly to exercise the dead branches, e.g. `db/queries/audit.integration.test.ts:255-380`, `db/runtime-role.integration.test.ts:651-690`, `auth/machine-audit.integration.test.ts:376-431`. Those tests go with the branches.

| # | Object | What it does today | Evidence | Verdict | Why |
| --- | --- | --- | --- | --- | --- |
| B2 | 8 unreachable `user_effects` branches of `capture_audit_subjects` (792-802, 803-812, 813-816, 841-850, 852-853, 854-856, 859-860, 864-866) and `sso_provider.deleted` in 867-869 | Parse payload shapes no writer emits | Every action that reaches them is written at a single other version (B1); the census never produced them (only the 34 hand-inserted fixture events above reach them) | **delete** | Dead plpgsql in a SECURITY DEFINER trigger that runs on every audit insert, including token issuance |
| B3 | `schema_version` as a dispatch key | 19 occurrences in the SQL; 4 values; 2 actions written at two versions (entitlement 1/2, `oauth.token.rejected` 2/3) | B1 | **simplify**: one shape per action, all at version 1 today. Give member-principal entitlement events the same `audience` field (one member) and give `oauth.token.rejected` one shape with nullable decision/client. Keep the integer column for the first post-launch change | With no production data, a second version of an action is history nobody has |
| B4 | `listAuditEvents` description (`http/admin/audit-events.ts:104`) and `schemaVersion` description (`:41`, 4,494 bytes on one line) | Explains versions 0–4, "legacy history", superseded physical-erasure payloads | No writer can emit 0 (`queries/audit.ts:30` types 1-4); "0 is legacy" and "supported … 1, 2 or 3" contradict version 4; most of the text describes payloads no writer emits | **simplify** into a per-action payload table generated from the writers | The contract describes history that does not exist |
| B5 | `listOrganizationAuditEvents` visibility filter (`queries/audit.ts:107-116`) | Hides link events unless version 2 or 3 | Link events are only ever written at 3 (`services/clients.ts:132`) | **delete** the filter | It filters nothing |
| B6 | `ip`, `user_agent`, session `ip_address` descriptions ("legacy values", "new sessions store null") | API wording | Nothing shipped, so no legacy value exists; Better Auth writes `getIP(...) \|\| ""` into `sessions.ip_address` (`better-auth/dist/db/internal-adapter.mjs:264`), and `auth/sso-origin.ts:154` copies it into audit `ip`. Census: `audit_events.ip` non-null in 4,761 of 7,369 events; `sessions.ip_address` non-empty in 3,421 of 3,490 images and `''` (not null) in 1 | **simplify** the wording | Describes values that cannot exist and misstates what is stored |
| B7 | `audit_event_subjects.provenance` + `'legacy_derived'` + `capture_audit_subjects(origin)` | Column, CHECK, function parameter | The only caller passes `'recorded'` (`0000_initial.sql:906`); `record_user_oauth_subjects` hard-codes it (1253-1271); no reader (`queries/audit.ts:183-193` reads `entity_type`, `entity_id`, `event_id` only). Census: `'recorded'` in all 22,416 subject rows | **delete** | Dead vocabulary |
| B8 | `audit_event_subjects` as a whole | 2 triggers, 186 + 40 lines of plpgsql, 6 columns, 2 secondary indexes; one reader | The only reader asks `entity_type = 'user'` (`queries/audit.ts:183-193`) on a platform-read route. Census: 22,416 subject rows for 7,369 events; 8,685 (38.7 %) are `user` rows. Per token event: `oauth.user.issued` 14.24 rows (1 user row), `oauth.user.authorized` 13.89 (2), `auth.signin.succeeded` 3.00 (2, the same user as actor and as affected). Probe 06: 7,189 bytes of subject storage per issuance event in today's shape versus 124 bytes in `(user_id, event_id)`; the reader's lookup is 0.055 ms versus 0.037 ms | **simplify**: keep a trigger-owned subject index (recorded decision: "Trigger-owned subjects", docs/04) but store only user subjects: `audit_event_users(user_id uuid, event_id uuid, primary key (user_id, event_id))`; drop `entity_type`, `relationship`, `provenance`, `organization_id`, both secondary indexes and the RLS tenant branch nothing reads | Every other row is written on the token hot path and never read |
| B9 | `audit_events` only, without subjects (first-principles alternative) | — | Could answer: actor (`actor_type='user' and actor_id=$u`, indexed `audit_events_actor_id_idx`), user target (`audit_events_target_type_target_id_idx`), member/group-member targets (`target_id in (select id::text from members where user_id=$u)`, members are never physically deleted), user-OAuth events (`target_type='grant_context' and target_id in (select id::text from grant_contexts where user_id=$u)`, grant contexts are never deleted: no app DELETE, cascades never fire because parents are soft-deleted). Could not answer cheaply: session-target events after the session row is physically deleted (needs `data.userId`), and users named inside effect manifests (`effects.*[].userId`, `audience`, `policySources`) without a JSON scan of every event. Census: of the 8,685 user subject rows, 7,799 are the actor, 115 the user target, 97 a member target, 174 a grant-context target, 15 a session target (14 with `data.userId`), and 485 (5.6 %, in 171 events) only a manifest can supply: entitlement events (355: `audience` or the entitlement's member), `organization.erased` (39), `client.grants_revoked` (23), `user.erased` (18), `sso_provider.*` (16), 34 others (probe 04 sections 14-15) | **keep a subject table** (narrowed, B8) | A union of 4 indexed queries covers direct subjects, but manifests listing many users need a row per user; a 2-column table filled by the existing trigger is the simplest thing that keeps them |

### C. Vocabularies and CHECK constraints

| # | Object | What it does today | Evidence | Verdict | Why |
| --- | --- | --- | --- | --- | --- |
| C1 | `users.status = 'inert'` | Default for any user Better Auth creates | No app writer: federation creates users `'active'` (`services/federation.ts:249`); `services/users.ts:146` refuses to enable inert users; import tooling is "Not yet" (`docs/02-plan.md:34`). Census: 40 of 4,010 user images are `inert`: the Better Auth default exercised directly (`db/schema.integration.test.ts:135`) and fixtures | **keep** | Fail-closed default for any path that creates a user without a status (comment `auth.ts:158-159`) |
| C2 | `invitations.status` 4 values | CHECK | No reachable writer (A15) | **keep** with the plugin table (A15) | Plugin vocabulary |
| C3 | `audit_event_subjects.provenance` | `recorded`, `legacy_derived` | B7 | **delete** | |
| C4 | `system_bindings.name` = `'platform'` | One-value CHECK, primary key | Written once by `bootstrap.ts:204`, read by `bootstrap.ts:68` | **keep** | A named singleton; no simpler shape |
| C5 | Other vocabularies (`organizations/groups/entitlements/organization_domains/organization_capabilities.status`, `members.status`, `grant_kind`, `classification`, `actor_type`, `outcome`, `admin_operations.outcome`) | CHECKs | Every value has an app writer (grep: `actorType: "system"` `bootstrap.ts:20`, `http/principal.ts:227`, `http/signin-audit.ts:32`; `"failure"` `auth/machine-audit.ts:128`, `http/signin-audit.ts:39`; `"noop"` `http/admin/*`; all four grant kinds `bootstrap.ts:219`, `http/admin/capabilities.ts:81,173`, `services/capabilities.ts:33`). Census: every value observed (probe 04 section 5); `invitations.status` `pending`/`canceled` only from test inserts | **keep** | |
| C6 | `audit_events.schema_version` | No CHECK | Writers emit 1-4 only | **add** `CHECK (schema_version > 0)` only if B3 is not taken; with B3, `= 1` | Cheap contract |
| C7 | `audit_event_subjects.relationship` | Free text: `actor`, `target`, `affected`, `authorized`, `authenticated` | Never read (`queries/audit.ts:183-193`). Census: 5 values observed across 22,416 rows | **delete** with B8 | |

### D. Grant authentication evidence

| # | Object | What it does today | Evidence | Verdict | Why |
| --- | --- | --- | --- | --- | --- |
| D1 | `grant_contexts.authentication` (nullable jsonb, 10 keys) | Snapshot written at grant creation (`auth/create-resource-grant.ts:96-100`); `validate_grant_authentication` recomputes it from 4 joins and compares the jsonb exactly (`0000_initial.sql:1212-1237`); `currentGrantAuthentication` re-parses it and re-checks it against the row (`auth/grant-authentication.ts:44-60`); copied into every v4 audit row and compared again by `record_user_oauth_subjects` (1250) | Of the 10 keys: 5 duplicate columns of the same row (`userId`, `memberId`, `authenticationSessionId`, `authenticationOrganizationId`, `brokerAuthenticatedAt` = `auth_time`); 1 is never read (`sessionExpiresAt`: only produced, `tenant-authentication.ts:75`, `grant-authentication.ts:37`); 4 are needed after the session is gone (`authenticationAccountId`, `authenticationProviderId`, `authenticationProviderRevision` read at `grant-authentication.ts:61-92`; `upstreamAuthTime` at `user-token-boundary.ts:72-76`). NULL is allowed by column and trigger (`IF NEW.authentication IS NULL THEN RETURN NEW`) (1216) but the one writer never writes NULL and a NULL grant can never be used (`safeParse` fails). Census: 99 of 273 grant inserts have NULL `authentication`, all from 12 test files that insert grants directly (e.g. `services/users.integration.test.ts`, `http/admin/user-erasure-audit.integration.test.ts`): the nullable column exists for fixtures | **simplify** into 4 typed NOT NULL columns named as on `sessions` (`authentication_account_id`, `authentication_provider_id`, `authentication_provider_revision`, nullable `upstream_auth_time`) | The column is needed (renewal after sign-out); the JSON, its duplicates and the text comparison are not |
| D2 | `protect_grant_context` + `validate_grant_authentication` | Two BEFORE INSERT SECURITY DEFINER triggers on `grant_contexts`; both join `sessions` and `members` and both check `session.id`, `session.created_at = auth_time`, `member_id`, `organization_id` | `0000_initial.sql:1041-1082`, `1212-1237`, `1341`, `1409` | **simplify**: one trigger comparing the 4 typed columns to the session row inside the existing provenance join | Same invariant checked twice |
| D3 | `data.authentication` copy in v4 audit rows | Equality enforced by `record_user_oauth_subjects` | Grant contexts are permanent (D1, B9) and the audit row's `target_id` is the grant id | **delete** the copy and its comparison | Read the grant row instead |

### E. Soft deletion consistency

| # | Object | What it does today | Evidence | Verdict | Why |
| --- | --- | --- | --- | --- | --- |
| E1 | Live-only partial unique indexes | `group_members`, `entitlements`, `organization_domains` (2), `sso_providers.organization_id`, `oauth_client_resources`, `organization_capabilities` exclude deleted rows | Matches `reports/id-soft-deletion.md:33` | **keep** | Consistent |
| E2 | Full unique keys on soft-deleted tables | `users.email` (released by email retirement), `organizations.slug`, `groups (organization_id, slug)`, `accounts (issuer, account_id)`, `members (organization_id, user_id)`, `oauth_clients.client_id`, `oauth_resources.identifier`, `sso_providers.provider_id` | Recorded reservations (`reports/id-soft-deletion.md:31-32`, docs/04 "Tombstone rows keep unique public identifiers reserved") | **keep** | Intentional |
| E3 | `oauth_consents` | `deleted_at`, no unique key at all | Plugin writes one consent per grant (`reference_id` = grant id, `auth/user-oauth-flow.ts:79`) | **not verified** whether a live `(client_id, user_id, reference_id)` unique index is needed; left to the index audit | |
| E4 | Lifecycle encodings | Three shapes for the same idea: `status` + `disabled_at` (users, organizations), `status` only (groups, entitlements, domains, capabilities), boolean `disabled` (clients, resources: plugin field `disabled`, read by the plugin) ; `members` use `status` + `revoked_at` | `db/schema/*.ts` | **keep** | Each is enforced by `protect_product_deletion` and the plugin needs `disabled`; `disabled_at` is read only by two API responses (`services/users.ts:32`, `services/organizations.ts:33`) |
| E5 | Combinations the CHECKs allow that code never produces | `invitations` deleted while `pending` (no invitations exist); `members` `revoked` with a future `valid_from` | `protect_product_deletion` covers deleted ⇒ inactive for every other table | **keep** | Nothing worth a constraint |

### F. Naming and wording

| # | Object | What it does today | Evidence | Verdict | Why |
| --- | --- | --- | --- | --- | --- |
| F1 | `oauth_access_tokens.revoked`, `oauth_refresh_tokens.revoked` | Timestamp named like a boolean, beside `revoked_at` on `members` and `grant_contexts` | `db/schema/oauth.ts:197,242`; also read in raw SQL by `protect_product_parents` (`row_data->>'revoked'`, `0000_initial.sql:1193`) | **simplify**: rename the physical column to `revoked_at` (property stays `revoked` for the plugin, as `oauth.ts:18-20` already allows) | Free before the first production migration |
| F2 | `oauth_client_resources.resource_id` | Holds the resource identifier URL; `system_bindings.resource_id` holds a row UUID | `oauth.ts:154-155`, `system-bindings.ts:15` | **simplify**: physical `resource` (as on `entitlements`, `organization_capabilities`); property stays `resourceId` | Same name, two meanings |
| F3 | Client/resource reference style | Public text ids (`client_id`, `resource`) in entitlements, capabilities, links, tokens, consents; row UUIDs as `client_instance_id`/`resource_instance_id` in `grant_contexts` and `resource_id` in `system_bindings` | schema files | **keep**, but rename `system_bindings.resource_id` to `resource_instance_id` | The `_instance_id` suffix already means "row UUID" elsewhere |
| F4 | `oauth_resources.revision` vs `policy_version` | Two counters | A6 | **delete** `policy_version` | |
| F5 | `oauth_*_tokens.reference_id`, `oauth_consents.reference_id` | Hold the grant context UUID as text, no FK | `auth/user-oauth-flow.ts:79`, `auth/user-token-assertions.ts:109` | **keep** | Plugin naming; a physical rename to `grant_context_id` is optional |
| F6 | British vs American spelling in identifiers | All identifiers American (`organization`, `authorization`, `normalized`, `canceled`); British only in exception messages (`0000_initial.sql:1016,1034`) | grep of the SQL | **keep** | Consistent; matches Better Auth and OAuth terms |
| F7 | `sessions.active_organization_id` | Name suggests a selectable tenant; it is the authentication organisation | A16 | **delete** (A16) | |

### G. Column census (26 tables)

Owner: BA = Better Auth core, Org = organisation plugin, SSO = `@better-auth/sso`, JWT = JWT plugin, OP = `@better-auth/oauth-provider`, A = Answerable. "Keep" rows group columns with the same attribution.

| Table | Columns | Owner | Written by | Read by | Verdict |
| --- | --- | --- | --- | --- | --- |
| users | id, name, email, email_verified, image, created_at, updated_at | BA | `services/federation.ts:241-250`, `:231-236`; `db/queries/users.ts:200,551` | federation, admin users API, policy joins | keep (`email_verified` is always true, `image` is API-only: core fields) |
| users | status, disabled_at, retired_email, deleted_at | A | same | policy (`status`), API, retirement CHECK | keep |
| organizations | id, name, slug, created_at | Org | `bootstrap.ts:90`, `db/queries/organizations.ts` | everywhere | keep |
| organizations | logo, metadata | Org | admin API only | admin API only | delete (A11) |
| organizations | status, disabled_at, authorization_version, revision, updated_at, deleted_at | A | `db/queries/organizations.ts:173,374`, triggers | policy, tokens, ETags | keep |
| sessions | id, token, expires_at, created_at, updated_at, user_id, ip_address, user_agent | BA | BA core (`internal-adapter.mjs:264`) | BA, sessions API, sign-in audit | keep |
| sessions | active_organization_id | Org | `auth/sso-origin.ts:170` | `auth/audit-hooks.ts:19`, sessions API | delete (A16) |
| sessions | authentication_organization_id, authentication_provider_id, authentication_provider_revision, authentication_account_id, upstream_auth_time | A | `auth/sso-origin.ts:171-177` | `auth/tenant-authentication.ts`, `fresh-authentication.ts`, `verified-sso.ts`, triggers | keep |
| accounts | id, account_id, provider_id, user_id, created_at, updated_at | BA | SSO callback, `services/federation.ts:213-221,254-262` | federation, triggers | keep |
| accounts | access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope | BA | SSO callback (encrypted) | erasure clearing only | Q3 |
| accounts | password | BA | nothing | erasure, deletion guard | keep (A13) |
| accounts | issuer, directory_user_id, deleted_at | A | federation | federation (unique binding, conflict check) | keep |
| accounts | directory_id | A | federation | admin users API only | keep (Google `hd` is not in the issuer) |
| verifications | all 6 | BA | BA, `auth/user-oauth-flow.ts` | BA | keep |
| members | id, organization_id, user_id, created_at | Org | SSO provisioning, `auth/verified-sso.ts:238-245` | everywhere | keep |
| members | role | Org | constant `'member'` | nothing reachable | keep (A14, Q1) |
| members | status, revoked_at, valid_from, valid_until, revision, deleted_at | A | `db/queries/members.ts`, erasure | policy | keep |
| invitations | all 9 (incl. deleted_at) | Org (+A) | nothing reachable | SSO provisioning read | simplify (A15) |
| jwks | id, public_key, private_key, created_at, expires_at, alg, crv | JWT | JWT plugin | JWT plugin, `operations/preflight.ts` | keep |
| oauth_clients | id, client_id, client_secret, name, uri, contacts, redirect_uris, token_endpoint_auth_method, jwks, jwks_uri, grant_types, response_types, require_pkce, scopes, skip_consent, disabled, created_at, updated_at | OP | `services/clients.ts:266-290`, PATCH | plugin token/authorize paths, admin API | keep |
| oauth_clients | client_credentials_scopes, organization_id, authorization_version, revision, deleted_at | A | admin API, triggers | machine policy, tokens | keep |
| oauth_clients | user_id | OP | nothing | erasure, grant locks | delete (A1) |
| oauth_clients | 14 never-written columns | OP | nothing reachable | API echo | delete (A4) |
| oauth_clients | post_logout_redirect_uris, backchannel_logout_uri | OP | PATCH | end-session (unreachable) / sign-out hook | delete (A5) |
| oauth_resources | id, identifier, name, access_token_ttl, refresh_token_ttl, signing_algorithm, allowed_scopes, disabled, created_at, updated_at | OP | `services/resources.ts`, `bootstrap.ts:135` | plugin `resolveResourcePolicy`, admin API | keep |
| oauth_resources | classification, organization_id, revision, deleted_at | A | admin API | policy, triggers | keep |
| oauth_resources | policy_version, signing_key_id, custom_claims, metadata, dpop_bound_access_tokens_required | OP/A | nothing | API echo, plugin (undefined ≡ null) | delete (A6-A8) |
| oauth_client_resources | id, client_id, resource_id, created_at, deleted_at | OP/A | `db/queries/oauth-clients.ts` | plugin link check, policy | keep (rename F2) |
| oauth_client_resources | metadata | OP | nothing | nothing | delete (A9) |
| oauth_refresh_tokens | all 18 | OP | plugin, ID revocation/erasure (`db/queries/oauth-tokens.ts`, `users.ts`) | plugin, `auth/user-token-assertions.ts` | keep (rename F1) |
| oauth_access_tokens | all 15 | OP | same | same | keep (rename F1) |
| oauth_consents | all 10 (incl. deleted_at) | OP/A | plugin consent, erasure | plugin | keep |
| oauth_client_assertions | id, expires_at | OP | plugin | plugin | keep |
| organization_domains | all 7 | A | admin API | federation routing | keep |
| groups | all except external_id | A | admin API, bootstrap | policy | keep |
| groups | external_id | A | admin API | `requireManual` | delete (A10) |
| group_members | all 9 | A | admin API | policy | keep |
| entitlements | all 14 | A | admin API, bootstrap | policy | keep |
| sso_providers | id, issuer, oidc_config, provider_id, organization_id, domain, created_at, updated_at | SSO | `db/queries/sso-providers.ts:101-113` | SSO callback, federation | keep |
| sso_providers | revision, deleted_at | A | trigger, admin API | session origin, grants | keep |
| sso_providers | user_id, saml_config | SSO | nothing | erasure / deletion guard | delete (A2, A3) |
| audit_events | id, occurred_at, actor_type, actor_id, organization_id, action, target_type, target_id, outcome, reason, request_id, ip, user_agent, data, operation_id | A | `db/queries/audit.ts:46-74` | audit API, triggers | keep (B6 wording) |
| audit_events | schema_version | A | 19 writer files | triggers, tenant filter | simplify (B3) |
| audit_event_subjects | event_id, entity_type, entity_id | A | triggers | `queries/audit.ts:183-193` | simplify (B8) |
| audit_event_subjects | relationship, organization_id, provenance | A | triggers | RLS only / nothing | delete (B7, B8, C7) |
| admin_operations | all 10 | A | `services/operations.ts` | replay (`services/operations.ts:104`), operation status API | keep |
| system_bindings | all 4 | A | `bootstrap.ts:204` | bootstrap, policy, protection | keep |
| organization_capabilities | all 13 | A | admin API, bootstrap | policy | keep |
| grant_contexts | id, organization_id, member_id, user_id, client_instance_id, resource_instance_id, authorization_code_id, authentication_session_id, auth_time, requested_scopes, created_at, expires_at, revoked_at | A | `auth/create-resource-grant.ts`, native code/refresh/revocation | policy, audit trigger | keep |
| grant_contexts | authentication | A | `auth/create-resource-grant.ts:96-100` | `grant-authentication.ts`, triggers | simplify (D1) |

## Measured numbers

**Probe 01, clean suite** (`cd apps/id && TEST_DATABASE_URL=…47433/answerable_id_test bun run db:test:migrate && bun test --timeout 15000`, no root `.env`)

| What | Result |
| --- | --- |
| Pass/fail line | `1422 pass`, `39 fail`, `5 errors`, `Ran 1461 tests across 127 files. [2406.90s]`, exit 1 |
| Failure causes | load: `deadlock detected`, `canceling statement due to statement timeout`, `Connection terminated due to connection timeout`, 15 s test timeouts; four auditors ran suites on one machine at once (the brief expects 7-9 minutes; this took 40) |
| Deterministic failure | `authorize refuses a malformed request before writing a flow` (`auth/user-oauth.integration.test.ts:2031`, `"null" cannot be parsed as a URL`) failed in both runs; not investigated |

**Probe 02, instrumented suite** (probe 01 plus the census trigger on all 26 tables)

| What | Result |
| --- | --- |
| Pass/fail line | `1534 pass`, `21 fail`, `Ran 1555 tests across 127 files. [1092.93s]` |
| Failures | 20 in `auth/tenant-authentication.integration.test.ts` from `No space left on device` (18 lines; see "Did not get to"), 1 timeout in `http/admin/entitlements.integration.test.ts`, plus the deterministic one above |
| Re-run of those two files under the census (`02b-census-rerun.out`) | `87 pass`, `0 fail` (exit 1 only from the per-run coverage threshold) |
| Row images captured | 73,097 (62,189 inserts, 10,908 updates) |

**Probe 03, column grep**

| What | Result |
| --- | --- |
| Columns | 312 across 26 tables |
| Columns named in 0 non-test source files outside `db/schema` | `jwks.crv`, `requested_user_info_claims` (3 tables), `oauth_refresh_tokens.rotated_at`, `rotation_replay_response`, `rotation_replay_expires_at` (all plugin-internal) |
| Columns named only in `http/admin/clients.ts` (the API echo) | 10 of the 14 in A4; the other 4 (`reference_id`, `policy`, `subject_type`, `metadata`) share names with unrelated code. `oauth_resources.custom_claims` is named only in `http/admin/resources.ts` |

**Probe 04, census report** (`04-census-report.out`)

| What | Result |
| --- | --- |
| Columns never non-null in any image | 27. Dead (no app writer): 13 `oauth_clients` columns of A4, `oauth_resources.metadata`, `signing_key_id`, `sso_providers.saml_config`, `accounts.password`, `invitations.role`. Untested plugin paths: `accounts.scope`, `access_token_expires_at`, `refresh_token_expires_at`, `oauth_access_tokens.confirmation`, `requested_user_info_claims`, `resources`, `oauth_refresh_tokens.confirmation`, `requested_user_info_claims`, `users.image` |
| Columns holding one value in every image | 18, including `audit_event_subjects.provenance` (`recorded` ×22,416), `oauth_resources.policy_version` (1 ×1,612), `dpop_bound_access_tokens_required` (false ×1,612), `oauth_clients.dpop_bound_access_tokens` (false ×1,650), `require_pkce` (true ×1,328), `system_bindings.name` (`platform` ×395) |
| `audit_events.schema_version` values | 0: 4, 1: 2,567, 2: 3,838, 3: 632, 4: 328 (the 0s and the off-version pairs are fixture inserts, B1) |
| Actions observed at more than one version | 17 (app-written: entitlement ×4 at 1/2, `oauth.token.rejected` at 2/3; the rest only through fixtures) |
| Audit subjects | 22,416 rows / 7,369 events = 3.04 per event; 38.7 % `user` rows |
| Subject rows per `oauth.user.issued` | 14.24 (1 user row) |
| `grant_contexts` inserts with NULL `authentication` | 99 of 273, all fixtures |
| Sessions where `active_organization_id` ≠ `authentication_organization_id` at insert | 3 of 3,449, all fixtures |

**Probe 05, `pg_stat_user_tables` after the clean run**

| What | Result |
| --- | --- |
| `audit_event_subjects` vs `audit_events` inserts | 21,066 vs 6,844 (3.08 subject rows per event) |
| `invitations` inserts | 9, all test fixtures (no reachable writer) |
| Leftover-row null census | empty: the suite truncates its tables |

**Probe 06, subject storage** (10,000 synthetic issuance events over 5,000 users and 75 organisations, 14 subject rows each as measured in probe 04, in a throwaway schema of `answerable_id` on 47433)

| Shape | Rows | Size | Bytes per event | Bulk insert | Reader lookup (one user) |
| --- | --- | --- | --- | --- | --- |
| Today's `audit_event_subjects` (PK + 2 indexes) | 140,000 | 69 MB | 7,189 | 6,726 ms | 0.055 ms, index-only scan |
| `(user_id, event_id)` primary key only | 10,000 | 1,216 kB | 124 | 91 ms | 0.037 ms, bitmap index scan |


## Questions for the owner

| # | Decision | Recommended answer |
| --- | --- | --- |
| Q1 | Who creates a membership on first SSO sign-in? Today the SSO plugin's `organizationProvisioning` does (`auth.ts:43`, `sso/dist/index.mjs:186-276`), which is why the always-empty `invitations` table must exist (read at 240-261) and why `members.role` must exist (plugin default, A14). ID already provisions membership itself inside the callback transaction for linking (`auth/verified-sso.ts:226-246`). | Provision in ID for sign-in too, set `organizationProvisioning: { disabled: true }` (`sso/dist/index.mjs:187`), then delete `invitations` and `members.role`. The Drizzle adapter resolves a model only when it is queried (`drizzle-adapter/dist/index.mjs:57-61`), so an unused plugin model needs no table; that the server boots and signs in without it is **not verified**. |
| Q2 | Reset audit payloads to one version per action (all `1`) before the first production migration (B3)? | Yes. Unify the two actions written at two versions, delete the version dispatch, and replace the 4,494-byte description with a per-action payload table. |
| Q3 | Keep storing upstream access, refresh and ID tokens that no ID code reads (A12)? | Stop storing them if the SSO plugin allows it (**not verified**); otherwise keep them encrypted as decided. Either way, record that nothing reads them. |
| Q4 | Deferred features with a live surface: back-channel logout URI (settable, delivered on sign-out by the plugin's session-delete hook, hidden from discovery), post-logout redirect URIs (settable, end-session unreachable), directory groups (`external_id`, nothing syncs). | Delete all three until each is built; add them back with their feature. |
| Q5 | Must a person's history include users named only inside bulk manifests (organisation erasure lists every member; group disable lists every assignee; entitlement `audience`)? | Yes: keep a trigger-owned subject table, narrowed to `(user_id, event_id)` (B8). If no, the indexed queries in B9 (plus `data.userId` for session events) suffice and both subject triggers can be deleted. |

## Did not get to

- **Index audit** of the 26 tables (owned by another auditor); E3 (`oauth_consents` uniqueness) is left to it.
- **Boot without `invitations`** (Q1): reasoned from installed source, not run.
- **Whether the SSO plugin can skip upstream token storage** (Q3).
- **Query plans at production volume** for the user-history alternatives (B9): probe 06 measured the subject shapes at 10,000 events only, because the Docker VM disk was full (below).
- **RLS and runtime-role policies** were read only where a column finding touched them.
- **The deterministic failure** `authorize refuses a malformed request before writing a flow` (both runs) was not investigated.
- **Knock-on edits** each finding implies (docs/04 object counts, `migration-catalog.json`, the OpenAPI snapshots, tests that exist only to cover dead branches or fixture-only columns) were not enumerated.
- My census schema was dropped after the report; `audit-pg-a` keeps `max_wal_size = 96MB`, `min_wal_size = 32MB` (set with `ALTER SYSTEM`).
- **Incident to report**: my first run of probe 06 (100,000 events × 14 subject rows) filled the shared Docker VM disk at 13:45 (`could not extend file … No space left on device`); I dropped the schema at once and lowered my container's `max_wal_size` to 96 MB (freed 64 MB of WAL). The ENOSPC window failed 20 tests in my census run (re-run clean: 87 pass, `02b-census-rerun.out`) and may have failed tests in other auditors' runs around 13:45. At 13:47 the disk was again at 100 % (107 MB free) from other containers.

