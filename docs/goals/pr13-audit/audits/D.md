# Pull request 13 audit, D: the CLI

Auditor D. Tree: `claude/typed-config-b1` at 7ffd16b4, diff `62b6b1b3..7ffd16b4`. Read-only on the worktree. Every `bun mcp` run was in a copy of the tree under this folder, made as `scripts/mcp/end-to-end.test.ts` makes one (1,382 files, `bun install --frozen-lockfile` in 2.0 s), with MCPs named `auditda`, `auditdb` and `auditdc`.

## The size of `scripts/mcp`, measured

Tracked files, `wc -l` and `wc -c`. Lines are long here (about 64 bytes on average), so bytes are given too.

| Area | Source | Tests |
|---|---|---|
| The CLI's frame: `cli.ts`, `io.ts`, `ask.ts`, `definitions.ts`, `errors.ts`, `commands/help.ts` | 816 lines, 52.9 KB | 507 lines, 31.1 KB (with `test/io.ts`) |
| `new`, `add tool`, `rules.ts`, `workspace.ts` | 413 lines, 28.7 KB | 392 lines, 31.6 KB |
| `templates/*` | 469 lines, 25.5 KB | 554 lines, 28.8 KB (with the snapshot) |
| `generate.ts` | 81 | 76 |
| `check` with `connections.ts` and `role-switching.ts` | 166 | 168 |
| `db` with `database.ts` | 129 | 96 |
| `list` | 44 | 81 |
| The local loop: `setup`, `dev`, `local*.ts`, `machine.ts`, `servers.ts`, `environment.ts`, `config.ts` | 547 lines, 38.3 KB | 751 lines, 50.6 KB |
| End-to-end and `test/postgres.ts` | | 109 |
| **Total** | **2,703 lines, 172.9 KB** | **2,734 lines, 177.5 KB** |

What it does for an MCP author fits in `new`, `add tool`, `check` and `db generate`. The frame that describes the CLI to itself and to the docs (`definitions.ts`, `errors.ts`, their tests, and `apps/web/components/docs/cli.tsx` with `apps/web/lib/docs/cli.test.ts`) is 1,159 lines. The local loop is 1,298 lines with its tests.

**Timings, measured in the copy, no terminal:**
- `bun mcp new auditda … --serve toolbox`: exit 0 in 4.7 s; `check` 3.6 s of it. `new auditdb … --serve standalone --tool notes.list …`: 3.6 s.
- `bun mcp add tool auditda notes.add --mutation …`: 3.6 s; `check` 2.8 s of it.
- `bun mcp check auditda`: 2.7 s (typecheck 1.5 s). `bun run mcp:check @answerable/mcp-auditda`: 2.5 s.

## Findings

### D1. `bun mcp dev` promises a Claude Code sign-in that needs a company directory nobody sets up, and nobody has done it
- **Verdict:** defect (and D16 to revisit)
- **Cost today:** medium
- **Where:**
  - `apps/web/content/docs/mcp/local-testing.mdx:24` ("Nothing else is needed");
  - `scripts/mcp/commands/dev.ts:108-120` (prints `claude mcp add` and "Authenticate");
  - `docs/goals/mcp-cli/progress.md:260`;
  - `docs/goals/mcp-cli/decisions.md:131-132` (D16) and `docs/goals/mcp-cli/findings.md:125-138` (F7);
  - `AGENTS.md:56`, `apps/id/README.md:42` (first run);
  - `packages/acceptance/scripts/host-lane.ts`, `reports/mcp-foundation-evidence.md:423-445` (J9).
- **What it is:**
  - ID signs a person in only through a company directory: an SSO provider for the organisation, or a Google or Entra platform application whose ID and secret another system issues (`apps/id/README.md:42`, `default.env:20-25`).
  - `bun mcp dev`'s last step is the developer signing in from Claude Code to their own local ID. Its "Before you start" lists only Postgres and ID, and says nothing else is needed.
  - The sign-in was never done: M7's log says "Not done: the by-hand Claude Code sign-in".
  - The lane that did prove a by-hand Claude Code sign-in (J9) used the acceptance kit's disposable ID, whose test company directory takes `tester@host-lane.example.test` with no real identity provider.
  - The first run that makes local sign-in possible also locks ID's root, so the staff-token branch of `setup` is the normal path for anyone who can sign in.
- **The assumption:**
  - D16 assumes the developer's local ID can sign them in.
  - F7 weighed the disposable ID's costs (fixed ports, Docker, Chromium, nothing kept across restarts). It did not count the real ID's: a company directory to register and configure.
  - No number backs it, and the end-to-end path is unproved.
- **Proposal:** the owner chooses one.
  - (a) Keep D16. Prove the sign-in once by hand, and write the company-directory prerequisite into "Before you start", with the staff-token step as the normal path.
  - (b) Revisit D16: `bun mcp dev` starts the kit's disposable ID with a test directory, as the host lane does.
    - The kit's root stays unlocked, so `setup`, `mcp-dev` in `.env` and the staff token go.
    - It keeps F7's costs: fixed ports, Docker, and no sign-in kept across restarts.
- **Removes:** under (b):
  - `commands/setup.ts` (100 lines), `setup.test.ts` (192), most of `environment.ts` and `config.ts` (82);
  - 8 error rows (`setup-required`, `setup-stale`, `staff-token-required`, `staff-token-refused`, `invalid-organisation`, `organisation-not-found`, `platform-organisation-missing`, `invalid-configuration`: about 48 lines of `errors.ts`);
  - the docs section, and the concept of a local machine client.
  - Under (a): nothing; three lines of docs are added.
- **Risk:**
  - (a) none.
  - (b) It collides with an acceptance run on fixed ports, and a person signs in again after each restart.
- **Confidence:** read only for the sign-in requirement (ID's auth configuration and README). Verified from the goal's own log that the sign-in was not done.

### D2. `add tool` writes a table and a permanent migration for every new domain, even for a tool that uses no table
- **Verdict:** simplify
- **Cost today:** medium
- **Where:**
  - `scripts/mcp/commands/add-tool.ts:33`, `:94-98`, `:101-107`;
  - `scripts/mcp/templates/sources.ts:41-53`, `:56-79`;
  - `scripts/mcp/templates/names.ts:14-29`;
  - `scripts/mcp/templates/tool.ts:65-126`, `:147-204`;
  - `apps/web/content/docs/mcp/database.mdx:63`, `add-a-tool.mdx:57`.
- **What it is:**
  - Every `add tool` (and `new --tool`) whose domain has no table adds one to `src/db/schema.ts`: `id`, `organisation_id`, `title`, `created_at`, with row-level security. It then writes `drizzle/000N_<domain>.sql`.
  - The read and mutation templates and their tests use that table.
  - The docs say: "Edit the generated tool into the real one: its input, its output and its table", and "An applied migration is never edited, regenerated or removed".
  - **Probe:** in the copy, after `add tool auditda notes.add`, I removed the scaffolded table (as for a tool that calls an API) and ran `bun mcp db auditda generate`. It wrote `0002_api.sql`: `DROP POLICY …; DROP TABLE "auditda"."notes"`. History now holds a create and a drop, unless the person deletes the SQL, the journal entry and the snapshot by hand.
  - Once `bun mcp dev` has applied the scaffold locally, deleting it is refused as an edited migration, until the local schema is dropped.
- **The assumption:**
  - That each new domain is a new table shaped like the template's.
  - Unmeasured. The tool guidance itself names vendor-backed tools ("never the vendor or the transport (sharepoint_query)").
- **Proposal:**
  - `add tool` writes the tool and its test only. The templates' bodies touch no table and return their example output.
  - The person adds a table in `src/db/schema.ts` and runs `bun mcp db <name> generate`, as `database.mdx#add-a-table` already shows.
  - Fallback if the owner keeps the table: say in `add-a-tool.mdx` to delete the three drizzle files before the first `bun mcp dev` when the table is not wanted.
- **Removes:**
  - The table insertion, the import regex and the `migration` step of `add tool` (13 lines);
  - `tableTs` and `isolationImport` (13);
  - `unusable` and `tableBinding` (16);
  - the template test "every word that cannot name a binding … typechecks" (17 lines and a 60 s budget).
  - The read and mutation templates are rewritten, not deleted.
  - Concepts gone: the per-domain table, its binding rules, and a migration nobody asked for.
- **Risk:**
  - The scaffold stops teaching the row-level-security pattern by example; the docs page carries it.
  - An MCP author sees a different file. No deployed behaviour changes.
- **Confidence:** verified (the probe above; output kept in this session).

### D3. `--json` has no reader
- **Verdict:** delete
- **Cost today:** medium
- **Where:**
  - `scripts/mcp/io.ts:88-94`, `:101-127`, `:134-135`;
  - `cli.ts:52`, `:63-64`;
  - `commands/new.ts:18`, `:24`, `:32-33`, `:97-98`, `:142`;
  - `commands/add-tool.ts:15-17`, `:38`, `:54`, `:121`;
  - `commands/check.ts:110`, `commands/db.ts:19-23`, `commands/list.ts:34-37`, `commands/setup.ts:70-81`;
  - `definitions.ts:24-25` and every `json: jsonFlag`;
  - `apps/web/content/docs/mcp/cli.mdx:29`, `:81`.
- **What it is:**
  - Every command but `dev` takes `--json`. It prints `{ ok, steps, next }` or `{ ok: false, error: { code, message, fix, problems } }`.
  - It also turns prompts off (`interactive = io.isTTY && !options.json`).
  - `rg` finds no caller outside `scripts/mcp`: no workflow, script, package or doc parses it. The only non-unit use is `end-to-end.test.ts:63` (`list --json`).
  - The text output already gives one line per step, `Next:`, the fix command, and exit codes 0, 1 and 2.
- **The assumption:**
  - That coding agents need JSON. Unmeasured.
  - An agent reads the text output, and the brief's own question (an agent without a terminal) is answered by the exit code and the printed command.
- **Proposal:**
  - Remove the flag and the `json` parameter from `runSteps`, `printError` and `say`.
  - `list` prints its text only.
  - The error codes then have no machine reader (see D5).
- **Removes:**
  - About 30 source lines deleted and 15 simplified across 10 files (`grep -n json`);
  - 6 flag definitions;
  - 49 test lines that pass `--json` or read it (rewritten to read text);
  - the `problems` array as a public shape;
  - one of the two meanings of `--json`.
- **Risk:** a future script that wanted JSON would have to ask for it then. Nothing that exists breaks.
- **Confidence:** verified (`rg` over the repository, `.github/workflows` and `packages/acceptance`).

### D4. Interactive prompts are a second way to give the same answers
- **Verdict:** delete
- **Cost today:** medium
- **Where:**
  - `scripts/mcp/ask.ts` (53 lines);
  - `commands/new.ts:33`, `:46`, `:67-85`;
  - `commands/add-tool.ts:54`, `:58-60`, `:68-73`;
  - `commands/setup.ts:45-48`;
  - `io.ts:6-7`, `:31-32`; `cli.ts:3`, `:69`;
  - `errors.ts:82-87` (`cancelled`);
  - `scripts/package.json:21` (`@clack/prompts`);
  - `test/io.ts:15-57`; `new.test.ts:117-162`; `add-tool.test.ts:136-147`; `setup.test.ts:122-140`.
- **What it is:**
  - In a terminal, `new`, `add tool` and `setup` ask for missing answers with `@clack/prompts`.
  - Without a terminal, they refuse with every missing answer and the exact command to run, placeholders included. Probe: `bun mcp new` with no arguments printed the three missing answers and `bun mcp new <name> --description "<…>" --serve <toolbox|standalone|both>`, exit 2.
  - So a person in a terminal and an agent take two code paths, each tested.
- **The assumption:**
  - D5: "interactive in a terminal". An owner preference, not a measured need.
  - The refusal already shows each rule and the command to fill in.
- **Proposal:**
  - One path: flags, and the refusal with the command to run.
  - `setup`'s staff token comes only from `--staff-token`, which already exists.
- **Removes:**
  - About 95 source lines: `ask.ts` 53, and about 40 in `new`, `add tool`, `setup`, `io` and `cli`;
  - about 117 test lines;
  - one dependency, one error row and the TTY branch.
  - Concepts gone: "a terminal asks, a shell does not", and cancelling.
- **Risk:**
  - A person types flags, or copies the printed command and fills in the placeholders.
  - The behaviour a person sees in a terminal changes.
- **Confidence:** verified (the refusal probe; `grep -c "isTTY: true"` over the tests: 13 cases).

### D5. The error table restates messages that already say what to do: 53 rows and 41 codes, each message written three times
- **Verdict:** simplify
- **Cost today:** medium (for whoever changes the CLI)
- **Where:**
  - `scripts/mcp/errors.ts:1-340`; `errors.test.ts:82-219` (the scenarios);
  - `definitions.ts:162-176` (`errorCodes`); `definitions.test.ts:58-67` (a regex scan of the source for code strings);
  - `apps/web/components/docs/cli.tsx:131-171`; `apps/web/lib/docs/cli.test.ts:122-165`.
- **What it is:**
  - The design rule "every error says what to do" holds: each refusal prints its fix.
  - Yet `errors.ts` repeats each message as `see` and adds `meaning` and `action`. A runner test holds `see` to the real output.
  - Of the 53 rows, about 43 add nothing to the message. Examples:
    - `repeated-flag`: "Give it once.";
    - `name-taken`: "Choose another name.";
    - `invalid-serve`: "Use `toolbox`, `standalone` or `both`."
  - About 10 add something: `name-reserved`, `not-made-by-new`, `failed`, `step-failed`, `database-down`, `migration-refused`, `migration-edited`, `access-disabled`, `enable-refused`, `server-stopped`.
  - The 41 codes have no machine reader (D3).
  - `errorCodes` is a hand list that a regex scan holds to the source, because `Refusal` takes `code: string`.
- **The assumption:**
  - That `AGENTS.md`'s docs rule 3 ("every error code a person can hit gets a row") calls for a code per refusal.
  - The rule was written for API error codes. For a CLI that prints its own fix, the rows mostly copy the output.
- **Proposal:**
  - Keep codes only where a different action follows: usage, invalid answer, stack not running, setup, and step failed. Or keep no codes once `--json` goes.
  - Keep the about 10 rows that explain more than the message.
  - Type `Refusal`'s code as `ErrorCode`, so the compiler replaces the regex scan.
  - The owner decides how rule 3 reads for the CLI.
- **Removes:**
  - About 43 rows of `errors.ts` (about 260 lines) and their scenarios (about 70 lines);
  - the regex-scan test (10) and the hand list check;
  - the rule that a reworded message needs edits in three files.
- **Risk:**
  - The docs' Errors table is shorter. Each removed row's text is still what the command prints.
- **Confidence:** read only for the row classification (each row read). Verified for the counts (`grep -c 'id: "'` gives 53; the `errorCodes` list has 41).

### D6. `new`'s first-tool flags are a second way to add a tool, and the status tool they replace ships to production
- **Verdict:** delete
- **Cost today:** medium-low
- **Where:**
  - `scripts/mcp/commands/new.ts:14-26`, `:37`, `:54-60`, `:72-73`, `:82-85`, `:97`;
  - `scripts/mcp/ask.ts:34-53` (the optional first tool);
  - `scripts/mcp/templates/tool.ts:5-6`, `:46-63`, `:131-145`;
  - `templates/index.ts:13`; `templates/sources.ts:20-25`, `:56-58`;
  - `definitions.ts:33`, `:39-41`; `errors.ts:160-165` (`flag-needs-tool`);
  - `charts/answerable/mcps.json` (`example/example.status`); `scripts/mcp/end-to-end.test.ts:66`.
- **What it is:**
  - `new` takes `--tool`, `--tool-description` and `--mutation`, the same answers as `add tool`. Without them it writes `<name>.status`, whose description says "Replace it with the MCP's first real tool".
  - Nothing replaces it. `add tool` adds beside it (the end-to-end test lists `notes.add`, `notes.list` and `<name>.status`).
  - `mcps/example` ships `example.status` to every environment's Toolbox, and every MCP made without `--tool` will do the same.
  - The Toolbox's per-call cost grows with the tools a caller holds: M9 measured 3.5 ms at 10 tools and 11 to 12 ms at 1,000.
  - **Probe:** an MCP with the status tool removed (provider with an empty `tools` array) passed `bun mcp check` (5 tests, 100% lines and functions). `add tool auditdc notes.list` then added the first tool and passed.
- **The assumption:**
  - That a new MCP needs a tool from the start. The SDK has no minimum (`packages/mcp/src/provider.ts:59-86`), and the probe passes without one.
- **Proposal:**
  - `new` writes an MCP with no tool and takes no tool flags. `add tool` is the one way to add a tool.
  - Its `Next:` already names `add tool`.
- **Removes:** about 72 source lines (status template and test, `new`'s tool handling, 3 flags, one error row, the optional path in `askTool`), and about 55 test and snapshot lines. Concepts gone: the status tool, and one of two ways to add a tool.
- **Risk:**
  - A zero-tool MCP could be shipped by mistake. It would carry no scopes, and register would make a resource with `offline_access` only.
  - `mcps/example` keeps its committed status tool unless the owner removes it.
- **Confidence:** verified (the probe; the chart list read).

### D7. `new` and `add tool` run the tests and the generator again before `check` does the same
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `scripts/mcp/commands/new.ts:134-139`, `:141-145`;
  - `commands/add-tool.ts:108-119`, `:121-124`;
  - `definitions.ts:27`, `:51-53`, `:69-72` (`--no-check` and the two steps).
- **What it is:**
  - `new` runs `manifest` (the MCP's tests with `UPDATE_MANIFEST=1`), then `generate` again, then `check`. `check`'s `test` step runs the same tests with `UPDATE_MANIFEST=1`, and its `generated` step runs the same generator.
  - **Measured:**
    - `new`: manifest step 313 to 327 ms, then check's test again;
    - `add tool`: manifest 374 ms, then check's test 10 pass again;
    - the generator runs three times in `new`.
  - The duplicates exist only for `--no-check`, which only unit tests and `errors.test.ts` pass (`rg`).
- **The assumption:** that skipping the check is wanted. Nobody outside the tests passes the flag.
- **Proposal:**
  - Delete `--no-check` and the `manifest` and second `generate` steps.
  - `new` becomes write, generate, install, migration, check (see D8 for database). `add tool` becomes write, migration, check.
- **Removes:**
  - About 34 source lines and 1 flag;
  - one test run (0.3 to 0.4 s) per `new` and per `add tool`;
  - 12 test lines that pass `--no-check`.
- **Risk:** an agent that adds five tools in a row pays `check` five times (2.4 to 3.6 s each, measured). It already does unless it passes `--no-check`.
- **Confidence:** verified (step timings in the copy).

### D8. `new`'s `database` step runs before the first migration exists, so the schema it makes has no tables, and `dev` makes it again
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `scripts/mcp/commands/new.ts:123-133`; `definitions.ts:49-50`;
  - `commands/dev.ts:66-74`; `packages/mcp-postgres/src/testing.ts:141`.
- **What it is:**
  - The order is `database` (provision, then migrate what exists), then `migration` (write `0000_initial.sql`).
  - **Probe:** after `new auditdb --tool notes.list`, the dev schema `answerable_mcps.auditdb` existed with no `notes` table, while `0000_initial.sql` held the `CREATE TABLE`. `Next:` does not say to migrate.
  - `bun mcp dev` provisions and migrates every mounted MCP before it starts.
  - The tests do not need the step: `testMcpDatabase` calls `ensureLocalMcpDatabases` itself.
- **The assumption:** that `new` must touch the development database. Nothing after it needs that.
- **Proposal:** delete the step. `dev`, or `bun mcp db <name> migrate`, provisions and migrates. If the owner wants it kept, move it after `migration`.
- **Removes:** 6 lines, one step row, the `new` mention in `database-down` and `migration-*`, and one way the local schema ends up half made.
- **Risk:** `bun run toolbox:dev`, run alone after `new`, refuses to start until the MCP is provisioned. `bun mcp dev` is the documented path.
- **Confidence:** verified (the probe, by `psql` on the copy's MCP).

### D9. The chart list's `grants` field has no reader
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `scripts/mcp/generate.ts:55-57`; `charts/answerable/mcps.json`;
  - `charts/answerable/templates/_helpers.tpl:30` (keeps `name`, `serve`, `database`, `scopes`);
  - `charts/answerable/README.md:8`; `infra/k8s/charts.test.ts:445`; `scripts/mcp/generate.test.ts:25-26`.
- **What it is:**
  - The generator writes each MCP's grant strings into the chart's list. The chart's helper drops them.
  - `rg` finds no reader in `infra/ops`, `infra/pipeline`, `infra/k8s`, `apps/web` or `packages/acceptance`. The `grants` in `migrate-mcps.ts` is `src/db/grants.ts`, another thing with the same word.
  - Grant strings change with every tool, so this field is why most `add tool` runs rewrite a chart file.
- **The assumption:** none recorded.
- **Proposal:** drop the field. With it gone, `add tool` rewrites `charts/answerable/mcps.json` only when the scopes change (a first mutation).
- **Removes:** 3 lines of the generator, a field in the chart list and its README, the fixtures, and a second meaning of "grants".
- **Risk:** none found. The chart output is unchanged.
- **Confidence:** verified (`rg`, `_helpers.tpl` read).

### D10. `bun mcp dev` migrates each mounted MCP in a process of its own
- **Verdict:** optimise
- **Cost today:** low (grows with the number of MCPs)
- **Where:** `scripts/mcp/commands/dev.ts:71`; `scripts/mcp/database.ts:64-97`.
- **What it is:**
  - Before it starts the Toolbox, `dev` runs `bun scripts/mcp/cli.ts db <name> migrate` once per mounted MCP, one after another.
  - **Measured:** 0.14 s each with nothing pending (0.33 s the first). About 45 ms of that is the database; the rest is the process.
  - At 200 MCPs that is about 28 s per `dev` start (an estimate: 200 × 0.14 s). M9 measured `migrateMcps` over 200 schemas with nothing pending at 1.16 to 1.36 s.
- **The assumption:** the 200-MCP goal, which this path was not measured against.
- **Proposal:**
  - `dev`'s `database` step calls `provisionMcps` and `migrateMcps` once, in-process, over the mounted MCPs, as `mcps-migrate` does.
- **Removes:** N process starts per `dev` run, with the same lines of code.
- **Risk:** low. It is the deployment's own path.
- **Confidence:** verified for the per-MCP time (12 runs); the 200 figure is an estimate.

### D11. `bun mcp db migrate` from `mcps/<name>` ignores the root `.env`
- **Verdict:** defect
- **Cost today:** low
- **Where:**
  - `scripts/mcp/database.ts:65`;
  - `scripts/mcp/environment.ts:9-14`, `:37-44` (how the rest reads it).
- **What it is:**
  - `migrateLocal` reads `mcpCliConfig.read(process.env)`. Bun loads `.env` only from the working directory.
  - **Probe:** with `MCPS_DATABASE_ADMIN_URL` pointing at a missing database in the copy's root `.env`:
    - `bun mcp db auditda migrate` from the root failed on it;
    - `bun mcp db migrate` from `mcps/auditda` migrated the default database instead.
  - `setup` and `dev` read the root `.env` explicitly (`readSettings`).
- **Proposal:** `migrateLocal` takes the admin URL from `readSettings(root)`.
- **Removes:** one of two ways the CLI reads its configuration.
- **Risk:** none.
- **Confidence:** verified (the probe).

### D12. `check`'s `budget` step warns about a mode no MCP uses, against an assumed limit
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `scripts/mcp/connections.ts` (32 lines); `connections.test.ts` (22);
  - `scripts/mcp/commands/check.ts:68`, `:73-87`;
  - `definitions.ts:96`; `apps/web/content/docs/mcp/database.mdx:87`.
- **What it is:**
  - Every `check` computes the connections of `own` MCPs' pools at the autoscalers' ceilings, against `maxConnections: 100`. Its comment calls that number "an assumption until B7a measures Civo's".
  - No MCP is `own`, so every run prints "no MCP has a database of its own".
  - It warns and never fails.
- **The assumption:**
  - Civo's limit (`Q-CIVO-MAX-CONNECTIONS`, not measured).
  - That an MCP author is the one to act on a cluster's connection budget.
- **Proposal:** delete it. If the owner keeps `own` (auditor B's D1), check the budget once in `infra:check` against the chart's values, where the deployment owner sees it.
- **Removes:** about 50 source lines, 22 test lines, one step and a docs sentence.
- **Risk:** none today.
- **Confidence:** verified (output of every `check` run in the copy; the test holds the replicas to the chart).

### D13. Every MCP gets a README that repeats the docs and points at the wrong way to run it
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `scripts/mcp/templates/workspace.ts:66-98`; `templates/index.ts:25`;
  - `scripts/mcp/templates.test.ts:36-38`; the README entries of `__snapshots__/templates.test.ts.snap`.
- **What it is:**
  - 18 lines per MCP: the commands `bun mcp help` gives, and links to six docs pages.
  - Its local run hint is `bun run toolbox:dev` or `bun run standalone:dev`. It never names `bun mcp dev`, which migrates and gives access first.
  - Seen in the copy's `mcps/auditda/README.md`.
- **The assumption:** that each MCP needs its own copy of the guide. At 200 MCPs that is 200 copies to keep in step.
- **Proposal:**
  - Drop the template.
  - The description lives in `provider.ts` and the manifest. The guide is `/docs/mcp`, and `AGENTS.md` names the commands.
- **Removes:** 33 source lines, a template test, snapshot entries, and one file per MCP.
- **Risk:** a person browsing `mcps/<name>` on GitHub sees no README.
- **Confidence:** verified (generated README read).

### D14. The guidance comments are copied into every tool and schema file
- **Verdict:** simplify
- **Cost today:** low (grows with every tool)
- **Where:**
  - `scripts/mcp/templates/tool.ts:8-44`; `templates/sources.ts:60-77`;
  - D12 in `docs/goals/mcp-cli/decisions.md:116-118`.
- **What it is:**
  - **Counted:**
    - 16 comment lines in a read tool (48 lines in all);
    - 21 in a mutation (45);
    - 16 in the status tool (33);
    - 19 in `schema.ts` (30).
  - They state rules the docs also state, behaviour included ("risk: low lets the agent commit on its own…").
  - At 200 MCPs with 5 tools each, that is about 18,000 copied lines (an estimate), none updated when a rule changes.
- **The assumption:** that an agent reads the rules best inline. Not measured against a one-line pointer.
- **Proposal:** one comment line per file, naming the docs section (`/docs/mcp/tools`, `/docs/mcp/mutations`, `/docs/mcp/database#add-a-table`).
- **Removes:** about 50 template lines, and 15 to 20 lines from every tool file written.
- **Risk:** an agent that reads only the file loses the inline rules. The conformance kit still enforces the ones that matter.
- **Confidence:** verified (counted in generated files and in `mcps/example`).

### D15. Every MCP pins its own dependency versions, so a version bump edits every MCP
- **Verdict:** simplify
- **Cost today:** low (grows with the number of MCPs)
- **Where:**
  - `scripts/mcp/templates/workspace.ts:5-8`, `:17-25`; `scripts/mcp/templates.test.ts:30-34`;
  - `mcps/*/package.json`.
- **What it is:**
  - Each MCP's `package.json` pins `drizzle-orm`, `zod` and five dev tools. The hoisted linker needs one copy of each.
  - The test holds the template's pins to `packages/mcp`'s. Nothing holds existing MCPs to them, so a bump edits every `mcps/*/package.json` by hand.
  - **Probe:** Bun 1.3.1 resolves `"zod": "catalog:"` from a root `workspaces.catalog` (zod 4.6.7 installed, lockfile carries the catalog).
- **The assumption:** that pins per workspace are the only way to keep one version.
- **Proposal:**
  - A root catalog for the shared versions. MCPs and the template use `catalog:`.
  - Delete `pins` and its test.
- **Removes:** the pins and their test (11 lines), and N edits per bump.
- **Risk:** a lockfile change across the repository. Knip and turbo need to read `catalog:` (not checked).
- **Confidence:** verified (catalog probe in a scratch folder).

### D16. `mcp.json` repeats its folder's name and carries a JSON schema for a three-field file
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `scripts/mcp/workspace.ts:8-13`, `:48`; `scripts/mcp/mcp.schema.json` (38 lines);
  - `scripts/mcp/workspace.test.ts:6-8`; `templates/workspace.ts:14`; `errors.ts:97`.
- **What it is:**
  - `name` must equal the folder, and a check refuses a mismatch.
  - `$schema` points at a published schema, which a test holds equal to the zod object, for editors.
- **The assumption:**
  - D7, that a declaration file is needed. That holds: `new` needs `serve` before a manifest exists.
  - D7's stated reason, "the chart generator would have to import TypeScript", is weak: the generator is TypeScript run by Bun. The chart reads only the JSON the generator writes.
- **Proposal:**
  - `mcp.json` is `{ "serve", "database" }`. The name is the folder.
  - Delete `mcp.schema.json` and its test.
- **Removes:** 38 + 3 + 2 lines, one field in every MCP, and an `invalid-file` case.
- **Risk:** editors lose completion on a file the CLI writes.
- **Confidence:** read only.

### D17. `bun run mcp:check` beside `bun mcp check`: D5 kept it because "CI runs it", and CI does not
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `package.json:18`; `docs/goals/mcp-cli/decisions.md:86`;
  - `AGENTS.md:54`, `:81`; 18 files mention `mcp:check`;
  - `.github/workflows/ci.yml:38-63`.
- **What it is:**
  - CI runs `typecheck`, `lint`, `build`, `mcp:test` and `mcp:test:e2e`, never `mcp:check` (`rg` over `.github/workflows`).
  - For an MCP there are two checks:
    - `bun mcp check` rewrites a stale manifest;
    - `bun run mcp:check` fails on it.
  - `AGENTS.md:81` explains the difference.
- **The assumption:** D5's "because CI runs them", false for `mcp:check`.
- **Proposal:** keep `mcp:check` for the hubs and packages, which have no `mcp.json`. The MCP docs name only `bun mcp check`. Or delete the script and write the `turbo` line in `AGENTS.md`.
- **Removes:** one way to check an MCP, and the paragraph that tells them apart.
- **Risk:** none.
- **Confidence:** verified (`rg`).

### D18. A hand-written argument parser where `node:util`'s `parseArgs` does the same
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `scripts/mcp/cli.ts:21-48`; `errors.ts:28-45` (`unknown-flag`, `repeated-flag`, `flag-value`); `cli.test.ts`.
- **What it is:**
  - **Probe** under Bun 1.3.1, `parseArgs` with `strict: true`:
    - refuses `--force` and `-s`;
    - refuses a missing value (`--serve`) and an ambiguous one (`--serve --json`);
    - refuses `--mutation=yes`;
    - reads `--description=a=b`.
  - A repeated flag takes the last value instead of refusing.
- **Proposal:** `parseArgs` with each command's flags, mapped to one usage refusal that lists the flags and the usage.
- **Removes:** about 20 of the parser's 28 lines, and 2 to 3 codes and rows.
- **Risk:** `--serve a --serve b` is accepted (last wins).
- **Confidence:** verified (the probe).

### D19. Half of the reserved names have no recorded reason or are already taken by a folder
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `scripts/mcp/rules.ts:13`; `docs/goals/mcp-cli/decisions.md:120-125` (D13); `docs/goals/mcp-cli/briefs/m3.md:60`.
- **What it is:** 14 names are reserved.
  - **Justified:**
    - `test` (an MCP named `test` would own `mcp_test_owner`, the test role of an MCP named `owner`);
    - `public` and `drizzle` (Postgres schemas);
    - `platform` and `postgres` (package names);
    - `toolbox` (the Toolbox's own `toolbox_*` tools).
  - **Taken anyway by their folders:** `admin` and `standalone`, which the `name-taken` check refuses.
  - **No reason recorded:** `id`, `mcp`, `mcps`, `api`, `www`, `ops`. `api` and `www` read like host names, but D2 serves MCPs by path, not by host.
- **Proposal:** reserve only the justified names, each with its reason in a comment.
- **Removes:** 6 names, and the doc's list shrinks.
- **Risk:** a removed name may collide with something not found here. Read only.
- **Confidence:** read only.

## Kept

- **`bun mcp` as one command, `new`, `add tool`, `check` and `db generate` (D5).** That is what an agent needs, and each runs in 3 to 5 s from a clean copy.
- **The exit codes, 0, 1 and 2, and the fix line.** They are what an agent without a terminal acts on, and they cost a few lines.
- **"Every answer at once."** The multi-problem refusal costs about 45 source and 90 test lines. It saves an agent round trips. It is the next thing to cut if the owner wants fewer concepts (first problem only).
- **`finishing()`, the command that finishes the job.** 3 lines, and right after a failed step.
- **The generated lists and the servers' `package.json` dependencies (D7's output).** The Dockerfile installs every `mcps/*` either way. The dependencies keep turbo's graph and knip's unlisted-dependency check honest. The drift test (`generate.test.ts:7`) runs in `mcp:test`.
- **`mcps/retired.json`.** It guards against a new MCP silently inheriting a removed one's grants and ID rows. It works only if the person who removes an MCP adds the name; the docs say so. Its use in `generate.ts:62` could become "drop every `@answerable/mcp-*` dependency not served, platform packages aside".
- **`list`.** 44 lines. `agents.mdx` uses it as the proof step and for the staging and production URLs.
- **`check`'s `scan` step.** It repeats `role-switching.test.ts:18`, which CI runs over every MCP, but it gives local feedback in 1 ms with 4 lines.
- **`check`'s write mode beside CI's fail mode.** It is how a person or agent fixes generated files. CI's tests fail on drift.
- **Running `bun mcp` from inside `mcps/<name>`.** One script line per MCP and 2 lines of inference.
- **The `stack` parameters of `local-id.ts` and `local-access.ts`.** They have a second user, `packages/acceptance/src/journeys/mcp-cli.journeys.test.ts`.
- **`db generate`.** It removes drizzle-kit's `CREATE SCHEMA` and refuses a table outside the MCP's schema; drizzle-kit alone would do neither.
- **The two-word `add tool`.** 3 lines in `cli.ts`, and it reads naturally.

## Cleanup

- **Copy:** `…/pr13-audit/D/copy` (1,382 files and its install). Deleted.
- **MCPs made in the copy:** `auditda` (`toolbox`), `auditdb` (`standalone`, with `notes.list`) and `auditdc` (`toolbox`, made with no tool). `forget(name)` dropped each one's schemas in `answerable_mcps` and `answerable_mcps_test` and its four roles: `mcp_auditd?`, `mcp_auditd?_owner`, `mcp_test_auditd?` and `mcp_test_auditd?_owner`. Afterwards `traces` gave `[]` for each, and `psql` found no role, database or schema matching `auditd%` or `audit_d%`.
- **Postgres databases or roles of my own:** none created.
- **Probes:** a catalog probe (`probes/catalog`, deleted). `probes/copy.ts`, `forget.ts` and `parse.ts` remain in this folder as the probes' source.
- **Processes and ports:** no server started. Ports 47300, 47400, 47510 and 47520 were free before and after; 47432 was Postgres throughout.
- **Worktree:** untouched. `git status` shows only `docs/goals/pr13-audit/progress.md`, modified before this audit started.

## One line per finding

- D1, defect, medium, `apps/web/content/docs/mcp/local-testing.mdx:24` and `scripts/mcp/commands/dev.ts:108`: `bun mcp dev`'s Claude Code sign-in needs a company directory in the local ID that nothing sets up, and was never done (progress.md:260); either prove and document it, or use the kit's disposable ID. Removes 0 lines under (a); about 420 lines and 8 error rows under (b).
- D2, simplify, medium, `scripts/mcp/commands/add-tool.ts:94`: every new domain gets a table and a permanent migration, and dropping it leaves a create and a drop in history (probe). Removes about 60 lines.
- D3, delete, medium, `scripts/mcp/io.ts:91`: `--json` has no reader in the repository. Removes about 30 source lines, 6 flags and the JSON shape.
- D4, delete, medium, `scripts/mcp/ask.ts:1`: terminal prompts are a second path to the same answers. Removes about 95 source and 117 test lines, and `@clack/prompts`.
- D5, simplify, medium, `scripts/mcp/errors.ts:21`: about 43 of 53 error rows restate a message that already gives its fix, and 41 codes have no machine reader. Removes about 340 lines.
- D6, delete, medium-low, `scripts/mcp/commands/new.ts:54`: `new --tool` duplicates `add tool`, and the status tool it replaces ships to production; a zero-tool MCP passes `check` (probe). Removes about 72 source and 55 test lines.
- D7, delete, low, `scripts/mcp/commands/new.ts:134`: `new` and `add tool` run the tests and the generator before `check` runs them again, only for `--no-check`. Removes about 34 lines and 0.3 to 0.4 s per command.
- D8, delete, low, `scripts/mcp/commands/new.ts:123`: the `database` step runs before the migration exists, so the dev schema has no table (probe), and `dev` redoes it. Removes 6 lines and a step.
- D9, delete, low, `scripts/mcp/generate.ts:55`: the chart list's `grants` field has no reader, and is why most `add tool` runs rewrite a chart file. Removes 3 lines and a field.
- D10, optimise, low, `scripts/mcp/commands/dev.ts:71`: one process per mounted MCP to migrate, 0.14 s each, about 28 s at 200 (estimate), against 1.2 to 1.4 s measured for `migrateMcps`. Removes N process starts.
- D11, defect, low, `scripts/mcp/database.ts:65`: `db migrate` from `mcps/<name>` ignores the root `.env` (probe). Removes one of two ways to read configuration.
- D12, delete, low, `scripts/mcp/connections.ts:5`: `check`'s budget warns about `own` MCPs, of which there are none, against an unmeasured limit. Removes about 50 source and 22 test lines.
- D13, delete, low, `scripts/mcp/templates/workspace.ts:75`: a README per MCP repeats the docs and points at `bun run toolbox:dev`, not `bun mcp dev`. Removes 33 lines and one file per MCP.
- D14, simplify, low, `scripts/mcp/templates/tool.ts:8`: 16 to 21 guidance lines are copied into every tool file (about 18,000 at 200 MCPs, estimate). Removes about 50 template lines.
- D15, simplify, low, `scripts/mcp/templates/workspace.ts:5`: per-MCP version pins mean a bump edits every MCP; Bun 1.3.1 catalogs work (probe). Removes 11 lines and N edits per bump.
- D16, simplify, low, `scripts/mcp/workspace.ts:8`: `mcp.json` repeats the folder's name and ships a JSON schema with a sync test. Removes about 43 lines.
- D17, simplify, low, `package.json:18`: `mcp:check` was kept because "CI runs it", and CI does not. Removes one of two MCP checks.
- D18, simplify, low, `scripts/mcp/cli.ts:21`: `node:util` `parseArgs` does what the hand parser does (probe). Removes about 20 lines and 2 to 3 codes.
- D19, simplify, low, `scripts/mcp/rules.ts:13`: 6 reserved names have no recorded reason, and 2 are already taken by folders. Removes 6 names.
