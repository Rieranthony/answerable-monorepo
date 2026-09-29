import { expect, test } from "bun:test"
import { testDatabaseUrl } from "./test/database"

const directory = new URL("../", import.meta.url).pathname
const e2e = new URL("../", import.meta.resolve("@answerable/mcp-e2e/mcp")).pathname

test("the entry point serves against the database, answers /health and stops on SIGTERM", async () => {
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: e2e, stdout: "ignore", stderr: "pipe" })
  expect(await build.exited, await new Response(build.stderr).text()).toBe(0)
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const id = "http://127.0.0.1:1"
  const env = {
    ...process.env, TOOLBOX_DATABASE_URL: testDatabaseUrl, TOOLBOX_ID_ISSUER: id, TOOLBOX_RESOURCE_URL: `${origin}/mcp`, TOOLBOX_PORT: String(port),
    TOOLBOX_ID_CLIENT_ID: "toolbox-hub", TOOLBOX_ID_CLIENT_SECRET: "secret", TOOLBOX_ID_ADMIN_RESOURCE: `${id}/api/admin`,
  }
  // ID is not there: the poller logs that it failed, and nothing here reads grants.
  const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "ignore" })
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toContain(`Toolbox serving ${origin}/mcp`)
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ status: "ok" })
    server.kill("SIGTERM")
    expect(await server.exited).toBe(0)
  } finally {
    server.kill()
  }
}, 30_000)
