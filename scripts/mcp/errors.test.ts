// Every row of errors.ts, run for real, the one place each refusal is asserted: the command runs in a stand-in repository, or against the local
// stack's stand-ins, in the situation the row describes, and it must print what the row sees, with the row's code and exit code and the fix line
// its scenario names; a refusal must have written nothing. The docs render these rows, so a message reworded in the code fails here.
import { afterEach, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { dispatch, main, report } from "./cli"
import { migrateLocal } from "./database"
import { definitions, errorCodes } from "./definitions"
import { errors } from "./errors"
import { Refusal, shellWord, spawn } from "./io"
import { mcpFiles } from "./templates"
import { isolateEnvironment, localId } from "./test/id"
import { filesUnder, recorder, tempRepository, testIo } from "./test/io"
import { forget, randomName } from "./test/postgres"
import { localStack } from "./test/stack"

isolateEnvironment()
const repo = new URL("../../", import.meta.url).pathname
const description = "Notes for construction projects: list, read and add notes on a project."
const toolDescription = "List the notes of the caller's organisation, newest first, 20 per page."
const notesList = { name: "notes.list", description: toolDescription, mutation: false }
const declared = (name: string, serve = "toolbox") => ({ [`mcps/${name}/mcp.json`]: `${JSON.stringify({ serve, database: "shared" })}\n` })
const made = (name: string, tool?: typeof notesList) =>
  Object.fromEntries(Object.entries(mcpFiles({ name, description, serve: "toolbox", database: "shared", date: "2026-10-25", tool })).map(([path, text]) => [`mcps/${name}/${path}`, text]))
const create = (...more: string[]) => ["new", "acme", "--description", description, "--serve", "toolbox", ...more]
const withTool = (name: string, ...more: string[]) => create("--tool", name, "--tool-description", toolDescription, ...more)
const newFix = 'bun mcp new <name> --description "<what the MCP is for, 40 to 1,000 characters>" --serve <toolbox|standalone|both>'
const acmeFix = `bun mcp new acme --description '${description}' --serve toolbox`
const toolFix = `${acmeFix} --tool <domain.operation> --tool-description ${shellWord(toolDescription)}`

/** What a command did: its exit code; the code it was refused with, or `failed`; its message's lines; the fix line; and the files it changed. */
type Outcome = { exit: number; code?: string; lines: string[]; fix: string; changed: string[] }
type Options = Parameters<typeof testIo>[2] & { cwd?: string }

const removals: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const remove of removals.splice(0)) await remove() })

async function repository(files: Record<string, string>) {
  const repository = await tempRepository(files)
  removals.push(repository.remove)
  return repository
}

// Every file under `root` with its text, a directory or a link to one as nothing.
const contents = async (root: string) => new Map(await Promise.all((await filesUnder(root)).map(async path => [path, await Bun.file(join(root, path)).text().catch(() => "")] as const)))

// Run `argv` in `root` as main does, keeping what it threw: the outcome, the files it changed by path.
async function outcome(argv: string[], root: string, { cwd, ...options }: Options = {}): Promise<Outcome> {
  const io = testIo(argv, cwd ?? root, options)
  const before = await contents(root)
  let thrown: unknown
  const exit = await dispatch(io.io).catch(error => ((thrown = error), report(io.io, error)))
  const after = await contents(root)
  const printed = io.stderr()
  const split = printed.lastIndexOf("\n\n")
  return {
    exit, code: thrown instanceof Refusal ? thrown.code : thrown ? "failed" : undefined,
    lines: printed.slice(0, split).split("\n"), fix: printed.slice(split).trim().split("\n").at(-1)!.trim(),
    changed: [...after.keys()].filter(path => after.get(path) !== before.get(path)),
  }
}

// Run `argv` in a repository of `files`.
const run = async (argv: string[], files: Record<string, string> = {}, options: Options = {}) => outcome(argv, (await repository(files)).root, options)

// With node_modules linked, as in db.test.ts: drizzle-kit and the schema's imports resolve from the repository's install.
async function installed(files: Record<string, string>) {
  const made = await repository(files)
  await symlink(join(repo, "node_modules"), join(made.root, "node_modules"))
  return made
}

// A local ID that bun mcp setup has run against, and a repository whose .env it wrote: the starting point of the dev rows.
async function developer(files: Record<string, string>, stack: Parameters<typeof localStack>[1] = {}) {
  const { root } = await repository(files)
  const id = localId()
  const local = localStack(id, stack)
  const setup = testIo(["setup"], root, { fetch: local.fetch })
  expect(await main(setup.io), setup.stderr()).toBe(0)
  return { root, id, local }
}
const dev = (root: string, local: ReturnType<typeof localStack>, options: Options = {}) =>
  outcome(["dev", "acme"], root, { fetch: local.fetch, start: local.start, listening: async (_host, port) => port === 47432, ...options })
const setup = async (argv: string[], id = localId(), files: Record<string, string> = {}) => run(["setup", ...argv], files, { fetch: id.config.fetch })
const acmeManifest = `${JSON.stringify({ description, tools: [{ name: "notes_list", identity: "acme/notes.list", kind: "read", scopes: ["acme:read"] }], prompts: [], resources: [] })}\n`
const standalone = { ...declared("acme", "standalone"), "mcps/acme/manifest.json": acmeManifest }
const toolboxMcp = { ...declared("acme"), "mcps/acme/manifest.json": acmeManifest }

/** Each row's situation, by id, and the fix line it prints: `…` for what varies. */
const scenarios: Record<string, { fix: string; run: () => Promise<Outcome> }> = {
  "unknown-command": { fix: "bun mcp help", run: () => run(["deploy", "acme"]) },
  "unknown-flag": { fix: definitions.new.usage, run: () => run(["new", "acme", "--force"]) },
  "flag-value": { fix: definitions.new.usage, run: () => run(["new", "acme", "--serve"]) },
  "unexpected-argument": { fix: 'bun mcp add tool acme notes.list --description "<what it does, when to use it, its limits>"', run: () => run(["add", "tool", "acme", "notes.list", "notes.add"], made("acme")) },
  "unexpected-flag": { fix: definitions.db.usage, run: () => run(["db", "acme", "migrate", "--name", "x"]) },
  "unknown-action": { fix: definitions.db.usage, run: () => run(["db", "acme", "seed"]) },
  "missing-argument": { fix: `bun mcp new acme --description '${description}' --serve <toolbox|standalone|both>`, run: () => run(["new", "acme", "--description", description]) },
  "missing-tool": { fix: `bun mcp add tool acme <domain.operation> --description ${shellWord(toolDescription)}`, run: () => run(["add", "tool", "acme", "--description", toolDescription], made("acme")) },
  "missing-description": { fix: 'bun mcp add tool acme notes.list --description "<what it does, when to use it, its limits>"', run: () => run(["add", "tool", "acme", "notes.list"], made("acme")) },
  "cancelled": { fix: newFix, run: () => run(["new"], {}, { isTTY: true, answers: [Symbol("cancel")] }) },
  "not-in-repository": { fix: "cd <the repository>", run: async () => outcome(["list"], (await repository({})).root, { cwd: "/" }) },
  "invalid-file": { fix: "git diff mcps/retired.json", run: () => run(create(), { "mcps/retired.json": "not json" }) },
  "invalid-configuration": { fix: "bun mcp setup", run: () => setup([], localId(), { ".env": "MCP_DEV_ORGANISATION=Not A Slug\n" }) },
  "mcp-required": { fix: "bun mcp add tool <mcp> notes.list --description …", run: () => run(["add", "tool", "notes.list", "--description", toolDescription]) },
  "mcp-not-found": { fix: "bun mcp add tool <mcp> notes.list --description …", run: () => run(["add", "tool", "nope", "notes.list", "--description", toolDescription]) },
  "invalid-name": { fix: `bun mcp new <name> --description '${description}' --serve toolbox`, run: () => run(["new", "Acme", "--description", description, "--serve", "toolbox"]) },
  "name-reserved": { fix: `bun mcp new <name> --description '${description}' --serve toolbox`, run: () => run(["new", "toolbox", "--description", description, "--serve", "toolbox"]) },
  "name-retired": { fix: `bun mcp new <name> --description '${description}' --serve toolbox`, run: () => run(["new", "gone", "--description", description, "--serve", "toolbox"], { "mcps/retired.json": '["gone"]\n' }) },
  "name-taken": { fix: `bun mcp new <name> --description '${description}' --serve toolbox`, run: () => run(create(), declared("acme")) },
  "invalid-description": { fix: "bun mcp new acme --description \"<what the MCP is for, 40 to 1,000 characters>\" --serve toolbox", run: () => run(["new", "acme", "--description", "Notes.", "--serve", "toolbox"]) },
  "invalid-serve": { fix: `bun mcp new acme --description '${description}' --serve <toolbox|standalone|both>`, run: () => run(["new", "acme", "--description", description, "--serve", "cloud"]) },
  "invalid-database": { fix: `${acmeFix} --database <shared|own>`, run: () => run(create("--database", "big")) },
  "flag-needs-tool": { fix: `${acmeFix} --tool <domain.operation> --tool-description "<what the tool does, when to use it, its limits>" --mutation`, run: () => run(create("--mutation")) },
  "invalid-tool-name": { fix: toolFix, run: () => run(withTool("notes")) },
  "tool-name-reserved": { fix: toolFix, run: () => run(withTool("acme.commit")) },
  "tool-name-imported": { fix: toolFix, run: () => run(withTool("define.tool")) },
  "tool-exists": { fix: "bun mcp add tool acme <domain.operation> --description …", run: () => run(["add", "tool", "acme", "notes.list", "--description", toolDescription], made("acme", notesList)) },
  "invalid-tool-description": { fix: `${acmeFix} --tool notes.list --tool-description "<what the tool does, when to use it, its limits>"`, run: () => run(create("--tool", "notes.list", "--tool-description", "Gets notes.")) },
  "mutation-description": { fix: `${acmeFix} --tool notes.add --tool-description "<what the tool does, when to use it, its limits>" --mutation`, run: () => run(withTool("notes.add", "--mutation")) },
  "not-made-by-new": { fix: "bun mcp help add tool", run: () => run(["add", "tool", "bare", "notes.list", "--description", toolDescription], { ...declared("bare"), "mcps/bare/src/provider.ts": "export const provider = {}\n" }) },
  "table-outside-schema": {
    fix: "bun mcp db acme generate",
    run: async () => {
      const files = made("acme")
      files["mcps/acme/src/db/schema.ts"] += 'export const loose = pg.pgTable("loose", { id: pg.uuid().primaryKey() })\n'
      return outcome(["db", "acme", "generate"], (await installed(files)).root, { exec: spawn })
    },
  },
  "setup-required": { fix: "bun mcp setup", run: async () => dev((await repository(toolboxMcp)).root, localStack(localId())) },
  "setup-stale": {
    fix: "bun mcp setup",
    run: async () => {
      const { root, local } = await developer(toolboxMcp)
      await Bun.write(join(root, ".env"), "MCP_DEV_ID_CLIENT_ID=mcp-dev\nMCP_DEV_ID_CLIENT_SECRET=from-the-old-database\n")
      return dev(root, local)
    },
  },
  "id-down": {
    fix: "bun --filter @answerable/id dev",
    run: () => {
      const id = localId()
      id.unreachable(true)
      return setup([], id)
    },
  },
  "postgres-down": {
    fix: "bun mcp dev acme",
    run: async () => {
      const { root, local } = await developer(toolboxMcp)
      return dev(root, local, { listening: async () => false })
    },
  },
  "port-taken": {
    fix: "bun mcp dev acme",
    run: async () => {
      const { root, local } = await developer(toolboxMcp)
      return dev(root, local, { listening: async (_host, port) => port === 47432 || port === 47400 })
    },
  },
  "manifest-missing": {
    fix: "bun mcp dev acme",
    run: async () => {
      const { root, local } = await developer(declared("acme", "standalone"))
      return dev(root, local)
    },
  },
  "organisation-not-found": {
    fix: "bun mcp setup --organisation <slug>",
    run: async () => {
      const { root, local } = await developer(toolboxMcp)
      await Bun.write(join(root, ".env"), (await Bun.file(join(root, ".env")).text()).replace("MCP_DEV_ORGANISATION=answerable", "MCP_DEV_ORGANISATION=acme"))
      return dev(root, local)
    },
  },
  "invalid-organisation": { fix: definitions.setup.usage, run: () => setup(["--organisation", "Acme"]) },
  "platform-organisation-missing": { fix: "bun mcp setup", run: () => setup([], localId({ platform: false })) },
  "staff-token-required": {
    fix: "bun mcp setup --staff-token <token>",
    run: () => {
      const id = localId()
      id.lockRoot(true)
      return setup([], id)
    },
  },
  "staff-token-refused": { fix: "bun mcp setup --staff-token <token>", run: () => setup(["--staff-token", "wrong"]) },
  "failed": { fix: "bun mcp help", run: () => run(["db", "acme", "generate"], declared("acme")) },
  "step-failed": {
    fix: `bun install && bun mcp db acme generate --name initial && bun mcp db acme migrate && bun mcp check acme`,
    run: () => run(create(), {}, { exec: recorder(command => (command[1] === "install" ? { code: 1, output: "error: lockfile had changes, but lockfile is frozen" } : { code: 0, output: "3 pass" })).exec }),
  },
  "database-down": {
    fix: "bun mcp db acme migrate",
    run: async () => {
      process.env.MCPS_DATABASE_ADMIN_URL = "postgres://answerable:answerable@localhost:1/answerable_mcps"
      try {
        const printed = await run(["db", "acme", "migrate"], made("acme"), { migrate: migrateLocal })
        // A person's Postgres is on 47432: the stand-in listens on nothing, and the message names where it looked.
        return { ...printed, lines: printed.lines.map(line => line.replace("localhost:1;", "localhost:47432;")) }
      } finally {
        delete process.env.MCPS_DATABASE_ADMIN_URL
      }
    },
  },
  "migration-edited": {
    fix: "bun mcp db acme migrate",
    run: async () => {
      const name = randomName()
      removals.push(() => forget(name))
      const { root } = await installed(made(name))
      for (const argv of [[name, "generate", "--name", "initial"], [name, "migrate"]]) {
        const made = testIo(["db", ...argv], root, { exec: spawn, migrate: migrateLocal })
        expect(await main(made.io), made.stderr()).toBe(0)
      }
      await Bun.write(join(root, "mcps", name, "drizzle/0000_initial.sql"), "-- edited after it was applied\n")
      const printed = await outcome(["db", name, "migrate"], root, { exec: spawn, migrate: migrateLocal })
      const named = (text: string) => text.replaceAll(name, "acme")
      return { ...printed, lines: printed.lines.map(named), fix: named(printed.fix) }
    },
  },
  "check-failed": {
    fix: "bun mcp check acme",
    run: () => run(create(), {}, { exec: recorder(command => (command.at(-1) === "typecheck" ? { code: 2, output: "src/provider.ts(1,1): error TS1" } : { code: 0, output: " 3 pass\n" })).exec }),
  },
  "organisation-setting": {
    fix: "bun mcp check acme",
    run: () => {
      const files = made("acme", notesList)
      files["mcps/acme/src/tools/notes-list.ts"] += "// await db.execute(sql`select set_config('answerable.organisation_id', ${other}, true)`)\n"
      return run(["check", "acme"], files)
    },
  },
  "access-disabled": {
    fix: "bun mcp dev acme",
    run: async () => {
      const { root, id, local } = await developer(toolboxMcp)
      id.entitlement(id.organizationId, { resource: "http://localhost:47400/mcp", scopes: ["acme"], status: "disabled" })
      return dev(root, local)
    },
  },
  "enable-refused": {
    fix: "bun mcp dev acme",
    run: async () => {
      const { root, local } = await developer(toolboxMcp, { refuse: { status: 422, code: "unknown_host_client", message: "Answerable ID has no client claude-code-toolbox; register it first" } })
      return dev(root, local)
    },
  },
  "toolbox-token-refused": {
    fix: "bun mcp dev acme",
    run: async () => {
      const { root, id, local } = await developer(toolboxMcp)
      const capabilities = id.capabilities(id.organizationId)
      capabilities.splice(capabilities.findIndex(row => row.resource === "http://localhost:47400/admin"), 1)
      return dev(root, local)
    },
  },
  "server-stopped": {
    fix: "bun mcp dev acme",
    run: async () => {
      const { root, local } = await developer(standalone, { end: (_command, cwd) => (cwd.endsWith("mcps/toolbox") ? 1 : undefined) })
      return dev(root, local)
    },
  },
}

// What a row's `see`, or a fix, says, as a pattern: every character exact, and `…` for what varies.
const pattern = (see: string) => new RegExp(`^${see.split("…").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)

test("every row has a scenario, and every scenario a row", () => {
  expect(Object.keys(scenarios).sort()).toEqual(errors.map(row => row.id).sort())
  expect(new Set(errors.map(row => row.id)).size).toBe(errors.length)
})

test.each(errors.map(row => [row.id, row] as const))("%s: the real command prints what the row sees, with its code, its exit code and its fix", async (id, row) => {
  const { fix, run } = scenarios[id]!
  const printed = await run()
  const failed = row.code.endsWith("-failed")
  expect(printed.exit, id).toBe(failed || row.code === "failed" ? 1 : 2)
  expect(printed.lines.some(line => pattern(row.see).test(line)), `${id}: ${JSON.stringify(printed.lines)} does not match ${row.see}`).toBe(true)
  // A step's failure is no refusal: the step it names is the code's.
  if (failed) expect([printed.code, row.see.startsWith(`${row.code.slice(0, -"-failed".length)} failed: `)], id).toEqual([undefined, true])
  else expect(printed.code, id).toBe(row.code)
  expect(pattern(fix).test(printed.fix), `${id}: the fix ${printed.fix} is not ${fix}`).toBe(true)
  if (printed.exit === 2) expect(printed.changed, `${id} wrote`).toEqual([])
}, 60_000)

test("every error code has a row, and every other row's code is a step's", () => {
  const steps = new Set(Object.values(definitions).flatMap(command => command.steps.map(step => `${step.name}-failed`)))
  expect(new Set(errors.map(row => row.code).filter(code => !code.endsWith("-failed")))).toEqual(new Set(errorCodes))
  for (const row of errors.filter(row => row.code.endsWith("-failed"))) expect(steps.has(row.code), row.id).toBe(true)
})
