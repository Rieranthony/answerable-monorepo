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

- `defineTool` takes five fields and defaults the rest: version and scopes from the provider (`example:read`), a 25-second timeout. It refuses a bad name, a description outside 40 to 1,000 characters, or a timeout above 55 seconds. The wire name is `identity_get`; the identity `example/identity.get` travels in `_meta` with the version.
- `defineProvider` fills identity, version and scopes and refuses duplicates. `createMcpServer({ provider, auth })` returns a web-standard `{ fetch }`: `/health`, host and origin checks, protected-resource metadata, the SDK's bearer gate, and both the 2026 and 2025 protocol revisions.
- A token sees only the definitions whose scopes it carries. The server validates input and output, drops undeclared output fields and sends the result as `structuredContent` and as the same JSON in text.
- Every tool failure is an `isError` result whose one text block is the JSON envelope `{ error: { code, message, retry, details?, request_id } }`, with no `structuredContent` (MCP SDK 1.x clients reject structured content that does not match the output schema, even on errors): throw `ToolError`; bad input answers `INVALID_INPUT`, a slow handler `TIMEOUT`, anything else `INTERNAL`.
- `defineMutation` adds `prepare` and `commit` in place of `execute` (example below). Its prepare tool records an intent and changes nothing; the server's `<id>_commit` and `<id>_commit_confirmed` tools apply it, checking the principal, the single-use token, the expiry, the policy class from `risk` and every target's version, and return a receipt, the same one on a repeat. Intents live in an `IntentStore`; `createMemoryIntentStore()` is the default.
- `manifest(provider)` is the provider's contract as JSON; commit it and test it for drift.
- `@answerable/mcp/build` bundles an MCP Apps view into one HTML resource, in a separate Bun process (an in-process build breaks this repository's test suite on Bun 1.3.1).
- `@answerable/mcp/testing` serves a provider in-process with a local ID issuer and the official MCP client: no port, no network.

```ts
import { defineMutation } from "@answerable/mcp"
import { z } from "zod"

const notes = new Map<string, string>()
export const notesCreate = defineMutation({
  name: "notes.create",
  risk: "low",
  description: "Prepare adding a note. Changes nothing: returns a preview and a commit token; commit it with example_commit.",
  input: z.object({ text: z.string().min(1).max(500) }),
  output: z.object({ id: z.uuid() }),
  async prepare({ text }) {
    return { targets: [], preview: { summary: `Add the note “${text}”`, changes: [{ path: "notes[]", to: text }] }, plan: { text } }
  },
  async commit({ plan, preview }) {
    const id = crypto.randomUUID()
    notes.set(id, plan.text)
    return { results: { id }, applied_changes: preview.changes, effects_performed: [] }
  },
})
```

Add it to the provider's `tools`: `notes_create` returns the intent, and `example_commit` with its `intent_id` and `commit_token` returns the receipt.

```ts
import { createTestMcp } from "@answerable/mcp/testing"

const mcp = await createTestMcp(provider)
const client = await mcp.connect({ scopes: ["example:read"] })
await client.callTool({ name: "identity_get", arguments: {} })
await mcp.close()
```

Guides: [authoring](../../apps/web/content/docs/mcp/authoring.mdx), [errors](../../apps/web/content/docs/mcp/errors.mdx), [local testing](../../apps/web/content/docs/mcp/local-testing.mdx). Reference server: [`mcps/e2e`](../../mcps/e2e/README.md). Changes: [CHANGELOG](CHANGELOG.md).

```sh
bun run --filter @answerable/mcp test
```

The suite enforces 100% line and function coverage.
