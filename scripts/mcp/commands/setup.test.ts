import { afterEach, beforeEach, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { parseEnv } from "node:util"
import { main } from "../cli"
import { onboarding } from "./setup"
import { tempRepository, testIo } from "../test/io"
import { isolateEnvironment, localId, writesTo, type LocalId } from "../test/id"

isolateEnvironment()
let repository: Awaited<ReturnType<typeof tempRepository>>
beforeEach(async () => { repository = await tempRepository() })
afterEach(() => repository.remove())

const lines = (text: string) => text.split("\n").map(line => line.replace(/ \(\d+(\.\d+)? m?s\)$/, ""))
const env = async () => parseEnv(await Bun.file(join(repository.root, ".env")).text())
const run = async (id: LocalId, argv: string[] = [], options: Omit<NonNullable<Parameters<typeof testIo>[2]>, "fetch"> & { fetch?: typeof fetch } = {}) => {
  const io = testIo(["setup", ...argv], repository.root, { fetch: id.config.fetch, ...options })
  return { ...io, code: await main(io.io) }
}
const platform = (id: LocalId) => id.organizationId

test("with the root secret unlocked it makes mcp-dev, the Toolbox's registrations and its capabilities, writes the id and secret to .env, and never prints the secret", async () => {
  const id = localId()
  const { code, stdout, stderr } = await run(id)
  expect([code, stderr()]).toEqual([0, ""])
  const { MCP_DEV_ID_CLIENT_SECRET: secret, ...rest } = await env()
  expect(rest).toEqual({ MCP_DEV_ID_CLIENT_ID: "mcp-dev", MCP_DEV_ORGANISATION: "answerable" })
  expect(lines(stdout())).toEqual([
    "ok      toolbox    http://localhost:47400/mcp, its admin resource and claude-code-toolbox: 3 made, 0 changed, 0 found",
    "ok      client     mcp-dev made: platform:read platform:write on ID, toolbox:admin on the Toolbox",
    "ok      env        MCP_DEV_ID_CLIENT_ID, MCP_DEV_ID_CLIENT_SECRET and MCP_DEV_ORGANISATION=answerable written to .env",
    "",
    "Next:",
    "  bun mcp list",
    "  bun mcp dev <mcp>",
    "",
  ])
  expect(stdout()).not.toContain(secret!)
  expect((await stat(join(repository.root, ".env"))).mode & 0o777).toBe(0o600)
  expect(writesTo(id)).toEqual([
    "POST /resources", "POST /resources", "POST /clients", "POST /clients",
    `PUT /clients/mcp-dev/resources/${encodeURIComponent("http://localhost:47300/api/admin")}`, `POST /organizations/${platform(id)}/capabilities`,
    `PUT /clients/mcp-dev/resources/${encodeURIComponent("http://localhost:47400/admin")}`, `POST /organizations/${platform(id)}/capabilities`,
  ])
  expect(id.resourceOf("http://localhost:47400/admin")).toMatchObject({ allowedScopes: ["toolbox:admin"], accessTokenTtl: 300, clients: ["mcp-dev"] })
  expect(id.resourceOf("http://localhost:47400/mcp")).toMatchObject({ allowedScopes: ["offline_access", "toolbox"], accessTokenTtl: 900 })
  expect(id.capabilities(platform(id)).map(row => [row.clientId, row.resource, row.grantKind, row.scopes])).toEqual([
    ["mcp-dev", "http://localhost:47300/api/admin", "client_credentials", ["platform:read", "platform:write"]],
    ["mcp-dev", "http://localhost:47400/admin", "client_credentials", ["toolbox:admin"]],
  ])
  // The secret works: ID issues mcp-dev a token for each audience.
  for (const [resource, scope] of [["http://localhost:47300/api/admin", "platform:read platform:write"], ["http://localhost:47400/admin", "toolbox:admin"]]) {
    const answer = await id.config.fetch("http://localhost:47300/auth/oauth2/token", {
      method: "POST", headers: { Authorization: `Basic ${btoa(`mcp-dev:${secret}`)}` }, body: new URLSearchParams({ grant_type: "client_credentials", resource: resource!, scope: scope! }),
    })
    expect(answer.status, resource).toBe(200)
  }
})

test("run again it finds mcp-dev working, writes nothing to ID or to .env, and says so", async () => {
  const id = localId()
  await run(id)
  const [before, written] = [await Bun.file(join(repository.root, ".env")).text(), id.received.length]
  const again = await run(id)
  expect([again.code, lines(again.stdout())]).toEqual([0, ["ok      client     mcp-dev works: ID accepts its credentials in .env; nothing to do", "", "Next:", "  bun mcp dev <mcp>", ""]])
  expect(writesTo(id).length).toBe(8)
  expect(id.received.slice(written).every(({ request }) => request.startsWith("GET"))).toBe(true)
  expect(await Bun.file(join(repository.root, ".env")).text()).toBe(before)
})

test("--organisation stores another organisation's slug, and run again it changes only that line; an organisation ID does not hold is refused", async () => {
  const id = localId()
  id.organisation(Bun.randomUUIDv7(), { slug: "acme", name: "Acme" })
  await Bun.write(join(repository.root, ".env"), "# kept\nOTHER=1\nMCP_DEV_ORGANISATION=\n")
  expect((await run(id, ["--organisation", "acme"])).code).toBe(0)
  const first = await env()
  expect(first).toMatchObject({ OTHER: "1", MCP_DEV_ORGANISATION: "acme", MCP_DEV_ID_CLIENT_ID: "mcp-dev" })
  expect((await Bun.file(join(repository.root, ".env")).text()).startsWith("# kept\nOTHER=1\nMCP_DEV_ORGANISATION=acme\n")).toBe(true)
  const writes = writesTo(id).length
  const back = await run(id, ["--organisation", "answerable"])
  expect([back.code, lines(back.stdout()).slice(0, 2)]).toEqual([0, ["ok      client     mcp-dev works: ID accepts its credentials in .env; nothing to do", "ok      env        MCP_DEV_ORGANISATION=answerable written to .env"]])
  expect(await env()).toEqual({ ...first, MCP_DEV_ORGANISATION: "answerable" })
  expect(writesTo(id)).toHaveLength(writes)
  for (const argv of [["--organisation", "nobody"], ["--organisation", "Bad Slug"]]) {
    const refused = await run(id, argv)
    expect(refused.code).toBe(2)
  }
  expect((await run(id, ["--organisation", "nobody"])).stderr()).toBe("Answerable ID has no organisation nobody; pass its slug with --organisation, or leave it out for answerable\n\n  bun mcp setup [--organisation <slug>] [--staff-token <token>] [--json]\n")
  expect((await run(id, ["--organisation", "Bad Slug"])).stderr()).toStartWith("--organisation Bad Slug is not an organisation's slug: lowercase letters and digits, words joined by single hyphens")
  // Before ID holds mcp-dev, an organisation it lacks is refused too, and nothing is written.
  const fresh = localId()
  expect((await run(fresh, ["--organisation", "nobody"])).code).toBe(2)
  expect(writesTo(fresh)).toEqual([])
})

test("a client that exists while .env holds no secret is given a new one, and the old secret stops working", async () => {
  const id = localId()
  await run(id)
  const old = (await env()).MCP_DEV_ID_CLIENT_SECRET!
  await Bun.write(join(repository.root, ".env"), "")
  const { code, stdout } = await run(id)
  expect([code, lines(stdout())[1]]).toEqual([0, "ok      client     mcp-dev found, with a new secret: platform:read platform:write on ID, toolbox:admin on the Toolbox"])
  const fresh = (await env()).MCP_DEV_ID_CLIENT_SECRET!
  expect(fresh).not.toBe(old)
  const token = (secret: string) => id.config.fetch("http://localhost:47300/auth/oauth2/token", {
    method: "POST", headers: { Authorization: `Basic ${btoa(`mcp-dev:${secret}`)}` }, body: new URLSearchParams({ grant_type: "client_credentials", resource: "http://localhost:47300/api/admin", scope: "platform:read" }),
  })
  expect([(await token(old)).status, (await token(fresh)).status]).toEqual([401, 200])
})

test("credentials ID refuses, as after a reset of its database, are replaced by a new client", async () => {
  await Bun.write(join(repository.root, ".env"), "MCP_DEV_ID_CLIENT_ID=mcp-dev\nMCP_DEV_ID_CLIENT_SECRET=from-the-old-database\n")
  const id = localId()
  const { code, stdout } = await run(id)
  expect([code, lines(stdout())[1]]).toEqual([0, "ok      client     mcp-dev made: platform:read platform:write on ID, toolbox:admin on the Toolbox"])
  expect((await env()).MCP_DEV_ID_CLIENT_SECRET).not.toBe("from-the-old-database")
})

test("with the root secret locked, a terminal is asked once for a staff token, which is not echoed or stored; ID refusing it, or a cancel, writes nothing", async () => {
  const id = localId()
  id.lockRoot(true)
  id.staffToken("staff-token")
  const { code, stdout, asked } = await run(id, [], { isTTY: true, answers: ["", "staff-token"] })
  expect(code).toBe(0)
  expect(asked).toEqual([{ kind: "password", refused: ["A staff token is required"], message: `ID's root secret is locked: a person is a platform administrator, so bun mcp setup needs a staff token. Paste one (get it at ${onboarding}); it is not shown or stored` }])
  expect(stdout()).not.toContain("staff-token")
  expect(await env()).toMatchObject({ MCP_DEV_ID_CLIENT_ID: "mcp-dev" })
  expect(JSON.stringify(await env())).not.toContain("staff-token")
  await repository.remove()
  repository = await tempRepository()
  const refused = await run(id, [], { isTTY: true, answers: ["wrong-token"] })
  expect([refused.code, refused.stderr()]).toEqual([2, `ID refused the staff token; get another (${onboarding})\n\n  bun mcp setup --staff-token <token>\n`])
  const cancelled = await run(id, [], { isTTY: true, answers: [Symbol("cancel")] })
  expect([cancelled.code, cancelled.stderr()]).toEqual([2, "Cancelled: nothing was written\n\n  bun mcp setup\n"])
  expect(await Bun.file(join(repository.root, ".env")).exists()).toBe(false)
})

test("with the root secret locked and no terminal it exits 2 with the exact flag and the page that says where to get a staff token, writing nothing", async () => {
  const id = localId()
  id.lockRoot(true)
  const { code, stderr, stdout } = await run(id)
  expect([code, stdout()]).toEqual([2, ""])
  expect(stderr()).toBe(`ID's root secret is locked: a person is a platform administrator, so bun mcp setup needs a staff token: pass it with --staff-token (get one at ${onboarding})\n\n  bun mcp setup --staff-token <token>\n`)
  expect(writesTo(id)).toEqual([])
  const json = JSON.parse((await run(id, ["--json"])).stdout())
  expect(json).toEqual({ ok: false, error: { code: "staff-token-required", message: expect.stringContaining("--staff-token"), fix: "bun mcp setup --staff-token <token>", problems: [expect.objectContaining({ code: "staff-token-required" })] } })
})

test("--staff-token is used instead of the root secret, even while root is unlocked; ID refusing it is refused with the page", async () => {
  const id = localId()
  id.staffToken("staff-token")
  const { code } = await run(id, ["--staff-token", "staff-token"])
  expect(code).toBe(0)
  expect(id.received.filter(({ request }) => request.startsWith("POST")).length).toBeGreaterThan(0)
  const other = localId()
  const refused = await run(other, ["--staff-token", "wrong"])
  expect([refused.code, refused.stderr()]).toEqual([2, `ID refused the staff token; get another (${onboarding})\n\n  bun mcp setup --staff-token <token>\n`])
})

test("a root secret in .env that ID does not hold is treated as a locked root: a staff token is asked for", async () => {
  await Bun.write(join(repository.root, ".env"), `ROOT_ADMIN_SECRET=${"x".repeat(40)}\n`)
  const { code, stderr } = await run(localId())
  expect(code).toBe(2)
  expect(stderr()).toStartWith("ID refused ROOT_ADMIN_SECRET, so bun mcp setup needs a staff token: pass it with --staff-token")
})

test("it refuses when ID does not answer, naming where to start it and never bun dev from a worktree; and when ID has no platform organisation", async () => {
  const id = localId()
  id.unreachable(true)
  const { code, stderr } = await run(id)
  expect([code, stderr()]).toEqual([2, `Answerable ID does not answer on http://localhost:47300. Start it from the main checkout with bun dev, or with bun --filter @answerable/id dev; never bun dev from a worktree, where it runs env:up and recreates the shared Postgres. Then run bun mcp setup again\n\n  bun --filter @answerable/id dev\n`])
  expect((await run(localId(), [], { fetch: undefined })).stderr()).toStartWith("Answerable ID does not answer")
  const missing = await run(localId({ platform: false }))
  expect([missing.code, missing.stderr()]).toEqual([2, "Answerable ID has no organisation answerable, which it makes at its first start: start it once, then run bun mcp setup again\n\n  bun mcp setup\n"])
})

test("a read ID answers with an error is a failure, not a refusal", async () => {
  const id = localId()
  const broken = ((input: string | URL | Request, init?: RequestInit) => (String(input).includes("/organizations") ? Promise.resolve(new Response("{}", { status: 500 })) : id.config.fetch(input, init))) as typeof fetch
  const { code, stderr } = await run(id, [], { fetch: broken })
  expect([code, stderr()]).toEqual([1, "bun mcp failed: GET /organizations answered 500\n\n  bun mcp help\n"])
})

test("a flag it does not know, an argument, and an invalid variable in .env are refused naming what to do", async () => {
  expect((await run(localId(), ["acme"])).stderr()).toBe("bun mcp setup takes no argument; it was given acme\n\n  bun mcp setup [--organisation <slug>] [--staff-token <token>] [--json]\n")
  await Bun.write(join(repository.root, ".env"), "MCP_DEV_ORGANISATION=Not A Slug\n")
  const { code, stderr } = await run(localId())
  expect([code, stderr().split("\n")[0]]).toEqual([2, `Invalid bun mcp configuration: MCP_DEV_ORGANISATION: an organisation's slug: lowercase letters and digits, words joined by single hyphens; fix it in ${join(repository.root, ".env")}`])
})
