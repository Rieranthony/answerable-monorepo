You implement brief B3a of the Answerable admin MCP goal: the acceptance kit changes the admin MCP's journeys will need. You never commit; the coordinator reviews your diff and commits.

## Where

Worktree `/Users/anthonyriera/code/answerable/.claude/worktrees/admin-b3a` (branch `goal/admin-b3a`, cut from `claude/admin-mcp` after B0 landed; `bun install` done). Work only there, with absolute paths and `git -C <path>`.

Read first: `AGENTS.md`; `docs/goals/admin-mcp/design.md`, `decisions.md` (D0, D10, D12), `findings.md` (F7, F13–F19), `task_plan.md` (B3 and "Coordinator decisions"); `packages/acceptance` (README, `src/*.ts`, both journey files, `scripts/host-lane.ts`); `apps/id/scripts/mcp-e2e-fixture.ts`.

The planner proved the fixture change with a throwaway copy: `/private/tmp/claude-501/-Users-anthonyriera-code-answerable/d4e498c5-0f6b-4a8c-9917-b1878a0078bc/scratchpad/probes/probe-admin-fixture.ts` (diff it against the real fixture), used by `probe-admin2.journeys.test.ts` in the same directory; their outputs are `p2-output.txt` to `p4-output.txt`. Use them as the reference, written to the repository's standard (the fixture's style is `apps/id`'s: Prettier with semicolons).

## What to build

1. **Fixture plan fields** (`apps/id/scripts/mcp-e2e-fixture.ts`): `platform?: { signIns }` gives the platform organisation (seeded at boot, slug `answerable` locally; find it through the system binding, not the slug, if the fixture can) a domain and a local company directory with that many queued staff sign-ins; `spares?: [{ slug, signIns }]` starts spare company directories that are trusted at boot but bound to no organisation, for organisations a journey creates later. The manifest gains `platform` (organisation id, domain, staff email) and `spares` (slug, email, the directory's issuer and the endpoints and client id/secret a journey needs to set that organisation's SSO provider through the admin API). Comments say what each field is for. Test-only script: never imported by a production service.
2. **`startId`** (`packages/acceptance/src/id.ts`): accepts and validates the new plan fields and returns them in the manifest (zod schema updated).
3. **`registerMachine`**: the planner found it duplicated twice in the acceptance (F18). Move it into the kit as one exported helper that creates a machine client owned by an organisation with given `client_credentials` scopes and links it to one or more audiences (ID's admin resource and, for the admin MCP, the Toolbox's admin resource), returning the client id and secret. Replace both copies.
4. **`signIn` refusal variant**: today a refused sign-in waits for the consent step and times out after 30 s (F17). Add a way for a journey to assert ID's refusal text ("Access is unavailable for this organisation. …") quickly, without a timeout, and use it nowhere yet except in a kit unit test or a small journey assertion if one exists naturally.
5. A small helper to set an organisation's SSO provider to a spare directory through the admin API (what the journey will call after the admin MCP creates the organisation), if the existing `Admin` helper does not already make that one call.

## Tests first

- The kit's own unit tests cover the new code at 100% lines and functions (the acceptance enforces it).
- A journey (add it to an existing journey file or a new short `kit.journeys.test.ts`): with `startId({ tenants: [], platform: { signIns: 1 }, spares: [{ slug: "spare", signIns: 2 }] })`, a platform staff member signs in to an MCP served by the kit (token `organization_id` = the platform organisation); an organisation created through the admin API and pointed at the spare directory signs its person in; before an entitlement the refusal variant sees ID's refusal text. This repeats probe 2 with the kit's real API.
- The existing journeys still pass unchanged.

## Docs

`apps/web/content/docs/mcp/local-testing.mdx`: the new plan fields and `registerMachine` (one short table or list; cURL/commands first). `packages/acceptance/README.md` and CHANGELOG (bump the minor version).

## Must not touch

`apps/id/src` (application code), `packages/mcp`, `packages/auth`, `mcps/*`, `packages/id-admin`, `packages/mcp-postgres`. Another agent is building `mcps/admin` in parallel: do NOT run `bun run mcp:test` (it resets shared test databases); you are the only one running the acceptance.

## Gates (report counts)

`bun run mcp:test:e2e` (Docker; never run `bun run env:up` from a worktree; never two acceptances at once), `bun run mcp:check @answerable/acceptance` if it does not include the journeys, `bun run typecheck`, `bun run lint`, `bun --filter web test`. If a tool says `tsc: command not found`, run `bun install --frozen-lockfile`.

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

What changed (files, exported helpers and their signatures, the manifest's new fields), what the cleanup removed, `git status --short`, every gate with counts, coverage and the acceptance's duration, and anything left open.
