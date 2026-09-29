# E2E MCP

The reference MCP server, and the proof that Answerable ID signs people into MCP servers. Development and test only.

```sh
(cd mcps/e2e && bun x playwright install chromium)
bun run mcp:test:e2e
```

The acceptance provisions a real ID through its admin API, then signs three organisations in with the official MCP SDK's OAuth client and a real browser. [What it proves](../../apps/web/content/docs/mcp/local-testing.mdx#what-the-acceptance-proves).

## Tools

The provider is `e2e`, version `2026-09-29` (`src/mcp.ts`).

| Wire name | Identity | Scope | Behaviour |
| --- | --- | --- | --- |
| `identity_get` | `e2e/identity.get` | `e2e:identity` | The verified user, organisation and scopes |
| `records_list` | `e2e/records.list` | `e2e:read` | Your organisation's records, oldest first: `limit` (default 20, at most 100) and `cursor` in; `items`, `next_cursor` and `has_more` out |
| `records_show` | `e2e/records.show` | `e2e:read` | The first 20 records in an MCP Apps view |

Writes: Not yet; `records.create` and `records.delete` return with prepared mutations. The record store keeps `create` and `remove` for them, and tests and the acceptance seed records through it.

The prompt `fixture_walkthrough` and the resource `fixture://guide` need `e2e:read`. Records live in memory, per organisation, until the process stops. Errors: `INVALID_INPUT` (bad arguments, or a cursor this list did not issue: list again without one) and `INTERNAL` (unexpected; see the server log).

## Manifest

```sh
bun run --filter @answerable/mcp-e2e manifest
```

Rewrites `manifest.json`, the provider's contract. `src/manifest.test.ts` fails, naming this command, whenever the file and the definitions differ; run it and commit the file with the change.

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

`src/mcp.test.ts` checks every tool, pagination, the prompt and the resource in-process with `createTestMcp`, for a fully entitled and a read-only caller; copy it when you write an MCP. `src/apps.test.ts` renders the real view in Chromium through the official MCP Apps host bridge (`src/testing/host.ts`); the view never receives a token.
