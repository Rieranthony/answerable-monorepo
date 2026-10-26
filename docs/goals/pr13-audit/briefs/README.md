# Pull request 13 audit: how every brief is worked

Every brief in this folder starts by reading this page.

## Who does what

- **The agent** implements one brief in the worktree `/Users/anthonyriera/code/answerable/.claude/worktrees/typed-config-b1`, on branch `claude/typed-config-b1` (pull request 13). It never commits, pushes, tags or deploys.
- **The coordinator**, the session that ran the audit:
  - reviews the diff against [`../decisions.md`](../decisions.md) and the findings;
  - runs the gates;
  - commits the brief and pushes it to the pull request;
  - logs the evidence in [`../progress.md`](../progress.md).
- **The owner** decided D-1 to D-7 and merges the pull request.

## Read first, every time

1. `AGENTS.md`.
2. [`../decisions.md`](../decisions.md), the owner's decisions.
3. Each finding the brief names, in [`../audits/`](../audits/). The audit's letter is the file: A1 is in `A.md`. [`../findings.md`](../findings.md) says how each finding was checked.
4. The brief itself, then the files it names.

The MCP CLI goal's planning files (`docs/goals/mcp-cli/`) explain why the code is as it is. Its D1 and D2 are partly reversed by D-3 and D-1 here.

## Rules that bind every brief

These are the MCP CLI goal's rules (`docs/goals/mcp-cli/briefs/README.md`), and they still hold:
- tests first;
- 100% line and function coverage where the gate exists today;
- measured numbers only;
- documentation lands with the behaviour;
- no planned behaviour in the present tense;
- the repository's style;
- no secret in a commit, a fixture, a log or a report.

**On top of those:**
- **A finding is a claim, not an order.** Check it against the code before you act on it. If the code says otherwise, or the change would alter what a user sees beyond what the decision says, stop and report it with file and line.
- **Delete before you simplify, and simplify before you optimise.** When a deletion makes a later item moot, say so instead of doing it.
- **Generated files are rewritten by their generator, never by hand.** That covers manifests, `*.generated.ts`, `charts/answerable/mcps.json`, `packages/config/inventory.json`, `.env.example`, `apps/web/content/docs/mcp/reference.mdx` and the OpenAPI snapshots. Each brief names the command.

**Machine rules:**
- Never run `docker image prune`, `docker system prune` or any machine-wide Docker clean-up. Remove only what you created.
- Never run `bun run env:up` from the worktree. The development Postgres is on 47432 (`answerable`/`answerable`; `psql` is at `/opt/homebrew/opt/libpq/bin/psql`).
- Run `bun run mcp:test:e2e` and `bun run infra:test` one at a time, each alone, in the background, and wait for them.
- `bun --filter @answerable/id test:coverage` needs `bun --filter @answerable/id db:test:migrate` first.
- Leave no process behind: ports 47300, 47400, 47510 and 47520 must be free at the end, and no `bun --hot` of yours may be running.
- A probe works in a database or a copy named for it, and drops it afterwards. The session scratchpad is `/private/tmp/claude-501/-Users-anthonyriera--claude-spares-spare-qQNK1r/787e1118-e76c-4109-a85a-7962b23a9563/scratchpad/`.
- The shell is zsh: use `bash -c '…'` for loops. `afterAll(fn, { timeout })` throws in Bun 1.3.1; slow clean-up goes in the test's own `try … finally`.

## Gates

These run every time. The report gives counts and times.

```sh
bun install --frozen-lockfile
bun run typecheck --force
bun run lint --force
bun run build --force
bun run mcp:test
bun --filter web test
bunx knip
bun run infra:check
```

Each brief adds its own gates.

## The last step: the cleanup pass

> Think from first principles about what we're trying to achieve here. Interrogate what you built before calling it done:
>
> 1. Is anything here unnecessary, overly complicated, or based on weak assumptions? Challenge them.
> 2. What can be deleted entirely?
> 3. What can be simplified now that unnecessary pieces are gone?
>
> Then make the changes. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating.

## Report

The final message is the report, in this order:
1. What changed, finding by finding: done, not done (and why), or moot.
2. The tests added or changed, by name.
3. Every gate, with counts and times.
4. The lines removed and added, measured with `git diff --shortstat` over the brief's change.
5. Anything a finding got wrong, and every choice the brief did not fix.
6. What you created and dropped (databases, roles, copies, images, processes).
7. `git status --short`.

The harness refuses report files from agents, so put everything in the final message.
