import { afterEach, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { main } from "../cli"
import { definitions } from "../definitions"
import { cli } from "../io"
import { isolateEnvironment, localId, writesTo } from "../test/id"
import { recorder, tempRepository, testIo } from "../test/io"
import { localStack } from "../test/stack"

isolateEnvironment()
let repository: Awaited<ReturnType<typeof tempRepository>>
afterEach(() => repository.remove())

const acme = "http://localhost:47510/acme/mcp"
const toolbox = "http://localhost:47400/mcp"
const manifest = (scopes: string[]) => JSON.stringify({
  description: "Notes.",
  tools: [{ name: "acme_status", identity: "acme/acme.status", kind: "read", scopes: [scopes[0]] }, { name: "acme_commit", identity: "acme/commit", kind: "commit", scopes: scopes.slice(1) }],
  prompts: [], resources: [],
})
const lines = (text: string) => text.split("\n").map(line => line.replace(/ \(\d+(\.\d+)? m?s\)$/, ""))
type Stack = ReturnType<typeof localStack>

// A repository with the MCP acme and a local ID that bun mcp setup has run against, so that .env holds mcp-dev.
async function prepare(serve: "toolbox" | "standalone" | "both", { scopes = ["acme:read", "acme:write"], stack: options = {} }: { scopes?: string[]; stack?: Parameters<typeof localStack>[1] } = {}) {
  await repository?.remove()
  repository = await tempRepository({
    "mcps/acme/mcp.json": JSON.stringify({ name: "acme", serve, database: "shared" }),
    "mcps/acme/manifest.json": manifest(scopes),
  })
  const id = localId()
  const stack = localStack(id, options)
  const made = testIo(["setup"], repository.root, { fetch: stack.fetch })
  expect(await main(made.io), made.stderr()).toBe(0)
  return { id, stack }
}

// bun mcp dev, started: its output, and the means to Ctrl-C it, wait for it, or stop one of its servers.
function start(stack: Stack, argv = ["acme"], { cwd = repository.root, listening = async (_host: string, port: number) => port === 47432, answer }: { cwd?: string; listening?: (host: string, port: number) => Promise<boolean>; answer?: Parameters<typeof recorder>[0] } = {}) {
  const controller = new AbortController()
  const { exec, ran } = recorder(answer)
  const io = testIo(["dev", ...argv], cwd, { fetch: stack.fetch, start: stack.start, listening, signal: controller.signal, exec })
  const finished = main(io.io)
  const printed = async () => {
    while (!io.stdout().includes("Ctrl-C")) await Bun.sleep(2)
  }
  return { ...io, ran, finished, printed, interrupt: () => controller.abort() }
}

// bun mcp dev until it has printed what to do, then Ctrl-C.
async function dev(stack: Stack, argv?: string[], options?: Parameters<typeof start>[2]) {
  const running = start(stack, argv, options)
  await Promise.race([running.printed(), running.finished])
  running.interrupt()
  return { ...running, code: await running.finished }
}

test("a standalone MCP: migrates, starts the standalone server as mcp-dev, registers its resource and client, gives the organisation access, prints what to do and stops on Ctrl-C", async () => {
  const { id, stack } = await prepare("standalone")
  const before = writesTo(id).length
  const { code, ran, stdout, stderr } = await dev(stack)
  expect([code, stderr()]).toEqual([0, ""])
  expect(ran.map(({ command, cwd }) => [command.slice(1), cwd])).toEqual([
    [[cli, "db", "acme", "migrate"], repository.root], [["run", "db:migrate"], join(repository.root, "mcps/standalone")],
  ])
  expect(stack.started).toHaveLength(1)
  expect(stack.started[0]).toMatchObject({ command: [process.execPath, "run", "--silent", "dev"], cwd: join(repository.root, "mcps/standalone"), stopped: true })
  expect(stack.started[0]!.env).toMatchObject({ STANDALONE_ID_CLIENT_ID: "mcp-dev", STANDALONE_ID_CLIENT_SECRET: expect.stringMatching(/^secret-/) })
  expect(writesTo(id).slice(before)).toEqual([
    "POST /resources", "POST /clients", `PUT /clients/claude-code-acme/resources/${encodeURIComponent(acme)}`,
    ...[1, 2, 3, 4].map(() => `POST /organizations/${id.organizationId}/capabilities`), ...[1, 2].map(() => `POST /organizations/${id.organizationId}/entitlements`),
  ])
  expect(id.resourceOf(acme)).toMatchObject({ allowedScopes: ["acme:read", "acme:write", "offline_access"], accessTokenTtl: 900, clients: ["claude-code-acme"] })
  expect(id.entitlements(id.organizationId).map(row => [row.clientId, row.resource, row.scopes])).toEqual([["claude-code-acme", null, ["openid", "offline_access"]], ["claude-code-acme", acme, ["acme:read", "acme:write"]]])
  expect(lines(stdout())).toEqual([
    "ok      database   schemas acme; the database of the standalone server",
    "ok      standalone serving acme at http://localhost:47510/acme/mcp",
    "ok      register   http://localhost:47510/acme/mcp and claude-code-acme: 3 made, 0 changed, 0 found",
    "ok      access     organisation answerable: 6 made, 0 widened",
    "",
    "acme runs at http://localhost:47510/acme/mcp",
    "",
    "  claude mcp add --transport http acme http://localhost:47510/acme/mcp --client-id claude-code-acme --callback-port 47700",
    "",
    "In Claude Code, run /mcp, choose acme, then Authenticate.",
    "",
    "Ctrl-C stops the standalone server; an edit to acme reloads it.",
    "",
    "Stopping the standalone server.",
    "",
  ])
})

test("run again it writes nothing to ID: the registration and the access are found, and the printed commands are the same", async () => {
  const { id, stack } = await prepare("standalone")
  const first = await dev(stack)
  const written = writesTo(id).length
  const again = await dev(stack)
  expect(again.code).toBe(0)
  expect(writesTo(id)).toHaveLength(written)
  expect(lines(again.stdout()).slice(0, 4)).toEqual([
    "ok      database   schemas acme; the database of the standalone server",
    "ok      standalone serving acme at http://localhost:47510/acme/mcp",
    "ok      register   http://localhost:47510/acme/mcp and claude-code-acme: 0 made, 0 changed, 3 found",
    "ok      access     organisation answerable: already in place",
  ])
  expect(lines(again.stdout()).slice(4)).toEqual(lines(first.stdout()).slice(4))
})

test("an MCP that gained a scope since: its resource, client and the organisation's rows are widened, not made again, and nothing narrows what an organisation holds", async () => {
  const { id, stack } = await prepare("standalone", { scopes: ["acme:read"] })
  await dev(stack)
  await Bun.write(join(repository.root, "mcps/acme/manifest.json"), manifest(["acme:read", "acme:write"]))
  const written = writesTo(id).length
  const { code, stdout } = await dev(stack)
  expect(code).toBe(0)
  expect(lines(stdout()).slice(2, 4)).toEqual([
    "ok      register   http://localhost:47510/acme/mcp and claude-code-acme: 0 made, 2 changed, 1 found",
    "ok      access     organisation answerable: 0 made, 3 widened",
  ])
  expect(writesTo(id).slice(written).map(write => write.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>"))).toEqual([
    `PATCH /resources/${encodeURIComponent(acme)}`, "PATCH /clients/claude-code-acme",
    "PATCH /organizations/<id>/capabilities/<id>", "PATCH /organizations/<id>/capabilities/<id>", "PATCH /organizations/<id>/entitlements/<id>",
  ])
  expect(id.resourceOf(acme).allowedScopes).toEqual(["acme:read", "acme:write", "offline_access"])
  expect(id.capabilities(id.organizationId).filter(row => row.resource === acme).map(row => row.scopes)).toEqual([["acme:read", "acme:write"], ["acme:read", "acme:write"]])
  expect(id.entitlements(id.organizationId).find(row => row.resource === acme)!.scopes).toEqual(["acme:read", "acme:write"])
})

test("a Toolbox MCP: starts the Toolbox as mcp-dev, enables the MCP for the organisation through the Toolbox's admin API with mcp-dev's toolbox:admin token, grants its grant string, and says both are local conveniences", async () => {
  const { id, stack } = await prepare("toolbox")
  const before = writesTo(id).length
  const { code, stdout, stderr } = await dev(stack)
  expect([code, stderr()]).toEqual([0, ""])
  expect(stack.started).toHaveLength(1)
  expect(stack.started[0]).toMatchObject({ cwd: join(repository.root, "mcps/toolbox"), stopped: true })
  expect(stack.started[0]!.env).toMatchObject({ TOOLBOX_ID_CLIENT_ID: "mcp-dev", TOOLBOX_ID_CLIENT_SECRET: expect.stringMatching(/^secret-/) })
  expect(stack.enabled).toEqual([{ organisation: id.organizationId, body: { hostClientIds: ["claude-code-toolbox"], providers: ["acme"] } }])
  expect(writesTo(id).slice(before)).toEqual([`POST /organizations/${id.organizationId}/entitlements`])
  expect(id.entitlements(id.organizationId).map(row => [row.clientId, row.memberId, row.groupId, row.resource, row.scopes])).toEqual([[null, null, null, toolbox, ["acme"]]])
  expect(lines(stdout())).toEqual([
    "ok      database   schemas acme; the database of the Toolbox",
    "ok      toolbox    serving acme at http://localhost:47400/mcp",
    "ok      enable     organisation answerable: 2 rows made in ID and the catalogue; acme granted to the organisation",
    "",
    "acme runs in the Toolbox at http://localhost:47400/mcp, as the tools acme_*.",
    "",
    "  claude mcp add --transport http answerable-toolbox http://localhost:47400/mcp --client-id claude-code-toolbox --callback-port 47700",
    "",
    "In Claude Code, run /mcp, choose answerable-toolbox, then Authenticate.",
    "Enabling acme for organisation answerable and granting it to everyone there are local conveniences: in staging and production, staff do both (toolbox_enable and access_grant in the admin MCP).",
    "",
    "Ctrl-C stops the Toolbox; an edit to acme reloads it.",
    "",
    "Stopping the Toolbox.",
    "",
  ])
})

test("the organisation's entitlement on the Toolbox, which ID keeps one of, is widened with the MCP's grant string, not made twice; run again it writes nothing", async () => {
  const { id, stack } = await prepare("toolbox")
  const held = id.entitlement(id.organizationId, { resource: toolbox, scopes: ["beta"] })
  id.resourceOf(toolbox).allowedScopes.push("beta")
  await dev(stack)
  expect(id.entitlements(id.organizationId)).toHaveLength(1)
  expect(held).toMatchObject({ scopes: ["acme", "beta"], revision: 2 })
  const written = writesTo(id).length
  const again = await dev(stack)
  expect(writesTo(id)).toHaveLength(written)
  expect(lines(again.stdout())[2]).toBe("ok      enable     organisation answerable: 0 rows made in ID and the catalogue; acme was granted already")
})

test("a disabled organisation entitlement on the Toolbox stops the step, naming the row and the command that fixes it", async () => {
  const { id, stack } = await prepare("toolbox")
  const held = id.entitlement(id.organizationId, { resource: toolbox, scopes: ["acme"], status: "disabled" })
  const { code, stdout, stderr } = await dev(stack)
  expect(code).toBe(1)
  expect(lines(stdout()).slice(-3, -1)).toEqual(["ok      toolbox    serving acme at http://localhost:47400/mcp", "failed  enable    "])
  expect(stderr()).toBe(`enable failed: Answerable ID holds the organisation's entitlement on the Toolbox (${held.id}) with status disabled; enable it with access_enable in the admin MCP, then run bun mcp dev acme again\n\nFinish the job with:\n  bun mcp dev acme\n`)
  expect(stack.started.every(server => server.stopped)).toBe(true)
})

test("the Toolbox refusing the enable call, or ID refusing mcp-dev a token for the Toolbox's admin API, is a failed step with what each answered", async () => {
  const { stack } = await prepare("toolbox", { stack: { refuse: { status: 422, code: "unknown_host_client", message: "Answerable ID has no client claude-code-toolbox; register it first" } } })
  const refused = await dev(stack)
  expect([refused.code, refused.stderr().split("\n")[0]]).toEqual([1, "enable failed: the Toolbox answered 422 unknown_host_client: Answerable ID has no client claude-code-toolbox; register it first"])
  const { id, stack: other } = await prepare("toolbox")
  id.capabilities(id.organizationId).splice(id.capabilities(id.organizationId).findIndex(row => row.resource === "http://localhost:47400/admin"), 1)
  const noToken = await dev(other)
  expect([noToken.code, noToken.stderr().split("\n")[0]]).toEqual([1, "enable failed: ID refused mcp-dev a token for the Toolbox's admin API, which needs toolbox:admin: run bun mcp setup again"])
})

test("an MCP served both ways starts the Toolbox and the standalone server, prints both ways in, and stops them last started first", async () => {
  const { stack } = await prepare("both")
  const { code, stdout } = await dev(stack)
  expect(code).toBe(0)
  expect(stack.started.map(server => server.cwd.split("/").slice(-2).join("/"))).toEqual(["mcps/toolbox", "mcps/standalone"])
  expect(lines(stdout()).filter(line => line.startsWith("ok")).map(line => line.split(/ +/)[1])).toEqual(definitions.dev.steps.map(step => step.name))
  expect(stdout()).toContain("acme runs in the Toolbox at http://localhost:47400/mcp, as the tools acme_*.")
  expect(stdout()).toContain("acme runs at http://localhost:47510/acme/mcp")
  expect(stdout()).toContain("Ctrl-C stops the Toolbox and the standalone server; an edit to acme reloads them.")
  expect(stdout()).toEndWith("Stopping the Toolbox and the standalone server.\n")
})

test("from inside the MCP's directory it needs no name", async () => {
  const { stack } = await prepare("standalone")
  const { code, stdout } = await dev(stack, [], { cwd: join(repository.root, "mcps/acme") })
  expect(code).toBe(0)
  expect(stdout()).toContain("acme runs at http://localhost:47510/acme/mcp")
})

const refused = async (run: { finished: Promise<number>; stderr: () => string; stdout: () => string }) => ({ code: await run.finished, stdout: run.stdout(), stderr: run.stderr() })

test("without bun mcp setup, with ID down, with Postgres down and with both ports taken it refuses once, listing every problem each with its command, and starts nothing", async () => {
  repository = await tempRepository({ "mcps/acme/mcp.json": JSON.stringify({ name: "acme", serve: "both", database: "shared" }), "mcps/acme/manifest.json": manifest(["acme:read", "acme:write"]) })
  const id = localId()
  id.unreachable(true)
  const stack = localStack(id)
  const { code, stdout, stderr } = await refused(start(stack, ["acme"], { listening: async (_host, port) => port === 47400 || port === 47510 }))
  expect([code, stdout]).toEqual([2, ""])
  expect(stderr.split("\n")).toEqual([
    "bun mcp setup has not run: MCP_DEV_ID_CLIENT_ID and MCP_DEV_ID_CLIENT_SECRET are not in .env. Run bun mcp setup",
    "Answerable ID does not answer on http://localhost:47300. Start it from the main checkout with bun dev, or with bun --filter @answerable/id dev; never bun dev from a worktree, where it runs env:up and recreates the shared Postgres",
    "The development Postgres does not answer on localhost:47432. Start it from the main checkout with bun run env:up; never from a worktree, where it recreates the running one",
    "Port 47400 is taken, and the Toolbox needs it: stop what listens there (lsof -nP -iTCP:47400 -sTCP:LISTEN names it)",
    "Port 47510 is taken, and the standalone server needs it: stop what listens there (lsof -nP -iTCP:47510 -sTCP:LISTEN names it)",
    "",
    "  bun mcp dev acme",
    "",
  ])
  expect(stack.started).toEqual([])
})

test("credentials ID refuses, as after a reset of its database, and an organisation ID does not hold, are refused with the command that fixes each", async () => {
  const { stack } = await prepare("standalone")
  const env = await Bun.file(join(repository.root, ".env")).text()
  await Bun.write(join(repository.root, ".env"), `${env}MCP_DEV_ORGANISATION=nobody\n`)
  expect(await refused(start(stack))).toEqual({ code: 2, stdout: "", stderr: "Answerable ID has no organisation nobody. Run bun mcp setup --organisation <slug> with the slug of yours\n\n  bun mcp dev acme\n" })
  await Bun.write(join(repository.root, ".env"), "MCP_DEV_ID_CLIENT_ID=mcp-dev\nMCP_DEV_ID_CLIENT_SECRET=from-the-old-database\n")
  expect(await refused(start(stack))).toEqual({ code: 2, stdout: "", stderr: "ID refused the credentials of mcp-dev in .env, as after a reset of its database. Run bun mcp setup again\n\n  bun mcp dev acme\n" })
})

test("a standalone MCP whose manifest is not written yet is refused, since its scopes in ID come from it; a Toolbox MCP needs none", async () => {
  const { stack } = await prepare("standalone")
  await rm(join(repository.root, "mcps/acme/manifest.json"))
  expect(await refused(start(stack))).toEqual({ code: 2, stdout: "", stderr: "mcps/acme/manifest.json does not exist, and the MCP's scopes in ID come from it. Run bun mcp check acme\n\n  bun mcp dev acme\n" })
  const toolboxed = await prepare("toolbox")
  await rm(join(repository.root, "mcps/acme/manifest.json"))
  expect((await dev(toolboxed.stack)).code).toBe(0)
})

test.each([
  [["acme", "beta"], "bun mcp dev takes one MCP; it was given acme, beta"],
  [["nobody"], "No MCP is named nobody: mcps/nobody/mcp.json does not exist; bun mcp list names every MCP"],
  [[], "Name the MCP, or run the command from inside mcps/<name>"],
])("refuses %j", async (argv, message) => {
  const { stack } = await prepare("standalone")
  const { code, stderr } = await refused(start(stack, argv))
  expect([code, stderr.split("\n")[0]]).toEqual([2, message])
})

test("a server that stops before it lists the MCP is a failed step naming its exit code; what started is stopped and the command to run again is given", async () => {
  const { stack } = await prepare("both", { stack: { end: (_command, cwd) => (cwd.endsWith("mcps/standalone") ? 1 : undefined) } })
  const { code, stdout, stderr } = await dev(stack)
  expect(code).toBe(1)
  expect(lines(stdout())).toEqual(["ok      database   schemas acme; the databases of the Toolbox and the standalone server", "ok      toolbox    serving acme at http://localhost:47400/mcp", "failed  standalone", ""])
  expect(stderr()).toBe("standalone failed: the standalone server stopped with exit code 1 before http://localhost:47510/health listed acme; its output above says why\n\nFinish the job with:\n  bun mcp dev acme\n")
  expect(stack.started.map(server => server.stopped)).toEqual([true, true])
})

test("a server that stops while running ends the command with exit 1, naming it, and stops the other", async () => {
  const { stack } = await prepare("both")
  const running = start(stack)
  await running.printed()
  stack.started[1]!.exit(70)
  expect(await running.finished).toBe(1)
  expect(running.stderr()).toBe("\nthe standalone server stopped with exit code 70; its output above says why. Run bun mcp dev acme again.\n")
  expect(stack.started.map(server => server.stopped)).toEqual([true, true])
})

test("a migration that fails, of the MCP or of a server's database, is a failed step with the output's end and the command to run again; nothing is started", async () => {
  const { stack } = await prepare("standalone")
  const { code, stderr } = await dev(stack, ["acme"], { answer: () => ({ code: 1, output: "the development Postgres does not answer\n" }) })
  expect([code, stderr()]).toEqual([1, "database failed: the development Postgres does not answer\n\nFinish the job with:\n  bun mcp dev acme\n"])
  const hub = await dev(stack, ["acme"], { answer: command => (command.includes("db:migrate") ? { code: 1, output: "role answerable_standalone_owner does not exist\n" } : { code: 0, output: "" }) })
  expect([hub.code, hub.stderr().split("\n")[0]]).toEqual([1, "database failed: role answerable_standalone_owner does not exist"])
  expect(stack.started).toEqual([])
})

test("every MCP the started servers mount is migrated, the MCP's own and the others', and no other: the Toolbox's and the standalone server's lists differ", async () => {
  repository = await tempRepository({
    "mcps/acme/mcp.json": JSON.stringify({ name: "acme", serve: "standalone", database: "shared" }), "mcps/acme/manifest.json": manifest(["acme:read", "acme:write"]),
    "mcps/beta/mcp.json": JSON.stringify({ name: "beta", serve: "toolbox", database: "shared" }),
    "mcps/gamma/mcp.json": JSON.stringify({ name: "gamma", serve: "both", database: "own" }), "mcps/gamma/manifest.json": manifest(["gamma:read"]),
  })
  const id = localId()
  const stack = localStack(id, { mounted: ["acme", "beta", "gamma"] })
  expect(await main(testIo(["setup"], repository.root, { fetch: stack.fetch }).io)).toBe(0)
  const migrated = (ran: { command: string[]; cwd: string }[]) => ran.map(({ command, cwd }) => (command.includes("db:migrate") ? cwd.split("/").slice(-2).join("/") : command.at(-2)))
  const standalone = await dev(stack, ["acme"])
  expect([standalone.code, migrated(standalone.ran)]).toEqual([0, ["acme", "gamma", "mcps/standalone"]])
  expect(lines(standalone.stdout())[0]).toBe("ok      database   schemas acme and gamma; the database of the standalone server")
  const toolbox = await dev(stack, ["beta"])
  expect([toolbox.code, migrated(toolbox.ran)]).toEqual([0, ["beta", "gamma", "mcps/toolbox"]])
  const both = await dev(stack, ["gamma"])
  expect([both.code, migrated(both.ran)]).toEqual([0, ["acme", "beta", "gamma", "mcps/toolbox", "mcps/standalone"]])
  expect(lines(both.stdout())[0]).toBe("ok      database   schemas acme, beta and gamma; the databases of the Toolbox and the standalone server")
})

test("a row ID holds that does not fit, such as a disabled entitlement, stops the access step with ID's words and the command to run again", async () => {
  const { id, stack } = await prepare("standalone")
  const row = id.entitlement(id.organizationId, { clientId: "claude-code-acme", scopes: ["openid", "offline_access"], status: "disabled" })
  const { code, stderr } = await dev(stack)
  expect(code).toBe(1)
  expect(stderr()).toBe(`access failed: Answerable ID already holds the login entitlement of claude-code-acme (${row.id}) with status disabled and scopes openid offline_access; enable it, then run bun mcp dev acme again\n\nFinish the job with:\n  bun mcp dev acme\n`)
})

test("a Ctrl-C that came before the servers were up still ends the command, stopping what started", async () => {
  const { stack } = await prepare("standalone")
  const controller = new AbortController()
  controller.abort()
  const io = testIo(["dev", "acme"], repository.root, { fetch: stack.fetch, start: stack.start, listening: async (_host, port) => port === 47432, signal: controller.signal, exec: recorder().exec })
  expect(await main(io.io)).toBe(0)
  expect(stack.started.map(server => server.stopped)).toEqual([true])
})
