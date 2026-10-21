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
