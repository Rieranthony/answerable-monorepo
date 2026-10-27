Auditor A (typed configuration): I could not write `report.md`, because the harness refused it ("Subagents should return findings as text, not write report files"). I did not work around the refusal, so the full report is below. Please save it to `/private/tmp/claude-501/-Users-anthonyriera--claude-spares-spare-qQNK1r/787e1118-e76c-4109-a85a-7962b23a9563/scratchpad/pr13-audit/A/report.md`. The probes are in `/private/tmp/claude-501/-Users-anthonyriera--claude-spares-spare-qQNK1r/787e1118-e76c-4109-a85a-7962b23a9563/scratchpad/pr13-audit/A/probes/`.

# Pull request 13 audit, A: typed configuration

Worktree at 7ffd16b4, diff `62b6b1b3..7ffd16b4`. I changed nothing in the worktree.

## What I measured first

**The surface.** `packages/config/src/index.ts` is 115 lines. There are 20 `defineConfig` calls in 16 source files, defining 84 variables. That count leaves out `NODE_ENV`, which every definition adds, and the per-MCP fields, of which there are 0 today. The probe `drift.ts` confirms that the committed `default.env` (243 lines), `.env.example` (35) and `inventory.json` (1,053) match the generator, so the field counts below come from `jq` over `inventory.json`.

**How often each feature of a field is used (84 fields):**

| Feature | Fields | Notes |
| --- | --- | --- |
| `schema`, `doc` | 84 | Every field |
| `source` | 69 | chart 32, cluster 16, deploy 8, image 7, operator 6, none 15. Only `deploy` is tested; 3 `image` claims are wrong (A8) |
| `defaults` | 27 | **0 of 27 differ between development and test.** All 28 `locally(` calls in definitions give both profiles one value |
| `fallback` | 26 | No field has both a fallback and defaults |
| `secret` | 24 | 14 have defaults, so the production guard applies; on the other 10 it only fills the docs column |
| `optional` (computed) | 47 | Wrong for 3 fields (A8) |
| `refine` | 2 definitions | ID, and ops `register` |

**What reads the generated files.**
- **`default.env`:** no program reads it. 17 prose references point people at it.
- **`.env.example`:** people, who copy it to `.env`.
- **`inventory.json`:** read by:
  - the web docs, which render 9 of its 19 groups on 3 pages;
  - the web test;
  - `infra/pipeline/src/deploy.test.ts`, which reads the ID group's `source: "deploy"`;
  - people, sent there by docs/06.
- **All three files** are rewritten by every `bun mcp check`. Generating them takes 0.17 s.

**How many places describe one variable.** The definition, plus on average 2.94 Markdown or MDX files per variable. `ROOT_ADMIN_SECRET` is in 12 of them and `DATABASE_URL` in 9.

**What a developer touches to add a variable.**
1. The definition, and the service's mapping function.
2. The chart, if a deployment sets it.
3. `bun run env:inventory`, which rewrites three files to commit.
4. For an ID secret from the GitHub environment: `ID_ENV_NAMES` and both workflows. A test enforces this.

`turbo.json` already passes each service's prefix through, and the `dev` scripts read `.env` with `--env-file` inside the task, so nothing more is needed there.

## The decisions

| Decision | What it assumes | Measured or asserted | Verdict |
| --- | --- | --- | --- |
| **D1** (`NODE_ENV` is the only switch; unset means development) | Every deployed process sets `production` | Measured: three Dockerfiles set it, and `infra/k8s/local/stack.test.ts:129` asserts it. Unset fails open (A4) | Keep; fix A4 |
| **D2** (local defaults in code, secrets included) | A clone runs with no `.env`; a development instance cannot be reached from elsewhere | The first is measured in `progress.md`. The second is **false for ID** (A4) | Keep; simplify (A1); fix A4 |
| **D3** (one package) | One field shape serves every reader | Measured: 20 calls, and every feature has users except the development/test split (A1). An empty value gets two rules (A2) | Keep; simplify |
| **D4** (generated inventories and docs table) | Each generated file has a reader | `inventory.json` has readers; `default.env` has none (A3). docs/06's table became a pointer to the JSON instead of a rendered table | Partly delete |
| **D5** (secrets stay; `id-env` tied to ID's metadata) | The list can drift | Verified: `deploy.test.ts` ties `ID_ENV_NAMES` (7 names) to `source: "deploy"` and to both workflows, which pass `BETTER_AUTH_SECRETS` (`deploy-staging.yml:191`, `promote-production.yml:140`). The list is tested against the metadata, not read from it | Keep |
| **D6** (timing) | — | — | Moot |
| **D7** (no hostnames in application code) | — | Verified: the defaults name `localhost` 23 times and `127.0.0.1` 3 times, and no deployed host | Keep |

## Findings

### A1. Development and test defaults never differ, so `defaults` can be one local value
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `packages/config/src/index.ts:5,16-17,28-29,54-55,100-102`
  - `apps/web/lib/docs/configuration.ts:19-34`
  - `apps/web/lib/docs/configuration.test.ts:99-111`
  - `packages/config/README.md:24`
  - 28 `locally(` calls in 10 definition files
  - 27 `defaults` objects in `inventory.json`
- **What it is:** a field's `{ development?, test? }` defaults, `locally()`, and the docs branch that prints "`a` in development, `b` in test".
- **The assumption:** some variable needs a different test value. Measured: 0 of 27 do, and no field sets only one profile.
- **Proposal:** `local?: string`, used outside production. Delete `locally` and `Defaults`. The guard becomes `value === field.local`.
- **Removes:** about 25 hand-written lines, 81 generated lines, 1 export, 1 type, and the `locally` imports in 10 files.
- **Risk:** none visible to anyone.
- **Confidence:** verified (`jq`, `rg -c`).

### A2. An empty value follows two rules, and five places work around it by hand
- **Verdict:** simplify
- **Cost today:** medium
- **Where:**
  - `packages/config/src/index.ts:101`
  - `packages/config/src/index.test.ts:21-23`
  - `packages/config/README.md:23`
  - `scripts/env-inventory.ts:107` (the `default.env` warning)
  - The workarounds:
    - `infra/ops/src/commands.ts:115-116` (`present()`)
    - `apps/id/src/config.ts:38-42` (`optionalCredential`, 4 fields)
    - `mcps/toolbox/scripts/env.ts:16-17` and `mcps/admin/scripts/env.ts:16-17` (`role || runtimeRole`)
    - `scripts/mcp/environment.ts:13`
  - A third behaviour: `mcps/standalone/scripts/env.ts:14` refuses an empty runtime role.
- **What it is:** `defaults` fill an unset *or empty* variable; `fallback` fills an *unset* one only.
- **Probe (`semantics.ts`):**
  - In development, each of these empty values is refused: `PORT`, `DATABASE_POOL_MAX`, `ROOT_ADMIN_BREAK_GLASS`, `TRUSTED_PROXY_CIDRS`, `BETTER_AUTH_SECRETS`, `TOOLBOX_PORT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `ADMIN_FRESH_SECONDS`. An empty `DATABASE_URL` reads as its default.
  - Copying `default.env` to `.env` breaks 5 of 7 definitions, through 19 variables. Hence the header line "Most variables refuse an empty value".
- **The assumption:** D3's "no behaviour change under production". No number backs it. The chart does render empty values (`OPS_START_DEPLOYMENTS`, `OPS_ID_TOKEN`), which is why ops strips them.
- **Proposal:** in `read`, use `const raw = env[name] || undefined`. Then delete `present()`, `optionalCredential`, the two transforms, the fallback-only test, the README sentence and the warning.
- **Removes:** about 15 lines, one concept, and three different behaviours across the migration definitions.
- **Risk:** in production, a `""` value changes from refused to unset. A required variable is still refused, now as missing. An optional one now starts unset, for example `ROOT_ADMIN_SECRET=""` gives no root bearer. Deployments never send `""` for a required ID variable.
- **Confidence:** verified (probe and reading).

### A3. Delete `default.env` and the three hand-written groups
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `default.env` (243 lines)
  - `scripts/env-inventory.ts`: `:24` (`variable`), `:26-42` (the `reader` strings), `:43-78` (the `web`, `GitHub environment` and `infra tooling` groups), `:90-111`
  - `scripts/env-inventory.test.ts:10-15`
  - `scripts/mcp/commands/check.ts:12`
  - 17 prose references: `README.md:57`, `AGENTS.md:61`, `apps/id/README.md:17`, `apps/id/src/config.ts:44`, `apps/web/lib/docs/configuration.ts:57`, `mcps/admin/README.md:19`, `mcps/toolbox/README.md:22`, `mcps/standalone/README.md:11`, `packages/config/README.md:3,25,38`, `packages/config/src/index.ts:18`, `docs/11-admin-mcp.md:155`, `apps/web/content/docs/admin/index.mdx:263`, `apps/web/content/docs/toolbox/index.mdx:284`, `.env.example:2`
- **What it is:**
  - `default.env` shows less than `inventory.json`: no secret flag, defaults, source or optional.
  - `rg` finds no program that reads it.
  - Copied as `.env`, it breaks 5 of 7 definitions (A2).
  - The 17 variables of the three hand-written groups are already documented in `apps/web/.env.example` and `apps/web/README.md`, `infra/README.md`, `docs/12-deployment.md`, `infra/civo/README.md` and `infra/k8s/local/README.md`. No page renders those groups.
  - docs/06:61 already points operators at `inventory.json`, so people have two inventories to choose from.
- **The assumption:** AGENTS.md's older rule for a hand-kept inventory. The typed definitions now do that job.
- **Proposal:** keep `.env.example` and `inventory.json`. Delete `default.env`, the hand-written groups, `reader`, and the cross-group dedupe. Point the 17 references at the docs tables or at `inventory.json`.
- **Removes:** 243 generated lines, about 55 lines of script, and about 120 generated JSON lines (measured with `jq`).
- **Risk:** people lose a flat list of names. If the owner wants to keep it, delete only the hand-written groups: about 36 + 120 lines.
- **Confidence:** verified (`rg`, probe, `jq`).

### A4. ID in development listens on every interface and accepts a committed root bearer
- **Verdict:** defect
- **Cost today:** medium
- **Where:**
  - `apps/id/src/config.ts:113-121` and `:70-78`
  - `apps/id/src/runtime.ts:88-92` (`Bun.serve` with no hostname)
  - `packages/config/src/index.ts:57`
  - `apps/id/src/http/principal.ts:215-244`
  - `apps/id/src/app.ts:54-62` (the untrusted-ingress check runs in production only)
- **What it is:**
  - D2 gives `ROOT_ADMIN_SECRET` a committed value. At 62b6b1b3, `.env.example` had it commented out.
  - Probes:
    - `serve2.ts`: `lsof` shows `TCP *:<port>` for a `Bun.serve` with no hostname.
    - `semantics.ts` case 2: with `NODE_ENV` unset and the secrets left out, ID reads both committed secrets. At the base it failed closed.
    - `semantics.ts` case 5: an empty `ROOT_ADMIN_SECRET` still gives the committed value, so root cannot be switched off in development.
  - So any device on the network can call `/api/admin/*` as root on a local ID that has no platform administrator yet. `bun mcp setup` relies on that unlocked state.
  - The three MCP servers already bind `127.0.0.1` by default.
- **The assumption:** that a development instance cannot be reached from elsewhere. Nobody measured it, and it is false for ID.
- **Proposal:**
  - `hostname: environment.nodeEnv === "production" ? undefined : "127.0.0.1"`, or an `ID_HOST` variable that the image sets to `0.0.0.0`, as it does for the servers.
  - Optional: refuse the committed secrets when `BETTER_AUTH_URL` is not a loopback address.
- **Removes:** nothing (adds about 1 line); it closes an exposure.
- **Risk:** anything that reaches a local ID from outside the machine would stop working; `rg` finds none. `localhost` resolving to `::1` is worth checking with one `bun dev`.
- **Confidence:**
  - Verified by probe: the bind address and the defaults.
  - Read only: the root path.

### A5. `parseEnvironment` is a public SDK export used only by the three platform servers
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `packages/mcp/src/environment.ts` (38 lines) and its test (27)
  - `packages/mcp/src/index.ts:12`
  - `packages/mcp/package.json`
  - `packages/mcp/src/server.ts:51`
  - `apps/web/content/docs/mcp/reference.mdx:1211-1243`
  - `apps/web/content/docs/mcp/servers.mdx:105`
  - `apps/web/content/docs/mcp/index.mdx:93`
- **What it is:** it has 3 callers: the Toolbox, the admin MCP and the standalone server. An MCP made by `bun mcp` reads no environment, and `rg` finds none in the templates, e2e or example. It makes the SDK depend on `@answerable/config`. M4's brief planned to delete it.
- **The assumption:** someone will write "a server of your own". None exists.
- **Proposal:** move it to `@answerable/mcp-platform`, which all 3 callers already import. This overlaps auditor C.
- **Removes:** 1 export, one dependency, about 33 reference lines, and 1 paragraph.
- **Risk:** none outside the repository.
- **Confidence:** verified (`rg`).

### A6. Three ops variables are never set to anything but their default
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `infra/ops/src/commands.ts:57,64,77,78`
  - `infra/ops/src/kubernetes.ts:104,109`
  - `charts/answerable/templates/ops.yaml:139-142,151-154`
  - `charts/answerable/values.yaml:151`
  - `infra/k8s/charts.test.ts:225,229`
  - `infra/ops/README.md:29,31,38,74`
  - `infra/ops/src/admin-api.ts:114`
- **What it is:**
  - **`OPS_NAMESPACE`:** the chart sets it to `metadata.namespace`. Unset, the code reads the ServiceAccount's mounted namespace, which is the same value.
  - **`OPS_PLATFORM_SLUG`:** nothing sets it. ID hard-codes the same slug as a constant (`apps/id/src/env.ts:23`), and docs/06 says it is not configurable.
  - **`OPS_DATABASE_SSLROOTCERT`:** nothing sets it. Its fallback is the chart's mount path.
  - **`OPS_CLAUDE_CALLBACK_PORT`:** its 47700 is written twice, once in the code and once in `values.yaml`.
  - Only tests set any of these. All four predate the PR, which typed them.
- **The assumption:** they may need to differ one day.
- **Proposal:** make the first three constants. Keep one default for the callback port.
- **Removes:** about 20 lines, 3 variables and 3 inventory rows.
- **Risk:** if someone renamed the platform organisation's slug, a code change would follow. ID binds the organisation by id.
- **Confidence:** verified (`rg`, the chart).

### A7. The chart sets four `*_DATABASE_RUNTIME_ROLE` variables to the only values that work
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `charts/answerable/values.yaml:75,100,114,128`
  - `charts/answerable/templates/migrations.yaml:67,75,77,92`
  - `infra/k8s/charts.test.ts:437`
  - `infra/ops/src/bootstrap.ts:13`, which hard-codes the login `answerable_${name}_runtime`
- **What it is:** each value equals both the definition's fallback and the login bootstrap creates. No overlay changes them. Any other value would grant a role that no service logs in as.
- **The assumption:** the role name is per deployment. It is not, without also editing `bootstrap.ts`.
- **Proposal:** delete the 4 values and the chart's environment lines. Keep the variables as a test seam (`apps/id/src/db/migrate-script.integration.test.ts:23`).
- **Removes:** about 10 lines and 1 assertion.
- **Risk:** none.
- **Confidence:** verified.

### A8. The metadata says false things about six fields
- **Verdict:** defect
- **Cost today:** low
- **Where:**
  - `packages/config/src/index.ts:90`
  - `apps/id/src/config.ts:107-112,128-139,169-189`
  - `infra/ops/src/commands.ts:73,113`
  - `mcps/toolbox/src/environment.ts:31`, `mcps/admin/src/environment.ts:10`, `mcps/standalone/src/environment.ts:16`
  - `docs/06-deploying-answerable-id.md:61`
- **What it is:**
  - `optional: true` on `TRUSTED_PROXY_CIDRS` and `BETTER_AUTH_TRUSTED_ORIGINS`, which production requires through `refine`.
  - `optional: true` on `OPS_ID_ROOT_SECRET`, which `make-admin` requires.
  - `source: "image"` on the three server ports, which no Dockerfile sets. I checked every source claim against the chart and the Dockerfiles; these 3 were the only failures.
  - docs/06 sends operators to that JSON.
- **The assumption:** metadata that is computed or hand-asserted stays true. Only `deploy` is tested.
- **Proposal:** drop `source` on the ports. Add a docs/06 sentence saying `refine` adds production requirements the metadata does not show.
- **Removes:** 3 wrong claims.
- **Risk:** none.
- **Confidence:** verified (`jq`, search of the chart and Dockerfiles).

### A9. Per-MCP database variables are generated for MCPs that do not exist
- **Verdict:** delete, if B drops the `own` mode
- **Cost today:** low
- **Where:**
  - `packages/mcp-platform/src/configuration.ts` (25 lines) and its test (14)
  - `mcps/toolbox/src/environment.ts:3,8,12,44`
  - `mcps/standalone/src/environment.ts:3,8,12,47`
  - `mcps/standalone/scripts/env.ts:29-37`
  - `apps/web/content/docs/mcp/servers.mdx:103`
- **What it is:**
  - Each `own` MCP adds two runtime-URL variables to the definitions and the docs tables, and rewrites the inventories.
  - Its migration variable `MCP_<NAME>_DATABASE_MIGRATION_URL` is not inventoried, which is inconsistent.
  - 0 of 2 declared MCPs are `own` today.
- **The assumption:** belongs to auditor B.
- **Proposal:** delete if B drops `own`. Otherwise inventory the migration variable too.
- **Removes:** about 60 lines.
- **Risk:** see B.
- **Confidence:** verified.

### A10. The chart's MCP list is parsed by two schemas under two variable names
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `infra/ops/src/commands.ts:45-55,65-69,105`
  - `packages/mcp-postgres/src/declared.ts:23-36`
  - `mcps/standalone/scripts/env.ts:26`
- **What it is:** the same JSON goes in as `OPS_MCPS` and `MCPS_DECLARED`. Register's `registeredMcps` skips the name and duplicate checks that bootstrap's `declaredMcps` runs.
- **Proposal:** one `declaredMcps` schema, with `scopes`. This overlaps auditors D and E.
- **Removes:** about 12 lines.
- **Risk:** none.
- **Confidence:** read only.

### A11. `ADMIN_FRESH_SECONDS`'s default lives outside its definition
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `mcps/admin/src/environment.ts:28,45`, `mcps/admin/src/admin.ts:34`, `mcps/admin/src/test/admin.ts:90`
- **What it is:** the 1800 lives in `createAdminMcp`, so the docs table shows "Optional" instead of 1800.
- **Proposal:** `fallback: "1800"`, make `freshSeconds` required in `createAdminMcp`, and have the test helper pass `?? 1800`.
- **Removes:** one copy of the default; net about 0 lines.
- **Risk:** none.
- **Confidence:** read only.

### A12. ID's README restates the definitions in prose
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `apps/id/README.md:17`, about 330 words.
- **What it is:** it restates `config.ts`, `env.ts` and docs/06. It is accurate today. This overlaps auditor F.
- **Proposal:** two sentences and a link.
- **Removes:** about 250 words.
- **Risk:** none.
- **Confidence:** verified.

## Kept
- **D1:** no `staging` profile; the images set production, and a test asserts it.
- **The `@answerable/config` package:** 115 lines, with readers in 7 workspaces.
- **The production guard on secrets:** 4 lines, covering 14 secrets.
- **Separate test-database definitions:** the failure they prevent was seen during the build, and CI and the parallel audits use the variables.
- **`inventory.json` as the docs' source:** it keeps the Next build from importing every server. Generating it takes 0.17 s.
- **`<Configuration>`:** it replaced 3 hand-written tables. docs/06's hand-written table had drifted once.
- **`.env.example`:** generated from 10 names.
- **D5 and D7:** as in the table above.
- **The chart's variables:** all 51 names have a reader, except Bun's own `NODE_EXTRA_CA_CERTS`.
- **The per-command ops definitions (`pick`).**
- **The `*_MCPS_ROLE_PREFIX` variables:** only tests set them, and spawned entry-point tests need them as environment variables; whether the prefixes exist at all is auditor B's call.
- **`ConfigError`:** 3 callers.

## Cleanup
- **Created only probes** in `/private/tmp/claude-501/-Users-anthonyriera--claude-spares-spare-qQNK1r/787e1118-e76c-4109-a85a-7962b23a9563/scratchpad/pr13-audit/A/probes/`: `drift.ts`, `semantics.ts`, `serve.ts`, `serve2.ts`, `names.txt`, `chart-names.txt`, `prose-counts.txt`. No database, role, copy of the tree, container or `bun mcp` run.
- **Processes:** none left running. The two `Bun.serve` probes used port 0 and stopped. Ports 47300, 47400, 47510 and 47520 have no listener.
- **Worktree side effect:** `bun test` in `packages/config` (7 pass, 100% coverage) rewrote the git-ignored `packages/config/coverage/lcov.info`. No tracked file changed; `git status` shows only `docs/goals/pr13-audit/progress.md`, which is the coordinator's.

## Findings, one line each
- A1, simplify, low, `packages/config/src/index.ts:5`: development and test defaults never differ (0 of 27), so `defaults` and `locally` become one `local` value. Removes about 25 lines, 81 generated lines, 1 export and 1 type.
- A2, simplify, medium, `packages/config/src/index.ts:101`: an empty value gets a default but not a fallback, so 19 variables refuse `""` and 5 places work around it by hand. Treating empty as unset removes about 15 lines and 1 concept.
- A3, delete, low, `default.env:1`: no program reads `default.env`, it shows less than `inventory.json`, and copying it breaks 5 of 7 definitions. Delete it with the 3 hand-written groups: 243 + about 55 + about 120 lines.
- A4, defect, medium, `apps/id/src/runtime.ts:88`: ID in development listens on every interface and accepts the committed root bearer, and it fails open with `NODE_ENV` unset. Bind to loopback outside production. Adds 1 line.
- A5, simplify, low, `packages/mcp/src/environment.ts:23`: `parseEnvironment` is an SDK export with 3 callers, all platform servers. Move it to `mcp-platform`: 1 export, the SDK's dependency on config, and about 33 reference lines.
- A6, delete, low, `infra/ops/src/commands.ts:57`: `OPS_NAMESPACE`, `OPS_PLATFORM_SLUG` and `OPS_DATABASE_SSLROOTCERT` are only ever set to their default. Make them constants: about 20 lines, 3 variables.
- A7, delete, low, `charts/answerable/values.yaml:75`: the 4 `runtimeRole` values must equal what bootstrap hard-codes. Drop them from the chart: about 10 lines.
- A8, defect, low, `packages/config/src/index.ts:90`: `optional` is wrong for 3 fields production requires, and `source: "image"` is wrong for 3 ports. Removes 3 wrong claims.
- A9, delete if B drops `own`, low, `packages/mcp-platform/src/configuration.ts:11`: per-MCP database variables are generated for 0 `own` MCPs. About 60 lines.
- A10, simplify, low, `infra/ops/src/commands.ts:46`: one MCP list is parsed by two schemas under two variable names. About 12 lines.
- A11, simplify, low, `mcps/admin/src/admin.ts:34`: `ADMIN_FRESH_SECONDS`'s default lives outside its definition. Net about 0 lines, 1 copy of the default removed.
- A12, simplify, low, `apps/id/README.md:17`: the README restates ID's definitions in about 330 words. About 250 words.