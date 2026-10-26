# Pull request 13 audit: findings

## Baseline before M9 (measured 2026-10-26)

`git diff 62b6b1b3 e4b217f1`: 14 commits, 488 files, +22,726 and −3,494 lines.

**By kind:**

| Kind | Files | Added | Removed |
|---|---|---|---|
| Tests (`*.test.ts`, `test/`, `testing`, snapshots) | 153 | 9,628 | 1,016 |
| Source | 186 | 6,708 | 1,039 |
| Docs and inventories (`.md`, `.mdx`, `default.env`, `.env.example`) | 78 | 2,575 | 894 |
| Generated files and migrations (manifests, inventories, drizzle metadata, SQL, `bun.lock`) | 25 | 2,691 | 96 |
| Deployment (`charts`, `infra`, `.github`, Dockerfiles) | 46 | 1,124 | 449 |

**By area, the largest:**

| Area | Files | Added | Removed |
|---|---|---|---|
| `scripts/mcp` | 58 | 5,592 | 0 |
| `packages/mcp-postgres` | 39 | 2,561 | 15 |
| `apps/web` | 37 | 2,334 | 515 |
| `mcps/standalone` | 32 | 1,967 | 0 |
| `packages/config` | 8 | 1,343 | 0 |
| `infra/ops` | 13 | 1,011 | 340 |
| `packages/mcp` | 33 | 960 | 247 |
| `packages/mcp-platform` | 23 | 761 | 0 |
| `mcps/admin` | 23 | 621 | 147 |
| `packages/acceptance` | 15 | 601 | 53 |

**Gates on M8 (e4b217f1):**
- `mcp:test`: 1,022 pass;
- web: 120;
- typecheck and lint: 21 of 21;
- build: 2 of 2;
- knip clean;
- `infra:check` passed.

**Workspaces after the PR:**
- packages: `acceptance`, `auth`, `config`, `countries`, `design`, `id-admin`, `mcp`, `mcp-platform`, `mcp-postgres`, `ui`;
- MCPs: `admin`, `e2e`, `example`, `standalone`, `toolbox`, plus `mcps/Dockerfile` and `mcps/retired.json`.

## The decisions under audit

**Typed configuration,** D1 to D7 (`docs/goals/typed-config/task_plan.md`):
- defaults in code for development and test, none for staging and production;
- one central `packages/config`;
- the inventories and the docs tables generated from it.

**The MCP CLI** (`docs/goals/mcp-cli/decisions.md`):
- D1: two database modes, `shared` by default and `own`.
- D2: one shared standalone server, at `mcp.<zone>/<name>/mcp`.
- D3: the order of the work.
- D4: the models.
- D5: one command, `bun mcp`.
- D6: three places to run, `toolbox`, `standalone` and `both`.
- D7: `mcp.json` declarations, with generated lists.
- D8: one `mcps` image.
- D9: a register machine client.
- D10: tags, and no per-environment switch.
- D11: MCP tests on the real role path.
- D12: one file per tool.
- D13: names.
- D14: e2e on Postgres, served `both`.
- D15: the admin MCP kept apart.
- D16: `bun mcp dev` against the local ID.
- D17: the tool context.
- D18: profiles from ID's admin API, cached.
- D19: organisation isolation in Postgres.

## After M9 (measured 2026-10-26)

M9's diff: 99 files, +442 and −624 lines; `registrar.ts`, `registrar.test.ts` and `bench/scale.ts` added; three files deleted.

**Size of the goal's workspaces,** source then tests, as M9 measured them (TypeScript, SQL and chart templates, without drizzle's snapshots):

| When | Source | Tests |
|---|---|---|
| Before M1 (971ada93) | 11,075 | 12,569 |
| After M8 (e4b217f1) | 16,541 | 19,196 |
| After M9 | 16,660 | 19,151 |

**Gate timings after M9:**

| Gate | Result |
|---|---|
| typecheck (forced) | 13 s |
| lint (forced) | 11 s |
| build (forced) | 21 s |
| `mcp:test` | 1,020 pass in 29 s |
| web | 120 pass in 2 s |
| `infra:check` | 18 s |
| ID's suite | 1,491 pass in 303 s |
| The acceptance | 69 pass in 150 s |
| Kind | 123 pass in 239 s |

**M9's open items.** These are this session's own inputs. They go into verification with the audits' findings, and are not given to the auditors:

1. The Toolbox's per-call cost grows with the tools a caller holds: about 3.5 ms at 10 tools, 11 to 12 ms at 1,000 (`packages/mcp/src/server.ts:244-255`).
2. `migrateLocal` reads `mcpCliConfig.read(process.env)`, not `readSettings(root)` (`scripts/mcp/database.ts:65`). From `mcps/<name>`, a root `.env` value is ignored.
3. The chart-list entry is typed four times: `infra/ops/src/commands.ts:46`, `infra/ops/src/register.ts:6`, `infra/pipeline/src/smoke.ts:4` and `infra/k8s/local/stack.ts:21`.
4. Stale status lines:
   - "Development and test only" in three READMEs;
   - `docs/02-plan.md`'s "Not yet: the first staging deployment";
   - `docs/12-deployment.md:6` on `reports/staging-evidence.md`.
5. The Toolbox's `src/test/mcps.ts` and the standalone server's `src/server.test.ts:12-18` build the same test databases.
6. The kind stack's directory sign-in budget (`infra/k8s/local/stack.ts:158`: staff 3, tenant 1).

## Audit findings

The auditors' reports are in the session scratchpad, under `pr13-audit/<letter>/report.md`. Findings are recorded here as this session verifies them.

### Audit A: typed configuration (12 findings, received 2026-10-26)

**A2. An empty value follows two rules.** Verified by probe:
- `{}` reads both the default and the fallback;
- `{ WITH_DEFAULT: "", WITH_FALLBACK: "" }` is refused on `WITH_FALLBACK`. A field's default fills an empty value, but a fallback does not (`packages/config/src/index.ts:101`).

**A3. Nothing reads `default.env`.** Verified with `rg`: the only references outside prose are the generator, `scripts/env-inventory.ts`, and its test. The file has 100 `NAME=` lines.

**A4. ID in development accepts a committed root bearer on every interface.** Verified by reading:
- `Bun.serve` in `apps/id/src/runtime.ts:88` passes no `hostname`. That was the same at the base 62b6b1b3, so this part predates the PR.
- The PR's change is `ROOT_ADMIN_SECRET: defaults: locally("development-only-root-admin-secret-never-for-production")` (`apps/id/src/config.ts:116-121`). At the base, `.env.example` had `# ROOT_ADMIN_SECRET=` commented out, so root was off unless a developer set it.
- So since the PR, a local ID that no platform administrator holds yet accepts a public root bearer from any host that can reach the machine.

**A1, and A5 to A11.** Verified with `jq` and `rg`:
- **A1:** 0 of the 27 `defaults` in `inventory.json` differ between development and test.
- **A5:** the SDK's `parseEnvironment` has three callers, the Toolbox's, the admin MCP's and the standalone server's `environment.ts`. ID's `parseEnvironment` in `apps/id/src/env.ts:80` is a different function.
- **A6:** the chart sets `OPS_NAMESPACE`, to the namespace the code reads anyway. Nothing sets `OPS_PLATFORM_SLUG` or `OPS_DATABASE_SSLROOTCERT`.
- **A7:** the four `runtimeRole` values in `values.yaml` equal the logins `bootstrap.ts:13` hard-codes.
- **A8:** `inventory.json` says `optional=true` for `TRUSTED_PROXY_CIDRS`, `BETTER_AUTH_TRUSTED_ORIGINS` and `OPS_ID_ROOT_SECRET`, and `source=image` for `TOOLBOX_PORT`, `ADMIN_PORT` and `STANDALONE_PORT`. Of the Dockerfiles, only `apps/id/Dockerfile:35` sets a port.
- **A9:** both `mcp.json` files declare `database: "shared"`.
- **A11:** `createAdminMcp`'s `freshSeconds = 1800` is the default (`mcps/admin/src/admin.ts:34`).

**A12** is prose, accepted as reported.

### Audit E: shipping and registration (13 findings, received 2026-10-26)

**E1 and E3. One test MCP justifies the standalone server, and test MCPs ship to production.** Verified:
- `charts/answerable/mcps.json` declares `e2e` (`both`, `shared`) and `example` (`toolbox`, `shared`). So `e2e` is the only standalone MCP.
- At the base, the Toolbox mounted only `createE2eProvider({ records: createRecordStore() })`, an in-memory store. Since the PR, every environment's Toolbox mounts `e2e`, now on Postgres, and `example`, and its standalone server serves `e2e`.
- The owner asked for standalone serving as a choice in the CLI (2026-10-25), so the decision is whether a test MCP should keep it running in deployed environments. Whether the capability itself stays is a separate question.

**E4. The staff token duplicates break glass.** Verified:
- register takes `OPS_ID_TOKEN ?? OPS_ID_ROOT_SECRET` (`infra/ops/src/commands.ts:150`);
- ID accepts root again under `ROOT_ADMIN_BREAK_GLASS=true` (`apps/id/src/http/principal.ts:241`).

**E5.** Verified: `ops.yml` offers only `register` and `make-admin`.

**E7.** Verified: `grants` appears in `charts/answerable/mcps.json` (lines 13 and 32), and no template, ops or pipeline source reads it.

**E9.** Verified: `mcps/Dockerfile:27-32` copies six named packages.

**E10.** Verified: `values.yaml` sets `enabled: true`, and no overlay, tfvars, kind stack or workflow sets it false.

**E11.** Partly verified:
- `hostClientIds` is passed outside tests, by `scripts/mcp/local-access.ts:38`, as `[hostClientId]`, into the shared enablement plan;
- that the tool's input is reached only by tests is read only.

**E12.** Two of the four drifts verified:
- `charts/answerable/README.md:9` says 54,040 bytes (5.2%) at 200 MCPs, where M9 measured 61,680;
- `charts/answerable/templates/ops.yaml:109` says the migrations are at -10 to -8, where they are -10 to -6.

**E13.** Read only: the runbook's step 2 says the new `mcps` package is private and the pull fails. Auditor E says `reports/staging-evidence.md` contradicts that.

**E2, E6 and E8:** read, consistent with the code; to be checked when they are proposed.

### Audit B: the database model (11 findings, received 2026-10-26)

**B2. Per-MCP roles don't separate MCPs that share a serving login.** Reproduced by this session in a throwaway database, `audit_coord_roles`, dropped afterwards with its three roles:
- A login was a member of roles `a` and `b`, and was inside `set local role a`.
- A plain read of `b`'s table was refused: `permission denied for schema sb`.
- `select set_config('role', 'b', true)` then made `current_user` `b`, and the read returned `b`'s row.
- This is Postgres's rule: a role change is checked against the session user's memberships. The Toolbox's and the standalone server's logins are members of every runtime role they serve, and the migrator of every owner role. So the roles stop a mistake, a schema named by accident, but not code that means to switch.

**B3.** Verified by reading:
- the scanner's pattern (`packages/mcp-postgres/src/migrate-mcp.ts:23`) matches `set role` and `set session authorization`, but not `set_config('role', …)`;
- the scanner blanks string literals before matching, so `'role'` inside `set_config` is invisible to it.

**B4.** Verified: `ensureLocalMcpDatabases` appears 29 times in code outside docs, definitions and calls together.

**B5.** Verified: no `mcps/*/src/db/grants.ts` exists. `scripts/mcp/database.ts:72` and `mcps/standalone/src/db/migrate-mcps.ts` still look for it.

**B7.** Verified: `mcps/standalone/src/db/schema.ts` holds only `evidenceEvents`, `evidencePayloads` and `intents`.

**B8.** Verified: `mcps/toolbox/scripts/migrate.ts:4` imports `../src/test/database`.

**B1, B6, B9, B10 and B11:**
- the facts behind B1 agree with A9 and C10: both `mcp.json` files declare `shared`;
- B6's timings are the auditor's measurements, not re-run here.

### Audit C: the SDK and the servers (17 findings, received 2026-10-26)

**C1 and C2** agree with E1. The facts are verified there, and the line counts are the auditor's.

**C3. Readiness now waits on the shared MCP pool.** Verified by reading:
- At the base, the Toolbox's `/health` ran `select 1` on its own database only (`git show 62b6b1b3:mcps/toolbox/src/toolbox.ts:134-141`).
- Now `health({ toolbox: db.$client, ...pools }, …)` also queries every MCP pool (`mcps/toolbox/src/toolbox.ts:87`).
- The chart's `readinessProbe` sets no `timeoutSeconds` (`charts/answerable/templates/_server.tpl:95-97`), so Kubernetes' 1 s default applies.
- The timings under load (1,525 to 3,029 ms) are the auditor's probe, not re-run here.
- The Toolbox's own pool also serves the calls' intents and evidence, so it could queue before the PR too, but less.

**C4. Every handler waits on the profile.** Verified:
- `context()` awaits `profile ??= profileOf(principal)` once per request, before any handler (`packages/mcp/src/server.ts:279-292`).
- `profiles` is required in `McpServerConfig` (`:59`).
- Outside the SDK, only `mcps/example` reads `person.name` or `organisation.name` (`example-status.ts:31`, `notes-add.ts:37`, `docs/caller.ts:12`).

**C8.** Verified: nothing outside tests reads `context.client`.

**C9.** Verified: register gives `toolbox-hub` `platform:read platform:write` (`infra/ops/src/register.ts`, `machine("toolbox-hub", …)`).

**C16.** Verified: `/health` answers `providers`, the mounted MCPs' ids (`packages/mcp-platform/src/health.ts:12`).

**C5, C6, C7 and C10 to C15:** read, consistent with the code. C5's timing is the auditor's probe.

### Audit D: the CLI (19 findings, received 2026-10-26)

**D3.** Verified: `--json` appears only in the CLI's tests and in `apps/web/content/docs/mcp/cli.mdx`. No workflow, script or package reads it.

**D9 = E7**, verified.

**D11 = M9's open item 2.** The auditor reproduced it with a probe.

**D17.** Verified: `.github/workflows/ci.yml` runs typecheck, lint, build, the web tests, `mcp:test`, `mcp:test:e2e` and ID's tests, never `mcp:check`.

**D1. The Claude Code sign-in to a local ID was never done by hand.** Agrees with `docs/goals/mcp-cli/progress.md`'s M7 entry ("Not done"). That a sign-in needs a company directory is the auditor's reading of ID: the owner's local ID has the Entra application (memory, 2026-09-14).

**D2, D6, D7 and D8:** the auditor's probes in a copy, not re-run here.

### Audit F: tests, docs and the developer's path (18 findings, received 2026-10-26)

**F1 = D1.** "Nothing else is needed" (`local-testing.mdx:24`) leaves out ID's migration and a sign-in for the platform organisation. The auditor verified that `setup.ts` has no domain or SSO step.

**F2.** Verified by reading:
- `packageJsonOf` drops only dependencies on `known` names, meaning declared or retired (`scripts/mcp/generate.ts:40-45, 61`);
- an MCP deleted before it was ever declared or retired keeps its `workspace:*` dependency;
- the auditor reproduced `bun install` failing on it.

**F3.** Verified:
- `tools.mdx:64` and `packages/auth/src/index.ts:16,43` say "Constrain every query by `organisation.id`";
- `add-a-tool.mdx:78` and the generated tool comment (`scripts/mcp/templates/tool.ts:25`) say "Do not filter by organisation".

**F11.** Verified: `bun.lock` records `mcps/admin` and `packages/id-admin` at 0.6.0, while their `package.json` files say 0.7.0. `bun install --frozen-lockfile` accepts this. The other five goal workspaces match.

**F18.** Verified: Bun 1.3.1's `bun run --help` offers `--filter` and `--workspaces`, with no concurrency flag, so `mcp:test` starts every matching suite at once. Measured by this session with `pr13-audit/X/run.sh`:
- It made N MCPs (`bun mcp new … --serve toolbox --no-check`) in a copy of the tree.
- It ran `bun run --filter '@answerable/mcp-auditx*' test`, as `mcp:test` runs them, while sampling `pg_stat_activity` every 0.2 s.
- Then it dropped every MCP with `forget()` and deleted the copy.

| MCPs | Made in | Suites | Time | Peak connections sampled (`answerable_mcps_test` / all) |
|---|---|---|---|---|
| 50 | 43 s | 50 pass, exit 0 | 5.0 s | 48 / 55 |
| 100 | 84 s | 99 pass, 1 refused (`sorry, too many clients already`), exit 1 | 11.4 s | 99 / 105 |

The development Postgres has `max_connections` 100, as CI's does (same Compose file). So `mcp:test` fails between 50 and 100 MCPs, while serving holds at 200. Afterwards, `traces` returned nothing for all 150 names, and no `auditx` role remains.

**F4 to F10 and F12 to F17:** read, consistent with the code. The counts and probes are the auditor's.

