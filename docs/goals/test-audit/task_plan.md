# Test audit goal (opened 2026-10-03)

**Goal.** Step back and check the tests across the MCP kit, Answerable ID, the admin MCP and the e2e MCP: are they useful, do they test the right things, do they test enough. Challenge weak assumptions, delete what is unnecessary, simplify what is left, then make the changes. Prefer deleting over simplifying, simplifying over optimising, optimising over automating. Everything based on testing. Target: production, thousands of users.

**Rules carried over.** Report and decisions before code (owner's audit preference). Land on main, no pull requests. Measured numbers only. Opus 5.5 for hard briefs, Sonnet 5.5 for ordinary ones, Fable coordinates.

## Phases

| # | Phase | Status |
| --- | --- | --- |
| 0 | Baseline: inventory, gates run with timings | complete |
| 1 | Audit briefs (Opus) per area: ID auth, ID admin, MCP kit, admin MCP + Toolbox + acceptance | complete |
| 2 | Coordinator's first-principles pass over the audits; probes for every claim | complete |
| 3 | Report + decisions (artifact) | complete (republish with after-numbers at landing) |
| 4 | Implementation briefs (delete, simplify) | complete: C 7dfc0a2, D 48aef85, A 4e4776c, B 30f44d8 |
| 5 | Gates, land on main, memory update | complete |

## Decisions

Taken by the coordinator as recommended defaults (reversible), recorded in the report (https://claude.ai/artifact/HAESyzd6MvfxpRLJYcQRpC) and in `findings.md`: C1–C7 (kit), D1–D7 (admin MCP, Toolbox, acceptance), A1–A8 (ID auth), B1–B8 (ID admin). Coordinator additions while landing: the acceptance fixture runs ID with Better Auth's origin and CSRF checks on; `tier` stays as the middleware tests' observation point; `http/authorize.test.ts` stays (the two authorisation layers cannot be told apart through HTTP); the kit keeps `mcps/example`'s paging test and e2e's prompt/resource test (their facts had no other holder in the workspace).

## Errors encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
