# Common brief: v0 code audit of Answerable ID (20 October 2026)

You are one of five auditors. The owner's words: "for the last time audit our id platform code, is anything here unnecessary, overly complicated in our current setup, or based on weak assumptions? Challenge them. What can be deleted entirely? What can be simplified now that unnecessary pieces are gone? Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating. This should be an enterprise-grade solution, it will impact thousands of users, little details are important."

This is the fourth pass over this code. Three earlier goals settled a lot; read them before you form a view, and argue against a settled decision only with new evidence (a run, a measurement, a consumer that exists or does not):

- `docs/goals/v0-cleanup/conclusions.md` and `task_plan.md` (7 October: line-level slop, shared helpers, the keeps and why).
- `docs/goals/v0-schema-audit/task_plan.md` (19 October: the storage contract; soft deletion stays on every table by the owner's choice; scope modes; audit events).
- `docs/goals/test-audit/conclusions.md` (4 October: the suite's shape; a fact is proved once at the layer closest to the consumer).
- `docs/02-plan.md` "Do not re-propose" and docs/05 §11 "Accepted": own-tenant trust, explicit verified linking, five-minute sensitive-human freshness, terminal product deletion, UUID attribution, deferred purge, no email as a join key, no second authorisation framework, no seed accounts or bootstrap CLI, no impersonation or personal access tokens, no cached authority for staff tools, no tool that takes a secret.
- `docs/03-answerable-id.md` (the design), `docs/05-id-enterprise-foundation.md` (the invariants), `docs/04-answerable-id-schema.md`, `apps/id/README.md`, `apps/id/OPERATIONS.md`, `docs/09-mcp-design-standard.md` for the rule "build on the official SDK's primitives rather than re-implementing".

## What you are looking for

Not slop: the cleanup found none left worth the name. You are looking for **structure that exists because of an assumption**, and testing the assumption. For every mechanism in your scope ask, in this order:

1. **Who needs it?** Name the consumer (a route the admin MCP calls, a journey in `packages/acceptance`, an ops Job in `infra/ops`, a docs page, Better Auth itself) or show there is none. Consumers call paths, not operation ids: grep for the path.
2. **What does it protect against, and does that threat exist in this deployment?** (One Postgres, Bun behind Cloudflare and Traefik, staff and machines as callers, thousands of users signing in through their directory, no public registration.)
3. **What does the pinned dependency already do?** Read the installed sources, never the docs from memory: `node_modules/better-auth` 1.7.2, `node_modules/@better-auth/oauth-provider`, `@better-auth/sso`, `@better-auth/core`, `hono` 4.13.5, `hono-openapi` 1.3.1, `drizzle-orm` 0.45.2, `pg` 8.16.3. Cite the file and line of the dist you read.
4. **What would break if it went?** Run the suite or a targeted test with the piece removed (a spike in your worktree, reverted after) and report what failed and why. A test that exists only to light the mechanism is not a reason to keep it.
5. **What does it cost at scale?** Rows, bytes, round trips, locks, latency per request at 10,000 users; measure on your Postgres where a number matters.

Then give a verdict: **delete** (the piece and its tests go, nothing replaces it), **simplify** (fewer parts, same guarantee: say which parts), **keep** (say which consumer or threat holds it). Delete beats simplify; simplify beats optimise; optimise beats automate. A keep with a reason is a fine outcome; a delete without a run is not.

## How to work

- You run in an isolated worktree of the repository. The main checkout at `/Users/anthonyriera/code/answerable` is the owner's: never commit, edit or run tests there, never touch Postgres 47432, never run `bun run env:up` or `env:reset`. Your throwaway Postgres 17 is named in your brief; it was created from `infra/postgres/init`, so it holds every database and runtime login. Make your worktree's `.env` from the owner's with the port replaced: `sed 's/47432/<port>/g' /Users/anthonyriera/code/answerable/.env > .env` (and `apps/id/.env` if the suite reads one; check `bunfig.toml`). Run `bun install` in the worktree first if `node_modules` is missing.
- ID gates in `apps/id`: `bun run db:test:migrate` then `bun test --timeout 15000` (the full suite is ~5–6 minutes; a file at a time is faster: `bun test src/http/admin/clients.integration.test.ts`). Typecheck `bun run typecheck`, lint `bun run lint`.
- Spikes: change the code in your worktree, run what proves the point, record the result, `git checkout -- .` afterwards. Keep probe scripts and logs under `/tmp/v0-code-audit/probes/<your letter>/`, numbered, so the coordinator can re-run them.
- Read every file in your scope in full; do not sample. Note the line counts.
- Do not propose what the lists above forbid, do not reopen the schema, do not rewrite tests for their own sake. Do not fix anything.

## Your report

Write it to `/Users/anthonyriera/code/answerable/docs/goals/v0-code-audit/audits/<letter>.md` (absolute path into the main checkout; that file is yours to create). Markdown, British spelling, no marketing. Structure:

1. **Scope and method**: files read with line counts, the installed sources you read, the probes you ran (numbered, with the command and the result in one line each).
2. **Verdict table**: one row per finding: id (`<letter><n>`), mechanism, files, verdict (delete / simplify / keep), lines affected, consumer or threat, evidence (probe number or dist citation), what holds after (the test or the dependency).
3. **Findings in detail**: for every delete or simplify, the evidence, the proposal, what a user of the service would notice, the migration or consumer change it needs, the test that proves it afterwards, and the risk for thousands of users. For every challenged keep, the assumption and the evidence that held it.
4. **Unsafe or wrong**: anything you found that is a bug or a hole, with the reproduction. Report these first in your final message.
5. **Open questions for the owner**: only where two defensible designs differ in product terms.
6. **Measured numbers**: every number in the report with where it came from.

Your final message to the coordinator: the unsafe findings, then the deletes and simplifications with their line counts, then anything you could not verify. Under 600 words. The report file carries the detail.
