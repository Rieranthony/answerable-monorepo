# Pull request 13 audit: the auditors' brief

Every auditor reads this page first, then its own section below.

## The question

From the owner, who will decide on every finding:

> is anything here unnecessary, overly complicated in our current setup, or based on weak assumptions? Challenge them.
>
> - What can be deleted entirely?
> - What can be simplified now that unnecessary pieces are gone?
> - Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating.
>
> This PR once merged will impact thousands of users and future developers / companies future.

**What is under audit.** [Pull request 13](https://github.com/Rieranthony/answerable-monorepo/pull/13) is the diff `62b6b1b3..HEAD` on `claude/typed-config-b1`, in the worktree `/Users/anthonyriera/code/answerable/.claude/worktrees/typed-config-b1`. It covers two goals: typed configuration, then the MCP CLI.

The pull request is not yet merged. Nobody outside the team runs this code yet. So a deletion now costs nothing in migrations or users. A deletion after the merge does.

**The decisions are under audit too:**
- typed configuration's D1 to D7, in `docs/goals/typed-config/task_plan.md`;
- the MCP CLI's D1 to D19, in `docs/goals/mcp-cli/decisions.md`.

The owner approved them, but on assumptions you should test. For each decision in your area, ask:
- What does it assume?
- Is that assumption measured, or only asserted?
- What would removing the decision delete, and what would it cost?

`docs/goals/mcp-cli/findings.md` holds the probes behind the decisions. `reports/mcp-foundation-evidence.md` (the 26 October section) holds the measurements.

## How to work

1. Read `AGENTS.md`, then your section's code, then the decisions behind it.
   - Read the code itself, not only its docs. Where a doc and the code disagree, the code is the fact.
   - Read callers: an export with one caller, an option nobody passes and a branch no input reaches are findings.
2. Challenge from first principles. Ask of everything in your area:
   - What job does this do for a user or a developer?
   - Would anyone notice if it were deleted?
   - Is there a simpler shape that does the same job?
   - Is there a second way to do the same thing?
   - Is it built for a future that has no date, such as a mode, an option or a hook that only tests use?
   - Is a number the design depends on measured, and is it still true?
3. Verify what you can.
   - Find the callers with `rg`. Count the lines with `wc -l`.
   - Run a workspace's tests when they touch no Postgres.
   - Run a probe when reading cannot settle a question.
   - Mark each finding **verified** (say how) or **read only**.
4. Say what is right too, briefly: what you challenged and would keep, and why. A finding of "keep" is a valid result.

## Rules

- **Read-only on the repository.** Edit, create or delete nothing in the worktree. You are the auditor; the owner decides what changes.
- **No suite that resets a shared test database.** Do not run these, since other audits run beside yours and two runs collide:
  - `bun run mcp:test`, `bun run mcp:test:e2e`, `bun run infra:test`, `bun --filter @answerable/id test`;
  - the suites of `mcps/toolbox`, `mcps/admin`, `mcps/standalone`, `mcps/e2e`, `packages/mcp-postgres`, `packages/mcp-platform` and `scripts`.
- **Postgres probes.**
  - Use the development Postgres on `localhost:47432` (`answerable`/`answerable`; `psql` is at `/opt/homebrew/opt/libpq/bin/psql`).
  - Work only in a database you create, named `audit_<your letter>_<anything>`, with roles named the same way.
  - Drop both before you finish, and list what you dropped.
- **Running `bun mcp`.** Run it only in a copy of the tree. Make the copy under your scratch folder (below) with `git ls-files -z --cached --others --exclude-standard`, as `scripts/mcp/end-to-end.test.ts` does, then run `bun install --frozen-lockfile` in it.
  - Name every MCP `audit<letter><something>`.
  - Remove it afterwards with `forget(name)` from `scripts/mcp/test/postgres.ts`, and delete the copy.
- **Docker.** No `docker image prune`, `docker system prune` or any machine-wide clean-up. Start no container on ports 47432, 47532, 47600 to 47606, 47700, 47701 or 48443. Never run `bun run env:up`.
- **Ports.** Leave no process running. Check that ports 47300, 47400, 47510 and 47520 are as you found them.
- **Your scratch folder** is `/private/tmp/claude-501/-Users-anthonyriera--claude-spares-spare-qQNK1r/787e1118-e76c-4109-a85a-7962b23a9563/scratchpad/pr13-audit/<your letter>/`. Put copies, probes and notes there, never in the worktree.
- **Shell.** The shell is zsh: it does not split unquoted variables, and `echo =====` fails. Use `bash -c '…'` for loops.
- **Numbers.** Measured numbers only. Label an estimate as an estimate.

## What to write

**Write your full report to `<your scratch folder>/report.md`.** For each finding:

```markdown
### <letter><n>. <title, a plain sentence>
- **Verdict:** delete | simplify | optimise | automate | keep | defect
- **Cost today:** high | medium | low, meaning what it costs users or developers if it stays
- **Where:** file:line, every place
- **What it is:** what the code does, with the evidence
- **The assumption:** what it rests on, and whether a number backs it
- **Proposal:** the change, concretely, and what replaces it if anything
- **Removes:** lines (measured), files, concepts a developer no longer has to learn
- **Risk:** what could break, who would notice, and whether behaviour a user can see changes
- **Confidence:** verified (how) or read only
```

After the findings, add:
- **Kept:** what you challenged and would keep, and why.
- **Cleanup:** what you created and dropped (databases, roles, copies, processes).

**Your final message** gives every finding, one line each, as: id, verdict, cost today, `file:line`, the claim in one sentence, and the lines it removes. The report file holds the detail.

## The audits

### A. Typed configuration

- **The code:**
  - `packages/config`;
  - every `defineConfig` definition (`rg -l defineConfig`);
  - `scripts/env-inventory.ts`;
  - `packages/config/inventory.json`;
  - `default.env`, `.env.example`;
  - the `<Configuration>` docs component in `apps/web/components/docs`;
  - the variables the chart and the pipeline set.
- **The decisions:** typed configuration's D1 to D7.
- **Consider, among others:**
  - each feature of `defineConfig` and how many fields use it;
  - how many places describe one variable;
  - what a developer must touch to add a variable;
  - what the generated inventories are read by.

### B. The database model

- **The code:**
  - `packages/mcp-postgres`: the `shared` and `own` modes, provisioning, the roles and logins, `migrateMcp` and `migrateMcps`, `mcpDatabase`, row-level security, `serving-login`, the `testing` helpers and `bench`;
  - `infra/postgres`;
  - the database parts of `infra/ops` (`bootstrap`);
  - how the Toolbox, the standalone server and `bun mcp` open MCP databases.
- **The decisions:** the MCP CLI's D1, D11 and D19, and the database parts of D17.
- **Consider, among others:**
  - each mode, role, login and privilege, and who uses it today;
  - the SQL `migrateMcp` refuses, and why;
  - the work done on every connection borrow;
  - the number of test databases and role prefixes;
  - the 200-MCP assumption, against the measurements.

### C. The SDK and the servers

- **The code:**
  - `packages/mcp`: the tool context (`person`, `organisation`, `client`, `db`), `withDatabase`, `profiles`, `example`, the server's request path;
  - `packages/id-admin` (`createIdProfiles`, the fake ID);
  - `packages/mcp-platform`;
  - `mcps/toolbox`, `mcps/standalone`, the PR's changes to `mcps/admin`;
  - `mcps/e2e`, `mcps/example`.
- **The decisions:** the MCP CLI's D2, D6, D14, D15, D17 and D18.
- **Consider, among others:**
  - whether two serving processes, the Toolbox and the standalone server, and three places to run, are needed today;
  - what each reads from ID on a call, and its caches;
  - what `mcp-platform` holds, and whether each piece has more than one user;
  - what a tool author must learn.

### D. The CLI

- **The code:**
  - `scripts/mcp`: `cli.ts`, `commands/*`, `ask.ts`, `io.ts`, `templates/*`, `generate.ts`, `definitions.ts`, `errors.ts`, `rules.ts`, `local-*.ts`, `machine.ts`, `environment.ts`, `database.ts`, `config.ts`;
  - `mcps/*/mcp.json`;
  - `mcps/retired.json`;
  - the generated files: `charts/answerable/mcps.json`, `mcps/toolbox/src/mounted.generated.ts`, `mcps/standalone/src/served.generated.ts`, and their `package.json` dependencies;
  - root `package.json` scripts.
- **The decisions:** the MCP CLI's D5, D7, D12, D13 and D16.
- **Consider, among others:**
  - each command, flag, prompt, step and exit code, and who needs it;
  - what is written, generated or checked, and in how many places;
  - the size of `scripts/mcp` against what it does;
  - what an LLM agent, which has no terminal, needs from the CLI.

### E. Shipping and registration

- **The code:**
  - `mcps/Dockerfile`;
  - `charts/answerable` (templates, values, `mcps.json`, the hooks and their weights);
  - `infra/ops` (`bootstrap`, `register`, `registrar`, `make-admin`, `commands`, `admin-api`, `secret-store`);
  - `infra/pipeline`;
  - `infra/k8s`;
  - `.github/workflows`;
  - the admin MCP's `standalone_enable` and `toolbox_enable`;
  - every machine client the PR adds or keeps (`ops-register`, `toolbox-hub`, `standalone-hub`, `admin-mcp`, `mcp-dev`).
- **The decisions:** the MCP CLI's D8, D9 and D10, and the runbook `infra/README.md` and `docs/12-deployment.md`, as the PR changes them.
- **Consider, among others:**
  - each Job, hook, client and Secret, and what it guards against;
  - what runs on every deploy, and how long it takes;
  - the steps between a commit and a person using a new MCP;
  - what is described in more than one place.

### F. Tests, docs and the developer's path

- **The code:**
  - every test the PR adds or changes (`git diff --stat 62b6b1b3..HEAD -- '*.test.ts'`);
  - the test helpers (`testing.ts`, `test/` folders);
  - `apps/web/content/docs/mcp/*`, `docs/toolbox/*`, `docs/admin/*` as changed;
  - `AGENTS.md`;
  - the READMEs and CHANGELOGs the PR adds or changes.
- **The decisions:** the MCP CLI's D11, and the 100% coverage gates (`AGENTS.md`, Gates).
- **Consider, among others:**
  - tests that check implementation rather than behaviour;
  - the same behaviour proven at several levels;
  - each suite's time;
  - helpers with one user;
  - docs that repeat each other or drift from the code;
  - whether a developer who has never seen the repository can make, test and ship an MCP from the docs alone;
  - what a coding agent reads before it can start.
