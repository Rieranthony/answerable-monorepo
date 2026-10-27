import { expect, test } from "bun:test"
import { createFakeId } from "@answerable/id-admin/testing"
import { runtimeGrants } from "@answerable/mcp-postgres"
import { database } from "./test/database"

const directory = new URL("../", import.meta.url).pathname

// The entry point against a fake ID served over HTTP, as it would reach the real one, and against `databaseUrl`; under `bun --hot`, as
// `bun run admin:dev` runs it, when `hot`.
function start(databaseUrl: string, hot = false) {
  const fake = createFakeId({ clientId: "admin-mcp" })
  const id = Bun.serve({ port: 0, fetch: request => fake.config.fetch(request) })
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const env = {
    ...process.env, ADMIN_DATABASE_URL: databaseUrl, ADMIN_ID_ISSUER: `http://127.0.0.1:${id.port}`, ADMIN_RESOURCE_URL: `${origin}/mcp`, ADMIN_PORT: String(port),
    ADMIN_ID_CLIENT_ID: "admin-mcp", ADMIN_ID_CLIENT_SECRET: fake.config.clientSecret, ADMIN_ID_ADMIN_RESOURCE: fake.config.adminResource,
  }
  const server = Bun.spawn([process.execPath, ...(hot ? ["--hot"] : []), "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
  return { fake, origin, server, stop: () => { server.kill(); id.stop(true) } }
}

test("the entry point learns the platform organisation from ID, serves as the runtime login, answers /health and exits on SIGTERM, even under bun --hot", async () => {
  const login = await database.runtimeLogin(runtimeGrants)
  const { fake, origin, server, stop } = start(login.url, true)
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toBe(`Admin MCP serving ${origin}/mcp for platform organisation ${fake.organizationId}\n`)
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ status: "ok", databases: { admin: "ok" }, providers: ["admin"] })
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

test("the entry point refuses the owner's login before it listens, naming what makes it unsafe", async () => {
  const { server, stop } = start(database.url)
  try {
    expect(await server.exited).toBe(1)
    expect(await new Response(server.stdout).text()).toBe("")
    expect(await new Response(server.stderr).text()).toStartWith("The admin MCP cannot start: Database role answerable is not a restricted runtime role: has SUPERUSER;")
  } finally {
    stop()
  }
}, 30_000)

test("the entry point listens on ADMIN_HOST", async () => {
  const login = await database.runtimeLogin(runtimeGrants)
  const fake = createFakeId({ clientId: "admin-mcp" })
  const id = Bun.serve({ port: 0, fetch: request => fake.config.fetch(request) })
  const probe = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const env = {
    ...process.env, ADMIN_DATABASE_URL: login.url, ADMIN_ID_ISSUER: `http://127.0.0.1:${id.port}`, ADMIN_RESOURCE_URL: `http://[::1]:${port}/mcp`, ADMIN_PORT: String(port),
    ADMIN_HOST: "::1", ADMIN_ID_CLIENT_ID: "admin-mcp", ADMIN_ID_CLIENT_SECRET: fake.config.clientSecret, ADMIN_ID_ADMIN_RESOURCE: fake.config.adminResource,
  }
  const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toContain("Admin MCP serving")
    expect(await (await fetch(`http://[::1]:${port}/health`)).json()).toMatchObject({ status: "ok" })
    // Bound to the IPv6 loopback only, so nothing listens on the IPv4 loopback's port.
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  } finally {
    server.kill()
    await server.exited
    id.stop(true)
    await login.drop()
  }
}, 30_000)
