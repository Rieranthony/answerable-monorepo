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

None yet: phase 3.
