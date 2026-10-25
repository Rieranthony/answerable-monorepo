import { expect, test } from "bun:test"

const directory = new URL("../", import.meta.url).pathname

test("the entry point serves the built view's MCP, answers /health and stops on SIGTERM", async () => {
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: directory, stdout: "ignore", stderr: "pipe" })
  expect(await build.exited, await new Response(build.stderr).text()).toBe(0)
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const env = { ...process.env, MCP_ID_ISSUER: "http://localhost:47300", MCP_RESOURCE_URL: `${origin}/mcp`, MCP_PORT: String(port), MCP_ID_CLIENT_ID: "e2e-mcp", MCP_ID_CLIENT_SECRET: "e2e-secret" }
  const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "inherit" })
  try {
    const started = new TextDecoder().decode((await server.stdout.getReader().read()).value)
    expect(started).toContain(`E2E MCP serving ${origin}/mcp`)
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ status: "ok" })
    expect((await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()).resource).toBe(`${origin}/mcp`)
    server.kill("SIGTERM")
    expect(await server.exited).toBe(0)
  } finally {
    server.kill()
  }
}, 30_000)

test("without a machine client to read who is calling, the entry point refuses to start, naming the variables", async () => {
  const env = { ...process.env, MCP_ID_ISSUER: "http://localhost:47300", MCP_RESOURCE_URL: "http://localhost:1/mcp", MCP_PORT: "1", MCP_ID_CLIENT_ID: undefined, MCP_ID_CLIENT_SECRET: undefined }
  const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
  expect(await server.exited).toBe(1)
  expect(await new Response(server.stderr).text()).toContain("The e2e MCP cannot start: set MCP_ID_CLIENT_ID and MCP_ID_CLIENT_SECRET, a machine client in ID with platform:read, to read who is calling")
})
