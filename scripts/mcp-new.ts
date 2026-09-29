import { existsSync } from "node:fs"
import { rm, symlink, unlink } from "node:fs/promises"
import { join } from "node:path"

const repo = new URL("../", import.meta.url).pathname
const e2e = join(repo, "mcps/e2e")
const pick = (from: Record<string, string>, names: string[]) => Object.fromEntries(names.map(name => [name, from[name]]))

// bun install has not linked the new workspace's dependencies yet, so the e2e server's stand in for the first run, which writes the manifest.
// The run's coverage directory goes with the link.
async function writeManifest(dir: string) {
  const link = join(dir, "node_modules")
  await symlink(join(e2e, "node_modules"), link)
  try {
    const run = Bun.spawn([process.execPath, "test"], { cwd: dir, env: { ...process.env, UPDATE_MANIFEST: "1" }, stdout: "ignore", stderr: "pipe" })
    const [exitCode, output] = await Promise.all([run.exited, new Response(run.stderr).text()])
    if (exitCode) throw new Error(`The new server's first test run failed:\n${output}`)
  } finally {
    await unlink(link)
    await rm(join(dir, "coverage"), { recursive: true, force: true })
  }
}

/** Write `mcps/<name>`, a server with one tool that passes `bun run mcp:check` once `bun install` has linked it, and return the commands to run next. */
export async function scaffold(name: string, { root = repo, date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!/^[a-z][a-z0-9]{0,11}$/.test(name)) throw new Error(`Server name "${name}" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme`)
  const dir = join(root, "mcps", name)
  if (existsSync(dir)) throw new Error(`mcps/${name} already exists; choose another name or remove it`)
  const pins = await Bun.file(join(e2e, "package.json")).json()
  const pkg = {
    name: `@answerable/mcp-${name}`,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { dev: "bun --hot src/server.ts", start: "bun src/server.ts", test: "bun test", typecheck: "tsc --noEmit", lint: "eslint src --max-warnings 0" },
    dependencies: pick(pins.dependencies, ["@answerable/mcp", "zod"]),
    devDependencies: pick(pins.devDependencies, ["@eslint/js", "@types/bun", "eslint", "typescript", "typescript-eslint"]),
  }
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "tsconfig.json": await Bun.file(join(e2e, "tsconfig.json")).text(),
    "eslint.config.mjs": await Bun.file(join(e2e, "eslint.config.mjs")).text(),
    "bunfig.toml": `[test]
root = "src"
coverage = true
coverageSkipTestFiles = true
coverageThreshold = { lines = 1, functions = 1 }
# lcov writes the coverage/ directory that Turborepo expects from a test task.
coverageReporter = ["text", "lcov"]
coveragePathIgnorePatterns = ["../**"]
`,
    "src/provider.ts": `import { defineProvider, defineTool } from "@answerable/mcp"
import { z } from "zod"

const status = defineTool({
  name: "${name}.status",
  description: "Report that the ${name} server is running and which organisation the caller signed in to. Replace it with your first real tool.",
  input: z.object({}),
  output: z.object({ status: z.string(), organizationId: z.uuid() }),
  async execute(_input, { principal }) {
    return { status: "ok", organizationId: principal.organizationId }
  },
})

export const provider = defineProvider({ id: "${name}", version: "${date}", tools: [status] })
`,
    "src/server.ts": `import { createMcpServer, readMcpEnvironment } from "@answerable/mcp"
import { provider } from "./provider"

const { auth, port } = readMcpEnvironment(process.env)
const server = createMcpServer({ provider, auth })
Bun.serve({ hostname: "127.0.0.1", port, fetch: server.fetch })
console.log(\`${name} MCP serving \${auth.resource}\`)
`,
    "src/provider.test.ts": `import { expect, test } from "bun:test"
import { assertProviderConformance, createTestMcp } from "@answerable/mcp/testing"
import { provider } from "./provider"

assertProviderConformance(provider, {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: { "${name}.status": {} },
})

test("${name}_status names the caller's organisation", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const organizationId = crypto.randomUUID()
    const client = await mcp.connect({ organizationId })
    const result = await client.callTool({ name: "${name}_status", arguments: {} })
    expect(result.structuredContent).toEqual({ status: "ok", organizationId })
  } finally {
    await mcp.close()
  }
})
`,
    ".env.example": `# Copy to .env (git-ignored) to change a value; an MCP running beside another needs its own port.
MCP_ID_ISSUER=http://localhost:47300
MCP_RESOURCE_URL=http://localhost:47510/mcp
MCP_PORT=47510
`,
    "README.md": `# ${name} MCP

An MCP server on Answerable ID with one tool, \`${name}.status\`. Replace it with your own.

\`\`\`sh
bun --env-file=mcps/${name}/.env.example run --filter @answerable/mcp-${name} dev
curl http://localhost:47510/health
\`\`\`

Run these from the repository root. The second command answers \`{"status":"ok"}\`. \`.env.example\` holds \`MCP_ID_ISSUER\`, \`MCP_RESOURCE_URL\` and \`MCP_PORT\`; copy it to \`.env\` in this directory, which is git-ignored, to change them, and give each MCP running at the same time its own port. Before the first sign-in, register the resource, whose scope is \`${name}:read\`, and a client in Answerable ID, as [Connect Claude Code](../../apps/web/content/docs/mcp/claude-code.mdx#register-the-server) does for the e2e server.

## Test

\`\`\`sh
bun run mcp:check @answerable/mcp-${name}
\`\`\`

It runs the typecheck, the lint and the tests with a 100% line and function coverage gate. \`src/provider.test.ts\` runs the conformance kit and makes one call in-process.

## Add a tool

Define it with \`defineTool\` in \`src/provider.ts\` and add it to \`tools\`; a mutation adds \`prepare\` and \`commit\`. Give \`examples\` in \`src/provider.test.ts\` one valid input for it, then rewrite the manifest and commit it with the change:

\`\`\`sh
UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-${name} test
\`\`\`

[Author an MCP](../../apps/web/content/docs/mcp/authoring.mdx) covers tools, mutations and errors. [Test an MCP](../../apps/web/content/docs/mcp/testing.mdx) covers the checks.
`,
  }
  for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content)
  await writeManifest(dir)
  return `Created mcps/${name} (@answerable/mcp-${name}). Next, from the repository root:

  bun install
  bun run mcp:check @answerable/mcp-${name}
  bun --env-file=mcps/${name}/.env.example run --filter @answerable/mcp-${name} dev
`
}

if (import.meta.main) {
  try {
    console.log(await scaffold(Bun.argv[2] ?? ""))
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
