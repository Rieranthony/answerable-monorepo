# E2E MCP

The reference MCP server, and the proof that Answerable ID signs people into MCP servers. Development and test only.

```sh
(cd mcps/e2e && bun x playwright install chromium)
bun run mcp:test:e2e
```

The acceptance provisions a real ID through its admin API, then signs two organisations in with the official MCP SDK's OAuth client and a real browser. [What it proves](../../apps/web/content/docs/mcp/local-testing.mdx#what-the-acceptance-proves).

## Tools

| Tool | Scope | Behaviour |
| --- | --- | --- |
| `identity_get` | `e2e:identity` | The verified user, organisation and scopes |
| `records_list` | `e2e:read` | The first 100 records of your organisation |
| `records_show` | `e2e:read` | The same list in an MCP Apps view |
| `records_create` | `e2e:write` | Create a record |
| `records_delete` | `e2e:write` | Delete a record of your organisation |

The prompt `fixture_walkthrough` and the resource `fixture://guide` need `e2e:read`. Records live in memory, per organisation, until the process stops. Errors: `record_not_found` (no such record in your organisation) and `tool_failed` (unexpected; see the server log).

## Run it

```sh
bun run --filter @answerable/mcp-e2e build
MCP_ID_ISSUER=http://localhost:47300 MCP_RESOURCE_URL=http://localhost:47500/mcp \
  bun run --filter @answerable/mcp-e2e start
```

Register the resource and a client in ID first: [Connect Claude Code](../../apps/web/content/docs/mcp/claude-code.mdx).

## Tests

```sh
bun run mcp:test
```

`src/apps.test.ts` renders the real view in Chromium through the official MCP Apps host bridge (`src/testing/host.ts`); the view never receives a token.
