# Changelog

## 0.1.0

The tool model for capabilities. Breaking: servers take a provider, and tool names are dotted.

- `defineTool` takes five fields (`name`, `description`, `input`, `output`, `execute`) and defaults the rest: `version` and `scopes` from the provider, `timeoutMs` 25,000 (at most 55,000). Names are `<domain>.<operation>`; descriptions are 40 to 1,000 characters; `input` is closed with `.strict()`. `annotations` is no longer an author field.
- `defineProvider({ id, version, tools, prompts?, resources? })` fills identity, version and scopes (default `<id>:read`) and refuses duplicates, conflicting views and a deprecation whose replacement is not a current tool.
- `createMcpServer({ provider, auth })` replaces `createMcpServer({ name, version, auth, tools, prompts, resources })`. The wire name is the tool name with `_` for `.`; annotations are derived; `_meta["com.answerable/capability"]` carries identity, version, kind and deprecation; a deprecation is mirrored into the description.
- Every tool failure is an `isError` result whose one text block is the JSON envelope `{ error: { code, message, retry, details?, request_id } }`, with no `structuredContent`, so MCP SDK 1.x clients (which check structured content against the output schema even on errors) return it instead of throwing. `ToolError(code, message, { retry?, details? })` takes a standard code (`errorCodes`) or a `<PROVIDER>_<CODE>` with a retry policy. Invalid input answers `INVALID_INPUT` with `details.field_violations`; a handler past its timeout answers `TIMEOUT`; anything else answers `INTERNAL` (formerly `tool_failed`).
- The handler context gains `executionId`, a UUIDv7 per call and the envelope's `request_id`.
- `manifest(provider)` serialises a provider's contract for review and drift tests.
- `createTestMcp(provider, options?)` replaces `createTestMcp(auth => server, options?)`.
- Prompts and resources take optional `scopes`, defaulting to the provider's.
