# Changelog

## 0.3.0

Its records live in Postgres, in schema `e2e`, each organisation's limited to it by row-level security, and it is laid out as `bun mcp new` lays an MCP out: `src/mcp.ts`, `src/provider.ts`, one file per tool in `src/tools`, `src/db/schema.ts` and `drizzle/`. It is served both ways (`mcp.json`: `both`, `shared`), by the Toolbox and the standalone server. Its contracts are unchanged: `manifest.json` is byte for byte the same, at version `2026-09-29`.

- Breaking: `exports` is `./provider` alone, the provider as plain data. `createE2eProvider`, `createRecordStore` and its `touch`, `./mcp`, `./records` and `./view` are gone; a test makes and moves records through the database.
- `src/server.ts`, its `MCP_ID_*` machine client and `bun run mcp:dev` are gone: the standalone server serves it (`bun run standalone:dev`).
- The view is bundled when `src/view.ts` is first imported, so `dist/`, `scripts/build.ts` and `bun run build` are gone.

## 0.2.0

The server reads who is calling from ID, so it needs a `platform:read` machine client: `MCP_ID_CLIENT_ID` and `MCP_ID_CLIENT_SECRET`. Without them it refuses to start, naming them. The provider has a description, which the manifest carries, and every tool but `records.delete` carries its example.

## 0.1.1

`bun run build` finds the view's entry file in a checkout whose path has a space or a non-ASCII character. No tool changes.

- `exports` gains `./view`: `viewHtml`, the built `dist/records.html` read once, for this server and the Toolbox, which used to derive the file's path from `./mcp`'s location. Without a build it throws `Missing the e2e records view. Run bun run --filter @answerable/mcp-e2e build first.`, the message the Toolbox gave; this server's said `Missing records view.`

## 0.1.0

The reference server, on `@answerable/mcp`, and the first provider the Toolbox mounts.

- `createE2eProvider({ records, viewHtml })` returns the provider `e2e`: `identity.get`, `records.list`, `records.show` with an MCP Apps view, `records.create` (agent class), `records.delete` (controlled class, with the record's `version` as a target), the prompt `fixture_walkthrough` and the resource `fixture://guide`.
- `createRecordStore()` keeps records per organisation in memory; `touch` moves a record's version as another writer would.
- `manifest.json` is the provider's contract. `src/conformance.test.ts` runs the conformance kit against it, `src/mcp.test.ts` calls every tool in-process, `src/records.test.ts` tests the store, `src/apps.test.ts` renders the view in Chromium through the MCP Apps host bridge and `src/server.test.ts` builds the view and starts the entry point.
- `exports` `./mcp` and `./records` are what the acceptance and the Toolbox import; `bun run mcp:dev` serves it on port `47500`.
