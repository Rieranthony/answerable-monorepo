import { expect, test } from "bun:test"
import { runtimeGrants } from "./db/migrate"
import { database } from "./test/database"
import { mounted } from "./mounted.generated"
import { databases, healthy, ownUrls, prefix } from "./test/mcps"

const directory = new URL("../", import.meta.url).pathname
// The mounted MCPs' databases as the suite serves them, with the shared one's role prefix.
const mcps = { TOOLBOX_MCPS_DATABASE_URL: databases.url, TOOLBOX_MCPS_ROLE_PREFIX: prefix, ...ownUrls }

// The entry point on a free port against `databaseUrl`, under `bun --hot` as `bun run toolbox:dev` runs it when `hot`. ID is not there: the poller
// logs that it failed, and nothing here reads grants.
function start(databaseUrl: string, overrides: Record<string, string> = {}, hot = false) {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const id = "http://127.0.0.1:1"
  const env = {
    ...process.env, ...mcps, TOOLBOX_DATABASE_URL: databaseUrl, TOOLBOX_ID_ISSUER: id, TOOLBOX_RESOURCE_URL: `${origin}/mcp`, TOOLBOX_STANDALONE_ORIGIN: origin,
    TOOLBOX_PORT: String(port), TOOLBOX_ID_CLIENT_ID: "toolbox-hub", TOOLBOX_ID_CLIENT_SECRET: "secret", TOOLBOX_ID_ADMIN_RESOURCE: `${id}/api/admin`, ...overrides,
  }
  const server = Bun.spawn([process.execPath, ...(hot ? ["--hot"] : []), "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
  return { origin, server }
}

test("the entry point serves as the runtime login the hub and each MCP served alone at its path, answers /health with every MCP and exits on SIGTERM, even under bun --hot", async () => {
  const login = await database.runtimeLogin(runtimeGrants)
  const { origin, server } = start(login.url, {}, true)
  try {
    const alone = mounted.filter(({ serve }) => serve !== "toolbox").map(({ provider }) => provider.id)
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toBe(`Toolbox serving ${[`${origin}/mcp`, ...alone.map(name => `${origin}/${name}/mcp`)].join(", ")}\n`)
    expect(await (await fetch(`${origin}/health`)).json()).toEqual(healthy)
    for (const name of alone) expect((await (await fetch(`${origin}/.well-known/oauth-protected-resource/${name}/mcp`)).json()).resource).toBe(`${origin}/${name}/mcp`)
    server.kill("SIGTERM")
    // bun --hot keeps a process alive once its server stops, watching for changes: the entry point ends it.
    expect(await Promise.race([server.exited, Bun.sleep(5000).then(() => "still running")])).toBe(0)
  } finally {
    // SIGKILL, which a process left alive by bun --hot does not outlive.
    server.kill("SIGKILL")
    await server.exited
    await login.drop()
  }
}, 30_000)

test("the entry point refuses the owner's login before it listens, naming what makes it unsafe", async () => {
  const { server } = start(database.url)
  try {
    expect(await server.exited).toBe(1)
    expect(await new Response(server.stdout).text()).toBe("")
    expect(await new Response(server.stderr).text()).toStartWith("The Toolbox cannot start: Database role answerable is not a restricted runtime role: has SUPERUSER;")
  } finally {
    server.kill()
  }
}, 30_000)

test("the entry point listens on TOOLBOX_HOST", async () => {
  const login = await database.runtimeLogin(runtimeGrants)
  const probe = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const id = "http://127.0.0.1:1"
  const env = {
    ...process.env, ...mcps, TOOLBOX_DATABASE_URL: login.url, TOOLBOX_ID_ISSUER: id, TOOLBOX_RESOURCE_URL: `http://[::1]:${port}/mcp`, TOOLBOX_STANDALONE_ORIGIN: `http://[::1]:${port}`, TOOLBOX_PORT: String(port),
    TOOLBOX_HOST: "::1", TOOLBOX_ID_CLIENT_ID: "toolbox-hub", TOOLBOX_ID_CLIENT_SECRET: "secret", TOOLBOX_ID_ADMIN_RESOURCE: `${id}/api/admin`,
  }
  const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "ignore" })
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toContain("Toolbox serving")
    expect(await (await fetch(`http://[::1]:${port}/health`)).json()).toMatchObject({ status: "ok" })
    // Bound to the IPv6 loopback only, so nothing listens on the IPv4 loopback's port.
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  } finally {
    server.kill()
    await server.exited
    await login.drop()
  }
}, 30_000)

test("the entry point refuses a serving login that cannot take a mounted MCP's role, naming it, before it listens", async () => {
  const login = await database.runtimeLogin(runtimeGrants)
  const { server } = start(login.url, { TOOLBOX_MCPS_ROLE_PREFIX: "mcp_tbxnone" })
  try {
    expect(await server.exited).toBe(1)
    expect(await new Response(server.stderr).text()).toContain("is not a member of mcp_tbxnone_e2e")
  } finally {
    server.kill()
    await login.drop()
  }
}, 30_000)
