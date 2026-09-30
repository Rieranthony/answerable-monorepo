/**
 * The files `bun run mcp:new <name>` writes from templates, by path: the provider, the server, the test, the environment example and the README.
 * The configuration files are copied from mcps/e2e instead. Pure, so the docs render exactly these files at build.
 */
export function scaffoldSources(name: string, date: string): Record<string, string> {
  return {
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

An MCP server on Answerable ID with one tool, \`${name}.status\`. Replace it with your own: [Build your first MCP](../../apps/web/content/docs/mcp/quickstart.mdx) adds a read tool, a mutation and their tests.

\`\`\`sh
bun --env-file=mcps/${name}/.env.example run --filter @answerable/mcp-${name} dev
curl http://localhost:47510/health
\`\`\`

Run these from the repository root; the second answers \`{"status":"ok"}\`. \`.env.example\` holds \`MCP_ID_ISSUER\`, \`MCP_RESOURCE_URL\` and \`MCP_PORT\`; copy it to \`.env\` in this directory, which is git-ignored, to change them. Before the first sign-in, register the resource, whose scope is \`${name}:read\`, and a client in Answerable ID, as [Connect Claude Code](../../apps/web/content/docs/mcp/claude-code.mdx#register-the-server) does for the e2e server.

\`\`\`sh
UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-${name} test
bun run mcp:check @answerable/mcp-${name}
\`\`\`

The first writes \`manifest.json\`, the provider's contract: run it again after changing a tool, and commit the file with the change. The second runs the typecheck, the lint and the tests, with the conformance kit and a 100% coverage gate: [Test an MCP](../../apps/web/content/docs/mcp/testing.mdx).
`,
  }
}
