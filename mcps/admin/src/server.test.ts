import { expect, test } from "bun:test"
import { createFakeId } from "@answerable/id-admin/testing"
import { testDatabaseUrl } from "./test/database"

const directory = new URL("../", import.meta.url).pathname

// The entry point against a fake ID served over HTTP, as it would reach the real one.
async function start({ platform }: { platform: boolean }) {
  const fake = createFakeId({ clientId: "admin-mcp", platform })
  const id = Bun.serve({ port: 0, fetch: request => fake.config.fetch(request) })
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const env = {
    ...process.env, ADMIN_DATABASE_URL: testDatabaseUrl, ADMIN_ID_ISSUER: `http://127.0.0.1:${id.port}`, ADMIN_RESOURCE_URL: `${origin}/mcp`, ADMIN_PORT: String(port),
    ADMIN_ID_CLIENT_ID: "admin-mcp", ADMIN_ID_CLIENT_SECRET: fake.config.clientSecret, ADMIN_ID_ADMIN_RESOURCE: fake.config.adminResource,
  }
  const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
  return { fake, origin, server, stop: () => { server.kill(); id.stop(true) } }
}

test("the entry point learns the platform organisation from ID, serves against the database, answers /health and stops on SIGTERM", async () => {
  const { fake, origin, server, stop } = await start({ platform: true })
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toBe(`Admin MCP serving ${origin}/mcp for platform organisation ${fake.organizationId}\n`)
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ status: "ok" })
    server.kill("SIGTERM")
    expect(await server.exited).toBe(0)
  } finally {
    stop()
  }
}, 30_000)

test("the entry point refuses to start when its machine client does not belong to the platform organisation, saying what to fix", async () => {
  const { fake, server, stop } = await start({ platform: false })
  try {
    expect(await server.exited).toBe(1)
    expect(await new Response(server.stderr).text()).toBe(
      `The admin MCP cannot start: The machine client admin-mcp belongs to organisation ${fake.organizationId}, which is not the platform organisation; register ADMIN_ID_CLIENT_ID in the platform organisation\n`,
    )
  } finally {
    stop()
  }
}, 30_000)
