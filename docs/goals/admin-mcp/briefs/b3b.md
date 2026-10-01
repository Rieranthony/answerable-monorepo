You implement brief B3b of the Answerable admin MCP goal: prove the admin MCP end to end against real Answerable ID, give the owner a demo lane, and document setup. You never commit; the coordinator reviews your diff and commits.

## Where

Worktree `/Users/anthonyriera/code/answerable/.claude/worktrees/admin-b3b` (branch `goal/admin-b3b`, cut from `claude/admin-mcp` after B2 landed; `bun install` done). Work only there, with absolute paths and `git -C <path>`.

Read first, in full: `AGENTS.md`; `docs/goals/admin-mcp/design.md`, `decisions.md` (D0, D10, D12, D13), `findings.md`, `task_plan.md` (B3 and "Coordinator decisions"); `mcps/admin` as B1 and B2 left it (README, `src/*`, `apps/web/content/docs/admin/index.mdx`); `packages/acceptance` (README, `src/*`, every journey file, especially `kit.journeys.test.ts` from B3a, which already proves staff sign-in, spare directories, `signInRefused` and a two-audience machine client; and `scripts/host-lane.ts`); `apps/web/content/docs/mcp/local-testing.mdx`, `claude-code.mdx`, `apps/web/content/docs/toolbox/admin.mdx`, `apps/web/content/docs/id/onboard.mdx`; `reports/mcp-foundation-evidence.md` (its format for sections).

## What to build

### 1. `packages/acceptance/src/journeys/admin.journeys.test.ts`

Real ID from `startId({ tenants: [...], platform: { signIns: N }, spares: [...] })` (count the sign-ins each step consumes), the Toolbox on 47604 and the admin MCP on 47606 served in process with `serve`, the official MCP OAuth client and the browser through the kit. Register through the kit: the admin MCP's resource (allowed scopes `admin`, `offline_access` and the three role grant strings), a host client for it, the platform organisation's capability and organisation-wide entitlement carrying `admin`; three role groups with their entitlements; the admin MCP's machine client with `registerMachine` and two audiences (ID's admin resource with `platform:read platform:write`, the Toolbox's admin resource with the Toolbox's admin scope); the Toolbox as the existing Toolbox journey does. Use `manifest.platform.organizationId`, never the slug. Take each registration call from the docs page you write in step 3, so the page is proven by the journey.

| Journey | Proves |
| --- | --- |
| A1 roles without re-authorisation | Staff signs in to the admin MCP; `admin_whoami` says no role and is the only tool listed; the kit (root) puts the member in the team group: the SAME token lists the reads on the next call; then the owner group: writes and critical tools appear; owner removed again: they vanish. Measure per-request latency of `tools/list` with the live access read (median and max over at least 20 calls) and record it. |
| A2 onboarding through the MCP | As owner: `organisations.create` (prepare → preview → `admin_commit` answers `APPROVAL_REQUIRED` → `admin_commit_confirmed` with the summary commits), `domains.add` with the spare's domain, the SSO provider set by the kit with `setSsoProvider` (D0: the fixture directory needs a secret, which no tool takes), `groups.create`, `toolbox.enable` for the Toolbox's host client with provider `e2e`, `access.grant` of an `e2e` grant string to the organisation on the Toolbox resource. Receipts carry ID's operation ids; ID's audit rows for each write carry `requestId` = the commit's execution id and the machine client as actor (read them through `audit.list` AND the admin API). |
| A3 the Toolbox outcome | Before `toolbox.enable`, the new organisation's person is refused at ID's chooser (`signInRefused`, the exact text); after the enable and the grant, they sign in to the Toolbox and list `toolbox_whoami` and the `e2e` tools and call one; after `access.revoke` the tools are gone within the Toolbox's documented cache window (measure it); after `organisations.disable` (owner, with a fresh sign-in) refresh answers `invalid_grant`. |
| A4 refusals | A member of a client organisation (a tenant) who obtains a token for the admin MCP (grant that tenant the admin resource deliberately, to test the MCP's own platform check, as the second line of defence) lists nothing and `admin_whoami` is the unknown-tool error; without that deliberate grant ID refuses them at the chooser. An admin (not owner) calling `organisations.disable` gets the unknown-tool error and a `capability.denied` evidence row. Renaming the organisation through the kit between prepare and commit of `organisations.update` answers `INTENT_STALE` with the ETags. |
| A5 idempotency | Commit the same intent twice, concurrently and then again: exactly one effect in ID, `COMMIT_IN_PROGRESS` or the same receipt, and the replay has `idempotent_replay: true`; ID's audit shows one write for the intent's key. |
| A6 freshness | Run the admin MCP for this journey with a short `ADMIN_FRESH_SECONDS` (for example 5): after the window, a critical tool's prepare answers `ADMIN_REAUTHENTICATION_REQUIRED`; follow EXACTLY the remedy its message gives (B2 derived it from ID's code), get a new token through the kit, and the same critical tool now prepares and commits. If the remedy does not work against real ID, stop and report what does, with evidence. |
| A7 evidence | The platform organisation's evidence chain verifies (`createEvidence(db).verify(...)` on the acceptance database); `capability.completed`, `capability.denied`, `intent.prepared`, `intent.committed` and `receipt.issued` rows exist for the steps above; for every write, the evidence row's request id joins an ID audit row. |

The admin MCP's database in the acceptance: a database on the acceptance's own Postgres (port 47532), like `answerable_toolbox_acceptance`; never the development databases.

### 2. `packages/acceptance/scripts/admin-lane.ts` (the owner's demo)

Same shape as `host-lane.ts`: real ID from the fixture with the platform directory (several staff sign-ins) and one or two spare directories, the Toolbox on 47604 and the admin MCP on 47606, every registration done, the staff member placed in the owner group, up until Ctrl-C. It prints, in this order: the staff email, the `claude mcp add` command for the admin MCP (fixed public client id and callback port), the spare organisation's slug and domain to create, the `claude mcp add` command for the Toolbox, and the new organisation's person's email. Because the spare directory needs a secret no tool takes, the lane watches ID for a new organisation that holds the spare's domain and sets its SSO provider itself, printing that it did. `--check` runs the whole story headlessly with the kit (staff signs in, onboards the spare organisation through the tools, the person signs in to the Toolbox and calls a tool) and exits 0, printing timings. The script is covered the way `host-lane.ts` is (check how; keep the acceptance's coverage gate green).

### 3. Docs

- `apps/web/content/docs/admin/setup.mdx` (title, description; add to `admin/meta.json`): registering the admin MCP in an Answerable ID with cURL, root first and then a platform admin: the resource, the host client (Claude Code), the platform organisation's capability and entitlement, the three role groups with their entitlements, the machine client with two audiences, adding the first owner; then running it (`bun run admin:dev`) and connecting Claude Code. Every call matches what the journey runs. Then "Try it locally" with the lane: the exact commands, what to type into Claude Code for the demo (onboard the spare organisation, enable the Toolbox, grant access, then sign in to the Toolbox as the new organisation's person), and what each step shows.
- `apps/web/content/docs/mcp/local-testing.mdx`: what the admin journeys prove, the admin lane, ports 47606.
- `apps/web/content/docs/mcp/claude-code.mdx`: a short admin MCP section linking setup.
- Cross-links both ways with `admin/index.mdx`, `toolbox/admin.mdx`, `id/onboard.mdx`.
- `README.md` and `AGENTS.md`: the acceptance's new port 47606 (and the lane's), the lane command.
- `reports/mcp-foundation-evidence.md`: a new section "Admin MCP" with the commands, counts, durations and every measured number (access-read latency, refusal timing, cache window after revoke, acceptance duration), and what testing found.

## Must not touch

`apps/id/src`; `packages/mcp`; `packages/auth`; `mcps/toolbox` behaviour. Change `mcps/admin` only where a journey proves a defect; report each such change with the failing journey step that found it. Never run `bun run env:up` from a worktree; never two acceptances at once (you are the only one running it); do not kill processes you did not start (the owner runs services on 47100, 47500, 47510).

## Gates (report counts)

`bun run mcp:test:e2e` (all journey files; run it twice and report both durations), `bun packages/acceptance/scripts/admin-lane.ts --check`, `bun packages/acceptance/scripts/host-lane.ts --check`, `bun run mcp:test`, `bun run typecheck`, `bun run lint`, `bun run build`, `bun --filter web test`. If a tool says `tsc: command not found`, run `bun install --frozen-lockfile`.

## Last step: the cleanup pass (verbatim)

> Think from first principles about what we're trying to achieve here. Interrogate what you built before calling it done:
>
> 1. Is anything here unnecessary, overly complicated, or based on weak assumptions? Challenge them.
> 2. What can be deleted entirely?
> 3. What can be simplified now that unnecessary pieces are gone?
>
> Then make the changes. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating.

Then re-run the gates.

## Report contract

Each journey with what it asserted and its duration; every measured number; the lane's output (paste the printed instructions); any `mcps/admin` change with the step that forced it; what the cleanup removed; `git status --short`; every gate with counts and coverage; anything left open.
