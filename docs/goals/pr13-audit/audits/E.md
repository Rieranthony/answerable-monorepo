# Pull request 13 audit, section E: shipping and registration

Auditor E. Tree `claude/typed-config-b1` at 7ffd16b4, diff `62b6b1b3..7ffd16b4`. Read-only on the worktree: every command that writes (tests, `infra:check`, `helm template` probes) ran in a copy under this folder (`copy/`, made with `git ls-files -z --cached --others --exclude-standard`, `bun install --frozen-lockfile`), deleted at the end.

## What I ran

| Check | Result |
| --- | --- |
| `bun test` in `infra/ops` (copy) | 75 pass, 0 fail, 100% lines and functions, 0.4 s |
| `bun test` in `infra/pipeline` (copy) | 99 pass, 0 fail, 100% lines and functions, 0.4 s |
| `bun test charts.test.ts` in `infra/k8s` (copy, Helm only) | 92 pass, 0 fail, 9.4 s; the release at 200 MCPs is 61,572 bytes stored (5.9% of 1 MiB), 37,524 at 0 MCPs |
| `bun run infra:check` (copy) | Passed, 43 s |
| `helm template` probes (copy) | Production render: 7 hook Jobs, 4 Deployments, 4 Ingresses. Without `grants` in `mcps.json`: all three overlays render byte-identical. With e2e served `toolbox`: no standalone Deployment, but `standalone-migrate` and the standalone Secrets in the ops Role remain |

Not run: the kind stack, the acceptance, anything against Civo or a cluster (the brief forbids them).

## The inventory: what ships, and what each piece guards against

**Hook Jobs, every deploy** (verified by the production render). Before the PR: `ops-bootstrap`, `id-migrate`, `toolbox-migrate`, `admin-migrate`, and `ops-register` on the first install only. After: those plus `standalone-migrate` and `mcps-migrate`, and `ops-register` on every deploy: 7 Jobs, one pod each, run one at a time.

| Job | Weight | Guards against | Added by the PR |
| --- | --- | --- | --- |
| `ops-bootstrap` | -20 | Databases, logins and URL Secrets made by hand; now also each MCP's schema and roles | Extended |
| `id-migrate` | -10 | ID's schema behind its image | No |
| `toolbox-migrate` | -9 | The Toolbox's own database behind its image | No |
| `admin-migrate` | -8 | The admin MCP's database; kept apart so its owner login stays in one Job (D15) | No |
| `standalone-migrate` | -7 | The standalone server's own database (intents, evidence) behind its image; runs even with no standalone MCP | Yes |
| `mcps-migrate` | -6 | Each MCP's schema behind the image | Yes |
| `ops-register` | +10 | ID's rows drifting from what the code declares; a new standalone MCP without its resource and client | Every deploy now |
| `ops-make-admin` | +20 | On request, once per environment | No |

Measured cost of the Jobs' own work: `mcps-migrate` 0.1 s for 2 MCPs in kind (M5), `register` 0.8 to 1.3 s in kind (M6). Pod start per Job on Civo is not measured; before the PR, kind's "install with bootstrap" took 19 s for four hook Jobs (civo-deploy progress, line 85), so roughly 5 s per Job there (estimate). The kind stack in CI is unchanged in time: 236 to 254 s before, 239 s after (M9).

**Machine clients in a deployed ID.** `toolbox-hub` and `admin-mcp` (before); `ops-register` (`platform:read platform:write`, new) and `standalone-hub` (`platform:read`, new). Host clients: `claude-code-toolbox`, `claude-code-admin`, and one `claude-code-<name>` per standalone MCP (new: `claude-code-e2e` today). Locally only: `mcp-dev` (new, auditor D).

**Secrets the PR adds in the namespace:** `standalone-database`, `standalone-database-owner`, `mcps-database-owner`, `toolbox-mcps-database`, `standalone-mcps-database`, `standalone-id-client`, `ops-id-client`, and `ops-staff-token` (placed by hand); plus two per `own` MCP. Databases added: `answerable_standalone`, `answerable_mcps`, one per `own` MCP.

**From a commit on `main` to a person using a new MCP** (read from the runbook and code):

1. `git tag staging/<n> main` and push. The run: guard, CI (validate, `infra:check`, the kind stack, about 4 minutes), Terraform twice, three image builds, deploy (bootstrap, five migrations, rollout, `--wait`, register), smoke.
2. A Toolbox MCP: staff prepare and commit `toolbox_enable` for each organisation, then `access_grant` of its grant string. The person's existing Toolbox connection shows the tools.
3. A standalone MCP: staff prepare and commit `standalone_enable` (with `everyone: true` it also grants). Then each person runs `claude mcp add … https://mcp.<zone>/<name>/mcp --client-id claude-code-<name> --callback-port 47700` and signs in.
4. Production: `git tag production/<n> <commit>`, the owner's approval, then step 2 or 3 again in production.

A standalone MCP costs every person a new connection; a Toolbox MCP costs none.

## Findings

### E1. The standalone server, and everything that ships it, runs in every environment for one MCP: e2e, the test reference server
- **Verdict:** delete (with C), or at least simplify
- **Cost today:** medium
- **Where:**
  - `mcps/e2e/mcp.json:4` and `charts/answerable/mcps.json:6` (`"serve": "both"`), the only standalone or `both` MCP;
  - `mcps/standalone/src/served.generated.ts:7-9` (e2e alone);
  - `charts/answerable/templates/standalone.yaml:1-41`, `values.yaml:28-34,117-129`, `migrations.yaml:85-92`;
  - `infra/ops/src/register.ts:153-156`, `registrar.ts:130-141`;
  - `infra/civo/envs/staging.tfvars:20`, `production.tfvars:25`;
  - `mcps/admin/src/standalone.ts`, `enablement.ts`;
  - `infra/k8s/local/stack.test.ts:626-697`, `infra/k8s/local/standalone-sign-in.ts`.
- **What it is:**
  - Every environment runs the standalone Deployment: 2 to 3 replicas in staging, 2 to 4 in production, 100m CPU and 128Mi requested each.
  - Around it:
    - the `mcp.<zone>` record and a reissued origin certificate;
    - `standalone-hub` and its Secret;
    - `answerable_standalone` with 2 logins and 2 Secrets, and the `answerable_mcps_standalone` login with its Secret;
    - the `standalone-migrate` Job;
    - in ID, `e2e`'s resource, `claude-code-e2e` and their link;
    - `standalone_enable` in the admin MCP;
    - one smoke check per standalone MCP;
    - in CI, a second `mcps` image built and deployed in the kind stack, plus two browser sign-ins (the after-lock proof).
  - The only MCP this serves in staging and production is e2e. D14 calls e2e the proof that a database-backed MCP ships both ways; it is not a product.
- **The assumption:** that standalone MCPs are needed now (D2, D6). No MCP in `mcps/` other than e2e is standalone. The 200-MCP numbers are measured on the database and the chart; no number shows demand for standalone serving.
- **Proposal:**
  - **(A) With C, delete standalone serving until the first real MCP needs it.** In this area that removes:
    - `standalone.yaml`, the `standalone` values and overlays, and the `mcp` hostname in both tfvars;
    - the `hostnames.mcp` origin, `OPS_MCP_URL`, register's per-MCP loop and `registerStandalone`, and `standalone-hub`;
    - `standalone-migrate` and the standalone Secrets in the ops Role;
    - `standalone_enable`, `enablement.ts`, `access.ts`'s `standaloneNeedsClient` and `ADMIN_STANDALONE_ORIGIN`;
    - the smoke's per-MCP check, the kind stack's after-lock proof and `standalone-sign-in.ts`;
    - `infra/postgres/init/007`.

    Register on every deploy stays: it is simpler than the conditional it replaced (see Kept). With no per-MCP rows, the case for `ops-register` narrows to rotation.
  - **(B) The minimum, one line:** serve e2e `toolbox`. The chart then renders no standalone server in any environment; the kind stack's after-lock proof still deploys one (it serves `example` `both`). This reverses part of D14 and still leaves the always-on pieces of E2.
- **Removes (A), measured by block in this area:** 671 lines:
  - whole files: `standalone.yaml` 41, `standalone-sign-in.ts` 71, admin `standalone.ts` 84, `enablement.ts` 71, init `007` 20;
  - blocks: `standalone-migrate` 8, the values block 13, `registerStandalone` 12, `standaloneNeedsClient` 9, the kind after-lock proof 72, its serving proofs 28, `nextRelease` 29, `next()` 11, `standalone_enable`'s tests 116, register's standalone tests 86.

  Also about 55 scattered lines (estimate) in register, commands, smoke, environments, deploy, the helpers, the ops Role, the network policy, the admin MCP's environment and provider, the overlays and the tfvars.

  Outside this area, `mcps/standalone`: 1,114 lines, plus 853 of drizzle snapshots (C). The concepts that go: a fourth hostname, a fourth server, a fourth machine client, per-MCP ID rows, a second enable tool, a second way for a person to connect.
- **Risk:** (A) loses a capability the owner approved (D2) and its staged proof through Cloudflare; bringing it back later is the M4 to M6 work again. (B) leaves `/e2e/mcp` unreachable on `mcp.<zone>`; nobody uses it. A person sees no change either way.
- **Confidence:** verified for the facts (the generated lists, the production render with 4 Deployments, the line counts). The proposal is a decision.

### E2. The standalone server is gated on having a standalone MCP, but its database, logins, Secrets, migration Job and machine client are not
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - gated: `charts/answerable/templates/_helpers.tpl:47-50,188-189`, `standalone.yaml:23`, `network-policies.yaml:11,51`, `ops.yaml:22,83`, `infra/pipeline/src/deploy.ts:294`;
  - not gated: `infra/ops/src/bootstrap.ts:31,35`, `migrations.yaml:5,85-92`, `ops.yaml:33,42`, `infra/ops/src/register.ts:154`.
- **What it is:** with e2e served `toolbox` (probe), the render has no standalone Deployment. It still has `standalone-migrate`, and the Role still names `standalone-database*`, `standalone-mcps-database` and `standalone-id-client`. The bootstrap still makes `answerable_standalone` and its logins, and register still mints `standalone-hub` with `platform:read`. Today the gated branch is reached only by `charts.test.ts`'s 0-MCP case, since e2e is `both`.
- **The assumption:** that the server may come and go with the list. Half the plumbing follows the list and half does not.
- **Proposal:** gate on one thing, one way:
  - if E1 (A) is taken, the question disappears;
  - if standalone stays and e2e stays `both`, delete the conditional and always render the server: about 10 lines of template and `deploy.ts:294`'s optional lookup;
  - if (B) is taken, gate the bootstrap entry, `standalone-migrate`, the Role names and `standalone-hub` on the same list.
- **Removes:** about 10 lines and one concept, "the server exists only while…" (estimate).
- **Risk:** none visible to a user.
- **Confidence:** verified (the `helm template` probe with e2e served `toolbox`, and reading `register.ts:154` and `bootstrap.ts:31`).

### E3. Test and documentation MCPs ship to production, so D10's own trigger has already fired
- **Verdict:** defect (an assumption the tree contradicts)
- **Cost today:** low
- **Where:** `mcps/toolbox/src/mounted.generated.ts:7-10`, `mcps/standalone/src/served.generated.ts:7-9`, `docs/goals/mcp-cli/decisions.md` D10, D14.
- **What it is:**
  - Every MCP under `mcps/` ships everywhere.
  - Production's Toolbox mounts e2e, whose tools create and delete records in Postgres, and `example`, the docs' quickstart. Before the PR it mounted e2e alone, with in-memory records (`git show 62b6b1b3:mcps/toolbox/src/server.ts`).
  - Production's ID gets `claude-code-e2e` and e2e's resource.
- **The assumption:** D10 says a per-environment switch is Not yet, with the trigger "the first MCP that must stay out of production while its commit ships". No decision says e2e or `example` belongs in production; D14 speaks of staging's test data. They arrive there only because there is no switch.
- **Proposal:** the owner decides, explicitly:
  - accept test MCPs in production's catalogue (harmless until staff enable them), and say so in docs/12; or
  - take E1 (B) at least, so production runs no server for them.

  Adding the switch is automating, so it comes last.
- **Removes:** nothing, or E1's pieces.
- **Risk:** a staff member enables e2e for a customer organisation by mistake: test tools with real writes.
- **Confidence:** verified (the generated lists, and the pre-PR Toolbox entry point).

### E4. Two ways to mint register's own client once root is locked: a staff token placed with kubectl, and break glass
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `charts/answerable/templates/ops.yaml:175-183`, `infra/ops/src/commands.ts:72`, `infra/ops/src/register.ts:11-15,47-50,86-87`;
  - `infra/README.md:113-115,181,224-231`, `docs/12-deployment.md:156,169-170,194,204`, `infra/ops/README.md:34,69-71`;
  - `infra/ops/src/register.test.ts:96-117`.
- **What it is:** when `ops-id-client` is empty and ID refuses the root secret, a person gets a staff token, then uses an admin kubeconfig to `kubectl create secret … ops-staff-token`, tags, and deletes the Secret. The same state is already handled by break glass: `ROOT_ADMIN_BREAK_GLASS: "true"` in the overlay makes ID accept root (`apps/id/src/http/principal.ts:241`), and register mints with root (`commands.ts:151`).
- **The assumption:** that this state is common enough to need its own path. It arises:
  - once in staging if `make-admin` ran there before this PR ships (not known from the tree; the memory says it had not);
  - when someone rotates `ops-register`'s own secret;
  - when a cluster is rebuilt after the lock.

  Production has never shipped.
- **Proposal:** delete `OPS_ID_TOKEN` and the `ops-staff-token` reference. The remedy message then points at break glass: set it in the overlay, tag, remove it, tag. That also removes the only routine laptop step left in the register flow, which the owner's rule forbids.
- **Removes:** 9 lines of template, 1 field, the token branch and its test (22 lines), and about 30 lines of runbook and design text (estimate). It also removes one Secret a person creates by hand.
- **Risk:** break glass takes two ships and opens root for one deploy window, where the token was narrower. Rare either way.
- **Confidence:** read only.

### E5. `run-job` extracts the deployed commit's chart with `git archive`, and `run-job bootstrap` has no workflow
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `infra/pipeline/src/deploy.ts:359-424`, `cli.ts:109-118`;
  - `.github/workflows/ops.yml:49,55-61,87-103`;
  - `infra/pipeline/src/deploy.test.ts:438-610` (173 lines);
  - `infra/ops/README.md:15`.
- **What it is:**
  - Register now runs on every deploy, so `ops.yml` serves two rare jobs: rotating a machine client's secret, and `make-admin`, once per environment.
  - For them, `run-job` reads `image.tag` from `helm get values`, checks the commit exists, runs `git archive` and `tar`, upgrades from the extracted chart, prints `revision=`, and `ops.yml` checks out that revision for the smoke test (with `fetch-depth: 0`).
  - `run-job bootstrap` is accepted, but `ops.yml` offers only `register` and `make-admin`, and every deploy runs bootstrap. Yet `infra/ops/README.md:15,53` tells people to run it, which only a laptop can.
- **The assumption:** that `main`'s chart must never meet the deployed images. That is correct (an `own` MCP on `main` would roll pods onto a missing Secret). Extracting a chart is one way to guarantee it; refusing a mismatch is another.
- **Proposal:**
  - Delete `bootstrap` from `run-job`, and the README's laptop instruction.
  - Optionally, dispatch `ops.yml` on the deployed tag (`gh workflow run ops.yml --ref staging/<name>`; the environment's policy already admits `staging/*` and `production/*`). Then refuse when `helm get values`' tag is not `sha-$GITHUB_SHA`, naming the deployed commit. That replaces `chartAt`, the revision output and the smoke job's `ref` with one equality check.
- **Removes:** `chartAt` and `deployedRevision`, 28 lines; about 40 lines of tests; `fetch-depth`, `outputs` and `ref` in `ops.yml`; one way to run bootstrap (estimate except the 28).
- **Risk:** the person must name the right tag; the refusal tells them which. Behaviour for users unchanged.
- **Confidence:** read only (the logic). Verified that `ops.yml` offers only `register` and `make-admin` (`ops.yml:22-28`).

### E6. Three of the five migration Jobs run the same image against non-sensitive hub databases, one pod each
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `charts/answerable/templates/migrations.yaml:69-111`; `mcps/standalone/scripts/migrate-mcps.ts`, which migrates every MCP, Toolbox-only ones included, from the standalone server's workspace.
- **What it is:** `toolbox-migrate` (-9), `standalone-migrate` (-7) and `mcps-migrate` (-6) are separate hook Jobs from the `mcps` image, each a pod that Helm waits for in turn. Only `admin-migrate` has a reason to stand apart (D15: the admin MCP's owner login).
- **The assumption:** "each mounts only the owner logins of its own databases". That isolation matters for the admin MCP, not between the Toolbox's, the standalone server's and the shared MCP database's owners.
- **Proposal:** one `mcps-migrate` Job that runs the Toolbox's, the standalone server's (if it stays) and the MCPs' migrations in turn. Move `migrate-mcps.ts` out of the standalone workspace, since it serves every MCP.
- **Removes:** two hook Jobs per deploy (about 10 s in kind, estimate from 19 s for four Jobs), about 16 template lines and two weights.
- **Risk:** one Job holds three owner URLs; a failure still names the database in its log.
- **Confidence:** read only.

### E7. `grants` in `charts/answerable/mcps.json` is written and read by nothing
- **Verdict:** delete
- **Cost today:** low
- **Where:** `scripts/mcp/generate.ts:56-57`, `charts/answerable/mcps.json:13-22,32-39`, `charts/answerable/README.md:8`, `infra/k8s/charts.test.ts:445`.
- **What it is:** the generator writes each MCP's grant strings into the chart's list. The chart's helper keeps only name, serve, database and scopes (`_helpers.tpl:31`); the smoke test reads name and serve; nothing else reads the file's `grants`. Helm stores the chart's files in the release, so the field also takes release space at 200 MCPs.
- **The assumption:** M3's brief asked for grant strings in the list (`briefs/m3.md:98`); no consumer followed.
- **Proposal:** drop `grants` from the generator, the file, the README sentence and the test fixture.
- **Removes:** 2 lines of the generator; 422 of the 911 bytes of `mcps.json` today; the field from every future release.
- **Risk:** none.
- **Confidence:** verified: the three overlays render byte-identical without it (`helm template` probe), and `rg` finds no reader.

### E8. The chart list's entry is typed in six places
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `packages/mcp-postgres/src/declared.ts:24-37`, `infra/ops/src/commands.ts:45-55`, `infra/ops/src/register.ts:6`, `infra/pipeline/src/smoke.ts:4`, `infra/k8s/local/stack.ts:20`, `infra/k8s/charts.test.ts:19`; plus the Helm helper `_helpers.tpl:24-34` and the writer `generate.ts:57`.
- **What it is:**
  - `declaredMcps` (name, serve, database) is a Zod schema for the bootstrap and the migration Job.
  - `registeredMcps` repeats the JSON parse with name, serve and scopes for register, and `RegisteredMcp` types it again.
  - The smoke, the stack and the chart tests each declare their own type.

  M9 left this open ("the chart-list entry is typed four times").
- **Proposal:** one schema in `@answerable/mcp-postgres` with `scopes`, which the generator always writes. Use it for `OPS_MCPS` in both commands and for `MCPS_DECLARED`; delete `registeredMcps` and `RegisteredMcp`. Type the tests from the exported type.
- **Removes:** about 12 lines and one rule to keep in step (estimate).
- **Risk:** none.
- **Confidence:** verified with `rg` (the six declarations).

### E9. The `mcps` image lists six packages by hand, so "a new MCP needs no line here" holds only for MCPs that use those six
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `mcps/Dockerfile:5-6,27-32`.
- **What it is:** the image copies `packages/{auth,config,id-admin,mcp,mcp-platform,mcp-postgres}`. An MCP that adds `@answerable/countries`, or a future package, gets a dangling workspace link and crashes the Toolbox at start. F1 found the same class of fault in the old Toolbox Dockerfile, and D8 claims to remove it. The kind stack in CI would catch it, after an image build. The Dockerfile's `ARG REVISION` and `LABEL`s also repeat what `deploy-staging.yml:139-144` sets on every build.
- **Proposal:** `COPY packages packages` (`.dockerignore` already drops tests, Markdown and the acceptance kit). Optionally drop the Dockerfile labels the workflow sets.
- **Removes:** 5 lines, and a stale-list failure a new MCP's author can hit. The other packages add about 0.7 MB of source (`du`: design 384 KB, ui 264 KB, countries 32 KB) to a 262 MB image.
- **Risk:** a slightly larger image.
- **Confidence:** read only (no Docker build run).

### E10. `toolbox.enabled` and `adminMcp.enabled` are switches no overlay sets, and `run-job`'s restart would refuse the state they make
- **Verdict:** delete
- **Cost today:** low
- **Where:** `charts/answerable/values.yaml:90,104`, `toolbox.yaml:19`, `admin-mcp.yaml:18`, `_helpers.tpl:189`, `network-policies.yaml:51`, `infra/pipeline/src/deploy.ts:39,292-293`.
- **What it is:** no overlay sets either switch to false. The PR threads them further into `opsStartDeployments`. `restartServers` throws when either Deployment is missing, so `enabled: false` breaks `run-job register`. The switches predate the PR.
- **Proposal:** delete both switches and their conditions.
- **Removes:** about 8 lines and two values.
- **Risk:** none; nobody turns a server off.
- **Confidence:** verified with `rg` (no overlay sets them).

### E11. `ADMIN_STANDALONE_ORIGIN` is optional, and `standalone_enable` takes `hostClientIds`: options only tests reach
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `mcps/admin/src/environment.ts:22-27`, `standalone.ts:27,31-36`, `admin.ts:22-23`, `provider.ts:50`;
  - `apps/web/content/docs/admin/setup.mdx:201`, `admin/index.mdx:309`;
  - `mcps/admin/src/writes.test.ts:423,429,440-444`.
- **What it is:**
  - The chart always sets `ADMIN_STANDALONE_ORIGIN` (`admin-mcp.yaml:11`), and local development has a default. Only the tests, and the acceptance's in-process admin MCP, leave it unset, which reaches the `PRECONDITION_FAILED` branch and two docs rows.
  - `hostClientIds` lets staff name another host client. Register only ever makes `claude-code-<name>`, and only `writes.test.ts` passes another.
- **Proposal:** make the origin required, with its local default. Delete `hostClientIds`, so the client is always `claude-code-<name>`.
- **Removes:** about 15 source lines, 2 docs rows and 3 test cases (estimate).
- **Risk:** a second host for one standalone MCP would add the option back when it arrives.
- **Confidence:** verified with `rg` (no caller outside tests).

### E12. The register Job and the shipping path are described in ten places, and four of them have already drifted
- **Verdict:** simplify
- **Cost today:** medium
- **Where:** about 110 lines in ten files, measured by line range:
  - `infra/ops/src/register.ts:57-70`;
  - `charts/answerable/templates/ops.yaml:1-18`, `values.yaml:138-144`;
  - `infra/ops/README.md:55-75`;
  - `infra/pipeline/README.md:45,52,58-60,88`;
  - `infra/README.md:55,107-115,124,131,213-231,313`;
  - `docs/12-deployment.md:156,169-170,193-198,204`;
  - `infra/k8s/local/README.md:21`;
  - `infra/pipeline/src/deploy.ts:315-321`;
  - `.github/workflows/ops.yml:3-7`.
- **What it is:** the same facts (minted on first run, the staff-token remedy, widen-only, removed MCPs keep rows, every deploy) are restated in each. Drift already found:
  1. `charts/answerable/README.md:9` gives 54,040 bytes (5.2%) at 200 MCPs. `charts.test.ts` measures 61,572 (5.9%), and the evidence report says 60.2 KiB.
  2. `charts/answerable/templates/ops.yaml:109` says the migrations are "-10 to -8"; they are -10 to -6.
  3. `infra/ops/README.md:15` says `ops.yml` runs `run-job <bootstrap|register|make-admin>`; it offers two of the three.
  4. `infra/ops/README.md:53` rotates a password by "run `bootstrap` again"; `infra/README.md:179` says tag, and only a laptop can do the former.
- **The assumption:** that `infra/README.md`'s "Where the details live" table keeps one owner per fact. The table exists; the restatements do not follow it.
- **Proposal:** `infra/ops/README.md` owns what each Job does. docs/12 keeps why, in two or three lines with a link. The runbook keeps the steps, with links. Template and values comments shrink to a pointer. Fix the four drifts.
- **Removes:** about 60 of the 110 lines (estimate), and the next drift.
- **Risk:** none.
- **Confidence:** verified (the four drifts, against the code and my `charts.test.ts` run).

### E13. The runbook's "first ship with the standalone server" is a one-time note for one environment, and its step 2 contradicts staging's evidence
- **Verdict:** delete
- **Cost today:** low
- **Where:** `infra/README.md:107-115`.
- **What it is:**
  - The section is for the first tag that ships the `mcps` image to an environment that already ran. Only staging has; production never shipped.
  - Step 2 says "The `mcps` package is new, so private, and the deploy fails pulling it". `reports/staging-evidence.md` (Image pulls) records that the cluster pulled `ops` by digest with no visibility change, and First run step 5 keeps the failure conditional.
  - Step 2 also says to delete the old packages "once production runs `mcps`". Production never ran them.
- **Proposal:** make step 2 conditional, as step 5 is, or delete the section after staging's next tag and keep one line in docs/12's status. Delete the old `answerable/toolbox` and `answerable/admin-mcp` packages now.
- **Removes:** 9 lines of runbook.
- **Risk:** none.
- **Confidence:** verified (the evidence report against the runbook text).

## Kept, and why

- **D8, one `mcps` image.**
  - It replaces two Dockerfiles (47 and 35 lines) with one of 42, two matrix entries and two GHCR packages with one.
  - `images.json` drives the matrix, the promotion's loop and count, `deploy.ts` and the kind stack.
  - It restarts no more than before, since the revision label already changed every digest.
  - Its one gap is E9.
- **`infra/pipeline/images.json`.** One list read by four consumers, where there were four hand-written lists. Cheap.
- **Register on every deploy (D9).** The PR deleted `missingClientSecrets` and the conditional switch. Running every time is simpler than deciding when to run, and a declared change now reaches ID without a hand step. A failed register rolling back the release is consistent with the migrations.
- **The registrar, shared** by the register Job and `bun mcp setup` and `dev` (`scripts/mcp/local-id.ts` imports `infra/ops/src/registrar.ts`). One module, so the two cannot differ.
- **Compare, then change with `If-Match`, widening only.** Needed for a changed manifest. The Toolbox resource is never narrowed (`register.test.ts:187`). Its idempotency keys and rows are unchanged from before the PR (compared with `git show 62b6b1b3:infra/ops/src/register.ts`).
- **Zero replicas until the client Secret exists, then `OPS_START_DEPLOYMENTS`.** Needed on a first install, where ID is in the same release.
- **The smoke test generated from the list.** Linear in standalone MCPs and cheap: about 170 ms a check through Cloudflare in staging's run.
- **The ops Role naming exactly the Secrets.** It repeats `databasesFor`, but `charts.test.ts` holds the two equal, and it is the narrowing D23 asked for.
- **Path routing on one host.**
  - No MCP adds a DNS record, a certificate or an overlay line.
  - The Helm release at 200 MCPs is 5.9% of its limit (measured).
  - Register at 200 standalone MCPs makes 428 calls when nothing changed (the fake ID, M9).
  - If standalone stays, this is the right shape.
- **`make-admin`**, unchanged in substance.
- **`secret-store.ts`.** 20 lines, one implementation and a test fake. Not worth folding.

Cross-reference for F: the in-memory ID admin API exists twice, `infra/ops/src/testing.ts` (`fakeIdAdmin`, about 195 lines, +118 in this PR) and `packages/id-admin/src/testing.ts` (658 lines). Both learned revisions and `If-Match` in this PR.

## Cleanup

- **Created:** the copy at `…/pr13-audit/E/copy`, which I delete before I finish. `infra-check.log`, the `render-*.yaml` probe outputs, and `mcps-orig.json` and `mcps-nogrants.json` in this folder.
- **Outside the folder:** `/tmp/x.json`, written by mistake in one probe command and removed in the same command (checked: absent).
- **Not created:** no database, role, MCP, container, image or process. Ports 47300, 47400, 47510 and 47520 had no listener before or after.

## One line per finding

- E1, delete (with C), medium, `mcps/e2e/mcp.json:4`: the standalone server, its hostname, client, database, Job and ID rows run in every environment for e2e alone, a test server; removes 671 lines measured in this area (+about 55 scattered, +1,114 in `mcps/standalone`).
- E2, simplify, low, `infra/ops/src/register.ts:154`: the server is gated on a standalone MCP but its database, logins, Secrets, migration Job and `standalone-hub` are not; removes about 10 lines.
- E3, defect, low, `mcps/toolbox/src/mounted.generated.ts:7-10`: e2e and `example` ship to production for want of a switch, so D10's own trigger has fired; removes nothing or E1's pieces.
- E4, simplify, low, `charts/answerable/templates/ops.yaml:175-183`: a kubectl-placed staff token duplicates break glass for minting `ops-register` after the lock; removes about 60 lines and one hand-made Secret.
- E5, simplify, low, `infra/pipeline/src/deploy.ts:359-424`: `run-job` extracts the deployed chart with `git archive` where refusing a mismatch would do, and `run-job bootstrap` has no workflow; removes 28 lines plus about 40 of tests.
- E6, simplify, low, `charts/answerable/templates/migrations.yaml:69-111`: three migration Jobs from one image against non-sensitive databases could be one; removes 2 Jobs per deploy and about 16 lines.
- E7, delete, low, `scripts/mcp/generate.ts:56-57`: `grants` in the chart's list is read by nothing (renders identical without it); removes 2 lines and 422 of `mcps.json`'s 911 bytes.
- E8, simplify, low, `infra/ops/src/commands.ts:45-55`: the chart list's entry is typed in six places; removes about 12 lines.
- E9, simplify, low, `mcps/Dockerfile:27-32`: the image hand-lists six packages, so a new MCP on another package breaks the Toolbox; removes 5 lines.
- E10, delete, low, `charts/answerable/values.yaml:90,104`: `toolbox.enabled` and `adminMcp.enabled` are never set false and would break `run-job`'s restart; removes about 8 lines.
- E11, delete, low, `mcps/admin/src/environment.ts:22-27`: an optional `ADMIN_STANDALONE_ORIGIN` and `hostClientIds` are reached only by tests; removes about 15 lines, 2 docs rows, 3 test cases.
- E12, simplify, medium, `infra/README.md:213-231`: register and shipping are described in ten places (about 110 lines), four already drifted; removes about 60 lines.
- E13, delete, low, `infra/README.md:107-115`: a one-time note for staging asserts a GHCR pull failure that staging's evidence disproved; removes 9 lines.
