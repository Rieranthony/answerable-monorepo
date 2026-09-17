# Answerable MCP Apps base

Hono, Answerable ID verification and the official MCP Apps SDK, shared by MCP workspaces.

Start with the [authoring guide](../../apps/web/content/docs/mcp/authoring.mdx). The executable reference is [mcps/e2e](../../mcps/e2e/README.md).

## Package boundaries

- `createMcpApp` returns a Hono app; the consumer owns its listener, services and shutdown.
- `defineTool`, `definePrompt` and `defineResource` produce reusable definitions with scope checks and request-bound identity. `defineView` attaches an Apps HTML resource to a tool.
- `readMcpEnvironment` validates common ID and port configuration.
- `/apps` and `/apps/react` expose the official browser APIs without importing server code.
- `/build` exports `buildView` for self-contained HTML and `bundleBrowser` for browser bundles. A separate Bun process avoids a reproduced Bun 1.3.1 module-cache conflict between browser and server dependencies.
- `/testing` provides `connectTestClient`, using the official SDK client over HTTP.

Domain services own tenant checks, storage and durable retry behaviour. Tools receive a verified principal, services, request ID and abort signal; they never receive the raw bearer token.

## Runtime behaviour

`GET /health` reports liveness. MCP requests log only request ID, HTTP status and duration; configure `log(event)` or `log: false` as needed.

The handler deadline defaults to 30 seconds after authentication, configurable up to five minutes. Cancellation combines HTTP, deadline and SDK signals. It is cooperative and cannot undo committed writes. The stateless transport has no cross-request cancellation registry.

See the authoring guide for configuration, errors and API examples. See [foundation evidence](../../reports/mcp-foundation-evidence.md) for tested behaviour and host compatibility.

## Verification

```sh
bun run --filter @answerable/mcp-base test
bun run --filter @answerable/mcp-base typecheck
bun run --filter @answerable/mcp-base lint
```
