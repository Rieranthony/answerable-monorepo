// Every row of errors.ts, run for real: the command is run in a stand-in repository, or against the local stack's stand-ins, in the situation the row
// describes, and what it printed must be what the row says it sees. The docs render these rows, so a message reworded in the code fails here.
import { afterEach, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { main } from "./cli"
import { definitions, errorCodes } from "./definitions"
import { errors } from "./errors"
import { spawn } from "./io"
import { mcpFiles } from "./templates"
import { isolateEnvironment, localId } from "./test/id"
import { recorder, tempRepository, testIo } from "./test/io"
import { forget, randomName } from "./test/postgres"
import { localStack } from "./test/stack"

isolateEnvironment()
const repo = new URL("../../", import.meta.url).pathname
const description = "Notes for construction projects: list, read and add notes on a project."
const toolDescription = "List the notes of the caller's organisation, newest first, 20 per page."
const declared = (name: string, serve = "toolbox") => ({ [`mcps/${name}/mcp.json`]: `${JSON.stringify({ name, serve, database: "shared" })}\n` })
const made = (name: string, files: Parameters<typeof mcpFiles>[0]["tool"] = undefined) =>
  Object.fromEntries(Object.entries(mcpFiles({ name, description, serve: "toolbox", database: "shared", date: "2026-10-25", tool: files })).map(([path, text]) => [`mcps/${name}/${path}`, text]))
const create = (...more: string[]) => ["new", "acme", "--description", description, "--serve", "toolbox", ...more]
const withTool = (name: string, ...more: string[]) => create("--tool", name, "--tool-description", toolDescription, ...more)

/** What a command printed in a situation: its exit code, the lines of its message, and the code `--json` gives where the command takes it. */
type Printed = { exit: number; lines: string[]; code?: string }
type Options = Parameters<typeof testIo>[2] & { cwd?: string; json?: boolean }

const removals: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const remove of removals.splice(0)) await remove() })

async function repository(files: Record<string, string>) {
  const repository = await tempRepository(files)
  removals.push(repository.remove)
  return repository
}

// Run `argv` in a repository of `files`, as JSON, which gives each problem and the code.
async function run(argv: string[], files: Record<string, string> = {}, { cwd, json = true, ...options }: Options = {}): Promise<Printed> {
  const { root } = await repository(files)
  const io = testIo(json ? [...argv, "--json"] : argv, cwd ?? root, options)
  const exit = await main(io.io)
  if (!json) return { exit, lines: io.stderr().split("\n\n")[0]!.split("\n") }
  const { error } = JSON.parse(io.stdout()) as { error: { code: string; message: string } }
  return { exit, lines: error.message.split("\n"), code: error.code }
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
const dev = async (root: string, local: ReturnType<typeof localStack>, options: Options = {}): Promise<Printed> => {
  const io = testIo(["dev", "acme"], root, { fetch: local.fetch, start: local.start, listening: async (_host, port) => port === 47432, ...options })
  const exit = await main(io.io)
  return { exit, lines: io.stderr().split("\n\n")[0]!.split("\n") }
}
// bun mcp setup against a local ID, as JSON: what it refused with.
async function setup(argv: string[], id = localId(), files: Record<string, string> = {}): Promise<Printed> {
  const { root } = await repository(files)
  const io = testIo(["setup", ...argv, "--json"], root, { fetch: id.config.fetch })
  const exit = await main(io.io)
  const { error } = JSON.parse(io.stdout())
  return { exit, lines: error.message.split("\n"), code: error.code }
}
const acmeManifest = `${JSON.stringify({ description, tools: [{ name: "acme_status", identity: "acme/acme.status", kind: "read", scopes: ["acme:read"] }], prompts: [], resources: [] })}\n`
const standalone = { ...declared("acme", "standalone"), "mcps/acme/manifest.json": acmeManifest }
const toolboxMcp = { ...declared("acme"), "mcps/acme/manifest.json": acmeManifest }

// With node_modules linked, as in db.test.ts: drizzle-kit and the schema's imports resolve from the repository's install.
async function installed(files: Record<string, string>) {
  const made = await repository(files)
  await symlink(join(repo, "node_modules"), join(made.root, "node_modules"))
  return made
}

const scenarios: Record<string, () => Promise<Printed>> = {
  "unknown-command": () => run(["deploy", "acme"]),
  "unknown-flag": () => run(["new", "acme", "--force"]),
  "repeated-flag": () => run([...create(), "--serve", "both"]),
  "flag-value": () => run(["new", "acme", "--serve"]),
  "unexpected-argument": () => run([...create(), "extra"]),
  "unexpected-flag": () => run(["db", "acme", "migrate", "--name", "x"]),
  "unknown-action": () => run(["db", "acme", "seed"]),
  "missing-argument": () => run(["new", "acme", "--description", description]),
  "missing-tool": () => run(["add", "tool", "acme", "--description", toolDescription], made("acme")),
  "missing-description": () => run(["add", "tool", "acme", "notes.list"], made("acme")),
  "cancelled": () => run(["new"], {}, { json: false, isTTY: true, answers: [Symbol("cancel")] }),
  "not-in-repository": () => run(["list"], {}, { cwd: "/" }),
  "invalid-file": () => run(create(), { "mcps/retired.json": "not json" }),
  "invalid-configuration": () => setup([], localId(), { ".env": "MCP_DEV_ORGANISATION=Not A Slug\n" }),
  "mcp-required": () => run(["add", "tool", "notes.list", "--description", toolDescription]),
  "mcp-not-found": () => run(["add", "tool", "nope", "notes.list", "--description", toolDescription]),
  "invalid-name": () => run(["new", "Acme", "--description", description, "--serve", "toolbox"]),
  "name-reserved": () => run(["new", "toolbox", "--description", description, "--serve", "toolbox"]),
  "name-retired": () => run(["new", "gone", "--description", description, "--serve", "toolbox"], { "mcps/retired.json": '["gone"]\n' }),
  "name-taken": () => run(create(), declared("acme")),
  "invalid-description": () => run(["new", "acme", "--description", "Notes.", "--serve", "toolbox"]),
  "invalid-serve": () => run(["new", "acme", "--description", description, "--serve", "cloud"]),
  "invalid-database": () => run(create("--database", "big")),
  "flag-needs-tool": () => run(create("--mutation")),
  "invalid-tool-name": () => run(withTool("notes")),
  "tool-name-reserved": () => run(withTool("acme.commit")),
  "tool-name-imported": () => run(withTool("define.tool")),
  "tool-exists": () => run(["add", "tool", "acme", "notes.list", "--description", toolDescription], made("acme", { name: "notes.list", description: toolDescription, mutation: false })),
  "invalid-tool-description": () => run(create("--tool", "notes.list", "--tool-description", "Gets notes.")),
  "mutation-description": () => run(withTool("notes.add", "--mutation")),
  "not-made-by-new": () => run(["add", "tool", "bare", "notes.list", "--description", toolDescription], { ...declared("bare"), "mcps/bare/src/provider.ts": "export const provider = {}\n" }),
  "table-outside-schema": async () => {
    const files = made("acme")
    files["mcps/acme/src/db/schema.ts"] += 'export const loose = pg.pgTable("loose", { id: pg.uuid().primaryKey() })\n'
    const { root } = await installed(files)
    const io = testIo(["db", "acme", "generate", "--json"], root, { exec: spawn })
    const exit = await main(io.io)
    const { error } = JSON.parse(io.stdout())
    return { exit, lines: error.message.split("\n"), code: error.code }
  },
  "setup-required": async () => {
    const { root } = await repository(toolboxMcp)
    return dev(root, localStack(localId()))
  },
  "setup-stale": async () => {
    const { root, local } = await developer(toolboxMcp)
    await Bun.write(join(root, ".env"), "MCP_DEV_ID_CLIENT_ID=mcp-dev\nMCP_DEV_ID_CLIENT_SECRET=from-the-old-database\n")
    return dev(root, local)
  },
  "id-down": async () => {
    const { root } = await repository(toolboxMcp)
    return dev(root, localStack(localId()), { fetch: async () => { throw new TypeError("Unable to connect") } })
  },
  "postgres-down": async () => {
    const { root, local } = await developer(toolboxMcp)
    return dev(root, local, { listening: async () => false })
  },
  "port-taken": async () => {
    const { root, local } = await developer(toolboxMcp)
    return dev(root, local, { listening: async (_host, port) => port === 47432 || port === 47400 })
  },
  "manifest-missing": async () => {
    const { root, local } = await developer(declared("acme", "standalone"))
    return dev(root, local)
  },
  "organisation-not-found": async () => {
    const { root, local } = await developer(toolboxMcp)
    await Bun.write(join(root, ".env"), (await Bun.file(join(root, ".env")).text()).replace("MCP_DEV_ORGANISATION=answerable", "MCP_DEV_ORGANISATION=acme"))
    return dev(root, local)
  },
  "invalid-organisation": () => setup(["--organisation", "Acme"]),
  "platform-organisation-missing": () => setup([], localId({ platform: false })),
  "staff-token-required": () => {
    const id = localId()
    id.lockRoot(true)
    return setup([], id)
  },
  "staff-token-refused": () => setup(["--staff-token", "wrong"]),
  "failed": () => run(["db", "acme", "generate"], declared("acme")),
  "step-failed": () => run(create("--no-check"), {}, { exec: recorder(command => (command[1] === "install" ? { code: 1, output: "error: lockfile had changes, but lockfile is frozen" } : { code: 0, output: "3 pass" })).exec }),
  "database-down": async () => {
    process.env.MCPS_DATABASE_ADMIN_URL = "postgres://answerable:answerable@localhost:1/answerable_mcps"
    try {
      const printed = await run(["db", "acme", "migrate"], made("acme"))
      // A person's Postgres is on 47432: the stand-in listens on nothing, and the message names where it looked.
      return { ...printed, lines: printed.lines.map(line => line.replace("localhost:1;", "localhost:47432;")) }
    } finally {
      delete process.env.MCPS_DATABASE_ADMIN_URL
    }
  },
  "migration-refused": async () => {
    const name = randomName()
    removals.push(() => forget(name))
    const { root } = await installed(made(name))
    const generated = testIo(["db", name, "generate", "--name", "initial"], root, { exec: spawn })
    expect(await main(generated.io), generated.stderr()).toBe(0)
    await Bun.write(join(root, "mcps", name, "drizzle/0000_initial.sql"), 'GRANT SELECT ON "x"."y" TO PUBLIC;\n')
    const io = testIo(["db", name, "migrate", "--json"], root, { exec: spawn })
    const exit = await main(io.io)
    const { error } = JSON.parse(io.stdout())
    return { exit, lines: (error.message as string).replaceAll(name, "acme").split("\n"), code: error.code }
  },
  "migration-edited": async () => {
    const name = randomName()
    removals.push(() => forget(name))
    const { root } = await installed(made(name))
    for (const argv of [[name, "generate", "--name", "initial"], [name, "migrate"]]) {
      const made = testIo(["db", ...argv], root, { exec: spawn })
      expect(await main(made.io), made.stderr()).toBe(0)
    }
    await Bun.write(join(root, "mcps", name, "drizzle/0000_initial.sql"), "-- edited after it was applied\n")
    const io = testIo(["db", name, "migrate", "--json"], root, { exec: spawn })
    const exit = await main(io.io)
    const { error } = JSON.parse(io.stdout())
    return { exit, lines: (error.message as string).replaceAll(name, "acme").split("\n"), code: error.code }
  },
  "check-failed": () => run(create(), {}, { exec: recorder(command => (command.at(-1) === "typecheck" ? { code: 2, output: "src/provider.ts(1,1): error TS1" } : { code: 0, output: " 3 pass\n" })).exec }),
  "access-disabled": async () => {
    const { root, id, local } = await developer(toolboxMcp)
    id.entitlement(id.organizationId, { resource: "http://localhost:47400/mcp", scopes: ["acme"], status: "disabled" })
    return dev(root, local)
  },
  "enable-refused": async () => {
    const { root, local } = await developer(toolboxMcp, { refuse: { status: 422, code: "unknown_host_client", message: "Answerable ID has no client claude-code-toolbox; register it first" } })
    return dev(root, local)
  },
  "toolbox-token-refused": async () => {
    const { root, id, local } = await developer(toolboxMcp)
    const capabilities = id.capabilities(id.organizationId)
    capabilities.splice(capabilities.findIndex(row => row.resource === "http://localhost:47400/admin"), 1)
    return dev(root, local)
  },
  "server-stopped": async () => {
    const { root, local } = await developer(standalone, { end: (_command, cwd) => (cwd.endsWith("mcps/standalone") ? 1 : undefined) })
    return dev(root, local)
  },
}

// What a row's `see` says, as a pattern: every character exact, and `…` for what varies.
const pattern = (see: string) => new RegExp(`^${see.split("…").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)

test("every row has a scenario, and every scenario a row", () => {
  expect(Object.keys(scenarios).sort()).toEqual(errors.map(row => row.id).sort())
  expect(new Set(errors.map(row => row.id)).size).toBe(errors.length)
})

test.each(errors.map(row => [row.id, row] as const))("%s: the real command prints what the row sees", async (id, row) => {
  const printed = await scenarios[id]!()
  expect(printed.exit, id).toBe(row.code === "failed" || row.code.endsWith("-failed") ? 1 : 2)
  expect(printed.lines.some(line => pattern(row.see).test(line)), `${id}: ${JSON.stringify(printed.lines)} does not match ${row.see}`).toBe(true)
  if (printed.code) expect(printed.code, id).toBe(row.code)
}, 60_000)

test("every error code has a row, and every other row's code is a step's", () => {
  const steps = new Set(Object.values(definitions).flatMap(command => command.steps.map(step => `${step.name}-failed`)))
  expect(new Set(errors.map(row => row.code).filter(code => !code.endsWith("-failed")))).toEqual(new Set(errorCodes))
  for (const row of errors.filter(row => row.code.endsWith("-failed"))) expect(steps.has(row.code), row.id).toBe(true)
})
