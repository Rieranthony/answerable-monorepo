# Progress

## Session 1: 21 October 2026

- Read the brief, AGENTS.md, the package, both servers, ID's drizzle model, the chart, the Dockerfiles, infra/ops, the acceptance, the kind stack test, the docs that mention the migrator.
- Checked the development Postgres on 47432 (PostgreSQL 17.9; the seven databases exist), no kind cluster, Docker up.
- Installed the worktree's dependencies from the lockfile.
- Wrote task_plan.md, findings.md, progress.md.

## Gates

(Filled as each runs.)
- `packages/mcp-postgres` on drizzle: schema, connect, migrate with legacy adoption, evidence, intents, runtime role, testing helpers (`rowsOf`, `refusalOf`, `scratch`), drizzle folder generated (0000_initial, 0001_evidence_chain). Suite: 44 pass, 0 fail, 100% lines and functions; tsc and eslint clean.
- Dependencies raised for the whole repository: drizzle-orm 0.45.4, drizzle-kit 0.31.11, pg 8.23.1, @types/pg 8.23.1 (ID's package.json too).
- `mcps/toolbox` on drizzle: composed schema with the `tsvector` generated column as a `customType`, catalogue, search and admin queries, migrate module with the Toolbox's legacy baseline, drizzle folder, adoption test comparing the legacy and the fresh catalogues. Suite: 83 pass, 0 fail, 100%.
- `mcps/admin` on drizzle: schema re-exporting the package's tables, migrate module, drizzle folder, adoption test. Suite: 126 pass, 0 fail, 100%.
- Bun's isolated linker gave each workspace its own `drizzle-orm` instance per set of resolved optional peers, which made the package's and the Toolbox's drizzle types incompatible (private `shouldInlineParams`): `bunfig.toml` now sets the hoisted linker, the lockfile re-resolved, the four Dockerfiles keep `bunfig.toml` in their manifests stage.
- `infra/ops` on a pg pool through `connect` (61 pass, 100%); the acceptance kit's `createDatabase` on `connect`, the journeys on `rowsOf`; the kind stack's TLS probe on pg.
- Commits 2cc45e89 (code) and 0f19462e (docs).
- The scaffold test linked `mcps/e2e/node_modules` into its temporary server, which the hoisted linker no longer has: it links the repository's `node_modules` at the temporary root and the e2e server's only when it exists. Scripts suite: 16 pass.

## Gates

| Gate | Result |
|------|--------|
| `bun run typecheck` | 17 tasks successful |
| `bun run lint` | 17 tasks successful |
| `bun run build` | 3 tasks successful |
| `bun run mcp:test` | auth 62, id-admin 17, mcp 112, mcp-postgres 44, mcp-e2e 19, mcp-example 14, mcp-toolbox 83, mcp-admin 126, infra-ops 61, infra-pipeline 89, scripts 16 (after the link fix), all 100% lines and functions where gated |
| `bun --filter web test` | 88 pass, 0 fail |
| `bunx knip` | no unused files, exports or dependencies (configuration hints only, as before) |
| `bun run infra:check` | passed (charts, Terraform, trivy, actionlint) |
| `bun test charts.test.ts` in `infra/k8s` | 82 pass, 0 fail |
| `bun --filter @answerable/id test` (first run) | 1486 pass, 2 fail, 21,889 expect() calls, 130 files, 333 s: the two failures were `src/auth/native-shapes.test.ts` reading `apps/id/node_modules/@better-auth/oauth-provider/dist/`, which the hoisted linker leaves at the root; fixed in 62f883ad to resolve the package; the file passes alone, the full suite runs again below |
| `bun run mcp:test:e2e` | 57 pass, 0 fail, 5 files, 127 s; the platform organisation's chain verified with 133 events, the Toolbox journeys' 46 events in 3 chains verified |
| `bun --filter @answerable/id test` (second run, after 62f883ad) | 1488 pass, 0 fail, 130 files, 293 s, 100% lines and functions |
| `bun run infra:test` (the kind stack, once; no cluster existed before, none after) | 105 pass, 0 fail, 2 files, 191 s: the chart tests and the stack, with the images built from this branch |

- Commits: 2cc45e89 (the move), 0f19462e (docs), e4ac9de8 (scaffold test links the root's node_modules), 62f883ad (ID's shape test resolves the package), and the plan files' final commit.
