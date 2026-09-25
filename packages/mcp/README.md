# Answerable MCP

Build an MCP server that signs people in with Answerable ID, on the official MCP TypeScript SDK.

```ts
import { createMcpServer, defineTool, readMcpEnvironment } from "@answerable/mcp"
import { z } from "zod"

const identityGet = defineTool({
  name: "identity_get", description: "Read your organisation", scopes: ["example:read"],
  input: z.object({}).strict(), output: z.object({ organizationId: z.uuid() }),
  async execute(_input, { principal }) { return { organizationId: principal.organizationId } },
})

const { auth, port } = readMcpEnvironment(process.env) // MCP_ID_ISSUER, MCP_RESOURCE_URL, MCP_PORT
const server = createMcpServer({ name: "example", version: "0.1.0", auth, tools: [identityGet] })
Bun.serve({ hostname: "127.0.0.1", port, fetch: server.fetch })
```

- `createMcpServer` returns a web-standard `{ fetch }`: `/health`, host and origin checks, protected-resource metadata, the SDK's bearer gate and `createMcpHandler`, which serves both the 2026-07-28 and 2025 protocol versions.
- `defineTool`, `definePrompt`, `defineResource` and `defineView` return frozen data. A caller only sees definitions whose scopes its token carries. Dependencies come from closures; wrap or combine definitions with ordinary code.
- `execute` returns the tool's output. The server drops fields the output schema does not declare and sends the result as `structuredContent` and as the same JSON in text.
- `@answerable/mcp/build` bundles an MCP Apps view into one HTML resource, in a separate Bun process (an in-process build breaks this repository's test suite on Bun 1.3.1).
- `@answerable/mcp/testing` runs an MCP in-process with a local ID issuer and the official MCP client: no port, no network.

```ts
const mcp = await createTestMcp(auth => createExampleMcp({ auth }))
const client = await mcp.connect({ scopes: ["example:read"] })
await client.callTool({ name: "identity_get", arguments: {} })
await mcp.close()
```

Guides: [authoring](../../apps/web/content/docs/mcp/authoring.mdx), [local testing](../../apps/web/content/docs/mcp/local-testing.mdx). Reference server: [`mcps/e2e`](../../mcps/e2e/README.md).

```sh
bun run --filter @answerable/mcp test
```

The suite enforces 100% line and function coverage.
