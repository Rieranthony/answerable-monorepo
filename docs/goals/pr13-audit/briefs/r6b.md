# R6b: what the newcomer read found

Read [`README.md`](README.md) first.

**Goal.** A developer who has never seen the repository can follow the MCP docs from `mcp/index.mdx` to a first tool call, and to a ship they understand, without opening source code. R6's fresh agent followed the docs in a copy. Everything it could run worked, and it found the gaps below (logged in [`../progress.md`](../progress.md), R6). Fix each one.

**Model.** Opus 5.5.

## Fix

1. **Local sign-in is blocked for anyone without directory credentials.**
   - `mcp/run-locally.mdx` ("Before you start") and `id/onboard.mdx` ("First run", steps 3 and 4) need `MICROSOFT_*` or `GOOGLE_*` credentials and "your work account". Nothing says where those come from, or that a local ID signs people in only through a company directory.
   - Say so plainly, and name both routes:
     - **with credentials:** your directory's application and a domain on the platform organisation;
     - **without them:** the acceptance kit's host lane. `bun packages/acceptance/scripts/host-lane.ts` keeps ID and the Toolbox up with a test directory, for Claude Code by hand.

       Read `packages/acceptance/README.md` and the script before you write about it, and check that it still works after R2 and R5: run it once, connect nothing, stop it, and confirm it leaves nothing behind.
2. **The root secret's development value is in no doc.**
   - `run-locally.mdx` says "at ID's development default", and `onboard.mdx` step 1 says to make one with `openssl rand`.
   - State the development default (it is committed: `apps/id/src/config.ts`). Say that `bun mcp setup` uses it while root is unlocked, and that production refuses it.
3. **The first-run steps are not local.**
   - `onboard.mdx` steps 2 to 6 use `https://id.answerable.org`.
   - Define the ID origin once, as a variable that works for both: for example, `ID=http://localhost:47300` locally, or the deployed origin.
   - `run-locally.mdx` names every step it needs, including step 2, which defines `$PLATFORM_ORG`.
4. **Two local-start recipes.** `README.md`'s Local environment and `run-locally.mdx` must give the same commands. Check whether `--env-file=.env` is needed for `db:migrate` now that typed configuration has local values, and say one thing in both places.
5. **`run-locally` is missing from `mcp/index.mdx`'s reading order.** Add it.
6. **Shipping's status contradicts itself.**
   - `mcp/index.mdx` says a tag ships to staging, "which has run". `deploy.mdx`'s "Where things stand" says the first tag of the `mcps` image has not been pushed.
   - Make `index.mdx` say what `deploy.mdx` says, and link to it.
   - "Two `git tag` commands" is really a tag and a push for each environment: say so.
7. **What to commit is said three ways, one of them wrong.**
   - `agents.mdx` omits `bun.lock` and the Toolbox's files.
   - Each command's `Next: git add` line lists only what that command changed.
   - Give one rule in `create.mdx`, and link to it from `deploy.mdx` and `agents.mdx`. For example: commit everything `git status` shows under `mcps/<name>`, plus `charts/answerable/mcps.json`, `mcps/toolbox/package.json`, `mcps/toolbox/src/mounted.generated.ts` and `bun.lock`.
   - Say that each `Next:` line lists what that command changed.
8. **There is no guide to changing a tool after it ships, and missing one fails a deploy.**
   - The Toolbox's ingest (`mcps/toolbox/src/catalogue.ts:42`) refuses a tool whose kind, risk, input or output changed under the same version. The Toolbox then fails to start, and the deploy rolls back.
   - CI's kind stack starts from an empty catalogue, and `bun mcp check` rewrites the manifest silently, so nothing catches it before staging.
   - Add a section, "Change a tool after it ships", to `add-a-tool.mdx` or `tools.mdx`:
     - what the version is;
     - that a contract change needs a new `YYYY-MM-DD` version in the tool's definition or its provider, and what counts as a contract change;
     - what changes freely, such as titles and descriptions;
     - the exact error the deploy shows when it is missed.

     Link it from `deploy.mdx`'s failure table.
9. **`add-a-tool.mdx` doesn't point to the migration workflow.** Under "Read or change", say that changing the tool's table means `bun mcp db <name> generate`, then `migrate`, then `bun mcp check`. Link `database.mdx#add-a-table`, and mention `--name`, which avoids drizzle's random file names.
10. **The manifest is regenerated two ways.**
    - `testing.mdx`, `errors.mdx` and `servers.mdx` say `UPDATE_MANIFEST=1 bun run test`.
    - Say once: for an MCP made with `bun mcp`, `bun mcp check` rewrites it; `UPDATE_MANIFEST=1` is for the hubs and packages.
11. **Two skipped tests are unexplained.** In `create.mdx`'s "Check it", say in one sentence that `bun test` shows two conformance checks skipped as not applicable, and link to `testing.mdx`.
12. **`run-locally.mdx` shows only a standalone MCP's `bun mcp dev` output.**
    - Add a Toolbox MCP's, rendered or taken from the real command.
    - If no ID is available to run it, build it from `scripts/mcp/commands/dev.test.ts`'s expectations, and say where it came from.
13. **`risk: "high"` is not marked "Not yet" where it is chosen.** Do that in the tool template's comment and in `add-a-tool.mdx`, linking `mutations.mdx`.
14. **Tag names and the hand-off are thin.**
    - In `deploy.mdx`, state what a tag name may contain, from the workflows' tag patterns.
    - Say how an agent hands work to the owner: a branch, and the two tag names.
15. **The CLI: `bun mcp dev`'s refusal suggests itself as the fix.**
    - When setup is missing, the fix line is `bun mcp dev <name>`, the command that just failed. It must be `bun mcp setup`, with ID started first when ID is down.
    - Fix the fix line and its error rows, with a test that fails first.
    - `run-locally.mdx` promises "the command that fixes it".
16. **The CLI: `Next:` after `new --tool` reads as if no tool existed.** Make it suggest adding another tool when one was given. This is minor; keep the change small.

## Gates

The README's gates, plus `bun --filter web test` for every page, and the acceptance alone if the CLI or the host lane changed.

## Must not touch

- Behaviour beyond items 15 and 16.
- The audit's other decisions.
