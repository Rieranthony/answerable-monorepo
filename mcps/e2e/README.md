# E2E MCP

The reference MCP server, and the proof that Answerable ID signs people into MCP servers. Development and test only.

```sh
(cd packages/acceptance && bun x playwright install chromium)
bun run mcp:test:e2e
```

The acceptance lives in [`packages/acceptance`](../../packages/acceptance/README.md): it provisions a real ID through its admin API, serves this MCP in process, and signs three organisations in with the official MCP SDK's OAuth client and a real browser. [What it proves](../../apps/web/content/docs/mcp/local-testing.mdx#what-the-e2e-journeys-prove). It imports `createE2eProvider` and `createRecordStore` through this package's `exports`, `@answerable/mcp-e2e/mcp` and `@answerable/mcp-e2e/records`, and serves the provider with `createMcpServer`. `@answerable/mcp-e2e/view` is the built view's HTML, read once, which this server and the Toolbox pass as `viewHtml`; importing it before `bun run --filter @answerable/mcp-e2e build` throws.

## Tools

The provider is `e2e`, version `2026-09-29` (`src/mcp.ts`).

| Wire name | Identity | Scope | Behaviour |
| --- | --- | --- | --- |
| `identity_get` | `e2e/identity.get` | `e2e:identity` | The verified user, organisation and scopes |
| `records_list` | `e2e/records.list` | `e2e:read` | Your organisation's records, oldest first: `limit` (default 20, at most 100) and `cursor` in; `items`, `next_cursor` and `has_more` out |
| `records_show` | `e2e/records.show` | `e2e:read` | Your organisation's records in an MCP Apps view, with `canWrite`, paged like `records_list` (`limit`, `cursor`, `next_cursor`, `has_more`); the view shows the first page and creates and deletes through the tools below |
| `records_create` | `e2e/records.create` | `e2e:write` | Prepares creating a record: risk `low`, so agent class; no targets; the preview names the title. Commit with `e2e_commit`; the receipt's `results` is the record |
| `records_delete` | `e2e/records.delete` | `e2e:write` | Prepares deleting a record by `id`: risk `normal`, so controlled class; one target with the record's `version` (`serial`). Commit with `e2e_commit_confirmed` and the summary; `NOT_FOUND` for a record outside your organisation |
| `e2e_commit` | `e2e/commit` | any mutation's | Commits an agent-class intent; returns the receipt |
| `e2e_commit_confirmed` | `e2e/commit_confirmed` | any mutation's | Commits a controlled-class intent with `preview_summary`; destructive, and asks hosts to confirm with the person |

Records carry a `version` starting at 1. The record store's `touch(principal, id)` moves it, as another writer would, which is how tests make a prepared delete stale. `createE2eProvider({ records, viewHtml })` returns the provider; give `createMcpServer` an intent store with a controlled clock to move expiry.

The prompt `fixture_walkthrough` and the resource `fixture://guide` need `e2e:read`. Records and intents live in memory, per organisation, until the process stops. Errors: `INVALID_INPUT` (bad arguments, or a cursor this list did not issue: list again without one), `NOT_FOUND` (no such record in your organisation), the commit codes in [MCP errors](../../apps/web/content/docs/mcp/errors.mdx) and `INTERNAL` (unexpected; see the server log).

## Manifest

```sh
UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-e2e test
```

Rewrites `manifest.json`, the provider's contract. The conformance kit's `manifest_matches_snapshot` fails, naming this command, whenever the file and the definitions differ; run it and commit the file with the change.

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
bun run mcp:check @answerable/mcp-e2e
```

`bunfig.toml` gates 100% line and function coverage of `src`. The journeys against real ID (`bun run mcp:test:e2e`) are in `packages/acceptance`. Changes: [CHANGELOG](CHANGELOG.md).

`src/conformance.test.ts` runs the conformance kit on the provider: the standard's read, mutate and provider checks, with one example input per tool and `touch` as `moveTarget`. [Test an MCP](../../apps/web/content/docs/mcp/testing.mdx) explains each check. `src/mcp.test.ts` checks every tool in-process with `createTestMcp`: pagination, both mutations prepared and committed, a stale delete after `touch`, another organisation's record, a replay, and fully entitled, partial and read-only callers; copy it when you write an MCP. `src/server.test.ts` builds the view and starts `src/server.ts`, as `bun run mcp:dev` does. `src/apps.test.ts` renders the real view in Chromium through the official MCP Apps host bridge (`src/testing/host.ts`): it creates a record, shows the summary before deleting it, and hides writes from a reader; the view never receives a token.
