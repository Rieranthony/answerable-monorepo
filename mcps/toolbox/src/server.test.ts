import { expect, test } from "bun:test"
import { runtimeGrants } from "./db/migrate"
import { database } from "./test/database"

const directory = new URL("../", import.meta.url).pathname

// The e2e view the entry point imports, built as the Toolbox's dev script builds it.
const build = Bun.spawn([process.execPath, "run", "--filter", "@answerable/mcp-e2e", "build"], { cwd: directory, stdout: "ignore", stderr: "pipe" })
if ((await build.exited) !== 0) throw new Error(`Building the e2e view failed: ${await new Response(build.stderr).text()}`)

// The entry point on a free port against `databaseUrl`. ID is not there: the poller logs that it failed, and nothing here reads grants.
function start(databaseUrl: string) {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const id = "http://127.0.0.1:1"
  const env = {
    ...process.env, TOOLBOX_DATABASE_URL: databaseUrl, TOOLBOX_ID_ISSUER: id, TOOLBOX_RESOURCE_URL: `${origin}/mcp`, TOOLBOX_PORT: String(port),
    TOOLBOX_ID_CLIENT_ID: "toolbox-hub", TOOLBOX_ID_CLIENT_SECRET: "secret", TOOLBOX_ID_ADMIN_RESOURCE: `${id}/api/admin`,
  }
  const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
  return { origin, server }
}

test("the entry point serves as the runtime login, answers /health and stops on SIGTERM", async () => {
  const login = await database.runtimeLogin(runtimeGrants)
  const { origin, server } = start(login.url)
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toContain(`Toolbox serving ${origin}/mcp`)
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ status: "ok" })
    server.kill("SIGTERM")
    expect(await server.exited).toBe(0)
  } finally {
    server.kill()
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
