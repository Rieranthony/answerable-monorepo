import { afterAll, expect, test } from "bun:test"
import { createFakeId } from "@answerable/id-admin/testing"
import { runtimeGrants } from "@answerable/mcp-postgres"
import { testSharedMcps } from "@answerable/mcp-platform/testing"
import { served } from "./served.generated"
import { database } from "./test/database"

const directory = new URL("../", import.meta.url).pathname
// The served MCPs' database as the entry point needs it: a serving login with exactly their roles.
const mcps = await testSharedMcps({ name: "answerable_standalone_test_served", prefix: "mcp_sts", mcps: served.map(({ provider }) => provider) })
afterAll(() => mcps.close())

// The entry point on a free port against `databaseUrl`, with a fake ID served over HTTP, as it would reach the real one.
function start(databaseUrl: string, overrides: Record<string, string> = {}) {
  const fake = createFakeId({ clientId: "standalone-hub" })
  const id = Bun.serve({ port: 0, fetch: request => fake.config.fetch(request) })
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const env = {
    ...process.env, STANDALONE_DATABASE_URL: databaseUrl, STANDALONE_MCPS_DATABASE_URL: mcps.url, STANDALONE_MCPS_ROLE_PREFIX: "mcp_sts", STANDALONE_ORIGIN: origin,
    STANDALONE_ID_ISSUER: `http://127.0.0.1:${id.port}`, STANDALONE_PORT: String(port), STANDALONE_ID_CLIENT_ID: "standalone-hub",
    STANDALONE_ID_CLIENT_SECRET: fake.config.clientSecret, STANDALONE_ID_ADMIN_RESOURCE: fake.config.adminResource, ...overrides,
  }
  const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
  return { origin, server, stop: () => { server.kill(); id.stop(true) } }
}

test("the entry point serves each MCP at its path as the runtime login, answers /health with them and stops on SIGTERM", async () => {
  const login = await database.runtimeLogin(runtimeGrants)
  const { origin, server, stop } = start(login.url)
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toBe(`Standalone server serving ${served.map(({ provider }) => `${origin}/${provider.id}/mcp`).join(", ")}\n`)
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ status: "ok", databases: { standalone: "ok", mcps: "ok" }, providers: served.map(({ provider }) => provider.id) })
    expect((await (await fetch(`${origin}/.well-known/oauth-protected-resource/e2e/mcp`)).json()).resource).toBe(`${origin}/e2e/mcp`)
    server.kill("SIGTERM")
    expect(await server.exited).toBe(0)
  } finally {
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
