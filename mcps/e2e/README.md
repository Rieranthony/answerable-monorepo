# E2E MCP

The reference MCP, and the proof that Answerable ID signs people into MCP servers. Laid out as `bun mcp new` lays an MCP out, with its records in Postgres, and served both ways (`"serve": "both"` in `mcp.json`): mounted in the Toolbox, and on its own URL, which the Toolbox serves too. It ships to every environment, as `charts/answerable/mcps.json` declares it.

```sh
(cd packages/acceptance && bun x playwright install chromium)
bun run mcp:test:e2e
```

The acceptance lives in [`packages/acceptance`](../../packages/acceptance/README.md): it provisions a real ID through its admin API, serves this MCP at its path and in the Toolbox's hub, and signs organisations in with the official MCP SDK's OAuth client and a real browser. [What it proves](../../apps/web/content/docs/mcp/local-testing.mdx#what-the-acceptance-proves).

## Tools

The provider is `e2e`, version `2026-09-29` (`src/provider.ts`), one file per tool in `src/tools`.

| Wire name | Identity | Scope | Behaviour |
| --- | --- | --- | --- |
| `identity_get` | `e2e/identity.get` | `e2e:identity` | The verified user, organisation and scopes |
| `records_list` | `e2e/records.list` | `e2e:read` | Your organisation's records, oldest first: `limit` (default 20, at most 100) and `cursor` in; `items`, `next_cursor` and `has_more` out |
| `records_show` | `e2e/records.show` | `e2e:read` | Your organisation's records in an MCP Apps view, with `canWrite`, paged like `records_list` (`limit`, `cursor`, `next_cursor`, `has_more`); the view shows the first page and creates and deletes through the tools below |
| `records_create` | `e2e/records.create` | `e2e:write` | Prepares creating a record: risk `low`, so agent class; no targets; the preview names the title. Commit with `e2e_commit`; the receipt's `results` is the record |
| `records_delete` | `e2e/records.delete` | `e2e:write` | Prepares deleting a record by `id`: risk `normal`, so controlled class; one target with the record's `version` (`serial`). Commit with `e2e_commit_confirmed` and the summary; `NOT_FOUND` for a record outside your organisation |
| `e2e_commit` | `e2e/commit` | any mutation's | Commits an agent-class intent; returns the receipt |
| `e2e_commit_confirmed` | `e2e/commit_confirmed` | any mutation's | Commits a controlled-class intent with `preview_summary`; destructive, and asks hosts to confirm with the person |

The prompt `fixture_walkthrough` and the resource `fixture://guide` need `e2e:read` (`src/guide.ts`). Records live in schema `e2e` (`src/db/schema.ts`), each organisation's limited to it by Postgres; a record's `version` starts at 1. Through the Toolbox the tools are `e2e_records_list` and so on. Errors: `INVALID_INPUT` (bad arguments, or a cursor this list did not issue: list again without one), `NOT_FOUND` (no such record in your organisation), the commit codes in [MCP errors](../../apps/web/content/docs/mcp/errors.mdx) and `INTERNAL` (unexpected; see the server log). `src/view.ts` bundles the view from `src/views/records.tsx` when it is first imported, in about 50 ms, so nothing builds it beforehand.

## Manifest

```sh
UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-e2e test
```

Rewrites `manifest.json`, the provider's contract. The conformance kit's `manifest_matches_snapshot` fails, naming this command, whenever the file and the definitions differ; run it and commit the file with the change. Moving onto Postgres left it byte for byte the same.

## Run it

```sh
bun mcp db e2e migrate
bun run toolbox:dev      # http://localhost:47400/mcp, as e2e_*, and http://localhost:47400/e2e/mcp
```

Register the resource, a client and the Toolbox's machine client in ID first, or run `bun mcp dev e2e`, which does it: [Connect Claude Code](../../apps/web/content/docs/mcp/claude-code.mdx#the-e2e-server).

## Tests

```sh
bun run mcp:test
bun run mcp:check @answerable/mcp-e2e
```

The tests serve the provider with `createTestMcp` from `@answerable/mcp-postgres/testing`, over schema `e2e` of `answerable_mcps_test` on the development Postgres. `bunfig.toml` gates 100% line and function coverage of `src`. `src/provider.test.ts` runs the conformance kit, with a fresh record made in the caller's organisation for `records.delete` and a version bump as `moveTarget`, and checks the tools an entitled caller sees. The tests in `src/tools` check pagination and cursors, a create in the caller's organisation alone, and a delete's stale target and another organisation's record. `src/apps.test.ts` renders the real view in Chromium through the official MCP Apps host bridge (`src/testing/host.ts`): it creates a record, shows the summary before deleting it, and hides writes from a reader; the view never receives a token. That its records agree between the Toolbox's hub and its path, and survive a restart, is `mcps/toolbox/src/alone.test.ts`.
