# Pull request 13 audit, B: the database model

Auditor B. Tree: `claude/typed-config-b1` at 7ffd16b4, diff `62b6b1b3..7ffd16b4`, read-only. Decisions under audit: the MCP CLI's D1, D11, D19 and the database parts of D17.

**How I worked.** I read `packages/mcp-postgres` (every source file the PR adds or changes, its tests' structure, `bench/`), `infra/postgres/init`, `infra/ops/src/bootstrap.ts` and its test, `packages/mcp-platform/src/{databases,configuration,testing,health}.ts`, the Toolbox's and the standalone server's entry points, environments and migrate scripts, `scripts/mcp/{database,connections,role-switching}.ts` and `commands/{db,check}.ts`, the chart's migration and ops templates, and the decisions, design and findings behind them. I found callers with `rg` and counted lines with `wc -l`/`sed -n`. I ran Postgres probes in my own database and roles (`audit_b_*`) on the development Postgres 17.9 (`max_connections` 100), calling the package's own functions (`provisionMcps`, `migrateMcp`, `mcpDatabase`, `assertServingLogin`) and the CLI's `roleSwitching` scan. The scripts and their raw output are in `probe/` beside this report (`probe.ts` → `probe-output.json`, `burst.ts` → `burst-output.json`, `adp.ts`, `importcheck2.ts`).

## What the PR adds to the database model, and who uses it today

| Object | Count today (2 MCPs) | At 200 MCPs | Used by today |
| --- | --- | --- | --- |
| Database `answerable_mcps` (and `answerable_mcps_test`) | 1 (+1) | 1 (+1) | e2e and example, through the Toolbox and the standalone server |
| Login `answerable_mcps_migrator` (owns the database) | 1 | 1 | `mcps-migrate` Job |
| Logins `answerable_mcps_toolbox`, `answerable_mcps_standalone` | 2 | 2 | the two serving processes |
| Roles `mcp_<name>_owner`, `mcp_<name>` (`NOLOGIN`, cluster-wide) | 4 | 400 | taken by the migrator per migration and by the serving logins per borrow |
| Database `answerable_standalone` (and `_test`), with owner and runtime logins | 1 (+1), 2 logins | same | the standalone server's intents and evidence |
| `own` mode: a database, 2 logins, 2 Secrets, 2 variables per own MCP | **0** | — | **nobody**: both `mcps/*/mcp.json` say `"shared"` |
| Kubernetes Secrets added | 5 (`mcps-database-owner`, `toolbox-mcps-database`, `standalone-mcps-database`, `standalone-database-owner`, `standalone-database`) | 5 | bootstrap writes, servers and Jobs read (`charts/answerable/templates/ops.yaml:33`) |
| Hook Jobs added per deploy | 2 (`standalone-migrate`, `mcps-migrate`) | 2 | every deploy, whether or not a standalone MCP exists (`migrations.yaml:5`) |
| Pool connections at the autoscalers' ceilings | 140 → 230 staging, 200 → 320 production (docs/12 before and after) | same | the Toolbox's second pool and the standalone server's two |
| Role prefixes | 12 (`mcp` and 11 test prefixes) | 12 | `mcp` in production; the rest only in tests and benches |

## Findings

### B1. The `own` database mode has no user and does not deliver the isolation it is chosen for: delete it.
- **Verdict:** delete
- **Cost today:** medium
- **Where:** `packages/mcp-postgres/src/names.ts:36-41`, `provision.ts:94-104`, `serving-login.ts:57-73`, `mcp-database.ts:57,64`, `migrate-mcp.ts:16,60`, `declared.ts:36`, `own-mode.test.ts` (whole file); `packages/mcp-platform/src/configuration.ts` (whole file), `databases.ts:10,22-27,40`, `testing.ts:62-89`; `mcps/toolbox/src/environment.ts:8,12`; `mcps/standalone/src/environment.ts:8,12`, `scripts/env.ts:29-37`, `scripts/migrate-mcps.ts:10,16`, `src/db/migrate-mcps.ts:39,52-56`; `infra/ops/src/bootstrap.ts:37-40,128-132`; `charts/answerable/templates/_helpers.tpl:52-65`, `migrations.yaml:100-104`, `ops.yaml:34-38`, `toolbox.yaml:17`, `standalone.yaml:21`; `scripts/mcp/database.ts:82-96`, `commands/check.ts:68,73-87`, `connections.ts` (whole file), `commands/new.ts:53,98-100`, `definitions.ts:33,38,96`, `workspace.ts:12`, `mcp.schema.json:25`; `apps/web/content/docs/mcp/database.mdx:79-97`, `docs/12-deployment.md:144`.
- **What it is:** a second mode in which an MCP gets `answerable_mcp_<name>`, an owner and a runtime login, two Secrets, a migration variable and a serving variable per server, its own pool in every serving process, its own login assertion (`assertOwnLogin`), its own test helper (`testOwnMcp`) and a connection-budget step in `bun mcp check` that only speaks when an own MCP exists (`check.ts:78-79`). No MCP uses it: `rg '"database": "own"' mcps` finds nothing; both declarations say `"shared"`.
- **The assumption:** D1 and the design say an MCP picks `own` for "hard isolation, a size or a maintenance window of its own, or a client's request" (`design.md` Database; `database.mdx:85`). None of these holds in this deployment, and none is measured:
  - every own database is created on the same Civo instance as everything else (`bootstrap.ts:104` writes one `host`/`port` into every URL), so it shares CPU, memory, disk, backups and the maintenance window;
  - the own runtime login's URL is a variable of the shared Toolbox and standalone processes (`environment.ts:8,12`; `_helpers.tpl:57-63`), so any provider mounted beside it can read `process.env` and connect: no isolation from co-mounted code beyond what `shared` gives;
  - it is the mode the connection argument of D1 argues against: +30/+40 connections per own MCP per serving server at the ceilings (`docs/12-deployment.md:144`).
  The owner asked to "leave the door open". The door is already open without the mode: tables are `pgSchema("<name>")` tables in both modes, so moving an MCP later is the dump and restore D1 describes, and the mode's code can be written then.
- **Proposal:** delete the mode, the `database` field of `mcp.json` and of the generated lists, `--database`, the budget step and `connections.ts`. Record "Not yet: a database of its own (trigger: an MCP that must live on a separate Postgres instance)" beside `Q-MCP-MOVE`. `Declared` becomes `{ provider }`; `mcpDatabases` takes one URL.
- **Removes:** 359 lines measured in whole units (own-mode.test 110, configuration.ts and test 39, connections.ts and test 54, provisionOwnMcp 11, assertOwnLogin 17, ownMcpDatabase 6, testOwnMcp 28, the chart helper 14, budgetOf 15, migrateLocal's own branch 15, ownMigration config 9, bootstrap 9, migrations.yaml 5, ops.yaml 5, the Toolbox's own test 14, db.test's own test 8); about 500 with the scattered branches, enum values, test cases and docs (estimate). Concepts: a mode, a flag, a field, two variable families per MCP, a login check, a CLI step, four test databases (`answerable_toolbox_test_own`, `answerable_standalone_test_migrate_own`, `answerable_mcp_platform_test_own`, `answerable_mcp_postgres_test_ownmode`).
- **Risk:** none for a user: no MCP is own, nothing is deployed. A developer loses a flag that today produces an MCP whose stated benefits do not exist.
- **Confidence:** verified (rg over `mcps/*/mcp.json`; read `bootstrap.ts:104`, `environment.ts`, `_helpers.tpl`; lines counted with `sed -n | wc -l`).

### B2. Per-MCP owner and runtime roles are not a boundary between MCPs: grant each serving login its MCPs' tables instead.
- **Verdict:** simplify (an owner decision, D1)
- **Cost today:** medium
- **Where:** `packages/mcp-postgres/src/names.ts:11,23-30`; `provision.ts:18-19,55-72,81-92`; `serving-login.ts:40-55`; `mcp-database.ts:59,64`; `migrate-mcp.ts:50,60,67-93` (the custom loop exists because the owner role has no `CREATE`); `scripts/mcp/role-switching.ts` and its test; `scripts/mcp/commands/check.ts:61-67`; `mcps/toolbox/src/environment.ts:27`, `mcps/standalone/src/environment.ts:31` (`*_MCPS_ROLE_PREFIX`); the `prefix` parameter of `mcpRoles`, `provisionMcps`, `assertServingLogin`, `mcpDatabase`, `migrateMcp`, `mcpDatabases`, `testSharedMcps`, `migrateDeclared`.
- **What it is:** each shared MCP gets two cluster-wide `NOLOGIN` roles; the migrator takes the owner role per migration and each serving login takes the runtime role on every borrow, so that MCP A's code cannot reach MCP B's schema. The design already concedes that provider code is trusted because the serving login may take every served MCP's role (`README.md` "The trust boundary"; D1 "The cost"); two text scans stand guard.
- **The assumption:** that the roles isolate MCPs. Measured by F4 only for a plain cross-schema query. My probes, through the package's own functions:
  - **A.** A plain read of B's table from A's `db`: `permission denied for schema auditbb`. The roles do refuse an accident.
  - **B.** In one transaction of A's `db`: `select set_config('role', 'audit_b_auditbb', true)` then `select … from auditbb.secrets` returned B's row as `current_user = audit_b_auditbb`. The same as one multi-statement `execute` outside a transaction also switched role.
  - **B3.** `roleSwitching()`, the scan `bun mcp check` runs, found nothing in a file holding both forms (`{ files: 1, found: [] }`).
  - **C.** A pending migration of MCP A, accepted by `migrateMcp`'s scanner, ran `select set_config('role', '…auditbb_owner', true)`, `select set_config('search_path', 'auditbb', true)` and `CREATE TABLE "planted"`: the table landed in B's schema, owned by B's owner role.
  - **F.** Row-level security does not need the roles: a login granted `select` on the table directly (not its owner) saw only organisation Y's row with the setting at Y, and no row with it reset. D19 stands on its own.
  - **E.** The role switch costs nothing measurable per borrow: the same setup without `set role` took 0.353–0.374 ms per query against 0.362–0.369 ms with it. The borrow's cost is the round trip, which the organisation setting needs anyway.

  So the roles guard against one accident: raw SQL in one MCP that names another MCP's schema. drizzle's `pgSchema` tables are always schema-qualified, `bun mcp db generate` already refuses a table outside the MCP's schema (`scripts/mcp/database.ts:18-25`), and such a line is visible in review. Against that: 400 cluster-wide roles at 200 MCPs on the Postgres that also holds ID, the role lock, the prefix in eight signatures and two production variables, eleven test prefixes, a membership check, and a migrator that cannot use drizzle's or this package's own `migrate()`.
- **Proposal:** keep the schema per MCP, the one shared database and one pool per serving process. Drop the per-MCP roles:
  - provisioning: `create schema` owned by the migrator; `grant usage` on it to the serving logins of its `servedBy`, revoked from the other;
  - migration: as the migrator, which may create schemas, so `migrateMcp`'s hand-written apply loop gives way to the package's existing `migrate()` with the journal's schema as a parameter; the grant step grants DML on the schema's tables to the serving logins that serve it;
  - borrow: `set search_path` and the organisation setting, as today, without `set role`;
  - assertion: the serving login owns nothing, has no attribute, no `CREATE` or `TEMPORARY` (the check `assertOwnLogin` already makes);
  - delete `role-switching.ts` and its check step; keep RLS (D19) unchanged.
  If the owner keeps the roles, at least make both scans match `set_config('role'` and stop describing them as refusals of a role switch: they are lints.
- **Removes:** about 280 lines of source and tests (estimate: `mcpRoles` 7, provisioning's role statements ~30, `assertServingLogin`'s membership checks ~16, the migration loop ~30, `role-switching.ts` and test 68 plus the check step 7, the prefix plumbing ~30, role tests in `provision.test.ts`, `serving-login.test.ts`, `migrate-mcp.test.ts` and `bootstrap.test.ts` ~90). 400 roles at 200 MCPs (4 today), 11 test prefixes, `TOOLBOX_MCPS_ROLE_PREFIX` and `STANDALONE_MCPS_ROLE_PREFIX`, the concepts "owner role", "runtime role", "INHERIT FALSE, SET TRUE" and "role prefix".
- **Risk:** raw SQL in one MCP that names another MCP's schema, or a migration of one that alters another's table, would succeed instead of being refused. Organisation isolation is unchanged (probe F). No user-visible behaviour changes.
- **Confidence:** verified for the claims (probes A, B, B3, C, E, F, output in `probe/probe-output.json`); the lines removed are an estimate.

### B3. `migrateMcp`'s text scanner repeats what Postgres and its own grant step already do, and cannot stop the one thing only it targets: delete it.
- **Verdict:** delete
- **Cost today:** low
- **Where:** `packages/mcp-postgres/src/migrate-mcp.ts:22-24,31-44,83-85`; `migrate-mcp.test.ts:110-147`; `apps/web/content/docs/mcp/database.mdx:61`.
- **What it is:** before applying, a regex scan of each pending file refuses `CREATE SCHEMA`, `GRANT`, `REVOKE`, `ALTER DEFAULT PRIVILEGES`, `SET`/`RESET ROLE`, `SET SESSION AUTHORIZATION` and any name qualified by another schema, with file and line.
- **The assumption:** that a migration could otherwise do these. Probe D, each statement run as the owner role through the migrator login:
  - `create schema …` and `create schema if not exists …`: `permission denied for database`;
  - a table in `public`, an unqualified table: `permission denied for schema public`;
  - a table in, or a read of, another MCP's schema: `permission denied for schema auditbb`;
  - `grant select … to` another MCP's role: allowed, and **taken back** by the next `migrateMcp` (D2: privilege `true` before, `false` after a run with nothing pending);
  - `alter default privileges … grant select … to` another MCP's role: allowed, and a table a later migration created was not readable by it after `migrateMcp` (`adp.ts`: `other_mcp = f`);
  - `set role` to another MCP's owner: allowed, but the scanner is bypassed by `set_config('role', …)` (B2, probe C).

  So the scanner adds an earlier, clearer message, and a guard that is not one.
- **Proposal:** delete the scan; keep `blank` and `lineOf` for `withoutSchemaCreation`. Let Postgres's errors (which `migrateMcp` already wraps with the MCP and file, line 90) and the grant step do the work. If B2 is taken, this goes with it.
- **Removes:** about 19 source lines (`forbidden`, `tokens`, `problems`, lines 83-85), 38 test lines, one docs paragraph, one rule a developer must learn.
- **Risk:** a hand-written `GRANT` in a migration now runs, and the same transaction's grant step undoes it. Error messages for the refused cases come from Postgres instead of from the scan.
- **Confidence:** verified (probes C, D, D2, ADP).

### B4. `ensureLocalMcpDatabases` is a one-time shim for development volumes made before this PR, run from eleven places: delete it.
- **Verdict:** delete
- **Cost today:** low
- **Where:** `packages/mcp-postgres/src/local.ts:1-40`, `local.test.ts` (42 lines); call sites `testing.ts:141`, `mcp-database.test.ts:27`, `provision.test.ts:13`, `serving-login.test.ts:17`, `migrate-mcp.test.ts:21`, `bench/mcp-database.ts:37`, `packages/mcp-platform/src/testing.ts:46`, `mcps/standalone/scripts/migrate.ts:15`, `mcps/standalone/src/db/migrate-mcps.test.ts:46`, `scripts/mcp/database.ts:68`.
- **What it is:** it reads `infra/postgres/init/006` and `007`, re-implements psql's `\gexec` by splitting and reversing the text, runs them under a cluster-wide session lock, and applies the database grants only when it has just created a database (a race explained in a comment).
- **The assumption:** that a developer's Postgres volume may predate the shared databases. Every fresh volume already gets them: `docker-compose.yml:15` mounts `infra/postgres/init`, which CI starts (`ci.yml:35`), and the kind stack mounts it too (`infra/k8s/local/database.yaml:102`); the acceptance makes its own (`packages/acceptance/src/mcps.ts:33`). Only volumes made before this PR lack them, and the repository already handles that case for `005` with one documented `psql` command (`apps/web/content/docs/toolbox/index.mdx:276-279`).
- **Proposal:** delete the function and its call sites; document "on a volume made before, run 006 and 007 once", as for 005.
- **Removes:** 82 lines (40 + 42), 11 call sites and their imports, the psql-syntax parser, and a lock taken at the start of every MCP suite.
- **Risk:** a developer with an old volume gets "database answerable_mcps does not exist" once and runs two commands. CI, kind and the acceptance are unaffected.
- **Confidence:** verified (rg of call sites and of `infra/postgres|docker-entrypoint-initdb`; read `ci.yml`, `docker-compose.yml`).

### B5. The `src/db/grants.ts` narrowing hook has no user: delete it.
- **Verdict:** delete
- **Cost today:** low
- **Where:** `packages/mcp-postgres/src/migrate-mcp.ts:14-15,62-66,111-113`; `scripts/mcp/database.ts:62,72-74`; `mcps/standalone/src/db/migrate-mcps.ts:23,37-38,54`; `scripts/mcp/templates/sources.ts:73-77` and its snapshot; `mcps/example/src/db/schema.ts:17-21`; tests `migrate-mcp.test.ts:92-97,174-178`, `scripts/mcp/commands/db.test.ts:59-66`, `mcps/standalone/src/db/migrate-mcps.test.ts:10-11,41`.
- **What it is:** an MCP may export `grants` from `src/db/grants.ts` to narrow its runtime role's table privileges; both the CLI and the production `mcps-migrate` Job `import()` that TypeScript file at migration time.
- **The assumption:** that an MCP will want fewer than DML privileges on its own tables. No MCP has the file (`ls mcps/*/src/db/`). Row-level security, not grants, is what limits rows.
- **Proposal:** delete; every MCP's runtime gets DML on its tables. Add it back with the first MCP that needs it.
- **Removes:** about 50 lines (estimate from the places above), a dynamic import of MCP code in a production Job, and a comment every new MCP's schema carries.
- **Risk:** none today.
- **Confidence:** verified (no `grants.ts` under `mcps/*/src/db`; callers read).

### B6. The reset on release costs a third of a burst and protects nothing: delete it.
- **Verdict:** optimise
- **Cost today:** low
- **Where:** `packages/mcp-postgres/src/mcp-database.ts:7-8,28-34`; `mcp-database.test.ts:121-134`.
- **What it is:** every borrow runs one setup round trip (role, search path, organisation) and, on release, a second (`reset role; reset search_path; reset answerable.organisation_id`) before the connection goes back to the pool; a failed reset destroys it.
- **The assumption:** that a connection might be used without the setup. Every `mcpDatabase` borrow sets all three (an absent organisation issues `reset`, `mcp-database.ts:66`). The raw pool's other users are `/health`'s `select 1` (`packages/mcp-platform/src/health.ts:10`) and the boot assertion, which runs before any borrow.
- **Measured (probe E and `burst.ts`, pool of 10):** sequentially, 0.400–0.426 ms per query with the reset, 0.362–0.369 ms without, 0.180–0.187 ms plain. A burst of 1,000 queries over two MCPs: 132–145 ms with the reset, 91–98 ms without (five runs each after a warm-up), about 30% less, because the reset holds each connection for a third round trip.
- **Proposal:** delete the reset and its failure path; keep destroying a connection released inside a transaction.
- **Removes:** about 20 lines (the reset constant and release wrapper's reset, one 14-line test).
- **Risk:** a future raw-pool user would see the last borrower's role and organisation; with B2 taken, only the organisation, which RLS then applies to that user's own query, so it should set its own.
- **Confidence:** verified (probe E, `burst-output.json`).

### B7. The standalone server has a database of its own for two tables the Toolbox's database already has.
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `mcps/standalone/drizzle/` (1,108 lines with the generated snapshots), `drizzle.config.ts`, `src/db/migrate.ts`, `src/db/migrate.test.ts`, `src/db/schema.ts`, `scripts/migrate.ts`, `scripts/env.ts:5-15`, `src/test/database.ts`, `src/environment.ts:17-23`; `infra/postgres/init/007-create-standalone-databases.sql`; `infra/ops/src/bootstrap.ts:31`; `charts/answerable/templates/migrations.yaml:86-92`, `ops.yaml:33`.
- **What it is:** `answerable_standalone` (and `_test`) holds only `intents`, `evidence_events` and `evidence_payloads` (`src/db/schema.ts:2`), with an owner login, a runtime login, two Secrets, a hook Job on every deploy (rendered "whether or not a server is rendered", `migrations.yaml:5`) and a 10-connection pool per replica.
- **The assumption:** that every serving process needs a database of its own. Nothing in D1 to D19 decides it; the Toolbox's database already has the same three tables from the same package (`mcps/toolbox/src/db/schema.ts:5`).
- **Proposal:** either give the standalone server a second runtime role in `answerable_toolbox` with `runtimeGrants` only (the Toolbox's migrate script provisions it), or settle it with auditor C's question of whether two serving processes are needed, which would remove it entirely. The `mcps-migrate` code, which migrates every MCP including Toolbox-only ones, would then also leave `mcps/standalone` (today `scripts/migrate-mcps.ts`, `src/db/migrate-mcps.ts`).
- **Removes:** one database and one test database, the owner login and its Secret, one hook Job per deploy, `init/007`, 1,108 lines of drizzle files (836 of them generated snapshots) and about 130 hand-written lines (`wc -l`).
- **Risk:** the standalone server's evidence shares the Toolbox's database and migration journal; each organisation's chain interleaves both servers' events (it already interleaves replicas'). A Toolbox migration then gates the standalone server too.
- **Confidence:** read only (no probe of a shared intent store).

### B8. Three production migration Jobs load the test kit.
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `mcps/toolbox/scripts/migrate.ts:4`, `mcps/admin/scripts/migrate.ts:4`, `mcps/standalone/scripts/migrate.ts:4` (each imports `../src/test/database` for `--test`); `packages/mcp-postgres/src/testing.ts:1-6`, which the PR made import `bun:test`, `@answerable/mcp` and `@answerable/mcp/testing`.
- **What it is:** to know the test database's URL for `--test`, each migrate script imports its suite's `test/database.ts`, which imports `@answerable/mcp-postgres/testing`.
- **Measured:** with `NODE_ENV=production`, importing what the Toolbox's migration needs loads 260 modules in 46–50 ms; `test/database.ts` adds 100 modules and 43–45 ms, among them `bun:test`, `packages/mcp/src/testing.ts`, `conformance.ts` and `packages/auth/src/testing.ts` (three runs, `importcheck2.ts`).
- **Proposal:** split `--test` out of the production script (a `db:test:migrate` script of its own, as `packages/mcp-postgres/scripts/test-migrate.ts` already is), or move `testDatabase` to a module that imports no test kit.
- **Removes:** about 45 ms and 100 test modules from each of three Jobs on every deploy; test code from the production path.
- **Risk:** none for users.
- **Confidence:** verified (import probe).

### B9. The model needs 12 role prefixes and about 15 new test databases.
- **Verdict:** simplify (follows from B1, B2 and B7)
- **Cost today:** low
- **Where:** prefixes `mcp`, `mcp_test`, `mcp_plt`, `mcp_plte`, `mcp_tbx`, `mcp_tbxnone`, `mcp_tbench`, `mcp_std`, `mcp_sts`, `mcp_stsnone`, `mcp_stdm`, `mcp_bench` (rg of `prefix` values); test databases the PR adds: fixed `answerable_mcps_test` and `answerable_standalone_test` (`init/006`, `007`); made per run `answerable_toolbox_test_mcps`, `answerable_toolbox_test_own`, `answerable_standalone_test_mcps`, `_served`, `_migrate`, `_migrate_own`, `_toolbox`, `answerable_mcp_platform_test`, `_empty`, `_own`, `answerable_mcps_test_platform`, `answerable_mcp_postgres_test_owned`, `_ownmode`; benches `answerable_mcps_bench`, `answerable_toolbox_test_bench`, `answerable_toolbox_test_benchmcps`.
- **What it is:** suites run concurrently (`mcp:test`), roles are cluster-wide and schemas are per database, so every suite that serves the real e2e or example provider needs a database of its own (schema names collide) and a role prefix of its own (role names collide). The prefix reaches production as two variables the chart is tested never to set (`infra/k8s/charts.test.ts:121`).
- **The assumption:** none of its own: it is the cost of B1's mode, B2's roles and B7's database.
- **Proposal:** take B1 (−4 databases), B2 (−11 prefixes, −2 variables) and B7 (−2 databases).
- **Removes:** counted in B1, B2 and B7.
- **Risk:** none beyond theirs.
- **Confidence:** verified (rg of prefixes and `answerable_*_test*` names).

### B10. The 200-MCP case for one shared database is measured and holds; the connection limit it is measured against is not.
- **Verdict:** keep
- **Cost today:** low
- **Where:** `docs/12-deployment.md:135-146`; `scripts/mcp/connections.ts:7`; `docs/goals/mcp-cli/findings.md` F4; `reports/mcp-foundation-evidence.md` (26 October).
- **What it is:** D1 rests on F4: at 200 MCPs a database per MCP had 105 of 200 queries refused at `max_connections` 100, while one shared database served 1,000 queries on 10 connections (M9: 192–198 ms, no error). That comparison is sound and re-measured.
- **The assumption:** the absolute limit. Civo's `max_connections` is not measured (`Q-CIVO-MAX-CONNECTIONS`). docs/12 already counts 230 (staging) and 320 (production) connections at the autoscalers' ceilings with shared MCPs only, against an assumed 100; before the PR it was 140 and 200. The PR adds 90/120: the Toolbox's second pool (30/40) and the standalone server's two (60/80). `bun mcp check`'s budget step says nothing unless an own MCP exists (`check.ts:79`), so the overrun it would report is the deployment's, not the MCPs'.
- **Proposal:** keep the shared-schema design. Measure Civo's limit before the first staging tag of this work, as the register already says; B7 would take 30/40 off the ceiling, B1 removes the step that reports only the own share.
- **Removes:** nothing by itself.
- **Risk:** if Civo's limit is near Postgres's default, the ceilings overrun it with or without MCPs.
- **Confidence:** verified (numbers read from docs/12 before and after, `git show 62b6b1b3:docs/12-deployment.md`; F4 and M9 numbers read).

### B11. The bootstrap test re-implements provisioning's SQL in a regex fake Postgres.
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `infra/ops/src/bootstrap.test.ts:13-65` (the fake), `125-154` (membership and schema assertions).
- **What it is:** to test `bootstrap`, a 53-line fake parses the statements `provisionMcps` sends (`create role … nologin noinherit`, `grant … with inherit false, set true`, `revoke … granted by`, `create schema if not exists … authorization …`) and the test asserts the resulting memberships. `provisionMcps` is already proven on real Postgres (`packages/mcp-postgres/src/provision.test.ts`) and end to end by the kind stack.
- **The assumption:** that bootstrap's test must prove provisioning again.
- **Proposal:** assert only that bootstrap hands `provisionMcps` the right list and logins (its `database` connection is already injected); drop the provisioning regexes and membership assertions.
- **Removes:** about 15 lines of fake and 15 of assertions (estimate), and a second copy of provisioning's SQL text that breaks whenever a statement's wording changes.
- **Risk:** none: the real-Postgres test and `infra:test` keep the behaviour proven.
- **Confidence:** read only.

## Kept

- **One shared database with a schema per MCP (D1, shared).** Measured twice (F4, M9): 10 connections for 200 MCPs, 22.7 MiB, 0.7 s to provision and 2 s to migrate 200. It is the right default, and the schema-qualified tables make a later move possible without the `own` machinery.
- **Organisation isolation by row-level security (D19).** Probe F shows it works without per-MCP roles; an unset organisation matches nothing (fail closed, `mcp-database.test.ts:74`). Its cost is part of the one setup round trip the search path needs anyway (probe E). It guards the worst bug class of a multi-tenant platform.
- **`mcpDatabase` made once per process per MCP over one pool (D17's database part).** One drizzle object per MCP, a borrow only while a query runs; measured +0.18–0.24 ms per query over plain, and a burst of 1,000 in 91–145 ms on 10 connections.
- **Destroying a connection released inside a transaction.** It is the one release rule that protects the next borrower.
- **The migrator login apart from Civo's administrator, and the two serving logins.** The Jobs never get `CREATEROLE`; the standalone server never reaches a Toolbox-only MCP. One login and one Secret each.
- **`assertServingLogin`'s "is not a member of" check.** A server refuses to start serving an MCP the bootstrap has not provisioned. Under B2 it becomes "lacks USAGE on schema".
- **Refusing an applied migration whose text changed.** drizzle's migrator would ignore it silently.
- **`withoutSchemaCreation`.** Needed while provisioning creates the schema; B2 would make drizzle-kit's own line usable again.
- **Tests against real Postgres (D11).** Only real Postgres proves RLS and grants; the cost (no Codex sandbox) is the honest price. Each MCP suite's provisioning is about 13 ms of the 200-MCP measurement (estimate from M9's totals).
- **`bench/mcp-database.ts`.** 103 lines, not a gate, drops what it makes; it is the only reproducible evidence for the 200 claim. It cannot answer Civo's limit.
- **Provisioning from the chart's list on every deploy.** Idempotent and measured at 0.7 s for 200.

## Cleanup

- **Databases created and dropped:** `audit_b_mcps` (dropped with `with (force)`).
- **Roles created and dropped:** `audit_b_migrator`, `audit_b_toolbox`, `audit_b_standalone`, `audit_b_auditba`, `audit_b_auditba_owner`, `audit_b_auditbb`, `audit_b_auditbb_owner` (dropped under the role lock). A final query found no database or role named `audit_b%`.
- **Copies:** none; `bun mcp` was not run. Probe scripts and a scan fixture are in this folder's `probe/`.
- **Processes:** none left; ports 47300, 47400, 47510 and 47520 had no listener before and after.
- **The worktree:** untouched.

## Findings, one line each

| Id | Verdict | Cost today | Where | Claim | Removes |
| --- | --- | --- | --- | --- | --- |
| B1 | delete | medium | `packages/mcp-postgres/src/provision.ts:94` (+ ~30 places) | The `own` mode has no user, and on one Civo instance with its URL in the shared processes' environment it gives none of the isolation, size or maintenance window it is chosen for. | 359 lines measured in whole units, ~500 estimated; a mode, a flag, a field, 4 test databases |
| B2 | simplify | medium | `packages/mcp-postgres/src/provision.ts:55` | Per-MCP roles are bypassed by `set_config('role', …)` in a tool or a migration, and RLS works without them: grant serving logins their MCPs' tables instead. | ~280 lines (estimate), 400 roles at 200 MCPs, 11 prefixes, 2 variables |
| B3 | delete | low | `packages/mcp-postgres/src/migrate-mcp.ts:23` | The migration scanner refuses what Postgres already refuses or the grant step undoes, and misses `set_config('role', …)`. | ~19 source + 38 test lines |
| B4 | delete | low | `packages/mcp-postgres/src/local.ts:17` | `ensureLocalMcpDatabases` only serves volumes made before this PR, which 005's one-line psql instruction already covers. | 82 lines, 11 call sites |
| B5 | delete | low | `packages/mcp-postgres/src/migrate-mcp.ts:15` | No MCP has `src/db/grants.ts`, yet the CLI and the production Job import it. | ~50 lines |
| B6 | optimise | low | `packages/mcp-postgres/src/mcp-database.ts:33` | The release reset adds a third round trip per borrow (burst 132–145 ms vs 91–98 ms) and protects nothing, since every borrow sets all three. | ~20 lines |
| B7 | simplify | low | `mcps/standalone/src/db/schema.ts:2` | The standalone server's database holds only intents and evidence, which the Toolbox's database already has. | 1 database, 1 login, 1 Secret, 1 Job per deploy, 1,108 drizzle lines (836 generated) + ~130 |
| B8 | simplify | low | `mcps/toolbox/scripts/migrate.ts:4` | Three production migration Jobs import the test kit (`bun:test`, the SDK's testing), 100 modules and ~44 ms each. | ~45 ms × 3 Jobs per deploy |
| B9 | simplify | low | `mcps/toolbox/src/test/mcps.ts:10` | 12 role prefixes and ~15 new test databases exist only because of B1, B2 and B7. | counted in B1, B2, B7 |
| B10 | keep | low | `docs/12-deployment.md:143` | The shared-database comparison at 200 is measured; the limit is not, and the PR raises the ceilings from 140/200 to 230/320. | nothing |
| B11 | simplify | low | `infra/ops/src/bootstrap.test.ts:13` | The bootstrap test re-parses provisioning's SQL with regexes, which real-Postgres tests already prove. | ~30 lines (estimate) |
