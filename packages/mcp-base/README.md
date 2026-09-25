# Answerable MCP base

Build an MCP server that signs people in with Answerable ID, on the official MCP TypeScript SDK.

```ts
import { createMcpApp, readMcpEnvironment } from "@answerable/mcp-base"

const { auth, port } = readMcpEnvironment(process.env) // MCP_ID_ISSUER, MCP_RESOURCE_URL, MCP_PORT
const app = createMcpApp({ name: "example", version: "0.1.0", auth, services: {}, tools: [identityGet] })
Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch })
```

- `createMcpApp` returns a web-standard `{ fetch }`: host and origin checks, protected-resource metadata, `/health`, the SDK's bearer gate and `createMcpHandler`, which serves both the 2026-07-28 and 2025 protocol versions.
- `defineTool`, `definePrompt`, `defineResource` and `defineView` declare scopes. A caller only sees definitions whose scopes its token carries.
- `@answerable/mcp-base/build` bundles an MCP Apps view into one HTML resource, in a separate Bun process (an in-process build breaks this repository's test suite on Bun 1.3.1).
- `@answerable/mcp-base/testing` connects the official MCP client with a bearer token.

Guides: [authoring](../../apps/web/content/docs/mcp/authoring.mdx), [local testing](../../apps/web/content/docs/mcp/local-testing.mdx). Reference server: [`mcps/e2e`](../../mcps/e2e/README.md).

```sh
bun run --filter @answerable/mcp-base test
```
