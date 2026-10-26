// Every error a person can meet from bun mcp, as plain data: what they see, what it means and what to do. Like definitions.ts it imports nothing,
// so the docs render it (`<CliErrors />`, `<CliReference />`). errors.test.ts runs the real command for every row and holds `see` to what it
// printed, so a message reworded in the code fails there until the row follows it. In `see`, `…` stands for what varies: a path, a port or
// what a tool printed; every other character is exact.
import type { ErrorCode } from "./definitions"

/** One error: the `id` a page names it by, the `code` it carries in `--json`, the commands that can answer it, and its three columns. */
export type ErrorRow = {
  id: string
  /** A code of `errorCodes`, or `<step>-failed` for a step that fails after files were written. */
  code: ErrorCode | `${string}-failed`
  commands: readonly string[]
  see: string
  meaning: string
  action: string
}

const every = ["new", "add tool", "list", "check", "db", "setup", "dev", "help"]

/** The errors of bun mcp, the ones every command can answer first, then each command's in the order its work meets them. */
export const errors: readonly ErrorRow[] = [
  {
    id: "unknown-command", code: "unknown-command", commands: every,
    see: "bun mcp has no command deploy; its commands are new, add tool, list, check, db, setup, dev, help",
    meaning: "The first word is not a command.",
    action: "Run `bun mcp help` and use one of its commands.",
  },
  {
    id: "unknown-flag", code: "unknown-flag", commands: every,
    see: "bun mcp new has no flag --force; its flags are --description, --serve, --database, --tool, --tool-description, --mutation, --no-check, --json, --help",
    meaning: "The command has no such flag. Flags are written in full, such as `--serve`. There are no short forms.",
    action: "Use one of the flags the message lists.",
  },
  {
    id: "repeated-flag", code: "repeated-flag", commands: every,
    see: "--serve is given twice; give it once",
    meaning: "A flag appears two times.",
    action: "Give it once.",
  },
  {
    id: "flag-value", code: "flag-value", commands: every,
    see: "--serve takes a value, <toolbox|standalone|both>",
    meaning: "A flag that takes a value has none, or is followed by another flag. A flag that takes no value, such as `--mutation=yes`, answers the same code with `--mutation takes no value`.",
    action: "Write the value after the flag, as in `--serve toolbox`. Give a flag that takes none no value.",
  },
  {
    id: "unexpected-argument", code: "unexpected-argument", commands: ["new", "add tool", "list", "check", "setup", "dev"],
    see: "bun mcp new takes one name; it was given acme, extra",
    meaning: "The command was given more words than it takes.",
    action: "Give it what its usage says. `bun mcp help <command>` shows the usage.",
  },
  {
    id: "unexpected-flag", code: "unexpected-flag", commands: ["db"],
    see: "--name names the migration bun mcp db generate writes; migrate takes none",
    meaning: "`--name` goes with `generate` only.",
    action: "Take `--name` out, or run `generate`.",
  },
  {
    id: "unknown-action", code: "unknown-action", commands: ["db"],
    see: "bun mcp db takes generate or migrate, after the MCP's name, not acme seed",
    meaning: "`bun mcp db` has two actions, and the word after the MCP's name is neither.",
    action: "Run `bun mcp db <mcp> generate` or `bun mcp db <mcp> migrate`.",
  },
  {
    id: "missing-argument", code: "missing-argument", commands: ["new", "add tool"],
    see: "Missing --serve: where it runs, toolbox, standalone or both",
    meaning: "Without a terminal, as in a coding agent's shell, the command asks nothing, so every answer must be given. It lists every answer that is missing or wrong at once, then the command to run again, with a placeholder where each one goes.",
    action: "Run the command it prints, with the placeholders filled in.",
  },
  {
    id: "missing-tool", code: "missing-argument", commands: ["add tool"],
    see: "Missing the tool: <domain.operation>, such as notes.list",
    meaning: "Without a terminal the command asks nothing, so the tool's name must be given. The command it prints does not guess whether the tool reads or changes: add `--mutation` for a change.",
    action: "Run the command it prints, with the placeholders filled in, and `--mutation` for a change.",
  },
  {
    id: "missing-description", code: "missing-argument", commands: ["add tool"],
    see: "Missing --description: what the tool does, when to use it and its limits, 40 to 1,000 characters",
    meaning: "Without a terminal the command asks nothing, so `--description` must be given. The command it prints does not guess whether the tool reads or changes: add `--mutation` for a change.",
    action: "Run the command it prints, with the placeholders filled in, and `--mutation` for a change.",
  },
  {
    id: "cancelled", code: "cancelled", commands: ["new", "add tool", "setup"],
    see: "Cancelled: nothing was written",
    meaning: "You cancelled a question in a terminal, with Ctrl-C or Esc.",
    action: "Run the command again.",
  },
  {
    id: "not-in-repository", code: "not-in-repository", commands: every,
    see: "bun mcp runs in the Answerable monorepo; no package.json with the mcps/* workspaces is at or above …",
    meaning: "You ran it outside the repository.",
    action: "Change to the repository's root, or to a folder inside it, and run it again.",
  },
  {
    id: "invalid-file", code: "invalid-file", commands: ["new", "add tool", "list", "check", "db", "dev"],
    see: "mcps/retired.json is not valid: …",
    meaning: "A file bun mcp reads does not have the shape it needs: `mcps/retired.json`, an `mcps/<name>/mcp.json` (also when it names another MCP than its folder) or a `manifest.json`.",
    action: "Fix the file the message names. `git diff <file>` shows what changed.",
  },
  {
    id: "invalid-configuration", code: "invalid-configuration", commands: ["setup", "dev"],
    see: "Invalid bun mcp configuration: MCP_DEV_ORGANISATION: …; fix it in …",
    meaning: "A variable in the root `.env` is not valid.",
    action: "Fix the line the message names, or run `bun mcp setup`, which writes it.",
  },
  {
    id: "mcp-required", code: "mcp-required", commands: ["add tool", "check", "db", "dev"],
    see: "Name the MCP, or run the command from inside mcps/<name>",
    meaning: "The command needs an MCP and you ran it from the root of the repository without one.",
    action: "Add the MCP's name, or `cd mcps/<name>` and run the command there.",
  },
  {
    id: "mcp-not-found", code: "mcp-not-found", commands: ["add tool", "check", "db", "dev"],
    see: "No MCP is named nope: mcps/nope/mcp.json does not exist; bun mcp list names every MCP",
    meaning: "No MCP has that name.",
    action: "Run `bun mcp list` for the names. To make one, `bun mcp new <name>`.",
  },
  {
    id: "invalid-name", code: "invalid-name", commands: ["new"],
    see: 'MCP name "Acme" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme',
    meaning: "The name is the MCP's id: it starts every tool name and names its database schema.",
    action: "Use a name such as `acme`.",
  },
  {
    id: "name-reserved", code: "name-reserved", commands: ["new"],
    see: "toolbox is reserved; choose another name",
    meaning: "The name belongs to the platform: `toolbox`, `admin`, `id`, `mcp`, `mcps`, `standalone`, `api`, `www`, `test`, `ops`, `public`, `drizzle`, `platform` or `postgres`. For `standalone` the message adds `; to serve your MCP on its own URL, pass --serve standalone`.",
    action: "Choose another name.",
  },
  {
    id: "name-retired", code: "name-retired", commands: ["new"],
    see: "gone is retired (mcps/retired.json): a removed MCP's name is never used again; choose another name",
    meaning: "An MCP of that name was removed. What it had in the databases and in Answerable ID would come back with the name, so a removed name is never used again.",
    action: "Choose another name.",
  },
  {
    id: "name-taken", code: "name-taken", commands: ["new"],
    see: "acme is taken by mcps/acme; choose another name",
    meaning: "A folder of `mcps/` already has that name.",
    action: "Choose another name.",
  },
  {
    id: "invalid-description", code: "invalid-description", commands: ["new"],
    see: "An MCP's description is 6 characters; write 40 to 1,000 saying what it does, when to use it and its limits",
    meaning: "The description of the MCP is too short or too long.",
    action: "Write one or two sentences of 40 to 1,000 characters.",
  },
  {
    id: "invalid-serve", code: "invalid-serve", commands: ["new"],
    see: '--serve must be toolbox, standalone or both, not "cloud"',
    meaning: "`--serve` takes one of three words.",
    action: "Use `toolbox`, `standalone` or `both`.",
  },
  {
    id: "invalid-database", code: "invalid-database", commands: ["new"],
    see: '--database must be shared or own, not "big"',
    meaning: "`--database` takes one of two words.",
    action: "Use `shared`, or leave the flag out for it, or `own`.",
  },
  {
    id: "flag-needs-tool", code: "flag-needs-tool", commands: ["new"],
    see: "--tool-description and --mutation describe the first tool: pass --tool <domain.operation> with them",
    meaning: "These two flags describe the first tool, and none was named.",
    action: "Add `--tool <domain.operation>`, or take the two flags out.",
  },
  {
    id: "invalid-tool-name", code: "invalid-tool-name", commands: ["new", "add tool"],
    see: 'Tool name "notes" must be <domain>.<operation>, each part a lowercase letter then up to 15 lowercase letters or digits, for example records.list',
    meaning: "A tool's name has two parts: what it is about and what it does.",
    action: "Use a name such as `notes.list`.",
  },
  {
    id: "tool-name-reserved", code: "tool-name-reserved", commands: ["new", "add tool"],
    see: "acme.commit would be called acme_commit, the name of acme's commit tool; choose another name",
    meaning: "The name would clash with one of the MCP's two commit tools, `<name>_commit` and `<name>_commit_confirmed`.",
    action: "Choose another name.",
  },
  {
    id: "tool-name-imported", code: "tool-name-reserved", commands: ["new", "add tool"],
    see: "define.tool would be exported as defineTool, a name the MCP's files import; choose another name",
    meaning: "The tool's file exports it under a name made from the two parts, and that name is one its own file imports: `defineTool`, `defineMutation` or `defineProvider`.",
    action: "Choose another name.",
  },
  {
    id: "tool-exists", code: "tool-exists", commands: ["add tool"],
    see: "acme has a tool notes.list: mcps/acme/src/tools/notes-list.ts; choose another name",
    meaning: "The MCP already has that tool: its file exists, or, with `mcps/acme/manifest.json` in place of the file, its manifest lists it.",
    action: "Choose another name, or edit the file the message names.",
  },
  {
    id: "invalid-tool-description", code: "invalid-tool-description", commands: ["new", "add tool"],
    see: "A tool's description is 11 characters; write 40 to 1,000 saying what it does, when to use it and its limits",
    meaning: "The model reads only the description to choose the tool, so it must say enough.",
    action: "Write 40 to 1,000 characters: what it does, when to use it, its limits.",
  },
  {
    id: "mutation-description", code: "mutation-description", commands: ["new", "add tool"],
    see: 'acme/notes.add: a mutation\'s description must say that it prepares an intent; use the word "prepare" or "intent"',
    meaning: "A change is prepared, then committed, and its description must say so.",
    action: 'Use the word "prepare" or "intent" in the description.',
  },
  {
    id: "not-made-by-new", code: "not-made-by-new", commands: ["add tool"],
    see: 'mcps/bare lacks src/mcp.ts, src/db/schema.ts and the two "// bun mcp: tools" lines of src/provider.ts, among its imports and in its tools array, which bun mcp new writes and add tool edits; add the tool by hand',
    meaning: "`add tool` edits the files `bun mcp new` writes. This MCP lacks one of them, or the two marker lines in `src/provider.ts`.",
    action: "Put the missing files or lines back, or add the tool by hand as [Add a tool](/docs/mcp/add-a-tool#by-hand) shows.",
  },
  {
    id: "table-outside-schema", code: "table-outside-schema", commands: ["db"],
    see: 'mcps/acme/src/db/schema.ts defines loose outside pgSchema("acme"); define every table with acmeSchema.table(…)',
    meaning: "A table in `src/db/schema.ts` is not in the MCP's own Postgres schema, so drizzle-kit would put it in `public`, which no MCP may touch.",
    action: "Define it with `<name>Schema.table(…)`, as the file's other tables are.",
  },
  {
    id: "setup-required", code: "setup-required", commands: ["dev"],
    see: "bun mcp setup has not run: MCP_DEV_ID_CLIENT_ID and MCP_DEV_ID_CLIENT_SECRET are not in .env. Run bun mcp setup",
    meaning: "`bun mcp dev` has no machine client in your local Answerable ID.",
    action: "Run `bun mcp setup`.",
  },
  {
    id: "setup-stale", code: "setup-stale", commands: ["dev"],
    see: "ID refused the credentials of mcp-dev in .env, as after a reset of its database. Run bun mcp setup again",
    meaning: "The client in `.env` is not in the ID that answers.",
    action: "Run `bun mcp setup`.",
  },
  {
    id: "id-down", code: "id-down", commands: ["setup", "dev"],
    see: "Answerable ID does not answer on http://localhost:47300. Start it from the main checkout with bun dev, or with bun --filter @answerable/id dev; never bun dev from a worktree, where it runs env:up and recreates the shared Postgres…",
    meaning: "Your local Answerable ID is not running.",
    action: "From the main checkout, run `bun dev` or `bun --filter @answerable/id dev`. Never run `bun dev` from a worktree.",
  },
  {
    id: "postgres-down", code: "postgres-down", commands: ["dev"],
    see: "The development Postgres does not answer on localhost:47432. Start it from the main checkout with bun run env:up; never from a worktree, where it recreates the running one",
    meaning: "The Postgres of `bun run env:up` is not running.",
    action: "Run `bun run env:up` from the main checkout.",
  },
  {
    id: "port-taken", code: "port-taken", commands: ["dev"],
    see: "Port 47400 is taken, and the Toolbox needs it: stop what listens there (lsof -nP -iTCP:47400 -sTCP:LISTEN names it)",
    meaning: "Another process listens on 47400, the port of the Toolbox, which `bun mcp dev` starts. Often it is the Toolbox of an earlier run.",
    action: "Find it with the `lsof` command in the message and stop it.",
  },
  {
    id: "manifest-missing", code: "manifest-missing", commands: ["dev"],
    see: "mcps/acme/manifest.json does not exist, and the MCP's scopes in ID come from it. Run bun mcp check acme",
    meaning: "A standalone MCP's scopes in your local ID come from its manifest, which the first test run writes.",
    action: "Run `bun mcp check <name>`.",
  },
  {
    id: "organisation-not-found", code: "organisation-not-found", commands: ["setup", "dev"],
    see: "Answerable ID has no organisation acme…",
    meaning: "`MCP_DEV_ORGANISATION`, or `--organisation`, names an organisation your local ID does not hold.",
    action: "Run `bun mcp setup --organisation <slug>` with the slug of yours, or leave `--organisation` out for `answerable`.",
  },
  {
    id: "invalid-organisation", code: "invalid-organisation", commands: ["setup"],
    see: "--organisation Acme is not an organisation's slug: lowercase letters and digits, words joined by single hyphens",
    meaning: "An organisation's slug has no capital letters, spaces or other characters.",
    action: "Use the organisation's slug.",
  },
  {
    id: "platform-organisation-missing", code: "platform-organisation-missing", commands: ["setup"],
    see: "Answerable ID has no organisation answerable, which it makes at its first start: start it once, then run bun mcp setup again",
    meaning: "Your local ID has never started on this database.",
    action: "Start ID once, then run `bun mcp setup` again.",
  },
  {
    id: "staff-token-required", code: "staff-token-required", commands: ["setup"],
    see: "ID's root secret is locked: a person is a platform administrator, so bun mcp setup needs a staff token: pass it with --staff-token (get one at https://www.answerable.org/docs/id/onboard#get-a-staff-token)",
    meaning: "Once a person is a platform administrator, ID locks its root secret. In a terminal `bun mcp setup` asks for a staff token. Without one it exits.",
    action: "Run `bun mcp setup --staff-token <token>`. [Get a staff token](/docs/id/onboard#get-a-staff-token).",
  },
  {
    id: "staff-token-refused", code: "staff-token-refused", commands: ["setup"],
    see: "ID refused the staff token; get another (https://www.answerable.org/docs/id/onboard#get-a-staff-token)",
    meaning: "The staff token is wrong or has expired.",
    action: "Get another, and run `bun mcp setup --staff-token <token>`.",
  },
  {
    id: "failed", code: "failed", commands: every,
    see: "bun mcp failed: …",
    meaning: "Something broke that is not a wrong answer: a file could not be read, or a service answered with an error. The exit code is 1.",
    action: "Read the message. If it names a service, check that it runs, then run the command again.",
  },
  {
    id: "step-failed", code: "install-failed", commands: ["new", "add tool", "check", "db", "setup", "dev"],
    see: "install failed: …",
    meaning: "A step failed after files were written, and the message ends with what the step printed. Every step has its own code, `<step>-failed`, such as `install-failed`. The files stay.",
    action: "Fix the cause. Then run the command under `Finish the job with:`, which does this step and every one after it.",
  },
  {
    id: "database-down", code: "database-failed", commands: ["new", "db", "dev"],
    see: "database failed: the development Postgres does not answer on localhost:47432; start it with bun run env:up from the main checkout",
    meaning: "The step that makes the MCP's schema could not reach the development Postgres.",
    action: "Run `bun run env:up` from the main checkout, then the command under `Finish the job with:`.",
  },
  {
    id: "migration-refused", code: "database-failed", commands: ["new", "db", "dev"],
    see: "database failed: Refusing to migrate acme: 0000_initial.sql line 1: GRANT. A migration creates no schema, grants nothing, takes no role and names no schema but acme",
    meaning: "A migration that has not been applied yet does something only the platform may do: create a schema, grant or revoke, take a role, or name a schema other than the MCP's own. The message names the file and the line. Nothing was applied.",
    action: "Take the statement out of the migration file. The platform makes the schema and the grants.",
  },
  {
    id: "migration-edited", code: "database-failed", commands: ["new", "db", "dev"],
    see: "database failed: Refusing to migrate acme: 0000_initial.sql is not the migration this database applied. Restore the applied file, or recreate a disposable database.",
    meaning: "A migration that was already applied has changed since, or was removed. An applied migration is never edited, regenerated or removed: the database kept a receipt of its text.",
    action: "Restore the file with `git checkout`. To change the tables, write a new migration with `bun mcp db <name> generate`. A local database that holds nothing you need can be dropped and migrated again.",
  },
  {
    id: "check-failed", code: "check-failed", commands: ["new", "add tool"],
    see: "check failed: typecheck: …",
    meaning: "The last step, `bun mcp check`, failed in the check it names: `typecheck`, `lint`, `test`, `scan` or `budget`. The message ends with what the check printed.",
    action: "Fix what it printed, then run `bun mcp check <name>`.",
  },
  {
    id: "access-disabled", code: "enable-failed", commands: ["dev"],
    see: "enable failed: Answerable ID holds the organisation's entitlement on the Toolbox (…) with status disabled; enable it with access_enable in the admin MCP, then run bun mcp dev acme again",
    meaning: "A row that gives your organisation access was disabled in your local ID. `bun mcp dev` never enables what someone disabled.",
    action: "Enable it with `access_enable` in the admin MCP, then run `bun mcp dev <name>` again.",
  },
  {
    id: "enable-refused", code: "enable-failed", commands: ["dev"],
    see: "enable failed: the Toolbox answered 422 unknown_host_client: …",
    meaning: "The Toolbox's admin API refused to enable the MCP for your organisation, and says why after the status and its code. The code names the cause: `unknown_provider` when the Toolbox does not mount the MCP, `unknown_host_client` when its client is not registered.",
    action: "Read what the Toolbox answered. For a client that is not registered, run `bun mcp setup`, then `bun mcp dev <name>` again.",
  },
  {
    id: "toolbox-token-refused", code: "enable-failed", commands: ["dev"],
    see: "enable failed: ID refused mcp-dev a token for the Toolbox's admin API, which needs toolbox:admin: run bun mcp setup again",
    meaning: "Your local ID holds no capability that lets `mcp-dev` call the Toolbox's admin API.",
    action: "Run `bun mcp setup`, which makes it.",
  },
  {
    id: "server-stopped", code: "toolbox-failed", commands: ["dev"],
    see: "toolbox failed: the Toolbox stopped with exit code 1 before http://localhost:47400/health listed acme; its output above says why",
    meaning: "The Toolbox crashed while starting.",
    action: "Read the server's output above the message, fix it, and run `bun mcp dev <name>` again.",
  },
]
