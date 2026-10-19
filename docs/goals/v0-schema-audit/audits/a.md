# Audit A: the deletion model (v0 schema audit, 19 October 2026)

Auditor A (Opus 5.5). Container `audit-pg-a` (PostgreSQL 17.9, port 47433). Worktree at main 9833960. Probes in `$S/probes/a/` (`$S` = the session scratchpad). Two throwaway spikes live uncommitted in the worktree under `apps/id/spike-audit-a/` and are copied into the probes directory. Host load during timings: macOS 5.8 to 7.5 (four audits running); container `/proc/loadavg` 1.99 to 2.07. Every timing verdict rests on on/off deltas or wait/no-wait, not absolute latency.

## 1. Summary

1. **Tombstones are needed on five tables, not fourteen.** Only users, organisations, memberships, clients and resources are read or referenced after deletion: `grant_contexts`' five restrict FKs point at them (probe 03: hard deletes refused), and client IDs and resource identifiers key downstream state (Toolbox `host_clients.client_id`, mcp-postgres evidence `client_id`, the JWT `aud`). The other nine (accounts, groups, group assignments, entitlements, domains, SSO providers, client-resource links, consents, capabilities) are read by nothing after deletion. The admin API exposes no `deletedAt` property (0 in `openapi.admin.json`), consumers treat 404 as absent, and every removal's audit event already records the row.
2. **Recommend design (ii′).** Hard-delete those nine and keep five tombstones. A hard-deleted child reaches a tombstoned parent through a *generated* constant `live` column. Probes 07 and 09 showed that drizzle-kit 0.31.10 generates it and that PostgreSQL 17.9 keeps both refusals. The change removes 9 `deleted_at` columns, 9 triggers, 6 deleted CHECKs, 9 case-expression live CHECKs, 3 live FKs, 1 live unique key, all 7 `deleted_at` partial unique indexes and 61 of 129 `isNull(…deletedAt)` filters. The two hand-written `NULLS NOT DISTINCT` indexes can then be declared in the schema modules, so they leave `0001_invariants.sql`.
3. **Design (iii), hard delete everywhere, is not cheaper.** It frees client IDs and resource identifiers that the Toolbox and the evidence store key on. It also forces either deleting grant contexts or dropping their FKs, so a reservation table would have to come back.
4. **Erasure today does not give a defensible answer (probe 06).** After `user.erased`, the user row keeps `name` and the original address in `retired_email`. Two account tombstones keep the IdP `sub` and object id. Audit keeps the sign-in IP and user agent. Re-sign-in by the same `(issuer, sub)` is refused (`user_disabled`), so the tombstone acts as a permanent ban. After `organization.erased`, 6 of 6 of its people kept their email, name, a live account **with encrypted upstream tokens** and a live browser session, with 0 memberships left.
5. **Smallest defensible fix:**
   - clear `name`, `image` and `retired_email` at erasure, enforced by `users_deleted_check`;
   - hard-delete the person's accounts, so erasure is no longer a ban and disable stays the ban;
   - make organisation erasure erase the people it leaves with no membership.
   - Audit IP and user agent stay, bounded by the retention period that `Q-EVIDENCE-RETENTION` must set.
6. **The live-key machinery is cheap; keep it on the five tombstone tables.** On/off insert cost is +16 to +32 µs per row (+17 to +29%), and updates cost +2.5 to +8 µs (probe 04). A parent update blocks no child FK check: 50 of 50 member inserts finished in 20 to 30 ms while a user or organisation row was held for 2.5 s (probe 05).
7. **A generated `live` column on a parent is still not viable on PostgreSQL 17.9.** With any BEFORE UPDATE row trigger, a non-key parent update made all 50 child inserts wait the whole 2,466 ms. Without the trigger they took 12 to 15 ms. Keep the plain column, `protect_soft_deletion` and the CHECK on the five tombstone tables.
8. **Keep `users.email` unique.** It is Better Auth's contract (`findUserByEmail` in `link-account.mjs:62` expects at most one match) and keeps sign-in fail-closed (`email_conflict`; 6 of 6 existing federation tests pass on 47433). Keep `retired_email` for disable-then-reuse. Relax `users_retired_email_check` to an implication so that erasure can clear it.

## 2. Verdict table

### One row per table

| Item | Today | Evidence | Verdict | Change | Lost or risked |
|---|---|---|---|---|---|
| `users` | Tombstone; email retired to `<id>@retired.invalid`; name, image, original address (`retired_email`) kept | P06: name and retired address survive erasure. P03: hard delete refused by `grant_contexts_user_id_users_id_fk`. Federation reads `owner.deletedAt` (`services/federation.ts:186`) | **keep tombstone, scrub** | At erasure set `name = ''`, `image = null`, `retired_email = null`. Extend `users_deleted_check` to `status = 'disabled' and retired_email is null and image is null and name = ''` | Staff can no longer see which address an erased UUID had. Audit never held it (P06: 0 audit rows carry the email or name) |
| `organizations` | Tombstone; `slug` reserved forever | P03: hard delete refused by `oauth_clients_organization_id…_fk` and `grant_contexts` restrict. Client and resource tombstones and grants need the row. Federation's `organization.deletedAt` branch cannot be reached: a live provider needs a live organisation (`sso_providers_organization_live_fk`) | **keep tombstone** | None. Optional: the admin MCP's `organisations_create` precondition reads the live list (`db/queries/organizations.ts:50`), so a slug held by an erased organisation passes `prepare` and fails `commit` with 409 (source-read, not run) | — |
| `accounts` | Tombstone keeps `issuer`, `account_id` (sub), `directory_user_id` (oid); tokens cleared | P06: re-sign-in refused `user_disabled`; 2 tombstones keep sub and oid. Accounts are only tombstoned by user erasure (`db/queries/users.ts:277`). No FK points at them; sessions and grants hold the UUID only (P03: delete succeeds, no cascade) | **hard delete** | Delete at erasure. Drop `deleted_at`, the trigger and both CHECKs; `live` becomes a generated constant for the live FK to users. Give runtime DELETE | The ban: an erased person whose directory still admits them can sign in again as a new user with a fresh membership. Disable remains the ban. **Owner's call** |
| `members` | Tombstone; set only by user or organisation erasure | P03: hard delete refused by `grant_contexts_member_id_members_id_fk`. Federation's `member.deletedAt` branch (`federation.ts:93`) cannot be reached through the API: erasure deletes the accounts first, and organisation erasure deletes the provider. Rows hold UUIDs only | **keep tombstone** | None | — |
| `groups` | Tombstone; `(organization_id, slug)` reserved | Nothing references a group after deletion. Grants have no group column. `system_bindings_organization_group_fk` (restrict) protects the platform group by itself (P03: refused). No consumer keys on a group slug (grep of `mcps/*`, `packages/*`). The admin MCP checks slugs against the live list (`mcps/admin/src/access.ts:38`) | **hard delete** | Plain cascade FKs already remove assignments and group entitlements (P03); `group.erased` records them first | A group slug can be reused after erasure; group identity is a UUID everywhere |
| `group_members` | Tombstone; partial unique on live | Nothing reads a deleted assignment: the admin API hides them, and `group_member.removed`, `group.erased`, `member.removed` and `user.erased` carry the row (docs/04 "one evidence shape") | **hard delete** | `DELETE … RETURNING` in place of `UPDATE … RETURNING`; plain unique `(group_id, member_id)` | — |
| `entitlements` | Tombstone; partial `NULLS NOT DISTINCT` unique (hand-written in 0001) | As above; `entitlement.removed` carries `before`, `after`, `audience` | **hard delete** | Plain `unique … nullsNotDistinct()` in Drizzle (P07: drizzle-kit emits it); 2 statements leave 0001 | — |
| `organization_domains` | Tombstone; two partial uniques | The adapter hides deleted domains from Better Auth (`auth/database-adapter.ts:38-60`); `domain.deleted` carries the row | **hard delete** | Plain unique `(organization_id, domain)`; the active-domain index keeps `status = 'active'` only | — |
| `sso_providers` | Tombstone; `provider_id` reserved; `oidc_config` cleared by CHECK | The adapter hides deleted providers. Sessions and grants hold the provider UUID and revision without an FK, and the current-authority check is an inner join (`auth/grant-authentication.ts:41-54`), so an absent row denies exactly as a deleted one does. P03: delete succeeds, no cascade | **hard delete** | Delete; the secret goes with the row | A `provider_id` can be reused. Identity is `(issuer, sub)` and admission is domain plus directory, so reuse is not a security boundary |
| `oauth_clients` | Tombstone; `client_id` reserved; secret cleared by CHECK | Downstream state is keyed by the public client ID: Toolbox `host_clients (client_id text primary key)` (`mcps/toolbox/migrations/0001_initial.sql:41`), evidence `client_id` (`packages/mcp-postgres/migrations/0001_evidence.sql:24`), audit `actor_id` for clients (`0001_invariants.sql`, `record_user_oauth_subjects`). P03: `grant_contexts` restrict | **keep tombstone** | None | — |
| `oauth_resources` | Tombstone; `identifier` (the `aud`) reserved | `grant_contexts` and `system_bindings` restrict (P03). Reuse would accept an old resource's unexpired JWTs at a new registration | **keep tombstone** | None | — |
| `oauth_client_resources` | Tombstone; `touch_client_resource_revision` fires on INSERT or UPDATE | The adapter hides deleted links; `client.resource_unlinked` records `relationship {id, deletedAt}` | **hard delete** | Delete. Re-add `AFTER DELETE` to the touch trigger, whose DELETE branch the previous audit removed as dead; it becomes live again | — |
| `oauth_consents` | Tombstone | The adapter hides deleted consents. Only user erasure and `client.grants_erased` delete them; both record them | **hard delete** | Delete | — |
| `organization_capabilities` | Tombstone; partial `NULLS NOT DISTINCT` unique (hand-written) | Bootstrap never reads a removed capability: it provisions only when no binding exists (`bootstrap.ts:84`). `capability.removed` carries the row | **hard delete** | As for entitlements | — |
| `grant_contexts` | Revoke-only; runtime has no DELETE; 5 restrict FKs | D11. Read after revocation by code-replay and refresh-replay handling and by the OAuth audit trigger | **keep** | None | — |

### One row per mechanism

| Item | Today | Evidence | Verdict | Change | Lost or risked |
|---|---|---|---|---|---|
| Live keys (`unique (id, live)` + composite live FKs) | 7 live uniques, 26 live FKs (P01) | P04: +16 to +32 µs per insert, +2.5 to +8 µs per update. P05: no blocking. P03 and P09: both refusals hold | **keep on the five tombstone tables; simplify on hard children** | Hard children carry `live boolean generated always as (true) stored`: no trigger, no CHECK, no writer (P09: refusals hold; P07: drizzle-kit generates it). Drop the 3 live FKs onto `groups` and `groups_id_live_unique`. 23 live FKs remain | — |
| `*_live_check` | 15 (14 plus system_bindings) | Redundant while the trigger runs; catches owner writes with triggers off | **keep on 5** (and system_bindings) | The 9 hard tables need none: a generated column cannot be written | — |
| `*_deleted_check` | 11 | P06: they hold "no credentials" on accounts, clients and providers | **keep on 5, extend users** | 6 go with hard deletes. `users_deleted_check` also requires a cleared profile | — |
| `protect_soft_deletion` trigger | 14 tables | P03: terminal deletion enforced. P05: a generated parent `live` plus any BEFORE UPDATE trigger blocks child inserts for the writer's whole transaction (2,466 ms, 50 of 50) | **keep on 5** | Drop from the 9 hard tables | — |
| Generated `live` on parents | Not used (`columns.ts` comment) | P05 on 17.9: all 50 inserts waited behind a non-key parent update when a BEFORE UPDATE trigger existed; 12 to 15 ms without one. Users, organisations, members, clients and resources all have BEFORE UPDATE triggers | **keep as is (not viable)** | — | — |
| `deleted_at` partial unique indexes | 7 | All 7 belong to tables proposed for hard delete | **simplify** | Plain uniques (domain's active index keeps its status predicate). 2 hand-written NND indexes leave `0001_invariants.sql` | — |
| `users.email` unique | Global unique, normalised | Federation's fail-closed `email_conflict` (`federation.ts:225-238`; 6 of 6 tests pass, P08). Better Auth's link path takes the first email match (`link-account.mjs:62`). An address can only enter through the organisation that owns its domain (active domain unique) | **keep** | — | Cross-tenant collision: see audit B |
| `retired_email` + `users_retired_email_check` | Equivalence: `retired_email is not null` ⇔ email is retired | P06: erasure leaves the original address in `retired_email`. Read only by the platform user API (`http/admin/users.ts:29`); no consumer reads it (grep `mcps`, `packages`) | **simplify** | Check becomes `retired_email is null or (status = 'disabled' and email = id || '@retired.invalid')`. Erasure clears it. "Email retired" is derived from the address in 3 places (`services/users.ts:24,108`, `db/queries/users.ts:59`) | — |
| Organisation erasure leaves people | "preserves global people" (docs/03:75, docs/04) | P06: 6 of 6 people keep profile, live account with encrypted upstream tokens, and session; 0 memberships | **fix** | Erase each person left with no live membership inside the same command, with the same steps as user erasure, and list their UUIDs in the effects | One larger command: about 200 people per organisation in the scale model |
| Audit `ip` and `user_agent` | Kept forever, keyed by actor UUID | P06: the sign-in event keeps both after erasure | **keep; needs a retention period** | No scrub: audit stays immutable. Bound by `Q-EVIDENCE-RETENTION` (audit C) | — |

## 3. Probes

All files are in `$S/probes/a/`. `psql.sh <file.sql>` runs a probe as the owner on `answerable_id` (port 47433 only) and writes `<file>.log`.

1. **01-catalogue-census.sql**, on a fresh `answerable_id` migrated from 9833960 (`DATABASE_MIGRATION_URL=… bun scripts/migrate.ts`).
   - 14 tables with `deleted_at`.
   - 7 live uniques; 7 `deleted_at` partial uniques; 26 live FKs (3 of them from `system_bindings`).
   - 15 live CHECKs; 11 deleted CHECKs; 14 `protect_soft_deletion` triggers.
   - Whole schema: 66 FKs, 75 CHECKs, 36 triggers. The deletion machinery is 39% of the FKs, 35% of the CHECKs and 39% of the triggers.
   - Non-partial uniques that a tombstone keeps reserved: `organizations.slug`, `oauth_clients.client_id`, `oauth_resources.identifier`, `sso_providers.provider_id`, `accounts (issuer, account_id)`, `accounts (issuer, directory_user_id)` (partial on not null only), `groups (organization_id, slug)`, `members (organization_id, user_id)`, `users.email` (freed by retirement).
2. **02-seed.sql**: at least one row in every product table, wired as production wires them: 2 organisations (tenant and a bound platform organisation), 2 users, accounts, domain, provider, 3 members, 2 groups, 2 assignments, 3 resources (shared, bound admin, tenant-owned), client, link, 2 capabilities, 3 entitlements, consent, a federated session, a grant context, refresh and access tokens, an operation and an audit event.
3. **03-hard-delete.sql**: a hard delete as the owner, one rolled-back transaction per case.
   - **users**: Alice is REFUSED by `grant_contexts_user_id_users_id_fk`. Bob cascades accounts, members and his platform-admins assignment.
   - **organizations**: tenant A is REFUSED by the clients' restrict FK. After removing its grants, tokens, entitlements, capabilities, client and private resource, the delete cascades members, groups, assignments, domains, providers, capabilities and consents. The platform organisation is REFUSED by `system_bindings`.
   - **accounts**: deleted, with no cascade.
   - **members**: Alice is REFUSED by `grant_contexts`; Bob in A is deleted; Bob in the platform organisation cascades his assignment.
   - **groups**: `engineers` cascades its assignment and its entitlement; `platform-admins` is REFUSED by `system_bindings`.
   - **Plain deletes, no cascade or refusal**: `group_members`, `entitlements`, `organization_domains`, `sso_providers`, `oauth_client_resources`, `oauth_consents`, `organization_capabilities`.
   - **oauth_clients**: REFUSED by the entitlements' restrict FK. Without grants, entitlements and capabilities, the delete cascades the link, consent and tokens.
   - **oauth_resources**: the Toolbox resource is REFUSED by the link's live FK; the tenant resource by the entitlement FK; the admin resource by `system_bindings`.
   - **grant_contexts**: the owner may delete.
   - **Purge after erasure**: an erasure-shaped soft delete of Alice followed by a hard delete is REFUSED by the grant FK. Physical purge of an erased person is impossible today unless their grant contexts go first.
   - **Guards confirmed**: an un-delete raises `Product deletion is terminal`; a parent with a live child raises the live FK; a live child under a deleted parent raises the live FK; slug reuse raises `organizations_slug_unique`.
4. **04-setup.sql, 04-live-cost.sql, 04-run.sql (log in 04-run.log)**: 2,000 single-row statements per mode, server time in a plpgsql loop, order on/off/off/on after a warm-up, each mode rolled back. "Off" drops the table's live FKs and disables its deletion trigger; for users it drops `users_id_live_unique` with cascade.

   | Table | Insert on (µs/row) | Insert off | Δ | Update on | Update off | Δ |
   |---|---|---|---|---|---|---|
   | members | 144.7 / 121.8 | 106.5 / 105.3 | +27 (+26%) | 83.1 / 88.1 | 79.4 / 81.4 | +5 |
   | group_members | 135.1 / 131.2 | 113.3 / 113.8 | +20 (+17%) | 68.7 / 71.8 | 67.9 / 67.6 | +2.5 |
   | entitlements | 155.2 / 129.8 | 110.3 / 110.0 | +32 (+29%) | 101.2 / 103.3 | 95.4 / 97.5 | +6 |
   | oauth_consents | 76.0 / 75.1 | 59.8 / 59.3 | +16 (+27%) | 52.4 / 55.3 | 47.8 / 49.9 | +5 |
   | users (parent key) | 64.5 / 65.2 | 60.4 / 61.4 | +4 (+7%) | 79.8 / 81.1 | 72.7 / 72.6 | +8 |

   These writes are on the admin path (200 commands a day) and at sign-in (one membership per person per organisation). At the scale model that is under a millisecond a day per tenant.
5. **05-lock-setup.sql and 05-lock.ts (log in 05-lock.log)**. A writer updates a parent row and holds it 2,500 ms. 50 connections then each insert one child checked by a live FK onto that row; `lock_timeout` 5 s; two rounds.

   | Scenario | Inserts p50 / p95 / max (ms), round 1; round 2 |
   |---|---|
   | `users.name` (today) ← 50 member inserts | 29.9 / 31.1 / 32.0; 22.2 / 25.0 / 25.3 |
   | `organizations.name` (3 BEFORE UPDATE triggers) ← 50 member inserts | 21.5 / 22.2 / 22.4; 20.3 / 21.4 / 21.7 |
   | Control: `users.email` (a key column) | 2,463 / 2,465 / 2,465; 2,458 / 2,459 / 2,459 |
   | Standalone plain `live` + assigning trigger | 11.8 / 12.3 / 12.5; 23.1 / 23.4 / 23.5 |
   | Standalone **generated** `live` + BEFORE UPDATE trigger | 2,466 / 2,468 / 2,468; 2,468 / 2,469 / 2,469 |
   | Standalone generated `live`, no BEFORE UPDATE trigger | 14.4 / 15.0 / 15.3; 12.1 / 13.0 / 13.1 |

   All 50 inserts succeeded in every scenario. The previous audit's finding holds on 17.9. A BEFORE trigger that assigns `NEW.live` on a generated column is silently ignored (05-lock-setup.log).
6. **06-erasure.integration.test.ts (log in 06-erasure.log)**. The admin fixture runs on a restricted runtime role. The person (`tenantReader`) has a second membership, an assignment, an entitlement, refresh and access tokens, a consent and 2 grant contexts. The session and the sign-in audit row were given production-shaped IP and user agent (the fixture has no client address; `auth/sso-origin.ts:136` copies `session.ipAddress` into audit). A census then scans every column of every table for the person's needles.
   - **After `DELETE /users/:id`**:
     - `users.name` and `users.retired_email` (the original address) remain; the email column holds the retired address.
     - 2 accounts keep `account_id` (sub) and `directory_user_id` (oid).
     - `audit_events.ip` and `user_agent`: 1 row.
     - Rows keyed by the person's UUID: audit 2, `audit_event_users` 2, grants 2, member tombstones 2, account tombstones 2, consent tombstone 1, `admin_operations.result_reference` 1.
     - Sessions, refresh tokens and access tokens: 0.
     - The `user.erased` payload is 4,323 B and carries UUIDs only. No audit row holds the email or the name.
     - The same `(issuer, sub)` signing in again is redirected with `error=user_disabled`.
   - **After `DELETE /organizations/:id`**: the organisation row keeps `name` and `slug`; the domain row keeps `domain`; the provider keeps `issuer`, `provider_id` and `domain` (`oidc_config` cleared). All 6 people keep `email`, `name` and their status (5 active, 1 disabled), plus 1 live account with stored upstream tokens (6 of 6), 1 browser session (6 of 6) and 0 live memberships.
   - A third test, an IdP replacement under one domain, could not run: the fixture fixes `trustedOrigins` before a second issuer exists (06c-idp-switch.log, `discovery_private_host`). It was removed from the spike; probe 08 covers the mechanism.
7. **07-nnd/ (schema.ts, drizzle.config.ts; output in 07-nnd.log, applied in 07-nnd-apply.sql/.log)**. drizzle-kit 0.31.10 emits `UNIQUE NULLS NOT DISTINCT` for `unique().nullsNotDistinct()`, and a composite FK from a child's `generatedAlwaysAs(sql\`true\`)` column onto a parent's `(id, live)`. PostgreSQL 17.9 accepts the output verbatim and the NND constraint refuses a duplicate null-target row.
8. **08-email-tests.log**. The existing federation tests for recycled email, the email-linking refusal, a directory identity under another subject and a disabled user bound to the exact account: 6 pass, 0 fail on 47433. They show that an active or inert holder of an address gets `email_conflict` and that a disabled holder has the address retired and a new user created. An organisation that replaces its IdP issuer under the same domain reaches the same branch, because a new issuer finds no exact account and no holder. That consequence is read from the source, not run.
9. **09-generated-child-live.sql**. A tombstoned parent (plain `live` plus trigger) and a hard child whose `live` is `generated always as (true) stored`:
   - tombstoning the parent with a live child is refused;
   - deleting the child and then tombstoning the parent succeeds;
   - a new child under the tombstoned parent is refused;
   - a writer cannot set the column (`cannot insert a non-DEFAULT value`);
   - an owner hard delete of the parent cascades the child.

## 4. Considered and kept

- **Terminal deletion on the five tombstone tables.** `protect_soft_deletion` is one function. It costs a few µs per write (included in P04's deltas) and stops a code path from resurrecting a deleted user, organisation, member, client or resource. Status and CHECKs cannot express "once set, never cleared".
- **The plain (not generated) `live` column on parents.** P05 repeats the previous audit's finding on PostgreSQL 17.9. Every tombstone parent carries BEFORE UPDATE triggers: revision guards, identity guards and the deletion guard.
- **`grant_contexts` restrict FKs (D11).** They are why users, organisations, members, clients and resources must stay as rows. The rows are UUIDs, statuses and timestamps, which is defensible history.
- **Replay against a deleted target.** `services/operations.ts:85-104` returns the stored receipt (`operationId`, `outcome`, `statusCode`, `resultReference`) without reading the target, so neither tombstones nor hard deletes affect replay.
- **Audit history of an erased user or organisation.** `services/audit.ts:48,66` answers from `audit_events` when the row is gone, not from the tombstone.
- **The Toolbox poller.** It reads `action`, `organizationId` and `targetId` only (`mcps/toolbox/src/poller.ts:29-31`). Event names stay the same under every design.
- **The admin MCP.** It reads lists and access views and maps 404 to absent (`calls.ts:29`, `roles.ts:32`). It has no erase tool.
- **The acceptance.** No journey calls an erase endpoint (grep of `packages/acceptance/src`).
- **Runtime DELETE on the nine tables.** It grants no new authority. Runtime already holds UPDATE on them, which can set `deleted_at`. RLS `for all` policies on the RLS tables apply to DELETE with the same USING clause. The broker tables (accounts, consents, links) have no RLS today for UPDATE either.
- **Cost at scale.** Tombstones accumulate at most at the admin command rate (200 a day, about 73,000 rows a year). Neither cost nor growth is a reason to change. The reasons are complexity and personal data.
- **`users.email` uniqueness.** It is Better Auth core's contract and the fail-closed branch in federation. Removing it would turn an IdP migration from a refusal into silently duplicated people.

## 5. Open questions

1. **Erasure versus ban (owner's call).** Should an erased person whose directory still admits them be able to return as a new user? Recommended: yes. Erasure forgets and disable keeps out. That is how directories themselves behave, and it lets the account tombstone, with its sub and oid, go. If the owner wants a permanent ban, keep the account tombstone and state in docs/04 that the IdP subject and object id are retained as a suppression record.
2. **Audit IP and user agent retention.** Erasure cannot clear them without breaking audit immutability. `Q-EVIDENCE-RETENTION` must give the period. Audit C measures growth.
3. **Organisation erasure of orphaned people: in ID or in a runbook?** Doing it in ID is the only version a constraint or a test can hold. A runbook ("erase each user first") is caller discipline. The cost of 200 user erasures in one transaction was not measured: not verified.
4. **The IdP-replacement journey.** It was not run, because the admin fixture fixes `trustedOrigins` at creation. A fixture override that appends origins would let probe 06c run. It matters to whoever owns IdP migration, since with email uniqueness every existing person meets `email_conflict` until disabled or linked.
5. **Slug reservation for organisations.** Kept, but the admin MCP's slug precondition reads only live organisations. Either the precondition should see tombstones, or slugs should become unique among live rows only. Not run; source-read.

## 6. Blast radius

### Design (ii′): hard delete for nine tables

- **Tables:** accounts, groups, group_members, entitlements, organization_domains, sso_providers, oauth_client_resources, oauth_consents, organization_capabilities.
- **Schema objects removed or changed:**
  - 9 `deleted_at` columns.
  - 9 `live` columns change from plain plus trigger to generated constant.
  - 9 live CHECKs and 6 deleted CHECKs.
  - 9 deletion triggers.
  - 3 live FKs (onto `groups`) and `groups_id_live_unique`.
  - 7 partial uniques become plain.
  - 4 statements leave `0001_invariants.sql` (the NND drop and recreate).
  - `touch_client_resource_revision` gains an AFTER DELETE branch.
  - `protect_session_authentication_origin` loses 2 `deleted_at` predicates (accounts, providers).
- **Code:**
  - 61 `isNull(X.deletedAt)` filters (accounts 6, groups 6, groupMembers 8, entitlements 9, organizationDomains 7, ssoProviders 12, oauthClientResources 7, oauthConsents 1, organizationCapabilities 5) across 20 non-test files.
  - Of 22 soft-delete `UPDATE … set deletedAt` statements, those for the nine tables become `DELETE … RETURNING`.
  - The adapter's `visible()` list shrinks from 6 models to 2 (`auth/database-adapter.ts:38-60`).
  - `runtime-role.ts` `productTables` shrinks from 15 to 6.
  - `services/federation.ts`: the `exactAccount.deletedAt` and holder semantics change (accounts are absent, not deleted).
- **Audit payloads:**
  - `deletionMode: "soft"` becomes `"hard"` for the nine (13 non-test refs to `deletionMode`).
  - `softDeleted*` keys for the nine are renamed (37 of the 41 non-test `softDeleted*` identifiers; the 4 `softDeletedMembers` stay).
  - `capture_audit_subjects` manifest paths `{effects,softDeletedConsents}` (×2) and `{effects,softDeletedAssignments}` are renamed.
- **Tests:**
  - 31 test files mention `deletedAt` or `deleted_at` (94 lines).
  - `http/admin/soft-deletion.integration.test.ts` (619 lines) and `__tests__/soft-deletion.ts` (34 lines, imported by 4 files).
  - `user-erasure-audit` and `organization-erasure-audit` expectations change.
  - The catalogue-equivalence test follows automatically.
- **Docs:**
  - docs/04 (sentences listed below).
  - docs/03 lines 53, 73 and 75.
  - docs/05 lines 27, 37, 72, 74 and 100.
  - docs/02 "terminal `deletedAt` … accepted decisions" and "physical product purge … deferred".
  - `apps/web/content/docs/id/manage.mdx`: about 10 paragraphs (lines 241, 243, 256, 258, 264, 402, 404, 430).
  - `onboard.mdx` lines 356, 432, 434, 436.
  - `reports/id-soft-deletion.md`: supersession note.
- **Consumers:** Toolbox none (event names unchanged); admin MCP none; acceptance none.

### Erasure scrub (users) and account hard delete

- **Schema:** `users_deleted_check` and `users_retired_email_check` change.
- **Code:** `db/queries/users.ts` `deleteUser` (one UPDATE gains 3 columns; the accounts UPDATE becomes a DELETE); 3 derivations of "email retired"; `services/federation.ts:229` (the `emailUser?.deletedAt` branch cannot be reached through the API, because erasure retires the address first).
- **Tests:** `user-erasure-audit.integration.test.ts` (asserts the name is retained), `users.integration.test.ts`, `federation.integration.test.ts` (tombstone rejection tests).
- **Docs:** docs/04 Soft deletion paragraph; docs/03:75; manage.mdx:258; onboard.mdx:432, 436.

### Organisation erasure of orphaned people

- **Code:** `services/organizations.ts` `eraseOrganization`, reusing the user-erasure query.
- **Audit:** `organization.erased` gains an effects list of erased users, and the trigger manifest gains one path.
- **Tests:** `organization-erasure-audit.integration.test.ts`.
- **Docs:** docs/03:75 and docs/04 "Organisation command receipts".

### docs/04 sentences that change under the recommendation

1. "**Live foreign keys hold soft deletion.** Each soft-deletable table has a `live` column … Every deletion path soft-deletes children first." Becomes: five tables keep tombstones; their children carry a generated constant `live` and are deleted, not tombstoned, before the parent.
2. "**A deleted row holds no authority.** Per-table CHECKs require a disabled or revoked status, and no client secret, account tokens, password or OIDC configuration." Becomes: … and a deleted user holds no name, image or retired address. Account and provider rows are deleted.
3. "Tombstone rows keep unique public identifiers reserved after product deletion." Name them: organisation slug, client ID, resource identifier.
4. "Fourteen product tables carry `deletedAt`: users, organisations, accounts, members, groups, assignments, entitlements, domains, SSO providers, clients, resources, client-resource links, consents and capabilities." Becomes "Five: users, organisations, memberships, clients and resources."
5. "User deletion retires email and retains profile/bindings." and "This retains identifying data and is not anonymisation." Replace with what remains: UUIDs, statuses, timestamps, and audit IP and user agent for the retention period.
6. "Links have immutable UUIDs and terminal tombstones. Relinking creates a new relationship." Becomes "Unlinking deletes the link; relinking creates a new relationship."
7. "Removal revokes the membership and matching grants, soft-deletes direct assignments …" Becomes "deletes direct assignments".
8. "Deletion retains tenant children as tombstones and preserves global people." Becomes: deletes tenant configuration, keeps membership tombstones, and erases people left with no membership.
9. "Soft-deleted entitlements, group assignments and memberships have one evidence shape …" and the audit table rows with `deletionMode: "soft"`.
10. "Runtime cannot DELETE/TRUNCATE product rows or grant contexts" Becomes "… tombstoned product rows (users, organisations, memberships, clients, resources) or grant contexts".
11. "Physical product purge jobs and their duration remain deferred." This stands for the five tombstone tables, with the retention question named.
