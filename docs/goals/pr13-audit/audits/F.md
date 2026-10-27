# Pull request 13 audit, F: tests, docs and the developer's path

Auditor F. Tree: `claude/typed-config-b1` at 7ffd16b4, diff `62b6b1b3..7ffd16b4`. Read-only on the worktree. Everything I ran ran in copies under this folder, made with `git ls-files -z --cached --others --exclude-standard` and installed with `bun install --frozen-lockfile`.

## What I measured

**Suites without Postgres.** Each ran in a clean copy, except `infra/pipeline`, which ran in the worktree:

| Suite | Tests | Time |
| --- | --- | --- |
| `packages/mcp` | 125 pass | 3.23 s |
| `packages/config` | 7 pass | 0.03 s |
| `packages/auth` | 62 pass | 0.13 s |
| `packages/id-admin` | 28 pass | 0.28 s |
| `infra/ops` | 75 pass | 0.38 s |
| `infra/pipeline` | 99 pass | 0.38 s |
| `apps/web` | 120 pass | 1.64 s |

In the copy, `infra/pipeline` had 98 pass and 1 fail. The failing test extracts the chart from git, and the copy is not a git repository; in the worktree all 99 pass. This is an artefact of the copy, not a finding.

**A generated MCP's own suite,** `auditfnotes` with 3 tools, in 3 runs:
- 11 pass and 2 skip in 0.46 to 0.51 s;
- at most 2 connections to `answerable_mcps_test`, sampled about every 7 ms;
- the 2 skips are conformance checks that do not apply: the mutation prepares no targets.

**The end-to-end test's parts,** measured one by one:

| Part | Time |
| --- | --- |
| Copy | 0.22 s |
| `bun install` | 2.0 to 2.2 s |
| `new` | 4.5 s |
| `check` | 3.1 s |
| `add tool`, twice | 3.6 and 3.8 s |
| `list` | 0.1 s |
| Removing the copy | 3.5 s |

**Recorded, not run by me** (rules):
- `mcp:test`: 645 tests in 11.1 s before the goal (`docs/goals/mcp-cli/progress.md:7`), 1,020 in 29.0 s after M9 (`reports/mcp-foundation-evidence.md`);
- the acceptance: 69 in 149.9 s.

## The newcomer test

I started from `apps/web/content/docs/mcp/index.mdx`. I followed `create.mdx` and `add-a-tool.mdx`, then `local-testing.mdx` and `create.mdx#undo-a-local-mcp`, in a copy, with the MCP `auditfnotes`.

**What worked as written:**

| Command | Result |
| --- | --- |
| `bun mcp new auditfnotes --description "…" --serve toolbox` | Exit 0 in 4.5 s; eight steps, one line each; the `Next` line and the `git add` list were right |
| `bun mcp add tool auditfnotes notes.add --mutation --description "…"` | Exit 0 in 3.8 s |
| `bun mcp add tool auditfnotes notes.list --description "…"` | Exit 0 in 3.6 s |
| `bun mcp check auditfnotes` | Exit 0 in 3.1 s |
| `bun mcp check` from inside `mcps/auditfnotes`, without the name | Works |
| `bun mcp list` | Exit 0 in 0.1 s |
| `bun mcp setup` and `bun mcp dev auditfnotes`, with ID down | Each refused with exit 2, every problem listed with its command, nothing started |

**What blocks a newcomer:** reaching the first tool call in Claude Code. The local ID needs two things no MCP page mentions (F1).

**What broke:** the documented undo of a local MCP leaves `bun install` failing (F2).

## Findings

### F1. The local path says "Nothing else is needed", but a newcomer cannot sign in without two undocumented steps
- **Verdict:** defect
- **Cost today:** high
- **Where:**
  - `apps/web/content/docs/mcp/local-testing.mdx:15-24`;
  - `apps/web/content/docs/mcp/create.mdx:20-24` and `:108`;
  - `apps/web/content/docs/mcp/claude-code.mdx:11`.
- **What it is:** "Before you start" lists the development Postgres and "your local ID: `bun dev`, or `bun --filter @answerable/id dev`", then says: "The first run of ID makes the platform organisation, `answerable`. Nothing else is needed." Then: "sign in with your work account". Two things are missing:
  - **ID's database is never migrated.** `apps/id/package.json:7`, `dev`, builds the CSS and starts the server, with no migration, and `turbo.json`'s `@answerable/id#dev` adds none. `docs/id/onboard.mdx`, First run, step 1, says to run `bun --filter @answerable/id db:migrate` before starting.
  - **There is no sign-in for the developer's work account.** A sign-in needs:
    - a domain and an SSO provider on the platform organisation;
    - the matching `MICROSOFT_CLIENT_ID`/`_SECRET` or `GOOGLE_CLIENT_ID`/`_SECRET` in the root `.env`.

    These are steps 3 and 4 of `onboard.mdx`. `bun mcp setup` does neither: `scripts/mcp/commands/setup.ts` has no `domain` and no `sso`. Without them, the Claude Code sign-in that `create.mdx` promises cannot complete.
- **The assumption:** that the reader already runs a configured local ID, as the owner does. No newcomer run backs it.
- **Proposal:** add two rows to the "Before you start" table in `local-testing.mdx`, and point `create.mdx` at it:
  - `bun --filter @answerable/id db:migrate`;
  - "a sign-in for your email domain on the platform organisation", linking `onboard.mdx#first-run` steps 3 and 4, and the `.env` credentials they need.

  Delete "Nothing else is needed."
- **Removes:** nothing; it adds about 3 lines. It also removes a dead end from the first hour of every new developer.
- **Risk:** none. Docs only.
- **Confidence:**
  - Verified: `bun mcp setup` and `bun mcp dev`, run with ID down, refuse as documented; `setup.ts` contains no domain or SSO step.
  - Read only: that ID fails to start on an unmigrated database. I did not start ID, which would have written to the shared ID database.

### F2. Following "Undo a local MCP" leaves the server's dependency on the deleted MCP, and `bun install` fails
- **Verdict:** defect
- **Cost today:** medium. Anyone who tries an MCP out and removes it hits this.
- **Where:**
  - `apps/web/content/docs/mcp/create.mdx:114`;
  - `scripts/mcp/generate.ts:39-44` (`packageJsonOf`) and `:61` (`known`).
- **What it is:** the page says: "delete `mcps/acme`, run `bun mcp check <another MCP>` to rewrite the lists without it, then `bun install`."
  - I did exactly that in the copy, with `auditfnotes` and `example`.
  - `check` rewrote `charts/answerable/mcps.json` and `mounted.generated.ts`.
  - `mcps/toolbox/package.json` kept `"@answerable/mcp-auditfnotes": "workspace:*"`.
  - `bun install` then failed: `error: Workspace dependency "@answerable/mcp-auditfnotes" not found`.
  - A second `bun mcp check example` reported `generated current`.

  The cause is in `packageJsonOf`: it only drops dependencies whose names are `known`, meaning declared or listed in `retired.json`. A removed MCP that never shipped is neither, so its dependency stays.
- **The assumption:** that an MCP leaves only by `retired.json`. The docs themselves describe the other way out.
- **Proposal:** in `packageJsonOf`, keep every dependency except `@answerable/mcp-<x>` where `<x>` is not a reserved name. D13 reserves `platform` and `postgres` for exactly these package names. Then add the served ones. This deletes `known` and the `retired` read in `generatedFiles`.
- **Removes:** about 3 lines, and the "known names" concept.
- **Risk:** low. A server's dependency on a platform package must keep matching a reserved name, which D13 already guarantees.
- **Confidence:** verified, by running the documented steps in the copy. The psql half of the undo worked: `traces` came back `[]`.

### F3. The docs contradict each other on filtering queries by organisation
- **Verdict:** defect
- **Cost today:** medium. An author or an agent who reads one page writes what another page forbids.
- **Where:** for filtering, against filtering:

  | Says: filter by organisation | Says: do not filter |
  | --- | --- |
  | `apps/web/content/docs/mcp/tools.mdx:64`: "**Constrain every query by `organisation.id`.**" | `add-a-tool.mdx:78`: "**Do not filter by organisation.**" |
  | `packages/auth/src/index.ts:16` and `:43`, rendered at `reference.mdx:78` and `:99` | `agents.mdx:38`: "Do not filter queries by organisation: Postgres does." |
  | | The generated tool's comment, `scripts/mcp/templates/tool.ts:25`: "no query filters on it by hand" |
- **What it is:** D19 moved isolation into Postgres for tables with the `organisationIsolation` policy. The older rule in `tools.mdx` and in `@answerable/auth`'s doc comments was never reconciled with it.
- **The assumption:** none. This is drift.
- **Proposal:** state one rule, once, in `database.mdx#add-a-table`:
  - a table with the policy needs no filter;
  - data the MCP reads from elsewhere, such as an upstream API or a table without the policy, is constrained by `organisation.id`.

  Make `tools.mdx:64` and the two `@answerable/auth` comments say the same, or link to it.
- **Removes:** about 2 lines and one contradiction.
- **Risk:** none.
- **Confidence:** verified with `rg`.

### F4. Every `bun mcp` refusal is asserted twice, so a reworded message is edited in three places
- **Verdict:** simplify
- **Cost today:** medium
- **Where:**
  - `scripts/mcp/errors.test.ts:82-221`, plus its test at `:229`;
  - `scripts/mcp/commands/new.test.ts:22-46`;
  - `add-tool.test.ts:30-51`;
  - `dev.test.ts:213-261`;
  - `setup.test.ts:141-192`.
- **What it is:** `errors.test.ts` runs the real command for every row of `errors.ts` (51 rows) and checks the exit code, the `see` line and the code. The command suites then assert the same messages again, verbatim:
  - 17 rows in `new.test.ts`;
  - 14 rows in `add-tool.test.ts`;
  - setup-required, id-down, postgres-down, port-taken, setup-stale and organisation-not-found in `dev.test.ts`;
  - staff-token-required, staff-token-refused, id-down and platform-organisation-missing in `setup.test.ts`.

  Rewording one message today means editing the code, its row in `errors.ts` and the command test.
- **The assumption:** that the per-command tables check something `errors.test.ts` does not. They add two things: the `fix` line, and that nothing was written.
- **Proposal:**
  - `errors.test.ts` also checks the `fix` line, and that nothing was written for exit-2 rows. That is one helper call.
  - Delete the per-command refusal tables.
  - Keep the tests of combined refusals ("three wrong answers at once") and of prompts.
- **Removes:** about 130 lines, from the measured blocks: 25 + 22 + 49 + about 40. A message is then written in two places, not three.
- **Risk:** low. A branch reached only by a deleted row, such as the "standalone is reserved" hint, must still be covered. Run the `scripts` suite's coverage after the change.
- **Confidence:** read only. I may not run the `scripts` suite.

### F5. The template snapshot is a third copy of the templates, while `mcps/example` already equals them with no test saying so
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `scripts/mcp/__snapshots__/templates.test.ts.snap`, 482 lines;
  - `scripts/mcp/templates.test.ts:18-28`;
  - `apps/web/content/docs/mcp/add-a-tool.mdx:49-55`.
- **What it is:** the template text lives in three places:
  - `scripts/mcp/templates/*.ts`;
  - the snapshot;
  - the docs' `<ScaffoldFile>` renders.

  Two tests check the snapshot: they detect change, not behaviour. Meanwhile `add-a-tool.mdx` says "A read, `bun mcp add tool acme notes.list …`, writes this:" and includes `mcps/example`'s file. Nothing tests that claim. My probe (`probes/template-vs-example.ts`) found it true today: `notes-add.ts`, `notes-add.test.ts`, `notes-list.ts` and `notes-list.test.ts` equal `toolFiles("example", …)` line for line, once the `//#region` lines are removed.
- **The assumption:** that the snapshot catches a template change a reviewer would miss. A template diff is already visible in `templates/*.ts`.
- **Proposal:** delete the snapshot and its two tests. Add one test: `mcps/example`'s files equal what `mcpFiles` and `toolFiles` write for it, ignoring `//#region` lines. The docs' "writes this" then holds by test, and every template change becomes an `example` diff that typechecks, lints and passes its own tests.
- **Removes:** 482 snapshot lines and about 10 test lines; adds about 15.
- **Risk:** `example` can no longer differ from what the CLI writes. That is the point.
- **Confidence:** verified by the probe.

### F6. `local-testing.mdx` retells eight test files in 3,455 words, and has already drifted
- **Verdict:** delete
- **Cost today:** medium
- **Where:**
  - `apps/web/content/docs/mcp/local-testing.mdx:106-255`, the "What the … journeys prove" sections: 151 lines, 3,455 words;
  - `:104`, the test count.
- **What it is:** at 7,197 words, the page is the longest in `/docs/mcp`. Its first 84 lines are the newcomer's local loop ("Run an MCP on your machine"). Most of the rest restates each journey's setup and assertions in prose.
  - Every journey change needs a matching prose change.
  - The prose has already drifted. `:104` says "the 70 tests took 154.4 seconds"; M9 measured 69 in 149.9 s, after M9 deleted "a journey that repeated another".
  - The PR added 138 lines to the page.
- **The assumption:** that an MCP author needs to know what each acceptance file asserts. The test names already say it, and the readers are the platform's own developers.
- **Proposal:**
  - Delete the "What the … journeys prove" sections and the count.
  - Keep one paragraph that points to `packages/acceptance`.
  - Move "Run an MCP on your machine" onto its own page, or into `create.mdx#run-it-and-try-it-in-claude-code`, so the newcomer's path is not lines 13 to 95 of a page about the acceptance.
- **Removes:** about 150 lines and 3,455 words, and one source of drift.
- **Risk:** none. The tests are the record.
- **Confidence:** verified with `wc` and `awk` on the page.

### F7. The docs keep by-hand local registrations that `bun mcp setup` and `bun mcp dev` replaced, with different client names
- **Verdict:** delete
- **Cost today:** medium. There are two local setups:

  | | The documented by-hand path | What `bun mcp setup` and `dev` use |
  | --- | --- | --- |
  | The Toolbox's machine client | `toolbox-hub` | `mcp-dev` |
  | The standalone server's machine client | `standalone-hub` | `mcp-dev` |
  | Claude Code's client for e2e | `claude-code-local` | `claude-code-e2e` |

  The pasted request bodies are checked by nothing.
- **Where:**
  - `apps/web/content/docs/mcp/claude-code.mdx:40-73` (34 lines) and `:85-178` (94 lines);
  - `apps/web/content/docs/toolbox/admin.mdx:64-118` (55 lines);
  - `apps/web/content/docs/toolbox/index.mdx:256-266`;
  - the by-hand steps of `apps/web/content/docs/toolbox/add-tools.mdx`;
  - the generated README, `scripts/mcp/templates/workspace.ts:70`, which says `bun run toolbox:dev` where the docs say `bun mcp dev <name>`.
- **What it is:** `claude-code.mdx` itself says "`bun mcp dev e2e` registers everything below … the steps are what it does, by hand." In a deployment, the register Job does it.
- **The assumption:** that someone needs the hand path. `bun mcp dev <any MCP>` starts the Toolbox or the standalone server for platform work too.
- **Proposal:**
  - Delete the by-hand registration sections.
  - Keep one sentence each: locally, `bun mcp setup`, then `bun mcp dev <name>`; in a deployment, the register Job.
  - The generated README says `bun mcp dev <name>`.
  - `toolbox/add-tools.mdx` keeps how mounting works, plus enable and grant through the admin MCP.
- **Removes:** about 194 measured lines (34 + 94 + 55 + 11). Add-tools.mdx's steps add about 100 more (estimate).
- **Risk:** a platform developer who wants a server running with no MCP of interest uses `bun mcp dev e2e`.
- **Confidence:** verified by reading the sections and the generated README in the copy.

### F8. The acceptance proves isolation, restarts and audience binding several times over, with a second ID start for it
- **Verdict:** simplify
- **Cost today:** medium. Each acceptance file starts its own ID and signs in through a real browser.
- **Where:**
  - `packages/acceptance/src/journeys/mcps.journeys.test.ts`, whole file (123 lines);
  - `mcp-cli.journeys.test.ts:105-120`.
- **What it is:**

  | Test | Repeats |
  | --- | --- |
  | `mcps.journeys:104`: two organisations see only their own e2e records, at the path and in the Toolbox | `mcps/standalone/src/both.test.ts:59`, in process; also `mcp-cli.journeys:75` and `:91`, and `e2e.journeys:144` |
  | `mcps.journeys:118`: records survive a restart | `both.test.ts:75`, in process. ID plays no part |
  | `mcp-cli.journeys:105`: 401 for a token issued for another resource | `e2e.journeys:164`, `admin.journeys:290` and `mcps/standalone/src/standalone.test.ts:19` |

  `mcps.journeys:82` is a latency measurement whose only assertion is `toHaveLength(20)`.

  `mcps.journeys` and `mcp-cli.journeys` have the same setup: two tenants, a sign-in to the Toolbox and one to e2e at its path for each, ports 47602 and 47604.
- **The assumption:** that the acceptance must repeat in-process facts "through real tokens". Only ID-dependent behaviour needs real ID.
- **Proposal:**
  - Move `mcps.journeys:71` into `mcp-cli.journeys`. It is the one test only real ID can prove: names from ID's admin API reach a tool.
  - Delete `mcps.journeys.test.ts`.
  - Delete `mcp-cli.journeys:105-120`.
  - Move the latency loop to a bench script.
- **Removes:**
  - about 140 lines;
  - one ID start and four browser sign-ins per acceptance run. That saves about 10 s of 150 s: an estimate, from `local-testing.mdx`'s "CLI journeys … 11.8 [s], run alone with their start";
  - one Toolbox acceptance database (`answerable_toolbox_acceptance` is shared by two files; `mcp-cli` uses its own).
- **Risk:** low. Every deleted assertion is held elsewhere, as listed above.
- **Confidence:** read only, by test names and bodies. I may not run the acceptance.

### F9. `bun mcp`'s end-to-end test makes the per-commit `mcp:test` gate about 2.6 times slower
- **Verdict:** optimise
- **Cost today:** medium, for developers who run `mcp:test` often.
- **Where:**
  - `scripts/mcp/end-to-end.test.ts`;
  - `scripts/mcp/definitions.test.ts:44-49`;
  - `scripts/mcp/commands/new.test.ts:164-202`.
- **What it is:** the test copies the tree, installs it, then runs `new`, `check`, `add tool` twice, `list` and `new` again, then removes the copy and the MCP. Its parts measure about 21 s: 0.2 + 2.1 + 4.5 + 3.1 + 3.7 + 3.6 + 0.1 + 3.5. That sum is an estimate for the whole test.
  - `mcp:test` went from 11.1 s (645 tests) before the goal to 29.0 s (1,020 tests). The `scripts` suite runs its files one after another.
  - The order of `new`'s steps is asserted three times:
    - `end-to-end.test.ts:47`;
    - `new.test.ts:164`, which also asserts the exact argv of each spawned command;
    - `definitions.test.ts:44`.
- **The assumption:** that the per-commit gate must hold a full copy and install. CI runs `mcp:test:e2e` anyway.
- **Proposal:**
  - Move `end-to-end.test.ts` into the acceptance lane (`mcp:test:e2e`), which CI already runs.
  - Delete `definitions.test.ts:44-49`.
- **Removes:** about 6 lines, and an estimated 21 s from every local `mcp:test`.
- **Risk:** a developer who runs only `mcp:test` no longer proves that generated code passes its own gates. CI still does.
- **Confidence:** the parts were measured. The test's total and its share of the 29 s are estimates.

### F10. Two in-memory fakes of ID's admin API now drive one registrar
- **Verdict:** simplify
- **Cost today:** medium. Two fakes must stay faithful to ID; the October test audit found the fake had diverged from real ID in seven ways.
- **Where:**
  - `infra/ops/src/testing.ts:60-266`: `fakeIdAdmin`, about 200 lines; the file grew from 205 to 279 lines in this PR (+96 −22);
  - `packages/id-admin/src/testing.ts`: `createFakeId`, 658 lines (+128 −41).
- **What it is:** since M9, `infra/ops/src/registrar.ts` is the one registrar for the register Job and for `bun mcp setup` and `dev`.
  - `registrar.test.ts`, `register.test.ts` and `commands.test.ts` drive it through `fakeIdAdmin`.
  - `scripts/mcp`'s setup, dev and errors tests drive the same registrar through `createFakeId`, via `scripts/mcp/test/id.ts`.
- **The assumption:** that the ops Jobs need a fake of their own. Each fake grew in this PR to cover the same rows: resources, clients, links, capabilities and entitlements.
- **Proposal:** add to `createFakeId` what only `fakeIdAdmin` has:
  - the root lock;
  - the platform slug;
  - the Microsoft flag;
  - failure injection.

  Then use it in `infra/ops`'s tests and delete `fakeIdAdmin`.
- **Removes:** about 200 lines (estimate from the line span), and one fake to keep faithful.
- **Risk:** `infra/ops` gains a dev dependency on `@answerable/id-admin`. Its 100% coverage must hold.
- **Confidence:** read only.

### F11. CHANGELOGs and version numbers of private workspaces have no reader, and the version bumps leave `bun.lock` stale
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - ten `CHANGELOG.md` files, 740 lines; the PR adds 191 of them;
  - `mcps/standalone/CHANGELOG.md` and `packages/mcp-platform/CHANGELOG.md` are new and already at 0.2.0, for changes inside this unmerged PR;
  - `mcps/admin/package.json:3` is 0.7.0, while `bun.lock:127` at HEAD still says 0.6.0.
- **What it is:**
  - There is no release and no changeset tool. The docs say "a public npm release is Not yet".
  - Every dependency between workspaces is `workspace:*`.
  - `rg` finds no code that reads a workspace's version. The versions that matter are providers' and tools'.
  - **The visible cost.** `bun install --frozen-lockfile` accepts the stale lock. The first `bun mcp new` on the branch then rewrites `bun.lock:127` to 0.7.0, so the developer's diff picks up an unrelated line. I verified this by comparing `bun.lock` in the two copies.
- **The assumption:** that a version history is needed before anything is released. Git and `reports/mcp-foundation-evidence.md` already hold it.
- **Proposal:**
  - Delete the CHANGELOGs, or at least the PR's two new ones and its entries.
  - Stop bumping private workspace versions; generated MCPs are already at 0.0.0.
  - Commit the `bun.lock` that `bun install` writes.
  - Start CHANGELOGs with the first npm release.
- **Removes:** up to 740 lines, and a step from every change.
- **Risk:** none for users. The history stays in git.
- **Confidence:** verified, by `rg` and the lockfile diff.

### F12. `AGENTS.md`, loaded into every agent session, says several things twice and carries test-harness detail
- **Verdict:** simplify
- **Cost today:** medium. 3,090 words of context in every session, through `CLAUDE.md`.
- **Where:** `AGENTS.md`:
  - line 3 (307 words);
  - "Workspaces", line 80 (295 words);
  - the command block (130 words);
  - "Commands" (144 words);
  - "Ports and databases" (199 words);
  - "Gates".
- **What it is:**
  - **The workspaces are described twice:** at line 3, and again in "Workspaces". `README.md` and `mcp/index.mdx`'s Packages table describe them a third and fourth time.
  - **The commands are described twice:** the "Commands" bullet restates the command block above it.
  - **"Ports and databases" is mostly test detail:** the test database names and five role prefixes (`mcp_tbx`, `mcp_std`, `mcp_sts`, `mcp_plt`, `mcp_plte`), which only the authors of the test helpers need.
  - **Two lists have drifted:**
    - "Gates" lists 9 workspaces with 100% coverage, while 14 `bunfig.toml` files set it. Missing: `packages/mcp-platform`, `mcps/standalone`, `mcps/example`.
    - `charts/answerable (ID, the Toolbox and the admin MCP)` omits the standalone server and the MCPs.
  - On top of all this, an agent is told to read `README.md` (2,107 words) and `docs/00-orientation.md` (790) before it starts.
- **The assumption:** that an agent needs every package and test database named before its first command.
- **Proposal:**
  - Drop the package descriptions from "Workspaces"; keep its rules.
  - Drop the "Commands" restatement.
  - Move the test database names and prefixes into the helpers' header comments.
  - Replace the gates list with "every workspace whose `bunfig.toml` sets `coverageThreshold`".
- **Removes:** about 500 words, roughly 16%. That is an estimate from the measured section word counts.
- **Risk:** none.
- **Confidence:** verified, by word counts and `bunfig.toml`.

### F13. User-facing docs quote stale measurements and incomplete lists
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - **`apps/web/content/docs/mcp/database.mdx:95-96`.** These are M1's numbers (`docs/goals/mcp-cli/progress.md:112-115`), which M9's evidence supersedes:

    | | The page says (M1) | M9 measured |
    | --- | --- | --- |
    | A query through the MCP's connection | 0.91 to 1.11 ms | 0.47 to 0.51 ms |
    | A query on a plain connection | 0.46 to 0.60 ms | 0.18 to 0.24 ms |
    | Making 200 MCPs' schemas and roles | about 1.0 s | 0.70 to 0.73 s |
    | First migration of 200 | 3.1 to 3.9 s | 1.96 to 2.16 s |
    | Migration with nothing pending | 1.5 to 2.0 s | 1.16 to 1.36 s |
    | 1,000 queries | 277 to 341 ms | 192 to 198 ms |

  - **`local-testing.mdx:104`:** "70 tests … 154.4 seconds".
  - **`testing.mdx:132`:** it names the auth, SDK, e2e and Toolbox suites as gated.
  - **`README.md:18`:** `mcp-postgres` is "shared by the Toolbox and the admin MCP".
  - **`README.md:25`:** the chart holds "ID, the Toolbox and the admin MCP".
- **The assumption:** that a tool author needs these figures. They do not. The evidence report holds them, dated.
- **Proposal:**
  - Delete the two performance rows, the test count and the gate list.
  - Fix the two README lines.
- **Removes:** about 5 lines.
- **Risk:** none.
- **Confidence:** verified, by `rg` against `progress.md` and the evidence report.

### F14. Three web tests hold prose and repeat other checks
- **Verdict:** delete
- **Cost today:** low
- **Where:** `apps/web/lib/docs/mcp-pages.test.ts`:
  - `:19-44`, "the pages the owner asked for exist, in this order…";
  - `:46-61`, "the two facts the owner asked to be impossible to miss…";
  - `:129-166`, "the deploy page's failed-upgrade rows…".
- **What it is:**
  - The first fixes the sidebar order and requires a title and a description. `apps/web/lib/source.ts:16`'s schema already fails the build without them.
  - The second asserts exact bold phrases.
  - The third runs a fake `deploy` from `infra/pipeline` inside the web suite. It repeats:
    - `infra/pipeline/src/deploy.test.ts:381` and `:414`;
    - the Errors-table test in the same file (`:110-127`), which already finds both quoted messages in the code.
- **The assumption:** that wording and order need tests. A reviewer reads the page.
- **Proposal:** delete the three tests and the imports only they use (`deploy`, `createFakeRunner`, `images`). Keep the Errors-table test and the smoke-table test.
- **Removes:** about 83 lines, and the web suite's import of `infra/pipeline`'s deploy.
- **Risk:** none.
- **Confidence:** verified by reading.

### F15. A regex over the CLI's source keeps `errorCodes` in step, where a type would
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `scripts/mcp/definitions.test.ts:58-67` and `:28-31`;
  - `scripts/mcp/io.ts:52`.
- **What it is:**
  - `Refusal`'s `code` is typed `string`, so a test scans every source file for `refuse("…")`, `Refusal("…")` and `code: "…"`, and compares what it finds with `errorCodes`.
  - `errors.test.ts:236` already proves that every code has a row and a scenario that reaches it.
  - `:28-31` asserts that `cli.ts` spreads the definitions: a structure test.
- **Proposal:**
  - Type `Refusal.code` and `Problem.code` as `ErrorCode | \`${string}-failed\``.
  - Delete both tests.
- **Removes:** about 14 lines, and a test coupled to how the source is written.
- **Risk:** none. The compiler then refuses an unknown code.
- **Confidence:** read only.

### F16. The standalone server's suite builds two shared MCP test databases, under two role prefixes
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `mcps/standalone/src/test/mcps.ts`: `answerable_standalone_test_mcps`, prefix `mcp_std`, fixed to `[e2e, example]`;
  - `mcps/standalone/src/server.test.ts:12-20`: `answerable_standalone_test_served`, prefix `mcp_sts`, from `served.generated.ts`;
  - `mcps/toolbox/src/test/mcps.ts:11-14`, which builds the same shape as `server.test.ts`.
- **What it is:** one suite makes two shared MCP databases and two role prefixes. The entry-point test builds its own list from the generated file, as the Toolbox's helper does.
- **Proposal:** one `src/test/mcps.ts` per server, made from the generated list plus the MCPs its behaviour tests need, imported by `server.test.ts` too.
- **Removes:**
  - about 10 lines;
  - one test database;
  - one role prefix (`mcp_sts`), and its mention in `AGENTS.md`.
- **Risk:** low.
- **Confidence:** read only. This matches M9's open item 5 independently.

### F17. One rule is written twice, and two test exports have no outside user
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `packages/mcp-postgres/src/names.ts:17-20` and `test-mcp.test.ts:71-82`;
  - `packages/mcp-postgres/src/testing.ts`, `testMcpDatabase`;
  - `scripts/mcp/test/io.ts:16`, `Asked`.
- **What it is:**
  - `assertMcpName` re-implements `checkProviderId`'s regex and message, and a test holds the two equal. `mcp-postgres` already depends on `@answerable/mcp`.
  - `testMcpDatabase` is public API of `@answerable/mcp-postgres/testing`. Its only users are `providerDatabase`, in the same module, and its own tests.
  - `Asked` is exported and used only inside its own file.
- **Proposal:**
  - `assertMcpName` calls `checkProviderId`, then checks `public` and `drizzle`.
  - Delete the regex half of the "agrees" test.
  - Unexport `testMcpDatabase` and `Asked`.
- **Removes:** about 12 lines, and one copy of a rule.
- **Risk:** none.
- **Confidence:** verified, by `rg` for the callers.

### F18. The test gate at 200 MCPs was never measured: every MCP's suite starts at once
- **Verdict:** optimise. Measure first.
- **Cost today:** none at 3 MCPs; possibly high at the goal's design point.
- **Where:**
  - root `package.json`, `mcp:test` (`bun run --filter … --filter '@answerable/mcp*'`);
  - `.github/workflows/ci.yml:57`.
- **What it is:**
  - `bun run --filter` has no concurrency option in Bun 1.3.1; `bun run --help` lists none. So every MCP workspace's suite starts at once, against one Postgres.
  - One generated MCP's suite peaked at 2 connections in 0.46 to 0.51 s, over 3 runs.
  - At 200 MCPs that is about 400 connections against `max_connections` 100, plus the platform suites. That figure is an estimate.
  - M9's 200-MCP benchmark measured serving, not testing.
- **The assumption:** that a gate which works at 3 MCPs works at 200. No number backs it.
- **Proposal:**
  - Run `mcp:test` once with 50 and with 200 generated MCPs.
  - If it fails, run the MCP suites through Turborepo with `--concurrency`, or split the gate: the platform suites, plus only the MCPs a change touches.
- **Removes:** nothing; it prevents a flaky gate at scale.
- **Risk:** none.
- **Confidence:** read only. The per-suite peak was measured; the projection is an estimate.

## Kept

- **D11, MCP tests on the real role path.** The cost is low: a 3-tool MCP's suite runs in under 0.5 s and needs 2 connections. It is also the only check that a tool's own table carries its policy: no gate checks row-level security per table. The generated tests' two-organisation assertions are therefore real behaviour tests of the MCP, not repeats of `mcp-postgres`'s. Keep. F18's scaling question is separate.
- **The 100% coverage gate on generated MCPs and on `scripts`.**
  - A new MCP is born at 100% by its generated tests, so the gate is free at birth, and it forces a test for every branch an author adds.
  - Its costs are real but bounded. `main()` in `scripts/mcp/cli.ts:69` takes 12 injected dependencies, and `scripts/env-inventory.ts:128` is shaped into one-liners "so the suite's coverage gate holds".
  - Deleting F4's duplicate tests should keep `scripts` at 100%, because `errors.test.ts` reaches every refusal.
- **`errors.test.ts`.** It runs every error row through the real command, and the docs render the rows. It is the right single place for refusals (F4).
- **The docs components rendered from code:**
  - `<CliErrors>`, `<CliSteps>`, `<CliReference>` and `<ScaffoldFile>`;
  - `mcp-pages.test.ts`'s Errors-table and smoke-table tests, which tie hand-written tables to the code.
- **`register.journeys.test.ts`.** It is the one real-ID proof of the `If-Match` patch path outside the kind stack, at the cost of one ID start.
- **`TOOLBOX_MCPS_ROLE_PREFIX` and `STANDALONE_MCPS_ROLE_PREFIX`.** They exist only for the entry-point tests (`docs/goals/mcp-cli/briefs/m5.md:78`), which is a test seam in production configuration. But Postgres roles span the cluster: without a prefix of their own, an entry-point test's clean-up would drop the developer's own `mcp_e2e` roles. Keep, unless the owner accepts entry-point tests without mounted MCPs.
- **The generated tool tests' shape:** one test beside each tool, seeding two organisations. Each is about 25 lines and reads well as an example.

## Cleanup

- **Copies:**
  - made `…/F/tree` (the newcomer test) and `…/F/clean` (timing), each installed with `bun install --frozen-lockfile`; both deleted;
  - `probes/copy-time.ts` made and removed two more copies.
- **MCP `auditfnotes`:** made by `bun mcp new` in the copy. That created:
  - schema `auditfnotes` in `answerable_mcps` and in `answerable_mcps_test`;
  - roles `mcp_auditfnotes`, `mcp_auditfnotes_owner`, `mcp_test_auditfnotes` and `mcp_test_auditfnotes_owner`.

  I removed them first with the docs' own psql commands (`create.mdx#undo-a-local-mcp`), then ran `forget("auditfnotes")`. Afterwards `traces("auditfnotes")` was `[]`, and no role or database whose name contains `auditf` or starts with `audit_f` remained.
- **Databases and roles named `audit_f_…`:** none created.
- **Test logins:** none left. `mcp_test_login_*` and `test_runtime_*` counted 0 afterwards.
- **Processes and ports:** no process left. Ports 47300, 47400, 47510 and 47520 were not listening before and are not listening after; only Postgres on 47432 listens.
- **Worktree:**
  - unchanged by me; `git status` shows only `docs/goals/pr13-audit/progress.md`, which was already modified when I started;
  - running `infra/pipeline`'s tests there rewrote its git-ignored `coverage/`, which already existed.
- **Left in this folder:** `report.md`, `numstat.txt` and `probes/`, which holds `peak.ts`, `copy-time.ts`, `template-vs-example.ts`, `traces.ts`, `forget.ts` and `junit.xml`.

## Findings, one line each

| Id | Verdict | Cost | Where | Claim | Removes |
| --- | --- | --- | --- | --- | --- |
| F1 | defect | high | `apps/web/content/docs/mcp/local-testing.mdx:24` | "Nothing else is needed" is false: a newcomer must migrate ID and add a domain and SSO sign-in before Claude Code can sign in, and no MCP page says so | 0 lines (adds about 3) |
| F2 | defect | medium | `scripts/mcp/generate.ts:39-44` | The documented undo of a local MCP leaves its dependency in `mcps/toolbox/package.json`, and `bun install` then fails (run) | about 3 lines and the "known" concept |
| F3 | defect | medium | `apps/web/content/docs/mcp/tools.mdx:64` | "Constrain every query by `organisation.id`" contradicts "Do not filter by organisation" in `add-a-tool.mdx:78`, `agents.mdx:38` and the generated tool | about 2 lines |
| F4 | simplify | medium | `scripts/mcp/commands/new.test.ts:22-46` | Every refusal is asserted in `errors.test.ts` and again in the new, add-tool, dev and setup suites | about 130 lines |
| F5 | simplify | low | `scripts/mcp/__snapshots__/templates.test.ts.snap` | The 482-line snapshot is a third copy of the templates; test that `mcps/example` equals them instead (true today, untested) | 482 lines, plus about 10 |
| F6 | delete | medium | `apps/web/content/docs/mcp/local-testing.mdx:106-255` | 3,455 words retell eight test files and have already drifted (70 tests and 154.4 s, against 69 and 149.9 s) | about 150 lines |
| F7 | delete | medium | `apps/web/content/docs/mcp/claude-code.mdx:40-178` | By-hand local registrations duplicate `bun mcp setup` and `dev`, with other client names | about 194 lines, plus about 100 (estimate) |
| F8 | simplify | medium | `packages/acceptance/src/journeys/mcps.journeys.test.ts:1` | Isolation, restart and audience binding are proven again with a second ID start; keep the one real-ID profile test | about 140 lines; one ID start and four sign-ins (about 10 s, estimate) |
| F9 | optimise | medium | `scripts/mcp/end-to-end.test.ts:36` | The end-to-end test, about 21 s by its measured parts, sits in the per-commit `mcp:test` (11.1 s before the goal, 29.0 s after); move it to the acceptance lane | about 6 lines; about 21 s per run (estimate) |
| F10 | simplify | medium | `infra/ops/src/testing.ts:72` | Two fakes of ID's admin API now drive one registrar; keep `createFakeId` | about 200 lines (estimate) |
| F11 | delete | low | `mcps/admin/package.json:3` | CHANGELOGs and versions of private workspaces have no reader, and a bump left `bun.lock` stale for the next `bun mcp new` | up to 740 lines |
| F12 | simplify | medium | `AGENTS.md:80` | `AGENTS.md` describes the workspaces and commands twice, carries test database detail, and its gates list has drifted | about 500 words (estimate) |
| F13 | delete | low | `apps/web/content/docs/mcp/database.mdx:95-96` | Docs quote M1's measurements, which M9 superseded, and stale test counts and lists | about 5 lines |
| F14 | delete | low | `apps/web/lib/docs/mcp-pages.test.ts:19-61,129-166` | Three tests hold prose and nav order, or repeat `infra/pipeline`'s deploy test | about 83 lines |
| F15 | simplify | low | `scripts/mcp/definitions.test.ts:58-67` | A regex over the source keeps `errorCodes` in step; type `Refusal.code` instead | about 14 lines |
| F16 | simplify | low | `mcps/standalone/src/server.test.ts:12-20` | One suite makes two shared MCP test databases under two role prefixes | about 10 lines, one database, one prefix |
| F17 | simplify | low | `packages/mcp-postgres/src/names.ts:17-20` | `assertMcpName` copies the SDK's id rule, with a test to hold them equal; two test exports have no outside user | about 12 lines |
| F18 | optimise | low | `package.json`, `mcp:test` | Every MCP's suite starts at once against one Postgres; at 2 connections each, 200 MCPs would exceed `max_connections` 100 (estimate, unmeasured) | 0 lines |
