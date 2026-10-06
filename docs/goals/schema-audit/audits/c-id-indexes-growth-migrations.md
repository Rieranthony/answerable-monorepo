# Audit C: Answerable ID indexes, table growth, and the migration file and tooling

## Summary

- **Scope.** The 52 named indexes and 45 foreign keys of `apps/id/drizzle/0000_initial.sql`, the queries that use them (suite statements, query modules, installed Better Auth 1.7.2), the growth of protocol and audit tables, and the migration file and tooling.
- **Indexes.** One index to delete: `audit_event_subjects_tenant_entity_idx`. No app query reads subjects by organisation, and the index is 27% of that table's size. Four `expires_at` indexes (sessions, access tokens, refresh tokens, client assertions) serve no query today; keep them only if the sweep below is adopted. The three `invitations` indexes go if Audit A deletes the table. All other indexes have a query (cited). No index is missing.
- **oauth_access_tokens.** The provider writes a row only for opaque (login-only) tokens; resource tokens are JWTs and write no row (`introspect-C6P1zrTr.mjs:1800,1852`). The five FK-column indexes cost about 67 µs per insert (408 vs 341 µs), which is within round-to-round noise. Keep them.
- **Growth.**
  - Better Auth already sweeps `verifications`.
  - Nothing sweeps `oauth_refresh_tokens`, `oauth_access_tokens`, `oauth_client_assertions` or abandoned `sessions`. Refresh rows grow by one per refresh. Revoking one client's tokens took 201 ms with 200,000 rows in the history, and that cost grows with the history. **Add one sweep.**
  - Each user token refresh writes about 9.9 KB: 1 audit event, 14.95 subject rows (73% of the bytes) and 1 refresh row.
- **Migration file.** It does not drift. Postgres' own catalogue shows the committed SQL equals what drizzle-kit generates from the schema modules, plus exactly 23 functions (with their grants), 57 triggers, one deferrable FK and two `NULLS NOT DISTINCT` indexes. drizzle-orm 0.45.2 cannot express those last three. The catalogue pins everything except those two indexes.
- **Tooling.**
  - Drizzle's migrator runs all pending migrations in one transaction, takes no lock and never compares the stored hash. That is why three of the four checks in `test-migrations.ts` only re-check Postgres and Drizzle.
  - Reset into `0000_initial.sql` (generated) plus `0001_invariants.sql` (`drizzle-kit generate --custom`).
  - Replace the hash catalogue with a catalogue-equivalence test (probe 03).

## Method

- **Read.** `AGENTS.md`, `docs/00`, `docs/02` (Do not re-propose), `docs/04`, `docs/goals/schema-audit/findings.md`, `0000_initial.sql`, the snapshot and journal, `drizzle.config.ts`, `src/db/{client,migrate,runtime-role,migrations.test}.ts`, `scripts/{migrate,reset-test-schema,test-migrations}.ts`, `src/__tests__/migration-{catalog.ts,catalog.json,worker.ts}`, `src/db/queries/*.ts`, `src/auth/*.ts` (provider configuration, token boundary, audit), `.github/workflows/ci.yml`. Installed sources (Bun store):
  - `drizzle-orm@0.45.2+d634bff2d9775a6d`: `pg-core/{dialect,indexes,unique-constraint,foreign-keys}.js`, `migrator.js`
  - `drizzle-kit@0.31.10`: `api.mjs`, the CLI
  - `better-auth@1.7.2+09d47d6a05cf7b6a`: `db/internal-adapter.mjs`, `api/routes/session.mjs`, `context/create-context.mjs`, `state.mjs`
  - `@better-auth/oauth-provider@1.7.2+9e1acf4dca199f54`: `introspect-C6P1zrTr.mjs`, `authorize-BmTe2VYG.mjs`
- **Ran.** Everything ran on container `audit-pg-c`, port 47435. Probes and outputs are in `scratchpad/probes/c/`.
  - Set `pg_stat_statements` (in database `postgres`, so a schema drop cannot remove it, `track=all`, `max=20000`).
  - Migrated `answerable_id_test` and ran `pg_stat_reset()`.
  - Ran the full ID suite once, without the root `.env` (01).
  - Read `pg_stat_user_*` (05) and `pg_stat_statements` (06, 07) before anything else touched the database.
- **Run conditions.**
  - Four auditors' suites ran at once. Load average was 106 to 150, so all timings carry that noise.
  - At 13:47 the shared Docker disk filled up ("No space left on device"). My Postgres crashed and restarted, which reset `pg_stat_*` and `pg_stat_statements`. Probes 05 to 07 had been saved before the crash.
  - I then dropped my scratch databases and set `max_wal_size=96MB`. The disk had 584 MB free when I finished. The later probes are smaller and use UNLOGGED tables.

## Findings

### Indexes (52 named in the SQL; the 41 PK and unique-constraint indexes are all keep)

`scans` is `idx_scan` over the whole suite (05). Suite tables are tiny, so the planner often picks seq scans there. A low number does not mean an index is unused; verdicts rest on query shapes and the probe-11 plans.

| # | Index (columns) | Used by | scans | Verdict | Why |
|---|---|---|---|---|---|
| 1 | accounts_issuer_directory_user_id_idx (issuer, directory_user_id) unique partial | directory-binding uniqueness and lookup | 3,173 | keep | constraint |
| 2 | accounts_user_id_idx | Better Auth `findAccounts` (internal-adapter.mjs:645), user erasure | 7,648 | keep | hot read |
| 3 | invitations_organization_id_idx | queries/organizations.ts:347-352 | 25 | keep while the table exists | Audit A decides `invitations` |
| 4 | invitations_inviter_id_idx | no app query; FK cascade from `users` never fires at runtime | 38 | delete (or with the table) | which statement scanned it in the suite: not verified |
| 5 | invitations_email_idx | Better Auth organisation adapter, invitations by email | 3,169 (0 tuples) | keep while the table exists | Audit A |
| 6 | members_user_id_idx | the policy-user subquery of every tenant RLS policy (0000_initial.sql:566-597), membership lists | 30,915 | keep | hot |
| 7 | sessions_user_id_idx | internal-adapter.mjs:205,504; queries/sessions.ts:16,56; users.ts:460 | 15,798 | keep | |
| 8 | sessions_active_organization_id_idx | queries/organizations.ts:365-366 (clear selections on organisation deletion) | 25 | keep | rare path; cost too small to measure |
| 9 | sessions_expires_at_idx | no query filters on `expires_at` alone; the 7,876 scans are tiny-table plan choices for `id = $1 and expires_at > now()` | 7,876 | keep only with the sweep | it is the sweep's index; it also makes the daily session-expiry update non-HOT |
| 10 | verifications_identifier_idx | find and consume by identifier (internal-adapter.mjs:740-750, 818-850) | 10,305 | keep | |
| 11 | verifications_expires_at_idx | Better Auth's own sweep `delete … where expires_at < $1` on every `findVerificationValue` (internal-adapter.mjs:756-760; 3,282 calls in the suite) | 0 | keep | serves an existing sweep (0 scans only because the table is tiny) |
| 12 | oauth_access_tokens_client_id_idx | oauth-clients.ts:297-311, oauth-tokens.ts:33-38 | 44 | keep | |
| 13 | oauth_access_tokens_session_id_idx | session revocation; FK `set null` when the runtime deletes a session (live) | 123 | keep | |
| 14 | oauth_access_tokens_user_id_idx | users.ts:271-276, oauth-tokens.ts | 97 | keep | |
| 15 | oauth_access_tokens_authorization_code_id_idx | provider code-replay cleanup (introspect:1528-1543), native-code-replay.ts:35 | 10 | keep | |
| 16 | oauth_access_tokens_refresh_id_idx | provider family invalidation (introspect:1500-1508); FK cascade on refresh delete (live) | 43 | keep | |
| 17 | oauth_client_assertions_expires_at_idx | no query | 0 | keep only with the sweep | |
| 18 | oauth_client_resources_client_id_resource_id_unique (partial) | link uniqueness and lookup | 2,450 | keep | |
| 19 | oauth_client_resources_resource_id_idx | oauth-resources.ts:202,219; create-resource-grant.ts:133 | 56 | keep | |
| 20 | oauth_clients_user_id_idx | users.ts:237,259,439; grant-contexts.ts:72 | 128 | keep | dozens of rows; cost negligible |
| 21 | oauth_clients_organization_id_idx | oauth-clients.ts:83; organizations.ts:192 | 503 | keep | the `(organization_id, deleted_at)` shape is irrelevant at dozens of rows |
| 22 | oauth_consents_client_id_idx | oauth-clients.ts:341 | 22 | keep | |
| 23 | oauth_consents_user_id_idx | provider consent lookup; users.ts:310 | 465 | keep | |
| 24 | oauth_refresh_tokens_client_id_idx | oauth-tokens.ts:20-31; oauth-clients.ts:291-330 | 78 | keep | |
| 25 | oauth_refresh_tokens_session_id_idx | session revocation; FK `set null` (live) | 123 | keep | |
| 26 | oauth_refresh_tokens_user_id_idx | provider `invalidateRefreshFamily` (client_id, user_id): probe 14C used it, 0.107 ms | 87 | keep | |
| 27 | oauth_refresh_tokens_authorization_code_id_idx | provider code-replay cleanup | 9 | keep | |
| 28 | oauth_resources_organization_id_idx | oauth-resources.ts:103; member-permission.ts:67 | 23 | keep | negligible |
| 29 | entitlements_principal_target_unique (org, member, group, client, resource) NULLS NOT DISTINCT, partial | uniqueness; principal lookups | 5,924 | keep | |
| 30 | entitlements_client_id_idx | access.ts:193-194; client reference checks | 41 | keep | |
| 31 | entitlements_resource_idx | access.ts:196; resource deletion checks | 323 | keep | |
| 32 | group_members_live_assignment_unique (group, member) partial | uniqueness and lookup | 6,343 | keep | |
| 33 | group_members_member_id_idx | groups.ts:60,295 | 3,846 | keep | |
| 34 | groups_organization_id_external_id_idx unique partial | uniqueness of `external_id`, written by the admin API (http/admin/groups.ts:75-80) | 0 | keep | constraint |
| 35 | organization_domains_organization_id_domain_unique | uniqueness | 3,362 | keep | |
| 36 | organization_domains_active_domain_idx | global active-domain uniqueness; login routing | 10 | keep | |
| 37 | sso_providers_organization_id_unique | one live provider per organisation | 7,983 | keep | |
| 38 | audit_event_subjects_entity_idx (type, id, event) | `listUserAuditEvents` (audit.ts:183-193) | 80 | keep | probe 11: 0.61 ms with it, 45.6 ms without, at 400,000 subjects |
| 39 | audit_event_subjects_tenant_entity_idx (org, type, id, event) | **no query**: the only read of subjects is audit.ts:186-191, platform scope, no organisation filter | 4 | **delete** | 49 MB of the table's 184 MB at 400,000 rows (27%); 1,914 B per token refresh |
| 40 | audit_events_organization_id_id_idx | tenant history (`id < cursor order by id desc`) | 36 | keep | probe 11 #3: 0.84 ms |
| 41 | audit_events_operation_id_idx | audit.ts:127-129; deferred FK | 188 | keep | |
| 42 | audit_events_actor_id_idx | audit.ts:133-135 | 2 | keep | probe 11 #4: 1.9 ms |
| 43 | audit_events_target_type_target_id_idx | audit.ts:142-147 | 5 | keep | probe 11 #7: 1.1 ms |
| 44 | organization_capabilities_target_kind_unique NULLS NOT DISTINCT, partial | uniqueness | 5,208 | keep | |
| 45 | grant_contexts_member_id_idx | grant-contexts.ts:15-31 | 12 | keep | |
| 46 | grant_contexts_user_id_idx | grant-contexts.ts:33-48,98-118; RLS policy-user | 96 | keep | |
| 47 | grant_contexts_client_instance_id_idx | grant-contexts.ts:140-160; RLS grant-client | 51 | keep | |
| 48 | grant_contexts_resource_instance_id_idx | grant-contexts.ts:120-138 | 29 | keep | |
| 49 | oauth_access_tokens_expires_at_idx | no query | 0 | keep only with the sweep | |
| 50 | oauth_refresh_tokens_expires_at_idx | no query | 0 | keep only with the sweep | |
| 51 | audit_events_action_occurred_at_idx | audit.ts:139-141 (+ from/to) | 283 | keep | probe 11 #6/#8: used for rare actions |
| 52 | grant_contexts_organization_id_idx | grant-contexts.ts:80-96; tenant RLS | 175 | keep | |
| – | members_/groups_organization_id_id_unique | targets of the composite FKs (entitlements, group_members, system_bindings) | 9,905 / 1,690 | keep | required as FK targets; the scans are RI checks |

**Missing indexes: none to add.**

| Shape | Evidence | Verdict |
|---|---|---|
| `sso_providers.domain` | `where domain = $1 and deleted_at is null` (12 calls); at most one live row per organisation, so at most ~75 rows | no index; a seq scan of ≤75 rows is optimal |
| `grant_contexts (user_id, revoked_at)`, `members (user_id, status, deleted_at)` | leading-column indexes exist; a user has at most tens of rows each | none |
| Toolbox poller `/audit-events?limit=200&cursor=` (mcps/toolbox/src/poller.ts:31) | PK backward scan: 0.145 ms first page, 0.452 ms by cursor (probe 11 #1-#2) | none |
| Better Auth `sessions where token =`, `verifications where identifier = … order by created_at desc limit 1`, `oauth_clients where client_id =` | unique / identifier indexes (2,096 / 10,305 / 13,637 scans); the ORDER BY sorts the few rows of one identifier | none |
| `oauth_refresh_tokens where client_id = $1 and revoked is null` (revocation) | seq scan of the client's whole history: 201 ms at 200,000 rows (probe 14A) | none; the sweep bounds the rows |

### oauth_access_tokens

| Object | Today | Evidence | Verdict | Why |
|---|---|---|---|---|
| Row per issued access token | Rows are written only by `createOpaqueAccessToken`. A JWT is issued whenever there is an audience (`isJwtAccessToken = audienceClaim && !disableJwtPlugin`) and writes no row. ID documents "Login-only access tokens are opaque; resource access tokens are JWTs" (http/auth-allowlist.ts:114). | introspect-C6P1zrTr.mjs:1349-1373, 1457-1481, 1800, 1852-1864 | keep | Only login-only flows insert rows. The MCP, Toolbox and machine (client_credentials, which requires a resource) paths insert none. |
| 5 FK-column indexes | 7 secondary indexes per insert | probe 04 (median server time per insert, 100,000 rows): all indexes 408 µs; without the 5 FK-column indexes 341 µs; PK + token only 355 µs; also without the parent-guard trigger 119 µs | keep | The index cost is within round-to-round spread (312-441 µs). The trigger is ~236 µs of the ~355 µs (Audit B's). Each index serves a deletion query (rows 12-16). |

### Growth and sweeps

| Table | Written by | Deleted by | Rows per event (measured) | Verdict |
|---|---|---|---|---|
| verifications | OAuth state, codes, DPoP and SAML reservations | Better Auth itself: `delete where expires_at < now()` on every `findVerificationValue`, which every upstream sign-in callback calls (state.mjs:120; internal-adapter.mjs:756-760); consume deletes. Suite: 3,282 sweeps for 3,659 inserts. | 2 per code flow | nothing to add |
| oauth_refresh_tokens | 1 insert per refresh, plus 1 update of the rotated row (introspect:1565-1600); never deleted on expiry | revocation, family invalidation, erasure, client deletion only | 1 per refresh; 556 B incl. indexes (probe 14) | **sweep**: `delete where expires_at < now()`, batched. Keep rotated rows until expiry so the provider's reuse detection still works. Revocation cost grows with the unswept history: 201 ms at 200,000 rows, seq scan (probe 14A). |
| oauth_access_tokens | login-only opaque tokens; TTL 3,600 s default (introspect:1351,1459) | revocation, code replay, erasure, cascade from refresh | 1 per login-only issuance | sweep (same job); low rate |
| oauth_client_assertions | 1 per `private_key_jwt` authentication; assertion lifetime ≤300 s (authorize-BmTe2VYG.mjs:1406,1431-1437) | nothing (provider only creates and finds) | 0 today: the first servers use `client_secret_basic` (packages/id-admin/src/index.ts:84) | sweep (same job); one statement |
| sessions | 1 per browser sign-in; 7-day expiry, extended daily on use (create-context.mjs:146-147) | sign-out, revocation, or presenting an expired cookie (api/routes/session.mjs:148-155) | abandoned sessions remain | sweep (same job). Grants keep their provenance in `authentication` JSONB; tokens get `set null`. |
| grant_contexts | 1 per member selection (user-oauth-flow.ts:209-219), 30-day life (`refreshTokenExpiresIn`, :218) | never (retained by design, docs/04 Soft deletion) | 1 per authorisation; 822 B tuple | nothing; revisit with the purge design |
| audit_events | every command and every token issuance | never (by design) | per refresh: 1 event, 1,820 B tuple + 292 B indexes | nothing; partitioning would not help because nothing is ever dropped |
| audit_event_subjects | audit triggers | never (by design) | 14.95 per refresh, 13.76 per code exchange, 3 per sign-in; 123 B heap + 359 B indexes each | delete the tenant index (−1,914 B per refresh); see the question on subjects per refresh |
| admin_operations | 1 per admin mutation | never (by design) | 673 B incl. indexes | nothing |

**Where the sweep would run.** Inside ID, on a timer, as the runtime role. That role may already DELETE these four tables: runtime-role.ts:49-53 revokes DELETE only from product and audit tables. Short batched transactions, each using its `expires_at` index. Expiry is not a product deletion, so it is not audited ("protocol consumption/expiry is separate", docs/04).

### Foreign keys (45; probe 13)

| Group | FKs | ON DELETE | Live at runtime? | Verdict |
|---|---|---|---|---|
| cascade from product tables | 29 | cascade | No: the runtime role has no DELETE on users, organizations, members, groups, oauth_clients, oauth_resources or audit_events (runtime-role.ts:49-58). They fire only for the owner. | keep. Exception, see question 4: the five on `grant_contexts` contradict "grant contexts retain revocation". |
| oauth_access_tokens.refresh_id → oauth_refresh_tokens | 1 | cascade | yes (the provider and the app delete refresh rows) | keep; indexed |
| tokens.session_id → sessions | 2 | set null | yes | keep; indexed |
| sessions.active_organization_id, sso_providers.user_id | 2 | set null | no | keep |
| restrict | 11 | restrict | no (all parents undeletable at runtime); `audit_events.operation_id` is DEFERRABLE INITIALLY DEFERRED | keep. On every guarded insert, the FK's FOR KEY SHARE and the parent-guard trigger's FOR SHARE both look up the same parent (suite: organizations 16,242 vs 17,539 lookups); Audit B's |
| missing: `sessions.authentication_{organization,provider,account}_id` | 0 | — | — | keep without an FK: validated on write by `sessions_authentication_origin_guard` (0000_initial.sql:1084-1113, 1344), and the parents are only ever tombstoned |
| missing: `grant_contexts.authentication_session_id` | 0 | — | — | keep without: the grant outlives the browser session (docs/04) |
| missing: `*.authorization_code_id` | 0 | — | — | none possible: they point at verification identifiers, which are deleted on consume |

### Migration file and tooling

| # | Object | Today | Evidence | Verdict | Why |
|---|---|---|---|---|---|
| M1 | 0000_initial.sql vs schema modules | hand-assembled | probe 03: the committed SQL and `generateMigration(empty, schema)` (158 statements) were each applied to an empty database and compared through Postgres' own catalogue (720 vs 617 lines). Only in the SQL: 23 functions (+23 function ACLs), 57 triggers, the deferrable FK, NULLS NOT DISTINCT on 2 indexes. Tables, columns, defaults, checks, uniques, FK actions, indexes, policies, RLS flags and table ACLs are identical. | keep (no drift) | assembly is faithful |
| M2 | snapshot vs schema | `migrations.test.ts` | probe 02: 0 statements | keep | — |
| M3 | `drizzle-kit pull` as a drift tool | — | probe 02: 244 statements each way, all representation noise | do not use | catalogue comparison (probe 03) is the reliable check |
| M4 | NULLS NOT DISTINCT partial unique indexes | hand-edited | drizzle-orm 0.45.2 `pg-core/indexes.js`: IndexBuilder has only `concurrently`, `with`, `where`; `unique-constraint.js:18-20` has `nullsNotDistinct()` for UNIQUE constraints, which cannot be partial | keep hand-written | cannot be generated; the SQL comment is correct |
| M5 | Deferrable FK | hand-written ALTER | `pg-core/foreign-keys.js`: only `onUpdate`/`onDelete` | keep hand-written | cannot be generated |
| M6 | migration-catalog.json pins | functions (definition hash, SECURITY DEFINER, settings, PUBLIC EXECUTE, which covers the REVOKE at line 1415), triggers, policies, RLS, deferrability of all 45 FKs | catalog keys: functions 23, triggers 57, policies 24, rls 26, deferred 45 | simplify (M10) | does not pin the 2 NULLS NOT DISTINCT indexes. A behaviour test covers entitlements (soft-deletion.integration.test.ts:477-489); capabilities' null client is not covered (capabilities.integration.test.ts:64-68 uses non-null targets) |
| M7 | drizzle-orm migrator | `migrate()` | dialect.js:54-55 creates the schema and receipt table outside the transaction; :60-71 runs **all pending migrations in one transaction**; :62 skips by `created_at < folderMillis`; the hash is stored but never compared; no lock | keep | a regenerated 0000 with a newer `when` re-runs on an existing database and fails; an edited applied file is silently ignored |
| M8 | test-migrations.ts (+ migration-worker.ts) | CI step: final-statement failure, SIGKILL before commit, SIGKILL after commit, concurrent bootstrap, repeat migration, catalogue | probe 15: passes in 14.06 s | simplify | the three failure/SIGKILL cases prove Postgres' transactional DDL and Drizzle's single transaction (M7). Keep: fresh install = catalogue (M10), re-run is a no-op. Move concurrent bootstrap (an app property, tested only here) into `bootstrap.integration.test.ts`. Delete `migration-worker.ts` |
| M9 | Migration connection | `scripts/migrate.ts:18` bare Pool, no timeouts | — | add `lock_timeout` (seconds) | not needed for the install; for any later migration on a live database, DDL should fail fast rather than queue behind live transactions and block the hot path behind it |
| M10 | Reset the migration | one hand-assembled file | — | simplify | see below |

**What the reset should produce.**

1. Generate `drizzle/` from the cleaned schema with `drizzle-kit generate --name initial`. That writes `0000_initial.sql`, the snapshot and the journal; the SQL is untouched Drizzle output.
2. Create `0001_invariants.sql` with `drizzle-kit generate --custom --name invariants`. It holds, in this order:
   - the deferrable-FK ALTER;
   - drop and re-create of the two NULLS NOT DISTINCT indexes (empty tables at install);
   - the functions;
   - the triggers;
   - the REVOKE.

   Both files apply in the migrator's single transaction (M7), so atomicity is unchanged. `migrations.test.ts` keeps working, because a custom entry's snapshot equals the previous one.
3. Replace `migration-catalog.{ts,json}` (1,191 lines) with probe 03's test:
   - apply `drizzle/` to one empty database;
   - apply `generateMigration(empty, schema)` + `0001_invariants.sql` to another;
   - compare the two catalogues, including `pg_get_indexdef` and function ACLs.

   The generated part is then proven equal to the schema, and the invariants file is reviewed as code. Keep a behaviour test for the capability null-client uniqueness.
4. Shrink `test-migrations.ts` as in M8.
5. Drop and recreate every existing ID database (the owner's on 47432, any CI cache): the migrator compares timestamps only (M7).

### Timeouts and pool

| Setting | Value (client.ts:25-34; env.ts:231-233) | Verdict | Why |
|---|---|---|---|
| statement_timeout | 10 s | keep | Per probe 14 the largest statements are revocations over token history (201 ms at 200,000 rows); the sweep keeps them well under. |
| lock_timeout | 2 s | keep | Issuance `FOR SHARE` locks conflict only with UPDATE or DELETE of the same parent rows (admin commands). A wait over 2 s becomes 503 with Retry-After (auth-allowlist.ts:114). |
| idle_in_transaction_session_timeout | 15 s | keep | longer than the statement timeout. Whether any transaction spans an upstream HTTP call (the SSO callback transaction): not verified. |
| pool max | 20 per instance (1 in tests) | keep | Issuance holds a connection for one short transaction. Default `max_connections` 100 leaves room for 4 instances plus the migration job. |
| migration connection | bare Pool, server defaults (no timeouts) | add `lock_timeout` | M9 |

## Measured numbers

| Probe | What | How | Result |
|---|---|---|---|
| 01 | Full ID suite | `bun test --timeout 15000`, no root `.env`, port 47435, 4 suites running at once | 1,461 pass, 24 fail, 5 errors, 2,382.76 s. Failures: test timeouts, connection timeouts, a 500 at sign-in; not re-run (load average 106-150) |
| 05 | Index and table usage | `pg_stat_user_indexes/tables` after 01 (schema never dropped during the run) | 93 public indexes. Zero scans: the `expires_at` indexes of oauth_access_tokens, oauth_refresh_tokens, oauth_client_assertions and verifications; `groups_organization_id_external_id_idx` (a constraint); `invitations_pkey`. Per-index counts are in the table above |
| 06 | Statement shapes | `pg_stat_statements`, aggregated across per-file roles | 4,857 shapes, 699,123 calls, 278 s; dealloc 4. Top by time: `insert into audit_events` 12,949 ms (1.876 ms mean incl. triggers), `capture_audit_subjects` 9,060 ms, `require_present_parent` 174,753 calls / 5,109 ms |
| 07 | WHERE shapes per table | 06 filtered by table | sessions, sso_providers, tokens and grant_contexts shapes listed in the file; every shape has a leading-column index or is on a table of ≤75 rows |
| 03 | SQL vs schema drift | catalogue diff of 2 freshly built databases | 106 lines only in the SQL (23 functions, 23 function ACLs, 57 triggers, 1 FK, 2 indexes); 3 only in the generated (the same FK and indexes without the hand edits) |
| 04 | Access-token insert at 100,000 rows | 5 × 2,000 prepared single-row autocommit inserts per variant; `synchronous_commit=off`; median of server mean | 408 / 341 / 355 / 119 µs (all / −5 FK indexes / PK+token / no trigger). Index sizes: token 11.84 MiB, authorization_code_id 7.49, pkey 3.03, others 0.63-0.93; heap 25.2 MiB |
| 11 | Audit read plans, 100,000 events / 400,000 subjects | synthetic, UNLOGGED | poller page 0.145 ms (PK backward); tenant page 0.84 ms; actor 1.9 ms; target 1.1 ms; user history 0.61 ms (entity_idx) vs 45.6 ms without it. Subjects: heap 47 MB, pkey 48, entity 40, tenant_entity 49 MB |
| 12 | Per-issuance footprint | capture triggers (probe 10) copied real rows while the OAuth and token test files ran | refresh: tuple 1,820 B, 14.95 subjects; code exchange: 1,709 B, 13.76; authorised: 1,742 B, 13.85; machine `oauth.token.issued`: 1,552 B, 2; sign-in: 528 B, 3. Subject tuple 115 B, refresh tuple 354 B, grant 822 B |
| 12+11+14 | Bytes per user token refresh | sum of measured per-row sizes | about 9.9 KB (events 2.1, subjects 7.2, refresh 0.56); 8.0 KB without `tenant_entity_idx`. Example (assumed activity: 1,000 hosts × 8 h, Toolbox TTL 900 s from packages/acceptance/src/admin-mcp.ts:43): 32,000 refreshes/day = 32,000 events + 478,400 subjects + 32,000 refresh rows, about 316 MB/day. At the provider's default TTL of 3,600 s, a quarter of that |
| 14 | Revocation with unswept history | 200,000 refresh rows for one client, 1,000 live | `update … where client_id and revoked is null` 201 ms (seq scan, 6,452 pages); `deleteClient` lock step 118 ms (200,000 rows locked); family read 0.107 ms; 106 MB, 556 B/row incl. indexes |
| 13 | Foreign keys | `pg_constraint` | 45: cascade 30 (1 live at runtime), restrict 11 (0 live), set null 4 (2 live) |
| 15 | `test-migrations.ts` | `bun scripts/test-migrations.ts` against 47435 | passes, 14.06 s |

## Questions for the owner

1. **Sweep expired protocol rows?** One job in ID, as the runtime role, deleting expired `oauth_refresh_tokens` (which cascades to access tokens), `oauth_access_tokens`, `oauth_client_assertions` and `sessions` in batches. **Recommend yes before production.** Refresh rows otherwise grow by one per refresh forever, and revocation cost grows with them (probe 14). If yes, keep the four `expires_at` indexes; if no, delete them.
2. **Subject rows per token refresh.** Each refresh writes 14.95 subject rows: user, member, organisation, client, resource, session, account, provider, capabilities, entitlements and groups. That is 73% of the 9.9 KB per refresh. The only app query that reads subjects reads `entity_type = 'user'` (audit.ts:186-191), and the immutable grant context already holds the rest. **Recommend:** record the full set once per grant (on `oauth.user.authorized`) and only actor, target and user per refresh. This is the owner's call on audit contract wording (docs/04 "Durable audit subjects"); the trigger itself is Audit B's.
3. **Delete `audit_event_subjects_tenant_entity_idx`?** **Recommend yes.** No query uses it, and it is 27% of the table. Re-add it if a tenant-scoped subject query is ever built.
4. **Owner-level cascades.** 29 cascades never fire at runtime. The five on `grant_contexts` (from users, members, organisations, clients, resources) would silently delete retained grant evidence on an owner-level delete. **Recommend:** make those five `restrict`, and leave the rest until the purge job is designed.
5. **Replace the hash catalogue with the equivalence test (M10, step 3)?** **Recommend yes**, together with the two-file migration.

## Did not get to

- Re-running the suite on a quiet machine to confirm the 24 failures are load-only. Re-running probe 04 at low load: the index deltas are within noise.
- The size of `rotation_replay_response` on rotated refresh rows: rows were captured on insert, before the update that sets it.
- `pg_multixact` growth from many concurrent `FOR SHARE` locks on hot client and resource rows (Audit B's locks).
- Whether any transaction stays open across an upstream HTTP call (idle-in-transaction timeout).
- `reference_id` columns on tokens and consents: what reads them (Audit A).
- Docker VM disk: at 13:47 it reached 100% (58.4 GB). That crashed `audit-pg-c` once and may affect the other auditors' containers.
