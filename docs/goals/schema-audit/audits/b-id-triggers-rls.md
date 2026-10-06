# Audit B: Answerable ID functions, triggers and row-level security

## Summary

- **Audited:** the 23 functions, 57 triggers, 24 policies and 11 RLS tables of `apps/id/drizzle/0000_initial.sql` (counts confirmed in the catalogue, probe 01), the runtime role (`runtime-role.ts`), the scopes (`isolation.ts`) and the application checks the guards duplicate. Measured on 5,000 users / 75 organisations / 100,000 audit events.
- **Headline:** most guards are sound and cheap. Four things should change before production:
  1. **Delete `protect_product_parents` from `sessions`, `oauth_access_tokens` and `oauth_refresh_tokens`.** The application already checks liveness in the same transaction and locks the same rows. On those tables the trigger costs 0.28–0.62 ms per row, 55–70% of each insert's server time. Its `FOR SHARE` lock made all 50 token inserts fail with `lock_timeout` behind a 2.5 s client update. Without it (foreign key only): no failures.
  2. **Fix a hole: a caller's temp tables shadow trigger lookups.** The runtime role can create temp tables, and Postgres searches `pg_temp` first for table names. A temp table therefore defeats `protect_private_resource_assignment` and also `protect_capability_target`, even though the second has `SET search_path` (both reproduced and rolled back). Qualify the names, or revoke TEMP.
  3. **Replace the generic parent and deletion machinery with constraints.** Live-parent composite foreign keys on generated columns plus per-table CHECKs can replace `require_present_parent`, `protect_product_parents` and three of the five concerns in `protect_product_deletion`. Probe 11 shows the same refusals and the same race behaviour, without blocking non-key parent updates.
  4. **Remove dead pieces:** `grant_delete` and the runtime's DELETE on `grant_contexts` (no caller), the `audit_insert` policy on `audit_event_subjects` (no non-owner can insert), the two owner-only immutability triggers, and the DELETE branch of `touch_client_resource_revision`.
- **Cost of RLS:** about +0.25 ms on the 0.19 ms grant-policy query. The `policy-user` membership subselect costs nothing measurable (0.434 ms against 0.440 ms for `platform-read`).
- **Audit-subject triggers:** +0.5 ms per machine token, +0.9 ms per sign-in and +1.8–2.2 ms per user token or refresh (15 subject rows each). Subjects take 457 B per row, so `audit_event_subjects` is 3x the size of `audit_events`. This is the main growth driver at scale.

## Method

- **Read:**
  - The brief files, plus `AGENTS.md`, docs/00, docs/02 ("Do not re-propose") and docs/04.
  - `0000_initial.sql` in full, `tenant-policies.ts`, `isolation.ts`, `runtime-role.ts` and `client.ts`.
  - The application paths the guards duplicate:
    - `auth/create-resource-grant.ts`, `auth/lock-resource-grant-policy.ts`, `auth/user-token-boundary.ts`, `auth/grant-authentication.ts`, `auth/tenant-authentication.ts`, `auth/verified-sso.ts`, `auth/database-adapter.ts`
    - `services/federation.ts:170-190`, `services/tenant-context.ts`
  - Installed Better Auth 1.7.2:
    - `@better-auth/oauth-provider` `introspect-C6P1zrTr.mjs:1457-1600` (token writes and rotation)
    - `@better-auth/sso` `index.mjs:2042-2110, 3019, 3962`: every SSO callback "locks" the provider row with an `UPDATE ... set providerId = providerId`.
  - The relevant tests (named in the findings).
- **Database:** my container `audit-pg-b` (port 47434) only.
  - Measurements ran on `answerable_id` in that container, migrated with `bun scripts/migrate.ts`, which also ran `configureRuntimeRole`.
  - The ID suite was running on `answerable_id_test` at the same time and resets that database, so the measurements could not use it.
  - Seed (probe 03, as owner with triggers on): 75 organisations, 5,000 users, 5,000 members, 5,000 accounts, 75 SSO providers, 500 groups, 20,000 group_members, 2,000 entitlements, 30 clients, 20 resources, 90 links, 200 capabilities, 5,000 SSO sessions, 20,000 refresh tokens, 20,000 access tokens and 100,000 audit events (which produced 266,666 subjects).
- **Hot-path probes:**
  - Inserts ran as `answerable_id_runtime` with the pool's `lock_timeout` 2000 and `statement_timeout` 10000, one transaction per row, with the scopes the app sets.
  - Each case ran in the order triggers on, off, off, on. "Off" means `ALTER TABLE … DISABLE TRIGGER USER` as owner, restored afterwards; every probe re-enabled triggers, checked with `tgenabled`.
  - Server times come from `pg_stat_statements` (`track=all`) and `pg_stat_user_functions` (`track_functions=all`).
- **Conditions:**
  - The host was heavily loaded by the other audits: load average 33–158 during the runs. Absolute numbers are inflated; read the on/off deltas. Each case has two pairs; both are reported.
  - At 11:45 UTC the shared Docker VM disk filled up (55.3 of 58.4 GB used, 87 MB free). My Postgres PANICked during a checkpoint and recovered on its own. I set `max_wal_size = 128MB` in my container only, then re-ran the probe.
- **ID suite:** I started it on `answerable_id_test` with function tracking, then stopped it after about 40 minutes because of the load. Five files had run, with 2 failures: "authorize refuses a malformed request…" and "missing origin or deleted member…", the latter taking 137 s. Its function-call counts are in `02-id-suite-functions.out`.
- **Probes:** `scratchpad/probes/b/`. Files 01–11 hold each SQL or Bun script with its `.out` beside it.

## Findings

### Triggers

**Who writes each table in production:**

| Abbreviation | Writer |
| --- | --- |
| BA | Better Auth adapter, protocol scope |
| AA | Admin API |
| GT | Grant/token transaction |
| Own | Owner only (runtime lacks the privilege, probe 01) |

**Shared invariants, referred to in the table:**

| Code | Invariant |
| --- | --- |
| T | Product deletion is terminal |
| B | A system-bound object cannot be soft-deleted |
| L | No soft deletion while live references remain |
| I | A deleted row is inactive and holds no credentials |
| P | A live row needs live parents (`require_present_parent`, `FOR SHARE`) |

**Replacements named in the verdicts:**

| Name | Replacement |
| --- | --- |
| Live FK | Composite foreign key `(parent_id, parent_live)` → `parent(id, live)` on generated `live` columns. Holds P and L, and B when `system_bindings` references `(…, live)`. Probe 11. |
| CHECK-I | A per-table CHECK for invariant I (exact text in "Simplest equivalents") |
| Terminal trigger | A three-line trigger: if `OLD.deleted_at` is set and differs from `NEW.deleted_at`, raise |

| # | Table / trigger | Event · function | Invariant | Writers | Overlap / evidence | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | accounts / `accounts_deletion_guard` | BI/BU · `protect_product_deletion` | T, I (no tokens or password on a deleted account) | BA (SSO), AA (user deletion) | None declarative | **simplify** → CHECK-I + terminal trigger |
| 2 | accounts / `zz_accounts_present_parents` | BI/BU · `protect_product_parents` | P (user) | BA, AA | Login already refuses deleted users and accounts (`federation.ts:180-190`) | **simplify** → live FK |
| 3 | admin_operations / `admin_operations_immutable` | BU/BD · `protect_admin_operation` | Receipts are immutable | Own | Runtime has no UPDATE or DELETE (probe 01); the REVOKE is tested ("runtime cannot mutate evidence…"). Never fired in the suite (probe 02). | **delete** |
| 4 | audit_events / `audit_events_capture_subjects` | AI · `record_audit_subjects` → `capture_audit_subjects` | Trigger-owned subjects | All | Recorded decision (docs/04). Cost: 0.54–5.6 ms per event (probe 06) | **keep** (content: Audit A) |
| 5 | audit_events / `audit_events_user_oauth_subjects` | AI · `record_user_oauth_subjects` | v4 subjects; the audit must match the grant | GT | Recorded decision. Cost: 1.19–1.45 ms per v4 event | **keep** |
| 6 | entitlements / `entitlements_deletion_guard` | BI/BU | T, I (disabled) | AA | — | **simplify** → CHECK-I + terminal trigger |
| 7 | entitlements / `entitlements_revision_guard` | BU · `protect_configuration_revision` | Server-controlled ETag | AA | `identity.integration.test.ts` "configuration revisions…" | **keep** |
| 8 | entitlements / `private_resource_assignment` | BI/BU · `protect_private_resource_assignment` | Never assign another tenant's private resource | AA | No foreign key can express it; bypassable through a temp table (probe 10) | **add**: qualify `public.oauth_resources` |
| 9 | entitlements / `zz_entitlements_present_parents` | BI/BU | P (org, member, group, client, resource) | AA | AA locks the org `FOR UPDATE` first (`lockOrganizationForCommand`) | **simplify** → live FKs |
| 10 | grant_contexts / `grant_authentication_provenance` | BI · `validate_grant_authentication` (SECURITY DEFINER) | Stored evidence equals the session's real origin | GT (one writer, `create-resource-grant.ts:81`) | Re-joins s, a, p, m that #11 and the app already joined. Compares JSON built with millisecond `to_char` against JS `toISOString`. Cost 0.245 ms (probe 05) | **simplify** → merge into #11; let the trigger *compute* `NEW.authentication` |
| 11 | grant_contexts / `grant_context_guard` | BI/BU · `protect_grant_context` (SECURITY DEFINER) | Insert: membership, user, org, session and client live and matching, under `FOR SHARE`. Update: immutable columns, irreversible revocation | GT; AA revocations | The app's INSERT … SELECT already applies every predicate (`create-resource-grant.ts:136-165`), after locking users, org, client and resource `FOR SHARE` (`lock-resource-grant-policy.ts:30-42`). Cost 0.249 ms | **keep** the update branch; **simplify** the insert branch (one join, lock only members and sessions) |
| 12 | group_members / `group_members_deletion_guard` | BI/BU | T | AA | No status column | **simplify** → terminal trigger |
| 13 | group_members / `group_members_identity_guard` | BU · `protect_group_assignment_identity` | id, org, group and member immutable | AA | Could be column-level UPDATE grants (see questions) | **keep** |
| 14 | group_members / `group_members_revision_guard` | BU | ETag | AA | — | **keep** |
| 15 | group_members / `zz_group_members_present_parents` | BI/BU | P (org, group, member) | AA | Proved by "parent deletion committed first denies a waiting SQL relationship creation" (`soft-deletion.integration.test.ts:508`) | **simplify** → live FKs (probe 11 case 8 reproduces it) |
| 16 | groups / `groups_deletion_guard` | BI/BU | T, B, I | AA | — | **simplify** → CHECK-I; B via the `system_bindings` live FK |
| 17 | groups / `groups_revision_guard` | BU | ETag | AA | — | **keep** |
| 18 | groups / `zz_groups_present_parents` | BI/BU | P (org) | AA | — | **simplify** → live FK |
| 19 | invitations / `invitations_deletion_guard` | BI/BU | T | BA (organisation plugin), AA | — | **simplify** → terminal trigger |
| 20 | invitations / `zz_invitations_present_parents` | BI/BU | P (org, inviter) | BA, AA | — | **simplify** → live FKs |
| 21 | members / `members_deletion_guard` | BI/BU | T, I (revoked) | BA (just-in-time on SSO), AA | — | **simplify** → CHECK-I + terminal trigger |
| 22 | members / `members_identity_guard` | BU · `protect_member_identity` | id, org, user immutable | BA, AA | — | **keep** |
| 23 | members / `members_revision_guard` | BU | ETag | BA, AA | — | **keep** |
| 24 | members / `zz_members_present_parents` | BI/BU | P (org, user) | BA, AA | `FOR SHARE` on the org row during SSO login | **simplify** → live FKs |
| 25 | oauth_access_tokens / `zz_oauth_access_tokens_present_parents` | BI/BU | P (user, client) | GT, BA | App checks and locks user and client in the same transaction (`currentGrantAuthentication`, `lockResourceGrantPolicy`); user and client deletion delete tokens. Cost 0.37–0.62 ms per row; S1 lock timeouts | **delete** |
| 26 | oauth_client_resources / `oauth_client_resources_deletion_guard` | BI/BU | T | AA | — | **simplify** → terminal trigger |
| 27 | oauth_client_resources / `oauth_client_resources_revision` | AI/AU/AD · `touch_client_resource_revision` | A link change bumps the client and resource ETags | AA | Chain below. The DELETE branch is unreachable (runtime has no DELETE). 2.32 ms per call in the suite | **simplify**: drop the DELETE event |
| 28 | oauth_client_resources / `zz_oauth_client_resources_present_parents` | BI/BU | P (client, resource), L for resources | AA | — | **simplify** → live FKs |
| 29 | oauth_clients / `oauth_clients_deletion_guard` | BI/BU | T, I (disabled, no secret), L (entitlements, capabilities) | AA | Uses `to_jsonb(OLD)->>'client_id'` | **simplify** → CHECK-I + live FKs + terminal trigger |
| 30 | oauth_clients / `oauth_clients_identity_guard` | BU · `protect_oauth_client_identity` | Identity immutable; `authorization_version` monotonic and bumped on credential change or disable | AA | `identity.integration.test.ts` "credential and disable writes advance version…" | **keep** |
| 31 | oauth_clients / `oauth_clients_revision_guard` | BU | ETag | AA, chain #27 | — | **keep** |
| 32 | oauth_clients / `zz_oauth_clients_present_parents` | BI/BU | P (org, user) | AA | — | **simplify** → live FKs |
| 33 | oauth_consents / `oauth_consents_deletion_guard` | BI/BU | T | BA, AA | — | **simplify** → terminal trigger |
| 34 | oauth_consents / `zz_oauth_consents_present_parents` | BI/BU | P (client, user) | BA (consent page) | The app checks the flow first (`user-oauth-flow.ts`) | **simplify** → live FKs |
| 35 | oauth_refresh_tokens / `zz_oauth_refresh_tokens_present_parents` | BI/BU | P (user, client) | GT | As #25. Cost 0.37–0.56 ms per row. A rotation UPDATE returns early (`revoked` set) | **delete** |
| 36 | oauth_resources / `oauth_resources_deletion_guard` | BI/BU | T, B, I, L (entitlements, capabilities, links) | AA | — | **simplify** → CHECK-I + live FKs + terminal trigger |
| 37 | oauth_resources / `oauth_resources_identity_guard` | BU · `protect_oauth_resource_identity` | id and identifier immutable | AA | Second BEFORE UPDATE immutability trigger on the same table as #39 | **simplify** → merge with #39 |
| 38 | oauth_resources / `oauth_resources_revision_guard` | BU | ETag | AA, chain #27 | — | **keep** |
| 39 | oauth_resources / `resource_ownership_immutable` | BU · `protect_resource_ownership` (no `SET search_path`) | Classification and owner immutable | AA | References only NEW and OLD, so search_path is irrelevant (not a hole) | **simplify** → merge into #37 |
| 40 | oauth_resources / `zz_oauth_resources_present_parents` | BI/BU | P (org) | AA | — | **simplify** → live FK |
| 41 | organization_capabilities / `capability_private_resource_guard` | BI/BU · `protect_private_resource_assignment` | As #8 | AA (platform-write) | Same hole | **add**: qualify names |
| 42 | organization_capabilities / `capability_revision_guard` | BU | ETag | AA | — | **keep** |
| 43 | organization_capabilities / `capability_target_guard` | BI/BU · `protect_capability_target` | Target immutable; `admin_session` needs the bound resource; `client_credentials` needs the owning tenant; `platform:` scopes need the platform org | AA | Bypassed through temp `system_bindings` and `oauth_resources` despite `SET search_path` (probe 10, case C). 0.41 ms per call | **keep** + **add**: qualify `public.` |
| 44 | organization_capabilities / `organization_capabilities_deletion_guard` | BI/BU | T, I | AA | — | **simplify** → CHECK-I + terminal trigger |
| 45 | organization_capabilities / `zz_organization_capabilities_present_parents` | BI/BU | P (org, client, resource) | AA | — | **simplify** → live FKs |
| 46 | organization_domains / `organization_domains_deletion_guard` | BI/BU | T, I | AA | — | **simplify** → CHECK-I + terminal trigger |
| 47 | organization_domains / `zz_organization_domains_present_parents` | BI/BU | P (org) | AA | — | **simplify** → live FK |
| 48 | organizations / `organizations_authorization_version_guard` | BU | Version monotonic, bumped on disable | AA | `identity.integration.test.ts:302` | **keep** |
| 49 | organizations / `organizations_deletion_guard` | BI/BU | T, B, I, L (clients, resources) | AA | — | **simplify** → CHECK-I + live FKs + terminal trigger |
| 50 | organizations / `organizations_revision_guard` | BU | ETag | AA | — | **keep** |
| 51 | sessions / `sessions_authentication_origin_guard` | BI/BU · `protect_session_authentication_origin` | Insert: origin provider and account match. Update: origin immutable | BA (SSO callback) | `tenantAuthentication` re-verifies the full origin join on every use (`tenant-authentication.ts:64-122`), so the insert check is a duplicate; the update immutability is not (a rewrite to another valid origin would pass the consumer). Its `FOR SHARE OF p` only works because `protocol` may write `sso_providers` (a probe without scope failed, 23514). Unqualified table names: same class of hole as #43. Cost 0.174 ms | **keep** update branch; **simplify** insert branch → composite FKs `(authentication_account_id, user_id)` → `accounts(id, user_id)` and `(authentication_provider_id, authentication_organization_id)` → `sso_providers(id, organization_id)` |
| 52 | sessions / `zz_sessions_present_parents` | BI/BU | P (user) | BA (login, session refresh, org switch) | Login refuses deleted users (`federation.ts:180-190`); user deletion deletes sessions (`soft-deletion.integration.test.ts:47` expects `sessions = []`). Cost 0.28 ms per row; `FOR SHARE` on the user row on every session write | **delete** |
| 53 | sso_providers / `sso_providers_deletion_guard` | BI/BU | T, I (no config) | AA, BA lock-update | Fires on every SSO login (BA `index.mjs:2050`) | **simplify** → CHECK-I + terminal trigger |
| 54 | sso_providers / `sso_providers_revision_guard` | BU · `protect_sso_provider_revision` | ETag, ignoring BA's per-login no-op update (keeps `updated_at`) | AA, BA | Near-identical to `protect_configuration_revision`; the difference (ignore `updated_at`) has a real cause, BA's lock-by-update | **simplify** → one function taking ignored columns via `TG_ARGV` |
| 55 | sso_providers / `zz_sso_providers_present_parents` | BI/BU | P (org) | AA, BA (every login) | Takes `FOR SHARE` on the organisation on every SSO login | **simplify** → live FK |
| 56 | system_bindings / `system_bindings_immutable` | BU/BD · `protect_system_binding` | Binding immutable | Own | Runtime has no UPDATE or DELETE. `bootstrap.integration.test.ts:228` proves it on the owner connection; never fired for runtime | **delete** (move that test to the runtime role) |
| 57 | users / `users_deletion_guard` | BI/BU | T, I (disabled) | BA, AA | — | **simplify** → CHECK-I + terminal trigger |

**The `touch_client_resource_revision` chain (#27):**

1. A link INSERT or UPDATE fires its own BEFORE triggers: #26, and #28, which takes `FOR SHARE` on the client and resource.
2. The AFTER trigger runs `UPDATE oauth_clients SET updated_at = greatest(clock_timestamp(), updated_at + 1 µs)`. That fires #29, #30, #31 (`to_jsonb` diff, revision + 1) and #32 (`FOR SHARE` on the org and user).
3. It then runs `UPDATE oauth_resources …`, which fires #36, #37, #38, #39 and #40.

So one link write runs 11 BEFORE trigger functions and 2 extra row updates. The `+1 µs` exists only so the `to_jsonb` diff in #31/#38 sees a change. It is cheap where it runs (admin links only).

**Functions:**
- `try_uuid`: keep.
- `capture_audit_subjects`: keep, cost below.
- `record_audit_subjects`: keep.

### Row-level security

Policy text comes from `0000_initial.sql:564-658`; scopes from `isolation.ts`. No table has `FORCE ROW LEVEL SECURITY` (probe 01), and none needs it:
- `assertRuntimeRole` refuses an owner connection at startup (`runtime-role.ts:70-90`).
- The migration role owns the tables and bypasses RLS by ownership.
- SECURITY DEFINER triggers run as the owner and so bypass RLS, which is what `protect_grant_context` relies on.

| Table | Policies | Scopes that reach it | `using (true)`? | App-layer isolation too? | Verdict |
| --- | --- | --- | --- | --- | --- |
| groups, group_members, entitlements | `tenant_write` (ALL), `tenant_read` (SELECT) | Write: platform-write, own tenant-write. Read adds platform-read, own tenant-read, policy-user (organisations where the subject is an effective member), policy-root (platform org) | No | Yes: typed contexts plus explicit `organization_id` predicates (`services/tenant-context.ts`) | **keep** (recorded decision). **simplify** the text: `tenant_read` repeats the `write` clause already granted by the permissive `tenant_write`, so it is evaluated twice (visible in the probe 09 plan for members) |
| organization_capabilities | `capability_write` (platform-write), `capability_read` | Read: platform r/w, own tenant r/w, policy-user, policy-root | No | Yes | **keep** |
| grant_contexts | `grant_read`, `grant_insert`, `grant_update`, `grant_delete` | Insert: platform-write, grant-admission (own user and session). Update: platform-write, platform-users, own tenant-write, grant-client | No | Partly: single writer | **delete** `grant_delete` and revoke the runtime's DELETE on `grant_contexts`. Nothing deletes grant contexts (grep: no `delete(grantContexts)`), and docs/04 says revocation is retained. Add the table to `assertRuntimeRole`'s DELETE check |
| members | `tenant_write`, `tenant_read` | Write: platform-write, **protocol (any tenant)**, own tenant-write. Read adds policy-user and grant-admission own rows | No | Yes | **keep**; same duplicate clause |
| invitations | as members | As members, without the subject branch | No | Yes | **simplify** the text: literal `or false` (`tenant-policies.ts:32`) |
| organization_domains | `routing_read` **true**, `routing_write` | Write: platform-write, own tenant-write | Read only | Yes | **keep**: RLS exists for write isolation. **simplify** the text: literal `(false and … 'protocol')` |
| sso_providers | `routing_read` **true**, `routing_write` | Write: platform-write, own tenant-write, **protocol** | Read only | Yes | **keep**: protocol write is required by BA's per-login lock-update and by the `FOR SHARE` in #51. **simplify** the text: `(true and …)` |
| audit_events | `audit_insert` **true**, `audit_read` | Read: platform r/w/users, own tenant r/w | Insert only | Yes | **keep** |
| audit_event_subjects | `audit_insert` **true**, `audit_read` | Insert: none. Runtime INSERT is revoked (`runtime-role.ts:57`); the owner and SECURITY DEFINER triggers bypass RLS | Insert | — | **delete** `audit_insert` (dead policy) |

**What the runtime role may and may not do:**
- **May:** SELECT on everything. INSERT on everything except `audit_event_subjects`. UPDATE on everything except `audit_events`, `audit_event_subjects`, `system_bindings` and `admin_operations`. DELETE only on `sessions`, `oauth_access_tokens`, `oauth_refresh_tokens`, `verifications`, `jwks`, `oauth_client_assertions` and `grant_contexts`. Create TEMP tables.
- **May not:** TRUNCATE, TRIGGER, or CREATE in `public` (probe 01, 10).
- **Triggers this makes owner-only:** guards on UPDATE or DELETE of `system_bindings` and `admin_operations` (#3, #56), and the DELETE branch of #27.

## Measured numbers

**Hot-path inserts: one row per transaction, runtime role, N = 2,000 per mode** (probe 04, profile in 05). Server time is `pg_stat_statements` `mean_exec_time`. "Run 1" is the first on/off pair and "run 2" the second; the profile run is a further on-only run.

| Insert | Server ms (on / off) | Client p50 ms (on / off) | Rows/s (on / off) | Trigger functions per row (profile run) |
| --- | --- | --- | --- | --- |
| sessions (SSO origin, protocol scope) | Run 1: 1.99 / 0.23<br>Run 2: 0.60 / 0.14<br>Profile: 0.59 | 5.01 / 0.69 · 1.01 / 0.48 | 144 / 846 · 581 / 1,665 | `protect_product_parents` 0.279<br>`protect_session_authentication_origin` 0.174 |
| oauth_refresh_tokens | Run 1: 0.50 / 0.15<br>Run 2: 0.39 / 0.18<br>Profile: 0.56 | 1.25 / 0.77 · 1.07 / 0.81 | 536 / 875 · 692 / 869 | `protect_product_parents` 0.373 (7 `require_present_parent` calls, 2 doing work) |
| oauth_access_tokens | Run 1: 0.39 / 0.13<br>Run 2: 0.37 / 0.14<br>Profile: 1.03 (load spike) | 1.11 / 0.75 · 1.03 / 0.74 | 654 / 1,065 · 788 / 1,034 | `protect_product_parents` 0.624 |
| grant_contexts (INSERT … SELECT, grant-admission) | Run 1: 0.60 / 0.37<br>Run 2: 0.64 / 0.39<br>Profile: 1.03 | 1.02 / 0.82 · 1.03 / 0.78 | 783 / 968 · 709 / 981 | `protect_grant_context` 0.249<br>`validate_grant_authentication` 0.245 |

Nested statements inside `require_present_parent` (probe 05): the users `FOR SHARE` query takes 0.031–0.078 ms, the clients `FOR SHARE` query 0.020–0.035 ms, and the foreign key's own `FOR KEY SHARE` checks 0.007–0.024 ms.

**Audit-subject triggers per `audit_events` insert** (runtime role, N = 1,000, probe 06; breakdown in 07):

| Event | Server ms (run 1 on/off · run 2 off/on) | Subjects per event | `capture_audit_subjects` ms | `record_user_oauth_subjects` ms |
| --- | --- | --- | --- | --- |
| v2 `oauth.token.issued` (each machine token) | 0.61 / 0.07 · 0.07 / 0.61 | 2 | 0.54 | 0.008 |
| v2 `auth.signin.succeeded` (each login) | 0.96 / 0.10 · 0.13 / 0.97 | 3 | 0.90–0.94 | 0.009 |
| v4 `oauth.user.issued` (each user token or refresh) | 2.30 / 0.14 · 0.18 / 1.95 | 15 | 0.58–0.70 | 1.19–1.45 |
| v1 `member.updated` (admin) | 2.09 / 0.14 · 0.19 / 1.29 | 3 | 1.09–1.89 | 0.011 |
| v3 `user.erased`, 50 effects (rare) | 1.13 / 0.19 · 0.13 / 1.01 | 3 | 0.85–0.94 | 0.011 |
| v2 `group.disabled`, 60 assignments (admin) | 4.45 / 0.40 · 0.33 / 6.18 | 61.6 | 4.14–5.65 | 0.013 |

**Where a simple event's time goes** (probe 07, the 2-subject machine event): `capture_audit_subjects` took 0.458 ms. Its nested statements account for about 0.19 ms:
- two subject inserts, 0.078 and 0.061 ms;
- two foreign-key checks, 0.017 ms each;
- an empty `INSERT … SELECT`, 0.015 ms.

The remaining ~0.27 ms is PL/pgSQL evaluating the version-branch `CASE`.

**Audit storage** (seeded database plus probe rows):

| Table | Rows | Heap | Indexes | Total | Per row |
| --- | --- | --- | --- | --- | --- |
| `audit_event_subjects` | 539,583 | 64 MB | 171 MB | 235 MB | 457 B |
| `audit_events` | 137,680 | 44 MB | 35 MB | 79 MB | 600 B (jsonb included) |

That is 3.9 subjects per event. At 15 subjects per v4 event, one user token refresh writes about 6.9 kB of subject rows: 15 × 457 B, arithmetic on the measured values.

**Lock contention on one popular client row** (probe 08). Fifty refresh-token inserts for `client-7`, pool `lock_timeout` 2,000 ms.

| Scenario | Triggers on | Triggers off (FK only) |
| --- | --- | --- |
| S1: writer updates the client row (as #27 does) and holds it for 300 ms | All 50 waited; p50 663 ms, max 680 ms | p50 94 ms, max 103 ms (host-load baseline) |
| S1: writer holds the row for 2,500 ms | **50 of 50 `55P03` lock timeouts** at about 2,093 ms | 0 timeouts; max 281 ms |
| S2: 50 token transactions (insert + 200 ms) arriving every 20 ms; writer arrives at 100 ms | Writer waited **1,199 ms** | Writer waited 16 ms |
| S2: MultiXacts created | 49 | 51 (the FK's `KEY SHARE` lockers create them too) |

**RLS cost**: mean of 1,000 executions in a server-side loop, runtime role versus owner (probe 09/09b).

| Query (seeded sizes) | policy-user | tenant-read | platform-read | policy-root | Owner (no RLS) |
| --- | --- | --- | --- | --- | --- |
| Grant-policy query (`userResourcePolicy` shape: entitlements, group_members, groups and capabilities subselects) | 0.434 | — | 0.440 | — | 0.188 |
| Entitlements of one organisation (24 rows) | 0.165 | 0.142 | 0.134 | — | 0.087 |
| Group memberships of one member (4) | 0.068 | 0.063 | 0.064 | — | 0.009 |
| Groups of one organisation (6) | 0.101 | 0.078 | 0.059 | — | 0.010 |
| Capabilities of one organisation (2) | 0.053 | 0.038 | 0.045 | — | 0.015 |
| Platform members (67) | — | — | 0.102 | 0.156 | 0.049 |

The plans keep their index scans. The membership subselect is a hashed subplan that is either never executed or run once. The cost is the per-row `current_setting()` chains.

**Set-based seed inserts** (probe 03, as owner, triggers on, host busy):

| Table | Rows | Time | Per row | Main trigger |
| --- | --- | --- | --- | --- |
| users | 5,000 | 62 ms | 0.012 ms | deletion guard only |
| members | 5,000 | 942 ms | 0.19 ms | parents |
| group_members | 20,000 | 5,814 ms | 0.29 ms | parents |
| refresh tokens | 20,000 | 5,233 ms | 0.26 ms | parents |
| access tokens | 20,000 | 4,785 ms | 0.24 ms | parents |
| audit events | 100,000 | 35,934 ms | 0.36 ms | subjects |

**Search-path probe** (probe 10, runtime role, rolled back):

| Check | Result |
| --- | --- |
| `has_database_privilege(TEMP)` | true |
| CREATE on `public` | false |
| A: cross-tenant entitlement on a private resource | refused |
| B: the same insert after `create temp table oauth_resources` | **inserted** |
| C: `admin_session` capability with `platform:write` on a non-bound resource after temp `system_bindings` and `oauth_resources` | **inserted** |

**Live-parent composite foreign key** (probe 11):

| Case | Result |
| --- | --- |
| Live child under a live parent | ok |
| Soft-delete a parent with a live child | 23503 |
| Soft-delete the child, then the parent | ok |
| Live child under a deleted parent | 23503 |
| Tombstone child under a deleted parent | ok |
| Revive a child under a deleted parent | 23503 |
| Non-key parent update while a child insert is open | 1 ms (no wait) |
| Child insert racing an uncommitted parent soft-delete | waited, then 23503 at 302 ms |

**Partial suite** (5 files, probe 02; ms per call on a loaded host):

| Function | Calls | ms per call |
| --- | --- | --- |
| `require_present_parent` | 127,885 (for 19,083 `protect_product_parents` calls; 6.7 per row) | 0.027 |
| `protect_product_parents` | 19,083 | 0.354 |
| `capture_audit_subjects` | 3,971 | 1.28 |
| `touch_client_resource_revision` | 468 | 2.32 |
| `validate_grant_authentication` | 174 | 1.77 |
| `protect_grant_context` | 361 | 0.76 |
| `protect_system_binding` | 0 | — |
| `protect_admin_operation` | not called | — |

### Scale verdict

**Thousands of users, about 75 organisations; token issuance and refresh are the hot path.**

| Question | Answer |
| --- | --- |
| **Won't show at this scale** | All admin-path guards: identity, revision, capability, deletion and the `touch` chain. 0.05–2.3 ms per admin write, at a handful of writes per minute. RLS: +0.25 ms per policy query. |
| **Visible as latency, not throughput** | Per user refresh, triggers add about 0.4 (refresh row) + 0.4 (access row, if opaque) + 1.8–2.2 (v4 audit) ≈ 2.6–3 ms of server time. A 10-connection pool still clears hundreds of refreshes per second. |
| **Grows with use** | `audit_event_subjects`: 15 rows per user token or refresh, 457 B per row, 3x the size of `audit_events`. Plan retention and partitioning with Audit A and the evidence-retention question (`Q-EVIDENCE-RETENTION`). |
| **Contention that can bite** | `FOR SHARE` from #25, #35 and #52. A client-row or user-row update, or a held admin transaction, stalls every concurrent token insert; past 2 s they all fail (S1). A stream of token transactions delays a client update (S2: 1.2 s). On the user-token path the app also takes `FOR SHARE` on users, org and client (`lock-resource-grant-policy.ts:30-42`), so deleting #25/#35 alone leaves that app-level coupling. The trigger adds the same lock where the app takes none: every session write and the opaque access-token row. The SSO login lock-update (BA) plus #55 adds an org-row `FOR SHARE` per login, which serialises with tenant commands that lock the org `FOR UPDATE`. |

### Simplest equivalents

The test named for each item is the one that must keep passing.

1. **#25, #35, #52 → nothing.** Token and session liveness is held by:
   - login admission (`federation.ts:180-190`);
   - `currentGrantAuthentication`, which checks users, orgs, accounts, providers and members, deleted and status (`grant-authentication.ts:44-110`);
   - `lockResourceGrantPolicy`, which uses `deleted_at is null` on client and resource;
   - the deletion manifests, which delete sessions and tokens.

   Existence stays with the current foreign keys. Proof tests: `soft-deletion.integration.test.ts:47` "user deletion retains identity…" (sessions empty, sign-in `user_disabled`), `http/admin/users.integration.test.ts:143`, `services/users.integration.test.ts:155` and `services/organizations.integration.test.ts:478`. No test I found issues a token *after* deletion through the native endpoint; add one before deleting the triggers.
2. **#2, 9, 15, 18, 20, 24, 28, 32, 34, 40, 45, 47, 55 and the L/B branches of `protect_product_deletion` → live FKs.**
   - On each parent: `live boolean generated always as (case when deleted_at is null then true end) stored` plus `unique (id, live)` (`(client_id, live)` and `(identifier, live)` for clients and resources).
   - On each child: `parent_live` generated the same way from the child's own `deleted_at` (and `revoked_at` for members), plus `foreign key (parent_id, parent_live) references parent (id, live)`.
   - `system_bindings` gets a constant `live boolean not null default true check (live)` and live FKs to the organisation, resource and group.
   - Proofs: `soft-deletion.integration.test.ts:508` (race, 23503), "group deletion … denies reuse", `services/resources.integration.test.ts:164` ("resource erasure requires explicit unlinking in both the service and database"), `bootstrap.integration.test.ts:228`.
3. **Invariant I → CHECK constraints:**
   - `users`, `organizations`, `groups`, `entitlements`, `organization_domains`, `organization_capabilities`: `check (deleted_at is null or status = 'disabled')`
   - `members`: `check (deleted_at is null or status = 'revoked')`
   - `oauth_clients`: `check (deleted_at is null or (disabled and client_secret is null))`
   - `oauth_resources`: `check (deleted_at is null or disabled)`
   - `accounts`: `check (deleted_at is null or num_nonnulls(access_token, refresh_token, id_token, password) = 0)`
   - `sso_providers`: `check (deleted_at is null or num_nonnulls(oidc_config, saml_config) = 0)`

   What remains of `protect_product_deletion` is the three-line terminal trigger. Proofs: the soft-deletion suite (credentials cleared, "cannot be enabled").
4. **#10 + #11 insert branch → one `BEFORE INSERT` SECURITY DEFINER trigger** that selects the s/a/p/m/o/u/c join once and *assigns* `NEW.authentication` and `NEW.auth_time`, raising if no row. Drop the app's JSON build, or keep it and stop comparing. It locks only members and sessions; the app already holds the rest. Proofs: `user-oauth.integration.test.ts` (`grant_authentication_provenance`, `grant_context_immutable`).
5. **#51 insert branch → the two composite FKs above;** keep the update immutability. Proofs: `federation.integration.test.ts` "a failed origin insert rolls back…" and "native SSO persists the accepted provider origin…".
6. **#3, #56 → delete;** the REVOKEs, already asserted by `assertRuntimeRole`, hold it for the runtime. Proofs: `runtime-role.integration.test.ts:170`; `bootstrap.integration.test.ts:228` must run its delete and update on the runtime connection.
7. **#54 + `protect_configuration_revision` → one function** comparing `to_jsonb(NEW) - 'revision' - TG_ARGV…`, created as `EXECUTE FUNCTION protect_configuration_revision('updated_at')` on `sso_providers`. Proof: `identity.integration.test.ts:194`, `sso-providers.integration.test.ts`.
8. **#37 + #39 → one function.** Proofs: `identity.integration.test.ts:105, 336`.
9. **#27:** `AFTER INSERT OR UPDATE` only. Proof: `identity.integration.test.ts:217`.
10. **Search path → schema-qualify every relation in trigger functions** (`public.oauth_resources`, `public.system_bindings`, `public.oauth_clients`, `public.sso_providers`, `public.accounts`), and add `REVOKE TEMPORARY ON DATABASE … FROM PUBLIC` with an `assertRuntimeRole` check. Proof: a new runtime-role test reproducing probe 10.
11. **RLS:**
    - drop `grant_delete`, revoke DELETE on `grant_contexts`, and drop `audit_insert` on `audit_event_subjects`;
    - remove the `write` clause from the read policies and the literal `true`/`false` terms.

    Proofs: `runtime-role-policy.integration.test.ts`, `runtime-role.integration.test.ts:219`, `migration-catalog.json`.

## Questions for the owner

| Question | Recommended answer |
| --- | --- |
| Remove the parent-liveness trigger from sessions and token rows (#25, #35, #52), relying on the app's same-transaction checks and locks? | **Yes.** It costs 55–70% of each insert, and its `FOR SHARE` turns a 2.5 s client write into 50 failed token requests. |
| Replace `require_present_parent` / `protect_product_parents` and the live-reference and binding branches with generated `live` columns and composite FKs? | **Yes,** with the migration generated by Drizzle (not verified that drizzle-kit 0.45.2 models a composite FK onto a generated column without hand SQL). It holds the same refusals and race (probe 11) and does not block non-key parent updates. |
| Revoke TEMP from PUBLIC on the ID database, or only qualify names? | **Both.** Qualifying closes the hole; the revoke removes the class. |
| Identity-immutability triggers (#13, #22, #30 identity part, #37/#39, #11 update, #51 update) versus column-level UPDATE grants? | **Keep the triggers for now.** They bind the owner too and cost under 0.2 ms on admin paths. Column grants would need checking against every Better Auth update shape (not verified). |
| Keep the audit-subject triggers on the hot path at 15 rows per refresh? | **Keep the trigger** (recorded decision). Decide retention and partitioning for `audit_event_subjects` now (with `Q-EVIDENCE-RETENTION`), since it is 3x the audit table. |

## Did not get to

- **The full ID suite.** Stopped after 5 files and about 40 minutes because the host was overloaded; 2 failures were seen, at least one load-related. So I have no full per-guard call counts, and I did not run it against the proposed replacements.
- **Clean-host timings.** Every absolute number was taken at load average 33–158. Only the on/off deltas, run in alternating order, are robust.
- **Contention on users and organisation rows** (session refresh against user updates; SSO logins against tenant commands). Inferred from the code paths, not measured.
- **Column-level UPDATE grants** as a replacement for identity triggers, checked against Better Auth's update payloads. Not verified.
- **`protect_capability_target`'s `client_credentials` ownership as a generated-column composite FK.** Not probed.
- **The content of `capture_audit_subjects`' version branches.** Audit A's scope; I measured cost only.
