// What bun mcp says about itself, as plain data: each command's usage, summary, flags, steps and example, its exit codes and the codes of its
// errors. The file imports nothing and runs nothing, so the docs (apps/web, `<CliReference />`) read it when a page builds. The commands in
// commands/*.ts spread their definition and add `run`; `bun mcp help` prints it; cli.test.ts holds every command, flag and step to it.

/** A flag of a command: a value's placeholder, `<…>`, for a flag that takes one, what it means, and what it is when left out. */
export type Flag = { value?: string; description: string; default?: string }

/** One step of a command, as its output names it: `ok      <name>  <detail>`. A step that fails answers the code `<name>-failed`. */
type StepDefinition = { name: string; does: string }

/** A command of bun mcp without what runs it. */
export type Definition = {
  name: string
  usage: string
  summary: string
  flags: Record<string, Flag>
  steps: readonly StepDefinition[]
  example: string
}

/** Every command's `--json`. */
const jsonFlag: Flag = { description: "Print one JSON object: { ok, steps, next }, or { ok: false, error: { code, message, fix, problems: [{ code, message }] } }, with every answer refused in problems" }

const noCheck: Flag = { description: "Skip the last step, bun mcp check" }

/** The commands of bun mcp, in the order `bun mcp help` lists them. */
export const definitions = {
  new: {
    name: "new",
    usage: "bun mcp new [name] [--description …] [--serve toolbox|standalone|both] [--database shared|own] [--tool <domain.operation> --tool-description … [--mutation]] [--no-check] [--json]",
    summary: "Make an MCP: write mcps/<name>, create its local schema, write its first migration and manifest, and check it. In a terminal it asks for what is missing; without one, name, --description and --serve are required",
    flags: {
      description: { value: "<text>", description: "What the MCP is for, in a sentence or two: 40 to 1,000 characters" },
      serve: { value: "<toolbox|standalone|both>", description: "Where it runs: in the Toolbox (recommended), on its own URL, or both" },
      database: { value: "<shared|own>", description: "Where its tables live: a schema in the shared database answerable_mcps, or a database of its own", default: "shared" },
      tool: { value: "<domain.operation>", description: "Its first tool, such as notes.list", default: "<name>.status, which reports who is calling" },
      "tool-description": { value: "<text>", description: "What the first tool does, when to use it and its limits: 40 to 1,000 characters" },
      mutation: { description: "The first tool is a change: prepared, then committed", default: "a read" },
      "no-check": noCheck,
      json: jsonFlag,
    },
    steps: [
      { name: "write", does: "Writes `mcps/<name>`" },
      { name: "generate", does: "Writes `charts/answerable/mcps.json` and the lists the Toolbox and the standalone server serve, with their dependencies" },
      { name: "install", does: "Runs `bun install`, which links the new workspace" },
      { name: "database", does: "Creates the MCP's schema and its two roles on the development Postgres" },
      { name: "migration", does: "Writes the first migration, `drizzle/0000_initial.sql`" },
      { name: "manifest", does: "Runs the tests once to write `manifest.json`, the MCP's contract" },
      { name: "generate", does: "Writes the generated lists again, now with the MCP's scopes and grant strings" },
      { name: "check", does: "Runs `bun mcp check <name>`; skipped by `--no-check`" },
    ],
    example: 'bun mcp new acme --description "Notes for construction projects: list, read and add notes on a project." --serve toolbox',
  },
  "add tool": {
    name: "add tool",
    usage: "bun mcp add tool [mcp] <domain.operation> --description … [--mutation] [--no-check] [--json]",
    summary: "Add a tool to an MCP: a read, or with --mutation a change, with its test, its entry in src/provider.ts and its domain's table; then write the migration and the manifest, and check the MCP",
    flags: {
      description: { value: "<text>", description: "What the tool does, when to use it and its limits: 40 to 1,000 characters; a mutation's says it prepares an intent" },
      mutation: { description: "The tool is a change: prepared, then committed", default: "a read" },
      "no-check": noCheck,
      json: jsonFlag,
    },
    steps: [
      { name: "write", does: "Writes the tool's file and its test, adds it to `src/provider.ts`, and adds its domain's table to `src/db/schema.ts` when the MCP has none" },
      { name: "migration", does: "Writes the migration for the new table, when there is one" },
      { name: "manifest", does: "Runs the tests once to rewrite `manifest.json`" },
      { name: "generate", does: "Writes the generated lists again" },
      { name: "check", does: "Runs `bun mcp check <mcp>`; skipped by `--no-check`" },
    ],
    example: 'bun mcp add tool acme notes.add --mutation --description "Prepare a new note on a project; commit it to save it. Use notes.list first to avoid duplicates."',
  },
  list: {
    name: "list",
    usage: "bun mcp list [--json]",
    summary: "Every MCP with an mcp.json, sorted by name: where it runs, its database mode, its tools, the first sentence of its description and its local URL, then its staging and production URLs",
    flags: { json: { description: "Print one JSON object: { ok, mcps: [{ name, serve, database, description, tools, urls: { local, staging, production } }] }" } },
    steps: [],
    example: "bun mcp list --json",
  },
  check: {
    name: "check",
    usage: "bun mcp check [mcp] [--json]",
    summary: "Typecheck, lint and test an MCP, with the conformance kit and its coverage gate; rewrite a stale manifest, the generated files and the environment inventories, to commit; scan its code for role switches",
    flags: { json: jsonFlag },
    steps: [
      { name: "typecheck", does: "Runs tsc over the MCP" },
      { name: "lint", does: "Runs eslint over its src" },
      { name: "test", does: "Runs its tests, the conformance kit included, with the 100% coverage gate" },
      { name: "manifest", does: "Says whether the tests rewrote `manifest.json`; commit it when they did" },
      { name: "generated", does: "Rewrites the generated lists and the environment inventories when they are stale; commit them when they are" },
      { name: "scan", does: "Refuses code in the MCP that switches the database role or sets the caller's organisation itself" },
      { name: "budget", does: "Warns when MCPs with a database of their own would pass the connection budget" },
    ],
    example: "bun mcp check acme",
  },
  db: {
    name: "db",
    usage: "bun mcp db [mcp] generate|migrate [--name <change>] [--json]",
    summary: "generate: write the migration for a change to an MCP's src/db/schema.ts, without drizzle-kit's schema line. migrate: provision and migrate its local development schema",
    flags: {
      name: { value: "<change>", description: "generate only: the migration's name, drizzle/<number>_<change>.sql", default: "drizzle-kit's" },
      json: jsonFlag,
    },
    steps: [
      { name: "migration", does: "`generate`: writes the migration for a change to `src/db/schema.ts`" },
      { name: "database", does: "`migrate`: creates the MCP's local schema and roles when missing, then applies its migrations" },
    ],
    example: "bun mcp db acme generate --name notes",
  },
  setup: {
    name: "setup",
    usage: "bun mcp setup [--organisation <slug>] [--staff-token <token>] [--json]",
    summary: "Connect bun mcp to your local Answerable ID, once: make its machine client, mcp-dev, there and write its id and secret, with your organisation, to the root .env. Run again, it finds the client working and does nothing",
    flags: {
      organisation: { value: "<slug>", description: "The organisation bun mcp dev gives access to the MCP it runs, so that you can sign in and call every tool", default: "your local ID's platform organisation, answerable" },
      "staff-token": { value: "<token>", description: "A staff token, for when ID's root secret is locked; without it, a terminal asks for one. Where to get one: https://www.answerable.org/docs/id/onboard#get-a-staff-token" },
      json: jsonFlag,
    },
    steps: [
      { name: "toolbox", does: "Registers the Toolbox's resource, its admin resource and Claude Code's client for the Toolbox in your local ID" },
      { name: "client", does: "Makes the machine client `mcp-dev`, or finds it working" },
      { name: "env", does: "Writes `MCP_DEV_ID_CLIENT_ID`, `MCP_DEV_ID_CLIENT_SECRET` and `MCP_DEV_ORGANISATION` to the root `.env`" },
    ],
    example: "bun mcp setup --organisation acme",
  },
  dev: {
    name: "dev",
    usage: "bun mcp dev [mcp]",
    summary: "Run an MCP on this machine, migrated, in the Toolbox or the standalone server as its serve says, with hot reload; register it in your local ID, give your organisation access, and print the claude mcp add command that connects Claude Code. It runs until Ctrl-C, which stops what it started. Needs bun mcp setup once",
    flags: {},
    steps: [
      { name: "database", does: "Migrates the schema of every MCP the servers it starts mount, and each server's own database" },
      { name: "toolbox", does: "Starts the Toolbox when the MCP's serve is toolbox or both, and waits for it to list the MCP" },
      { name: "standalone", does: "Starts the standalone server when the MCP's serve is standalone or both, and waits for it to list the MCP" },
      { name: "register", does: "Standalone only: registers the MCP's resource and its client, `claude-code-<name>`, in your local ID" },
      { name: "access", does: "Standalone only: gives your organisation sign-in and the MCP's scopes" },
      { name: "enable", does: "Toolbox only: enables the MCP for your organisation in the Toolbox and grants it" },
    ],
    example: "bun mcp dev acme",
  },
  help: {
    name: "help",
    usage: "bun mcp help [command]",
    summary: "Every command, or one command's usage, flags and example",
    flags: {},
    steps: [],
    example: "bun mcp help add tool",
  },
} satisfies Record<string, Definition>

/** What each exit code of bun mcp says; `--json` changes the output, never the code. */
export const exitCodes = [
  { code: 0, meaning: "Done" },
  { code: 1, meaning: "A step failed after files were written. The output names the command that finishes the job; an error that is not a refusal is bun mcp failed, with its message" },
  { code: 2, meaning: "Refused before anything was written: a wrong or missing answer, a flag it does not know, or a stack that is not running. Every problem is listed at once, with the command to run again" },
] as const

/**
 * Every code an error of bun mcp can carry, in `--json`'s `error.code` and in each of `error.problems[].code`. A step that fails answers
 * `<step>-failed`, such as `database-failed`, for each step a command's definition names.
 */
export const errorCodes = [
  "unknown-command", "unknown-flag", "repeated-flag", "flag-value", "unexpected-argument", "unexpected-flag", "unknown-action", "missing-argument", "cancelled",
  "not-in-repository", "invalid-file", "invalid-configuration", "mcp-required", "mcp-not-found",
  "invalid-name", "name-reserved", "name-retired", "name-taken", "invalid-description", "invalid-serve", "invalid-database",
  "invalid-tool-name", "tool-name-reserved", "tool-exists", "invalid-tool-description", "mutation-description", "flag-needs-tool", "not-made-by-new", "table-outside-schema",
  "setup-required", "setup-stale", "id-down", "postgres-down", "port-taken", "manifest-missing", "organisation-not-found", "invalid-organisation",
  "platform-organisation-missing", "staff-token-required", "staff-token-refused", "failed",
] as const

/** A code of an error of bun mcp, apart from the `<step>-failed` family. */
export type ErrorCode = (typeof errorCodes)[number]
