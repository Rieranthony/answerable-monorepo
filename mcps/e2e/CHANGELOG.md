# Changelog

## 0.1.0

The reference server, on `@answerable/mcp`, and the first provider the Toolbox mounts.

- `createE2eProvider({ records, viewHtml })` returns the provider `e2e`: `identity.get`, `records.list`, `records.show` with an MCP Apps view, `records.create` (agent class), `records.delete` (controlled class, with the record's `version` as a target), the prompt `fixture_walkthrough` and the resource `fixture://guide`.
- `createRecordStore()` keeps records per organisation in memory; `touch` moves a record's version as another writer would.
- `manifest.json` is the provider's contract. `src/conformance.test.ts` runs the conformance kit against it, `src/mcp.test.ts` calls every tool in-process, `src/records.test.ts` tests the store, `src/apps.test.ts` renders the view in Chromium through the MCP Apps host bridge and `src/server.test.ts` builds the view and starts the entry point.
- `exports` `./mcp` and `./records` are what the acceptance and the Toolbox import; `bun run mcp:dev` serves it on port `47500`.
