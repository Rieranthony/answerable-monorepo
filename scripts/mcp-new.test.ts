import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scaffold } from "./mcp-new"

const repo = new URL("../", import.meta.url).pathname
const date = "2026-09-29"
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-new-"))
  await mkdir(join(root, "mcps"))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const read = (path: string, name = "acme") => Bun.file(join(root, "mcps", name, path)).text()
const files = async (name = "acme") => (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(root, "mcps", name), dot: true }))).sort()

test.each(["", "Acme", "1acme", "acme-x", "acme_x", "abcdefghijklm"])("refuses the name %p and writes nothing", async name => {
  await expect(scaffold(name, { root, date })).rejects.toThrow(`Server name "${name}" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme`)
  expect(await readdir(join(root, "mcps"))).toEqual([])
})

test("refuses a directory that exists and leaves it alone", async () => {
  await mkdir(join(root, "mcps/acme"))
  await expect(scaffold("acme", { root, date })).rejects.toThrow("mcps/acme already exists; choose another name or remove it")
  expect(await readdir(join(root, "mcps/acme"))).toEqual([])
})

test("writes the workspace, and nothing else", async () => {
  await scaffold("acme", { root, date })
  expect(await files()).toEqual([".env.example", "README.md", "bunfig.toml", "eslint.config.mjs", "manifest.json", "package.json", "src/provider.test.ts", "src/provider.ts", "src/server.ts", "tsconfig.json"])
})

test("package.json is private, runs its scripts and pins what mcps/e2e pins", async () => {
  await scaffold("acme", { root, date })
  const e2e = await Bun.file(join(repo, "mcps/e2e/package.json")).json()
  const dev = ["@eslint/js", "@types/bun", "eslint", "typescript", "typescript-eslint"]
  const expected = {
    name: "@answerable/mcp-acme",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { dev: "bun --hot src/server.ts", start: "bun src/server.ts", test: "bun test", typecheck: "tsc --noEmit", lint: "eslint src --max-warnings 0" },
    dependencies: { "@answerable/mcp": "workspace:*", zod: e2e.dependencies.zod },
    devDependencies: Object.fromEntries(dev.map(name => [name, e2e.devDependencies[name]])),
  }
  expect(e2e.dependencies["@answerable/mcp"]).toBe("workspace:*")
  expect(Object.values(expected.devDependencies).every(Boolean)).toBe(true)
  expect(await read("package.json")).toBe(`${JSON.stringify(expected, null, 2)}\n`)
})

test("tsconfig.json and eslint.config.mjs are the e2e server's", async () => {
  await scaffold("acme", { root, date })
  for (const file of ["tsconfig.json", "eslint.config.mjs"]) expect(await read(file)).toBe(await Bun.file(join(repo, "mcps/e2e", file)).text())
})

test("bunfig.toml gates 100% line and function coverage of the server's own files", async () => {
  await scaffold("acme", { root, date })
  expect(await read("bunfig.toml")).toBe(`[test]
root = "src"
coverage = true
coverageSkipTestFiles = true
coverageThreshold = { lines = 1, functions = 1 }
# lcov writes the coverage/ directory that Turborepo expects from a test task.
coverageReporter = ["text", "lcov"]
coveragePathIgnorePatterns = ["../**"]
`)
})

test("the provider has one five-field read tool and is dated today", async () => {
  await scaffold("acme", { root, date })
  expect(await read("src/provider.ts")).toBe(`import { defineProvider, defineTool } from "@answerable/mcp"
import { z } from "zod"

const status = defineTool({
  name: "acme.status",
  description: "Report that the acme server is running and which organisation the caller signed in to. Replace it with your first real tool.",
  input: z.object({}),
  output: z.object({ status: z.string(), organizationId: z.uuid() }),
  async execute(_input, { principal }) {
    return { status: "ok", organizationId: principal.organizationId }
  },
})

export const provider = defineProvider({ id: "acme", version: "2026-09-29", tools: [status] })
`)
})

test("the server reads the environment and serves the provider", async () => {
  await scaffold("acme", { root, date })
  expect(await read("src/server.ts")).toBe(`import { createMcpServer, readMcpEnvironment } from "@answerable/mcp"
import { provider } from "./provider"

const { auth, port } = readMcpEnvironment(process.env)
const server = createMcpServer({ provider, auth })
Bun.serve({ hostname: "127.0.0.1", port, fetch: server.fetch })
console.log(\`acme MCP serving \${auth.resource}\`)
`)
})

test("the test runs the conformance kit and one in-process call", async () => {
  await scaffold("acme", { root, date })
  expect(await read("src/provider.test.ts")).toBe(`import { expect, test } from "bun:test"
import { assertProviderConformance, createTestMcp } from "@answerable/mcp/testing"
import { provider } from "./provider"

assertProviderConformance(provider, {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: { "acme.status": {} },
})

test("acme_status names the caller's organisation", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const organizationId = crypto.randomUUID()
    const client = await mcp.connect({ organizationId })
    const result = await client.callTool({ name: "acme_status", arguments: {} })
    expect(result.structuredContent).toEqual({ status: "ok", organizationId })
  } finally {
    await mcp.close()
  }
})
`)
})

test(".env.example names the three variables with a port to change", async () => {
  await scaffold("acme", { root, date })
  expect(await read(".env.example")).toBe(`# Copy to .env (git-ignored) to change a value; an MCP running beside another needs its own port.
MCP_ID_ISSUER=http://localhost:47300
MCP_RESOURCE_URL=http://localhost:47510/mcp
MCP_PORT=47510
`)
})

test("the README runs, tests and extends the server", async () => {
  await scaffold("acme", { root, date })
  expect(await read("README.md")).toBe(`# acme MCP

An MCP server on Answerable ID with one tool, \`acme.status\`. Replace it with your own.

\`\`\`sh
bun --env-file=mcps/acme/.env.example run --filter @answerable/mcp-acme dev
curl http://localhost:47510/health
\`\`\`

Run these from the repository root. The second command answers \`{"status":"ok"}\`. \`.env.example\` holds \`MCP_ID_ISSUER\`, \`MCP_RESOURCE_URL\` and \`MCP_PORT\`; copy it to \`.env\` in this directory, which is git-ignored, to change them, and give each MCP running at the same time its own port. Before the first sign-in, register the resource, whose scope is \`acme:read\`, and a client in Answerable ID, as [Connect Claude Code](../../apps/web/content/docs/mcp/claude-code.mdx#register-the-server) does for the e2e server.

## Test

\`\`\`sh
bun run mcp:check @answerable/mcp-acme
\`\`\`

It runs the typecheck, the lint and the tests with a 100% line and function coverage gate. \`src/provider.test.ts\` runs the conformance kit and makes one call in-process.

## Add a tool

Define it with \`defineTool\` in \`src/provider.ts\` and add it to \`tools\`; a mutation adds \`prepare\` and \`commit\`. Give \`examples\` in \`src/provider.test.ts\` one valid input for it, then rewrite the manifest and commit it with the change:

\`\`\`sh
UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-acme test
\`\`\`

[Author an MCP](../../apps/web/content/docs/mcp/authoring.mdx) covers tools, mutations and errors. [Test an MCP](../../apps/web/content/docs/mcp/testing.mdx) covers the checks.
`)
})

test("the manifest is the provider's contract, dated today", async () => {
  await scaffold("acme", { root, date })
  const manifest = JSON.parse(await read("manifest.json"))
  expect(manifest).toMatchObject({ id: "acme", version: date, tools: [{ identity: "acme/acme.status", name: "acme_status", kind: "read" }] })
})

test("the first test run leaves neither dependencies nor coverage behind", async () => {
  await scaffold("acme", { root, date })
  expect((await readdir(join(root, "mcps/acme"))).sort()).toEqual([".env.example", "README.md", "bunfig.toml", "eslint.config.mjs", "manifest.json", "package.json", "src", "tsconfig.json"])
})

// bun install links a workspace's dependencies; until then the e2e server's stand in.
async function scaffoldLinked(name: string) {
  await scaffold(name, { root, date })
  const cwd = join(root, "mcps", name)
  await symlink(join(repo, "mcps/e2e/node_modules"), join(cwd, "node_modules"))
  return cwd
}

test("a 12-character name works, and the new server passes its typecheck, lint and tests unchanged", async () => {
  const cwd = await scaffoldLinked("abcdefghijkl")
  for (const script of ["typecheck", "lint", "test"]) {
    const run = Bun.spawn([process.execPath, "run", script], { cwd, stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    expect(exitCode, `${script} failed:\n${stdout}${stderr}`).toBe(0)
  }
})

test("the new server starts from its .env.example and answers /health", async () => {
  const cwd = await scaffoldLinked("acme")
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  const envFile = join(cwd, ".env")
  await Bun.write(envFile, (await Bun.file(join(cwd, ".env.example")).text()).replaceAll("47510", String(port)))
  const server = Bun.spawn([process.execPath, `--env-file=${envFile}`, "src/server.ts"], { cwd, stdout: "pipe", stderr: "inherit" })
  try {
    expect(new TextDecoder().decode((await server.stdout.getReader().read()).value)).toContain(`acme MCP serving http://localhost:${port}/mcp`)
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({ status: "ok" })
  } finally {
    server.kill()
    await server.exited
  }
})

test("prints the three commands to run next", async () => {
  expect(await scaffold("acme", { root, date })).toBe(`Created mcps/acme (@answerable/mcp-acme). Next, from the repository root:

  bun install
  bun run mcp:check @answerable/mcp-acme
  bun --env-file=mcps/acme/.env.example run --filter @answerable/mcp-acme dev
`)
})

test("bun run mcp:new prints the refusal and exits 1", async () => {
  const run = Bun.spawn([process.execPath, "mcp-new.ts", "Not-A-Name"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()])
  expect(exitCode).toBe(1)
  expect(stderr).toBe('Server name "Not-A-Name" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme\n')
})
