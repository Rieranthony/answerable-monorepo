# Answerable MCP

Define read tools and prepared mutations, group them in a provider, and serve the provider as an MCP server that signs people in with Answerable ID, on the official MCP TypeScript SDK.

```ts
import { createIdAdmin, createIdProfiles } from "@answerable/id-admin"
import { createMcpServer, defineProvider, defineTool, readMcpEnvironment } from "@answerable/mcp"
import { z } from "zod"

const identityGet = defineTool({
  name: "identity.get",
  description: "Read who you are: your name and the organisation you signed in to.",
  input: z.object({}),
  output: z.object({ name: z.string(), organisation: z.string() }),
  example: {},
  async execute(_input, { person, organisation }) {
    return { name: person.name, organisation: organisation.name }
  },
})

export const provider = defineProvider({ id: "example", description: "Tells you who you are to Answerable ID, and your organisation.", version: "2026-09-29", tools: [identityGet] })

const { auth, port, id } = readMcpEnvironment(process.env) // MCP_ID_ISSUER, MCP_RESOURCE_URL, MCP_PORT, and the machine client MCP_ID_CLIENT_ID, MCP_ID_CLIENT_SECRET
const server = createMcpServer({ provider, auth, profiles: createIdProfiles(createIdAdmin(id!)) })
Bun.serve({ hostname: "127.0.0.1", port, fetch: server.fetch })
```

A read tool is five fields and an example; everything else has a default. A mutation replaces `execute` with `prepare` and `commit`. Every handler receives who is calling, `person`, `organisation` and `client`, which `profiles` reads from Answerable ID; an MCP with a database defines its tools with `withDatabase({ schema })`, and they receive its typed `db` too. `bun run mcp:new <name>` scaffolds a server that uses them.

`@answerable/mcp/testing` serves a provider in-process with a local ID issuer and the official MCP client, with no port and no network, as a test person you can change, and `assertProviderConformance(provider, fixture)` checks it against the design standard with each tool's example. An MCP with a database takes both from `@answerable/mcp-postgres/testing`.

Guides: [build your first MCP](../../apps/web/content/docs/mcp/quickstart.mdx), [read tools](../../apps/web/content/docs/mcp/tools.mdx) (fields, names, descriptions, pagination, errors), [mutations](../../apps/web/content/docs/mcp/mutations.mdx) (prepare, commit, policy classes, intents), [providers and servers](../../apps/web/content/docs/mcp/servers.mdx) (the server and its hub options, configuration, the manifest, prompts, resources and views), [test an MCP](../../apps/web/content/docs/mcp/testing.mdx) (the conformance checks, the helpers, the manifest snapshot), [errors](../../apps/web/content/docs/mcp/errors.mdx), [the standard](../../apps/web/content/docs/mcp/standard.mdx) and [local testing](../../apps/web/content/docs/mcp/local-testing.mdx). API reference, generated from the documentation comments by `bun run --filter @answerable/mcp reference`: [reference.mdx](../../apps/web/content/docs/mcp/reference.mdx). Reference server: [`mcps/e2e`](../../mcps/e2e/README.md). Changes: [CHANGELOG](CHANGELOG.md).

```sh
bun run --filter @answerable/mcp test
bun run mcp:check @answerable/mcp-e2e
```

The suite enforces 100% line and function coverage.
