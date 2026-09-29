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
- A tool or mutation lists the custom `<PROVIDER>_<CODE>` codes it throws in `errors`; a handler that throws an undeclared custom code answers `INTERNAL`. The manifest carries the list.
- A hub serves several providers at one endpoint: `createMcpServer({ provider, mount, allow, wrapCall, cacheHints, auth })` names mounted tools `<provider id>_<wire name>`, lets `allow(principal, tool, called)` decide visibility per request in place of scopes, and runs `wrapCall(call, run)` around every tool and prepare call. The Toolbox (`mcps/toolbox`) is the one hub.
- `@answerable/mcp/testing` serves a provider in-process with a local ID issuer and the official MCP client: no port, no network. `assertProviderConformance(provider, fixture)` registers one test per check of [the standard](../../docs/09-mcp-design-standard.md), so a failure names the check and the tool to change.

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

Call the conformance kit once per provider, at the top level of a test file, with a valid input for every tool and mutation. `UPDATE_MANIFEST=1 bun run test` writes the manifest snapshot the first time and after a change. A mutation that prepares targets also needs `moveTarget(target, principal)` in the fixture, which changes the target outside the MCP so that its version moves.

```ts
import { assertProviderConformance } from "@answerable/mcp/testing"

assertProviderConformance(provider, {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: { "identity.get": {}, "notes.create": { title: "Example" } },
})
```

Guides: [authoring](../../apps/web/content/docs/mcp/authoring.mdx), [testing](../../apps/web/content/docs/mcp/testing.mdx), [errors](../../apps/web/content/docs/mcp/errors.mdx), [local testing](../../apps/web/content/docs/mcp/local-testing.mdx). API reference, generated from the documentation comments by `bun run --filter @answerable/mcp reference`: [reference.mdx](../../apps/web/content/docs/mcp/reference.mdx). Reference server: [`mcps/e2e`](../../mcps/e2e/README.md). Changes: [CHANGELOG](CHANGELOG.md).

```sh
bun run --filter @answerable/mcp test
bun run mcp:check @answerable/mcp-e2e
```

The suite enforces 100% line and function coverage. `bun run mcp:check <workspace>` runs a workspace's typecheck, lint and tests, which include its conformance checks and manifest drift test.
