# MCP CLI briefs: how every brief is worked

Every brief in this folder starts by reading this page. It holds what every brief shares, so that a brief holds only its own job.

## Who does what

- **The agent** implements one brief in the worktree the coordinator names when dispatching it (`.claude/worktrees/mcp-cli-m<N>`, branch `goal/mcp-cli-m<N>`, cut from `origin/main`). It never commits, pushes, tags or deploys. M4, M5 and M6 are cut from the integration branch instead (below).
- **The coordinator** (the session that wrote the plan):
  - reviews the diff against [`../design.md`](../design.md) and [`../decisions.md`](../decisions.md);
  - runs the gates;
  - commits on the brief's branch;
  - rebases it on `origin/main` (on `claude/mcp-cli` for M4 to M6);
  - pushes it to `main` (M4 to M6: to `claude/mcp-cli`, then to `main` together after M6);
  - records the evidence in [`../progress.md`](../progress.md).
- **The owner** pushes the `staging/<name>` and `production/<name>` tags. Nothing in this goal ships an environment.
- **Where briefs land.**
  - M1, M2, M3, M7, M8 and M9 each land on `main` on their own.
  - M4, M5 and M6 are cut from, and land on, the integration branch `claude/mcp-cli`. That branch lands on `main` once M6's kind stack passes ([`../task_plan.md`](../task_plan.md), Landing).

## Read first, every time

1. `AGENTS.md` (repository rules, gates, ports, the worktree rules).
2. [`../task_plan.md`](../task_plan.md), [`../design.md`](../design.md), [`../decisions.md`](../decisions.md) and [`../findings.md`](../findings.md).
3. The brief itself, then the files it names.
4. `docs/goals/typed-config/` as landed. This goal runs after typed configuration's B1 and B2 (D3). Every variable a brief adds goes into the service's `defineConfig` definition, with its development and test defaults, and the generated inventories are rewritten with `bun run env:inventory`. If `@answerable/config` is not on `main`, stop and report.

## Rules that bind every brief

- **Tests first.** The brief names the tests. Write them failing, then make them pass.
- **Coverage.** 100% line and function coverage in every workspace that has the gate today, and in every new workspace except `packages/acceptance` and `infra/k8s`.
- **Measured numbers only,** in docs, reports and the evidence. Estimates are labelled as estimates.
- **Documentation lands with the behaviour.** The brief names its pages. They follow `AGENTS.md`'s ten principles:
  - plain English and British spelling;
  - a command first;
  - code included from tested files, never pasted;
  - an Errors table;
  - "Not yet." for anything unbuilt;
  - a `.md` form that matches the page.
- **No planned behaviour in the present tense,** anywhere: docs, comments or READMEs.
- **Style.**
  - No semicolons outside `apps/id`.
  - Small files with one job; plain data over classes; closures over containers, except the database the platform supplies (D17).
  - No abstraction with one caller, no option a default covers, no comment that repeats the code.
- **Never in this goal:**
  - run `terraform apply`, `destroy` or `-replace`, or `helm upgrade` against an environment, or push a tag;
  - run `bun run env:up` from a worktree (use the Postgres on 47432);
  - run two acceptances or two kind stacks at once on this machine.
- **No secret or real credential** in a commit, a test fixture, a log or a report.
- **Dependencies:** upgrade the libraries the brief touches to their latest release, reading the changelog for a major version. Name every new dependency and its version in the report.
- **When the brief or the design is wrong** (the code says otherwise, a rule can't be met, a decision is missing), stop. Report what you found with file and line and a recommendation, and don't work round it.

## Gates

Each brief lists its own. These always apply, and the report gives the counts:

```sh
bun run typecheck
bun run lint
bun run mcp:test
bun --filter web test
bunx knip
```

If a tool answers `tsc: command not found` in a fresh worktree, run `bun install --frozen-lockfile`.

## The last step of every brief: the cleanup pass (verbatim)

> Think from first principles about what we're trying to achieve here. Interrogate what you built before calling it done:
>
> 1. Is anything here unnecessary, overly complicated, or based on weak assumptions? Challenge them.
> 2. What can be deleted entirely?
> 3. What can be simplified now that unnecessary pieces are gone?
>
> Then make the changes. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating.

Then run the gates again.

## Report contract

The report covers, in this order:
1. What was built, as a short list.
2. The tests added, with names.
3. Every gate, with counts, coverage and timings.
4. The numbers the brief asked to measure.
5. What the cleanup pass removed.
6. The output of `git status --short`.
7. Anything the design got wrong or left open, with a recommendation.
8. Every choice made that the brief didn't fix.
