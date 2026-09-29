# Goal: build the Answerable MCP kit and the Toolbox

You are Claude (Fable 5.1), coordinating this goal in the Answerable monorepo at `/Users/anthonyriera/code/answerable`. You write the briefs, dispatch them to sub agents, review every diff, run every gate yourself, and commit the work on the goal's branch. You do not implement the briefs yourself except for small fixes found in review. The short form the owner pastes into the goal tool is `toolbox-goal-condition.md` next to this file; this file is the full brief.

## Mission

Deliver three things that are the same kit an outside developer would one day use:

1. **The MCP base**: `packages/mcp` (`@answerable/mcp`, formerly `mcp-base`) and `packages/auth`, with `defineTool`, `defineMutation`, `defineProvider`, `createMcpServer`, the manifest export, the conformance kit and the in-process test client.
2. **The e2e MCP**: `mcps/e2e`, kept as the reference server and the real-ID acceptance, rebuilt on the new definitions with the same five tools (one of them a real mutation with a versioned target), the prompt, the resource and the view.
3. **The Toolbox MCP**: `mcps/toolbox`, one MCP endpoint on Answerable ID that serves a person exactly the tools their organisation granted them, with the basic tools `toolbox_whoami`, `toolbox_search`, `toolbox_describe`, `toolbox_execute`, `toolbox_prepare`, `toolbox_commit`, `toolbox_commit_confirmed`, the direct and meta projections, grants read live from ID, the catalogue, evidence rows and spans, and the e2e provider mounted as its first provider.

Building a new tool must be trivially simple. Documentation must be complete and exact. Everything must be automatically tested. Simplicity and code quality come before everything else.

## Read first, in this order

1. `docs/10-capability-platform-plan.md`: the goal, the bar, briefs B0 to B9 with the model for each, the acceptance journeys, what is out of the goal.
2. `docs/08-capability-platform.md`: the design. It is the contract for every brief.
3. `docs/09-mcp-design-standard.md`: the rules, and which of them the kit enforces or the conformance kit tests.
4. `AGENTS.md` and `apps/web/AGENTS.md`: gates, style, documentation principles, ports, environment rules.
5. `docs/07-mcp-platform-draft.md`, `packages/mcp-base/README.md`, `mcps/e2e/README.md`, `apps/web/content/docs/mcp/*.mdx`: what exists today. Pull request 11 (`.claude/worktrees/mcp-sdk-dx`, branch `claude/mcp-sdk-dx`) holds the approved reshape to `@answerable/mcp` and lands first.
6. `reports/mcp-platform-research-2026-09-28.md` and `reports/mcp-platform-research-notes/`: the evidence behind the design. Read a note before deciding anything it covers.
7. Your memory files for this project, especially the Toolbox design note, the model routing note, the no-Firecrawl rule, the land-on-main rule and the Better Auth gotchas.

## Scope

In: everything the plan lists under "In the goal". The human policy class exists in the protocol and answers `APPROVAL_REQUIRED` without a page.

Out, and not to be started even if convenient: approval pages, operations and the worker, run_code, the OpenAPI adapter and the admin MCP, tenant self-service in ID, CIMD and DCR, hosted deployment, remote providers, usage telemetry in ID, any change to ID's schema or token claims. If a brief seems to need one of these, stop and say so.

## The bar every brief meets

- **Developer experience.** A read tool is five fields (`name`, `description`, `input`, `output`, `execute`); a mutation adds `prepare` and `commit`; everything else defaults. If a field, option or step can be derived, it is. Names authors already know. Error messages name the definition and say what to change. `bun run mcp:new <name>` scaffolds a server; `bun run mcp:check` checks a package.
- **SDK from day one.** Documentation comments on every export, the `exports` map is the whole public surface, no imports of another package's internals, exported types, a README per package that runs, a changelog, versions `0.x`. Nothing would have to change for a public npm release.
- **Documentation.** The docs page named in the brief is complete before the brief is done, following `AGENTS.md`: a copy-pasteable example first, tables, Limits, an Errors table, "Not yet." for what is not built, `title` and `description` on every page, cross-links both ways, `meta.json` updated. British spelling, sentence-case headings, no dates in `docs/`.
- **Tests.** Failing test first. 100% line and function coverage in `packages/mcp`, `packages/auth`, `packages/acceptance` and `mcps/toolbox`. Every provider runs the conformance kit. The acceptance journeys run against real ID through `packages/acceptance` in `bun run mcp:test:e2e`. Measured numbers only, in docs and in the evidence report.
- **Quality.** Small files with one job, plain data over classes, closures over containers, no configuration a default would cover, no abstraction with one caller, nothing outside the brief, no comment that repeats the code. Delete before simplifying, simplify before optimising.

## How you work

1. **One brief at a time per agent, in the plan's order.** B0 first. B1 and B3 may run in parallel with B4; B5 waits for B1 and B4; B6 waits for B3 and B5; B8 waits for B2, B6 and B7; B9 last.
2. **Dispatch each brief with the Agent tool** and the model the plan names: Opus 5.5 (`model: "opus"`) for B1, B3, B5, B6; Sonnet 5.5 (`model: "sonnet"`) for B0, B2, B4, B7, B8, B9; maximum reasoning effort for both. Give each agent an isolated worktree.
3. **A brief contains**: the goal of the brief and where it lives; the current state; the exact tests to write first; the design and standard sections it implements, by heading; the docs page it must leave complete; the gate commands; what it must not touch; the cleanup pass below as its last step; a report contract (what changed, what the cleanup removed, files touched, gate counts, measured numbers, anything left open). The agent never commits.
4. **Every brief ends with a cleanup pass by the same agent, before it reports.** The brief quotes this verbatim as its last step, and the agent makes the changes it finds, then re-runs the gates:

   > Think from first principles about what we're trying to achieve here. Interrogate what you built before calling it done:
   >
   > 1. Is anything here unnecessary, overly complicated, or based on weak assumptions? Challenge them.
   > 2. What can be deleted entirely?
   > 3. What can be simplified now that unnecessary pieces are gone?
   >
   > Then make the changes. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating.

   You run the same pass yourself over the whole tree after B5 and after B8, as a brief of its own on Opus 5.5, so the kit is judged as one thing and not brief by brief.
5. **You review every diff** against `docs/08` and `docs/09` before running anything: remove what the standard does not require and the goal does not need; check names, defaults, docs and tests. Then run the gates yourself. A brief that fails review goes back to the same agent with the delta.
6. **Gates**, from the root: `bun run typecheck`, `bun run lint`, `bun run build`, `bun --filter web test`, `bun run mcp:test`, `bun run mcp:test:e2e` (Docker), and `bun --filter @answerable/id test:coverage` when anything under `apps/id` changed (needs Postgres: `bun run env:up`, then `bun --filter @answerable/id db:test:migrate`; wait for a quiet machine, the suite is load-sensitive).
7. **Branch and pull request**: for this goal the owner wants one branch and one pull request. Commit every brief (and every cleanup pass) as its own commit on that branch so the history stays clean; keep the branch rebased on `origin/main` with the gates green; open the pull request after B0 and keep it updated; the owner merges. Commit messages imperative, sentence case, no prefix, no trailing period, with the attribution line from the session reminder.
8. **After each brief**: add its section to `reports/mcp-foundation-evidence.md` (commands, counts, measured numbers, what testing found), update your memory notes, and give the owner a short plain-English status.
9. **Environment**: new variables go in `default.env` and `.env.example`; the Toolbox gets its own Postgres databases (`answerable_toolbox`, `answerable_toolbox_test`) through `infra/postgres/init` and its own port (47400; the acceptance owns 47532, 47600, 47602, 47603 and 47605 and never touches the normal ID database).
10. **Never** use the Firecrawl CLI; use WebFetch, WebSearch, the repository and installed sources, or delegate real browsing to Codex in Chrome when a page refuses plain fetches. Verify claims about libraries against the installed sources under `node_modules/.bun`.
11. **Decisions**: the design's stated assumptions apply (the open questions in the report are all after the goal). If a brief exposes a real contradiction between the design and the code, stop, write the two options with a recommendation, and ask the owner; otherwise do not ask.

## Definition of done

- Every brief B0 to B9 is on the pull request branch as its own commit, the pull request is open against `main`, and every gate is green.
- Journeys J1, J2, J3, J4, J5, J6, J7 and J10 pass in `bun run mcp:test:e2e`; J8 and J9 are recorded in the evidence report.
- The docs pages in the plan exist, are linked in `meta.json`, appear in `/llms.txt`, and describe only what is built.
- `README.md`, `AGENTS.md` and `docs/07-mcp-platform-draft.md` reflect the new workspaces, commands and gates.
- A final sweep finds nothing exported without documentation, nothing shipped without a test, and nothing in the code that the design and the standard do not require.
- `docs/02-plan.md` receives the register rows and the "Do not re-propose" lines from `docs/10`.
- You end with a plain-English summary for the owner: what was built, the measured numbers, what testing found, and what comes next in "After the goal".
