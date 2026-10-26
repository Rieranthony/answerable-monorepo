import { afterAll, expect, test } from "bun:test"
import { createFakeId } from "@answerable/id-admin/testing"
import { runtimeGrants } from "@answerable/mcp-postgres"
import { type Declared } from "@answerable/mcp-platform"
import { testOwnMcp, testSharedMcps } from "@answerable/mcp-platform/testing"
import { served } from "./served.generated"
import { database } from "./test/database"

const directory = new URL("../", import.meta.url).pathname
// The served MCPs' databases as the entry point needs them, read from the generated list so that a new MCP needs no edit here: the shared ones
// through a serving login with exactly their roles, and each own one in a database of its own, as its runtime login.
const mcps = await testSharedMcps({ name: "answerable_standalone_test_served", prefix: "mcp_sts", mcps: served.filter(entry => entry.database === "shared").map(({ provider }) => provider) })
const owned = await Promise.all(served.filter((entry): entry is Extract<Declared, { database: "own" }> => entry.database === "own")
  .map(async entry => ({ entry, database: await testOwnMcp({ name: `answerable_standalone_test_${entry.provider.id}`, provider: entry.provider }) })))
const ownUrls = Object.fromEntries(owned.map(({ entry, database }) => [entry.variable, database.url]))
afterAll(async () => {
  await mcps.close()
  await Promise.all(owned.map(({ database }) => database.close()))
})

// The entry point on a free port against `databaseUrl`, with a fake ID served over HTTP, as it would reach the real one; under `bun --hot`, as
// `bun run standalone:dev` runs it, when `hot`.
function start(databaseUrl: string, overrides: Record<string, string> = {}, hot = false) {
  const fake = createFakeId({ clientId: "standalone-hub" })
  const id = Bun.serve({ port: 0, fetch: request => fake.config.fetch(request) })
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const env = {
    ...process.env, STANDALONE_DATABASE_URL: databaseUrl, STANDALONE_MCPS_DATABASE_URL: mcps.url, STANDALONE_MCPS_ROLE_PREFIX: "mcp_sts", STANDALONE_ORIGIN: origin,
    STANDALONE_ID_ISSUER: `http://127.0.0.1:${id.port}`, STANDALONE_PORT: String(port), STANDALONE_ID_CLIENT_ID: "standalone-hub",
    STANDALONE_ID_CLIENT_SECRET: fake.config.clientSecret, STANDALONE_ID_ADMIN_RESOURCE: fake.config.adminResource, ...ownUrls, ...overrides,
  }
  const server = Bun.spawn([process.execPath, ...(hot ? ["--hot"] : []), "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
  return { origin, server, stop: () => { server.kill(); id.stop(true) } }
}

test("the entry point serves each MCP at its path as the runtime login, answers /health with them and exits on SIGTERM, even under bun --hot", async () => {
  const login = await database.runtimeLogin(runtimeGrants)
  const { origin, server, stop } = start(login.url, {}, true)
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toBe(`Standalone server serving ${served.map(({ provider }) => `${origin}/${provider.id}/mcp`).join(", ")}\n`)
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({
      status: "ok", databases: Object.fromEntries([["standalone", "ok"], ["mcps", "ok"], ...owned.map(({ entry }) => [entry.provider.id, "ok"])]),
      providers: served.map(({ provider }) => provider.id),
    })
    expect((await (await fetch(`${origin}/.well-known/oauth-protected-resource/e2e/mcp`)).json()).resource).toBe(`${origin}/e2e/mcp`)
    server.kill("SIGTERM")
    // bun --hot keeps a process alive once its server stops, watching for changes: the entry point ends it.
    expect(await Promise.race([server.exited, Bun.sleep(5000).then(() => "still running")])).toBe(0)
  } finally {
    // SIGKILL first, which a process left alive by bun --hot does not outlive.
    server.kill("SIGKILL")
    stop()
    await server.exited
    await login.drop()
  }
}, 30_000)

test("the entry point refuses the owner's login, and a serving login without a served MCP's role, before it listens, naming why", async () => {
  for (const [databaseUrl, overrides, reason] of [
    [database.url, {}, "Database role answerable is not a restricted runtime role: has SUPERUSER;"],
    [undefined, { STANDALONE_MCPS_ROLE_PREFIX: "mcp_stsnone" }, "is not a member of mcp_stsnone_e2e"],
  ] as const) {
    const login = databaseUrl ? undefined : await database.runtimeLogin(runtimeGrants)
    const { server, stop } = start(databaseUrl ?? login!.url, overrides)
    try {
      expect(await server.exited).toBe(1)
      expect(await new Response(server.stdout).text()).toBe("")
      const said = await new Response(server.stderr).text()
      expect(said).toStartWith("The standalone server cannot start: ")
      expect(said).toContain(reason)
    } finally {
      stop()
      await login?.drop()
    }
  }
}, 30_000)
