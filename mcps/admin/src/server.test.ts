import { expect, test } from "bun:test"
import { createFakeId } from "@answerable/id-admin/testing"
import { database } from "./test/database"

const directory = new URL("../", import.meta.url).pathname

// The entry point against a fake ID served over HTTP, as it would reach the real one.
async function start() {
  const fake = createFakeId({ clientId: "admin-mcp" })
  const id = Bun.serve({ port: 0, fetch: request => fake.config.fetch(request) })
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const env = {
    ...process.env, ADMIN_DATABASE_URL: database.url, ADMIN_ID_ISSUER: `http://127.0.0.1:${id.port}`, ADMIN_RESOURCE_URL: `${origin}/mcp`, ADMIN_PORT: String(port),
    ADMIN_ID_CLIENT_ID: "admin-mcp", ADMIN_ID_CLIENT_SECRET: fake.config.clientSecret, ADMIN_ID_ADMIN_RESOURCE: fake.config.adminResource,
  }
  const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
  return { fake, origin, server, stop: () => { server.kill(); id.stop(true) } }
}

test("the entry point learns the platform organisation from ID, serves against the database, answers /health and stops on SIGTERM", async () => {
  const { fake, origin, server, stop } = await start()
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toBe(`Admin MCP serving ${origin}/mcp for platform organisation ${fake.organizationId}\n`)
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ status: "ok" })
    server.kill("SIGTERM")
    expect(await server.exited).toBe(0)
  } finally {
    stop()
  }
}, 30_000)
