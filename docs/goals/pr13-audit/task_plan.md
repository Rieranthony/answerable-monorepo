# Pull request 13: the audit before it merges

## Goal

Asked by the owner on 2026-10-26, for when M9 has landed:

> is anything here unnecessary, overly complicated in our current setup, or based on weak assumptions? Challenge them.
>
> - What can be deleted entirely?
> - What can be simplified now that unnecessary pieces are gone?
> - Then make the changes. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating.
>
> plan with files, report before coding. This PR once merged will impact thousands of users and future developers / companies future. This is not something to rush.

**Done means:**
- a published report, where every finding has been checked against the code and every number was measured;
- the owner's decision on each proposal;
- then the approved changes on the branch, with every gate green.

No code changes until the owner has decided.

## Scope

[Pull request 13](https://github.com/Rieranthony/answerable-monorepo/pull/13) (`claude/typed-config-b1`), measured against `main` at `62b6b1b3`, as it stands after M9. The owner confirmed this scope on 2026-10-26: "Keep the audit scoped to PR #13 and what it reshapes."

Before M9, it held 14 commits, 488 files, +22,726 and −3,494 lines. [`findings.md`](findings.md) has the breakdown.

**What the audit reads:**
- **The code the PR adds or changes:**
  - typed configuration: `packages/config`, every service's definition, `scripts/env-inventory.ts`, `default.env`, `.env.example`;
  - the MCP CLI goal: `packages/mcp-postgres`, `packages/mcp`, `packages/mcp-platform`, `packages/id-admin`, `scripts/mcp`, `mcps/*`, `charts/answerable`, `infra/ops`, `infra/pipeline`, `infra/k8s`, `infra/postgres`, the workflows, the docs and `AGENTS.md`.
- **The decisions it rests on:**
  - typed configuration: D1 to D7, in `docs/goals/typed-config/task_plan.md`;
  - the MCP CLI: D1 to D19, in `docs/goals/mcp-cli/decisions.md`.
  - A decision is challenged like code: what assumption it rests on, whether a number backs that assumption, and what removing the decision would cost.
- **The code that existed before the PR, where the PR builds on it or reshapes it:** the SDK, the Toolbox, the admin MCP, the chart and the ops Jobs.

**Out of scope:**
- Answerable ID's internals, except the 11 files the PR changes in `apps/id`;
- the website outside `/docs`;
- `packages/ui`, `packages/design` and `packages/countries`.

## Method

1. **Wait for M9.** It runs its own cleanup pass, the benchmark and every gate. The audit reads the tree that would merge. The counts and gate timings taken after M9 are the baseline.
2. **Six independent audits, in parallel.**
   - **Why independent:** this session wrote the design and reviewed every brief, so its own reading is anchored. Each auditor gets the code and the decisions for its area, never this session's opinions of them.
   - **How:** each runs on Opus and is read-only. For every finding it gives:
     - file and line;
     - the evidence;
     - the assumption behind the code, and whether a number backs it;
     - a verdict: delete, simplify, optimise, automate, or keep, with the reason;
     - what the change would remove, in lines and concepts;
     - the risk.

   | Audit | Area |
   |---|---|
   | A | Typed configuration: `packages/config`, the service definitions, the inventory script, `default.env`, `.env.example`, the generated docs tables |
   | B | The database model: `packages/mcp-postgres` (the `shared` and `own` modes, roles and logins, `migrateMcp`, `mcpDatabase`, row-level security, the test helpers), `infra/postgres`, the database parts of the ops Jobs |
   | C | The SDK and the servers: `packages/mcp` (the context, `withDatabase`, profiles), `packages/mcp-platform`, the Toolbox, the standalone server, the admin MCP's changes, `mcps/e2e`, `mcps/example` |
   | D | The CLI: `scripts/mcp` (commands, prompts, templates, generation, definitions and errors), `mcp.json`, `retired.json`, the generated lists |
   | E | Shipping and registration: the `mcps` image, the chart and `mcps.json`, the hooks, the register Job and its machine clients, `standalone_enable`, `infra/pipeline`, the workflows, the kind tests |
   | F | Tests, docs and the developer's path, across the PR: tests that check implementation rather than behaviour, duplicated or slow tests, flaky tests, docs that drift from the code, and whether a newcomer can follow the docs |

3. **Verify every finding.** This session reproduces each one by reading the line, or by running the probe or the test.
   - A finding that cannot be reproduced is dropped, or labelled as unverified.
   - Two audits that report the same thing become one finding.
   - Where auditors disagree, the report says so.
4. **Report.**
   - The findings, ranked by what they cost users and developers.
   - Each finding has its evidence, the proposal, the lines and concepts it removes, the risk, and a decision for the owner.
   - The report is published as an artifact. The decisions are recorded in `decisions.md`.
5. **The owner decides.** Then the approved changes are built in the order delete, simplify, optimise, automate. The gates run after each step, and a final pass runs every gate, including the acceptance and the kind stack.

## Rules

- No code changes before the owner's decisions. The audits are read-only.
- **The auditors run no suite that resets a shared test database** (`mcp:test`, the Toolbox's, the admin MCP's, `mcp-postgres`'s, the acceptance, the kind stack), because two concurrent runs collide.
  - A probe uses a throwaway database named for its audit (`audit_<letter>_…`) on the development Postgres (47432). The auditor drops it, and its roles, afterwards.
  - This session runs the shared suites itself.
- No `docker image prune` or `docker system prune`; never `bun run env:up` from a worktree.
- Measured numbers only. An estimate is labelled as an estimate.
- A proposal that changes behaviour a user can see says so, and names who would notice.

## Phases

| Phase | Status |
|---|---|
| 1. Plan (this file, `findings.md`, `progress.md`) | complete |
| 2. M9 lands; baseline counts and gate timings | complete |
| 3. Six audits | complete |
| 4. Verification | complete |
| 5. Report and decisions | complete |
| 6. The owner decides | complete (`decisions.md`) |
| 7. Changes, gates, the final pass | R1 to R6 (`briefs/`); R1 started |

## Errors

| Error | Attempt | Resolution |
|---|---|---|
| The harness refused the auditors' `report.md` files ("Subagents should return findings as text") | 1 | Each report was extracted from the agent's transcript into `pr13-audit/<letter>/report.md` with `pr13-audit/save.py` |
