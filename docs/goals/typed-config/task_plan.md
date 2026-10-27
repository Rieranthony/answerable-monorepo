# Typed configuration: plan

**Goal.** One typed place per service that says which variables it reads, which are secrets, and what each defaults to in development and test, so that a clone runs without a `.env`, the inventories and the docs table are generated rather than hand-written, and the secrets keep flowing exactly as they do today: five pasted into the GitHub environment, the rest generated where they are used.

**Asked on 2026-10-21** by the owner at step 6.1 of the staging tutorial: "What about the other secrets / var envs? What are the defaults? Maybe we should have our var env default being set in code (local have default localhost, same for staging and prod). This way we don't have to have var env as secret for everything. We just pass a node env (staging, development, production). If var env are present, they overwrite defaults. Plan with files, we should have a central place that manages secrets and envs and typed. Other actual secrets, salts and everything should live in GitHub secrets and passed at build / deploy time." Then: "report before coding".

**Status:** D1 to D7 approved by the owner on 2026-10-21 ("Continue the tutorial first; run B1 and B2 after staging/first"). Briefs written: `briefs/b1.md`, `briefs/b2.md`. Built on 2026-10-25, after staging went live at `staging/fourth`. B1 (93e214a1), one zod (6028e410) and B2 (3b51c241) are on branch `claude/typed-config-b1`, in pull request #13 (https://github.com/Rieranthony/answerable-monorepo/pull/13), which the owner asked for. Planning files: this one, `findings.md` (the inventory, every claim read from the tree at e7bce746), `progress.md`, `report.md` (the report's text; published at the link in `progress.md`).

## Phases

| # | Phase | Status |
| --- | --- | --- |
| 1 | Inventory: every variable, its reader, secret or not, its default, who sets it in staging | complete |
| 2 | Design: what moves into code, what stays in the chart and the GitHub environment | complete |
| 3 | Report with the decisions D1 to D7 | complete |
| 4 | B1: `packages/config`, the five readers on it, development and test defaults, generated inventories | complete: 93e214a1, in #13 |
| 5 | B2: the docs component, docs/06, the pipeline's `id-env` list from the metadata, `BETTER_AUTH_SECRETS` in the deploy steps, runbook | complete: 3b51c241, in #13 |
| 6 | Ship under the second staging tag; prove with the smoke test and a `bun dev` from a clone with no `.env` | after #13 merges: the next staging tag |

## Decisions (approved 2026-10-21; the report has the reasons)

- **D1** `NODE_ENV` stays the only mode switch, with its three values `development`, `test`, `production`. No `staging` value, no per-environment branch in application code: staging and production run the same production profile and differ only in hostnames, scale and secrets, which stay in the chart overlay, the tfvars and the GitHub environment.
- **D2** Development and test defaults move into code: every non-secret variable of ID, the Toolbox and the admin MCP gets its localhost value as the `development` and `test` default, and each service's own secrets (`BETTER_AUTH_SECRET`, `ROOT_ADMIN_SECRET`) get a fixed development-only value that the production profile refuses. `.env` becomes optional for ID and holds only credentials issued elsewhere.
- **D3** One shared package, `packages/config` (`@answerable/config`): `defineConfig(label, fields)`, each field `{ schema, secret, default?: { development?, test? }, doc }`, returning a typed `read(env)` that names the variable it refuses, and the fields' metadata. ID's `env.ts`, the Toolbox's and the admin MCP's `environment.ts`, the ops Jobs' `commands.ts` and the SDK's `readMcpEnvironment` move onto it. No behaviour change under `NODE_ENV=production`.
- **D4** Generated, not hand-written: `default.env` and `.env.example` come from the metadata (`bun run env:inventory`), and a test fails when either drifts, as the OpenAPI snapshot and the MCP reference do today. docs/06's configuration table becomes `<Configuration service="id" />`, rendered from the same metadata with a Markdown form.
- **D5** Secrets do not move. The GitHub environment keeps its 14 names. The pipeline's list of what goes into `id-env` is read from ID's metadata (the secrets the deploy delivers), so a new ID secret fails a pipeline test until a workflow hands it over. In the same stroke, close the gap found on the way: the deploy steps never pass `BETTER_AUTH_SECRETS`, so the ring rotation the runbook describes cannot happen through the pipeline.
- **D6** Timing: after `staging/first`. The change is to how the services read their environment; staging proves the current build first, and this ships under the second staging tag.
- **D7** Hostnames stay where Kubernetes, DNS and the certificates read them: the tfvars, the chart overlay and the pipeline's `ZONES`, already tied together by the chart tests and the pipeline tests. They do not go into application code.

## Not proposed, and why

- A `staging` profile in code: it would be the first place where staging and production run different code, which is what staging exists to rule out.
- A `config.<environment>.yaml` in the repository read by the services: the chart overlay is already that file for the cluster, and a second one drifts.
- Reading secrets at build time into the image: an image is public on GHCR and immutable by digest; secrets reach the pods at deploy time, as Kubernetes Secrets, and stay there.

## Errors encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
| The tutorial's step 6.1 named `UPSTREAM_TOKEN_SECRETS`, which the v0 code audit removed on 2026-10-20 | 1 | Corrected the sentence to the four generated names and republished the tutorial |
