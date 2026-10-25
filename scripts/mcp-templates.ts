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
  example: {},
  async execute(_input, { organisation }) {
    return { status: "ok", organizationId: organisation.id }
  },
})

export const provider = defineProvider({
  id: "${name}",
  description: "The ${name} MCP. Replace this with what it is for, in a sentence or two: the manifest and the Toolbox show it.",
  version: "${date}",
  tools: [status],
})
`,
    "src/server.ts": `import { createIdAdmin, createIdProfiles } from "@answerable/id-admin"
import { createMcpServer, readMcpEnvironment } from "@answerable/mcp"
import { provider } from "./provider"

const { auth, port, id } = readMcpEnvironment(process.env)
// Every handler is told who is calling, which only ID knows: without a machine client the server does not start.
if (!id) {
  console.error("The ${name} MCP cannot start: set MCP_ID_CLIENT_ID and MCP_ID_CLIENT_SECRET, a machine client in ID with platform:read, to read who is calling")
  process.exit(1)
}
const server = createMcpServer({ provider, auth, profiles: createIdProfiles(createIdAdmin(id)) })
Bun.serve({ hostname: "127.0.0.1", port, fetch: server.fetch })
console.log(\`${name} MCP serving \${auth.resource}\`)
`,
    "src/provider.test.ts": `import { expect, test } from "bun:test"
import { assertProviderConformance, createTestMcp } from "@answerable/mcp/testing"
import { provider } from "./provider"

assertProviderConformance(provider, { manifest: new URL("../manifest.json", import.meta.url) })

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
    ".env.example": `# Copy to .env (git-ignored) and set the machine client; an MCP running beside another needs its own port.
MCP_ID_ISSUER=http://localhost:47300
MCP_RESOURCE_URL=http://localhost:47510/mcp
MCP_PORT=47510
# A machine client in ID with platform:read, through which the server reads who is calling; ID issues both.
# MCP_ID_CLIENT_ID=
# MCP_ID_CLIENT_SECRET=
`,
    "README.md": `# ${name} MCP

An MCP server on Answerable ID with one tool, \`${name}.status\`. Replace it with your own: [Build your first MCP](../../apps/web/content/docs/mcp/quickstart.mdx) adds a read tool, a mutation and their tests.

\`\`\`sh
cp mcps/${name}/.env.example mcps/${name}/.env
bun --env-file=mcps/${name}/.env run --filter @answerable/mcp-${name} dev
curl http://localhost:47510/health
\`\`\`

Run these from the repository root; the last answers \`{"status":"ok"}\`. \`.env\`, which is git-ignored, holds \`MCP_ID_ISSUER\`, \`MCP_RESOURCE_URL\` and \`MCP_PORT\`, and the machine client the server reads who is calling through, \`MCP_ID_CLIENT_ID\` and \`MCP_ID_CLIENT_SECRET\`: set those two before you start it. Before the first sign-in, register the resource, whose scope is \`${name}:read\`, a client and the machine client in Answerable ID, as [Connect Claude Code](../../apps/web/content/docs/mcp/claude-code.mdx#register-the-server) does for the e2e server.

\`\`\`sh
UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-${name} test
bun run mcp:check @answerable/mcp-${name}
\`\`\`

The first writes \`manifest.json\`, the provider's contract: run it again after changing a tool, and commit the file with the change. The second runs the typecheck, the lint and the tests, with the conformance kit and a 100% coverage gate: [Test an MCP](../../apps/web/content/docs/mcp/testing.mdx).
`,
  }
}
