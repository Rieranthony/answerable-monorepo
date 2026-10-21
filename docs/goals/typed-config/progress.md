# Typed configuration: progress

## 2026-10-21

- Read the loaders: `apps/id/src/env.ts` (15 variables, zod, `NODE_ENV` three values, production refinements), `packages/mcp/src/environment.ts` (`parseEnvironment`, `readMcpEnvironment`), `mcps/toolbox/src/environment.ts` (9), `mcps/admin/src/environment.ts` (10), `infra/ops/src/commands.ts` (14 `OPS_*`), `infra/pipeline/src/environments.ts` (`ZONES`, `hostsFor`), the chart's `id.yaml`, `toolbox.yaml`, `admin-mcp.yaml`, `ops.yaml`, `_server.tpl`, `_helpers.tpl`, the four Dockerfiles, `bootstrap.yml`, `deploy-staging.yml`, `promote-production.yml`, `default.env`, `.env.example`, `apps/web/.env.example`, docs/06's configuration table, `apps/id/src/env.test.ts` (the inventory test).
- Wrote `findings.md`: the inventory tables and the three findings.
- Corrected the tutorial's step 6.1 (`UPSTREAM_TOKEN_SECRETS` no longer exists; nine names after the bootstrap) and republished it.
- Wrote the plan and the report; published the report at https://claude.ai/artifact/YEqw1PL8TRpWJqVxBNsuiR.
- Nothing coded. B1 and B2 wait for the decisions.

Report: https://claude.ai/artifact/YEqw1PL8TRpWJqVxBNsuiR (private to the owner).
