# Implementation, common brief (20 October 2026)

The owner took every recommended decision D1–D13 of `docs/goals/v0-code-audit/report.md` (decisions listed in `task_plan.md`). You implement one change set. Read first: `report.md`, `task_plan.md` (Decisions), the audit your change set comes from (`audits/a.md`, `b1.md`, `b2.md`, `c.md`; each has the exact files, lines, probes and the spike that proved the change), and the repository rules in `AGENTS.md` (gates, style, commits, docs rendered from source). The earlier goals' rules hold: `docs/02-plan.md` "Do not re-propose", docs/05 §11.

## How to work

- You are in an isolated worktree from `main` (60c98f65). Your throwaway Postgres 17 is named in your brief; make the worktree's `.env` with `sed 's/47432/<port>/g' /Users/anthonyriera/code/answerable/.env > .env` (check `apps/id/bunfig.toml` for the file the suite reads). `bun install` first. Never touch the main checkout or Postgres 47432; never `bun run env:up`.
- Tests first: change or write the test that pins the new behaviour, then the code. A test that existed only to light a deleted mechanism goes with it (test-audit rule: a fact is proved once, at the layer closest to the consumer). Keep 100% line and function coverage in `apps/id` and in every package you touch.
- Gates before you report, in `apps/id`: `bun run typecheck`, `bun run lint`, `bun run db:test:migrate && bun test --timeout 15000` (100%; note the time). For a package or an MCP workspace you touched: `bun run mcp:check <workspace>` from the root; if you changed a provider definition or a tool's output shape, `UPDATE_MANIFEST=1 bun run --filter <workspace> test` and commit the manifest. If you changed an admin route or schema: `bun run openapi:export` in `apps/id` (or its successor after change set 3) and commit both snapshots; `bun --filter web test` must stay green (the docs link check and the generated tables read ID's sources).
- Docs the change touches (README, OPERATIONS.md, docs/03/04/05/06, `apps/web/content/docs/**`, `default.env`, `.env.example`): update the sentences that describe what you changed, in the same commit. The docs change set (4) does the wider rewrite afterwards; do not do its work.
- Commits: small, one per finding, imperative, sentence case, no prefix, no trailing period; end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit in your worktree; the coordinator cherry-picks onto the landing branch.
- Do not widen the scope. If a decision cannot be done as written (a test shows a reason the audit missed), stop that item, keep the rest, and say so in your report with the evidence.
- No plaintext secret, no new dependency without a reason, British spelling in prose, the repository's Prettier style (semicolons in `apps/id`, none elsewhere).

## Your final message (under 500 words)

Per finding: done or not, the commits, and anything that deviated from the decision and why. Then the gate results with numbers (tests, time, coverage), the files the coordinator must watch for conflicts with the other change sets (`env.ts`, `openapi.admin.json`, `principal.ts`, README, docs/06), and what you could not verify.
