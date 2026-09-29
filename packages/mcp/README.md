# Answerable MCP

Define read tools and prepared mutations, group them in a provider, and serve the provider as an MCP server that signs people in with Answerable ID, on the official MCP TypeScript SDK.

```ts
import { createMcpServer, defineProvider, defineTool, readMcpEnvironment } from "@answerable/mcp"
import { z } from "zod"

const identityGet = defineTool({
  name: "identity.get",
  description: "Read your verified identity: your user id and the organisation you signed in to.",
  input: z.object({}),
  output: z.object({ userId: z.uuid(), organizationId: z.uuid() }),
  async execute(_input, { principal }) {
    return { userId: principal.userId, organizationId: principal.organizationId }
  },
})

export const provider = defineProvider({ id: "example", version: "2026-09-29", tools: [identityGet] })

const { auth, port } = readMcpEnvironment(process.env) // MCP_ID_ISSUER, MCP_RESOURCE_URL, MCP_PORT
const server = createMcpServer({ provider, auth })
Bun.serve({ hostname: "127.0.0.1", port, fetch: server.fetch })
```

A read tool is these five fields; everything else has a default. A mutation replaces `execute` with `prepare` and `commit`. `bun run mcp:new <name>` scaffolds a server that uses them. [Author an MCP](../../apps/web/content/docs/mcp/authoring.mdx) covers tools, mutations, providers, the server and its hub options, errors and the manifest.

```ts
import { assertProviderConformance, createTestMcp } from "@answerable/mcp/testing"
import { expect, test } from "bun:test"

assertProviderConformance(provider, { manifest: new URL("../manifest.json", import.meta.url), examples: { "identity.get": {} } })

test("identity_get names the caller's organisation", async () => {
  const mcp = await createTestMcp(provider)
  const organizationId = crypto.randomUUID()
  const client = await mcp.connect({ organizationId })
  expect((await client.callTool({ name: "identity_get", arguments: {} })).structuredContent).toMatchObject({ organizationId })
  await mcp.close()
})
```

`@answerable/mcp/testing` serves a provider in-process with a local ID issuer and the official MCP client: no port, no network. `UPDATE_MANIFEST=1 bun run test` writes the manifest snapshot the first time and after a change. [Test an MCP](../../apps/web/content/docs/mcp/testing.mdx) covers the conformance checks and the helpers.

Guides: [authoring](../../apps/web/content/docs/mcp/authoring.mdx), [testing](../../apps/web/content/docs/mcp/testing.mdx), [errors](../../apps/web/content/docs/mcp/errors.mdx), [the standard](../../apps/web/content/docs/mcp/standard.mdx), [local testing](../../apps/web/content/docs/mcp/local-testing.mdx). API reference, generated from the documentation comments by `bun run --filter @answerable/mcp reference`: [reference.mdx](../../apps/web/content/docs/mcp/reference.mdx). Reference server: [`mcps/e2e`](../../mcps/e2e/README.md). Changes: [CHANGELOG](CHANGELOG.md).

```sh
bun run --filter @answerable/mcp test
bun run mcp:check @answerable/mcp-e2e
```

The suite enforces 100% line and function coverage.
