# Changelog

## 0.3.0

The conformance kit, declared errors and documentation comments on every export. Breaking: a handler that throws an undeclared custom error code answers `INTERNAL`.

- `@answerable/mcp/testing` gains `assertProviderConformance(provider, fixture)`, which registers one `bun:test` test per check of the standard's read, mutate and provider checklists, under the standard's names. The fixture is `manifest` (the committed file), `examples` (one valid input per tool and mutation, or a function of the caller's principal that sets up state) and `moveTarget` (for a mutation that prepares targets). The kit serves the provider with `createTestMcp`, its own intent store and clock and one signed-in caller; a high-risk mutation runs as controlled, because human approvals are not built. `approval_bound_to_digest`, `secrets_declared` and `egress_guarded` are `test.todo`. `UPDATE_MANIFEST=1 bun run test` writes the manifest snapshot; the drift failure names it.
- A tool or mutation takes `errors`: the custom `<PROVIDER>_<CODE>` codes it throws, none by default. Standard codes need no declaration. An entry must be a custom code, and `defineProvider` requires it to start with the provider's id in capitals. A handler that throws an undeclared custom code answers `INTERNAL`, and the server log names the code to add. `manifest(provider)` lists a definition's `errors` when it has any.
- `Change`, `IntentStatus` and `Served` are exported. `Target` and `Preview` are written out as types rather than aliases of Zod schemas, so the reference shows their shape; `Change` keeps `from` and `to` optional. `createMcpServer` takes one `config` argument and `createMemoryIntentStore` one `options` argument, with the same fields.
- Every export carries a documentation comment. `bun run --filter @answerable/mcp reference` generates `apps/web/content/docs/mcp/reference.mdx` from them, and a test fails when the page drifts.
- `createTestMcp` lives in its own module; `@answerable/mcp/testing` still exports it.

## 0.2.0

Prepared mutations. Breaking: a `Tool` carries `kind: "read"`, and provider tools are a union of `Tool` and `Mutation`.

- `defineMutation` takes a read tool's fields with `prepare` and `commit` in place of `execute`, plus optional `risk` (`low`, `normal` by default, `high`), `effects` (from the six-name vocabulary) and `expiresInMs` (may shorten the class's expiry, never lengthen it). Its scopes default to `<provider>:write`; `kind: "mutate"` is derived.
- `prepare` returns `{ targets, preview, plan? }`: versioned targets, a preview whose `summary` is 1 to 500 characters and whose arrays default to empty, and the author's own plan data, stored as JSON and typed through to `commit`. A preview naming an effect the definition does not declare answers `INTERNAL` and logs the definition to fix.
- Each mutation is a prepare tool (read-only annotations, `_meta` with `kind: "mutate"`, `risk` and `policy_class`, input plus `validate_only`) returning the intent with a single-use `act_` commit token. A server with mutations adds `<id>_commit` and `<id>_commit_confirmed` (the latter destructive, with `anthropic/requiresUserInteraction`), listed when the caller can use at least one mutation; they return the receipt.
- Commit checks the principal first, then status (replay, `COMMIT_IN_PROGRESS`, `INTENT_EXPIRED`, `INTENT_STALE`, `INTENT_CONSUMED`, `APPROVAL_REQUIRED`), the served version and scopes, the token hash and the tool for the class; claims the intent by compare-and-set; runs `prepare` again and answers `INTENT_STALE` with `details.targets` when a target moved, disappeared or appeared; then commits and stores the receipt. `timeoutMs` bounds the prepare and the commit; a timed-out commit finishes in the background.
- Policy classes: `agent` (10 minutes), `controlled` (30 minutes), `human` (24 hours, recorded as `awaiting_approval`; approvals are not built). `createMcpServer({ policyClass })` decides the class per caller; the default follows `risk`.
- `IntentStore` (`now`, `insert`, `get`, `transition`) and `createMemoryIntentStore({ now? })`, the default per server. `createMcpServer({ intents })` and `createTestMcp(provider, { intents, policyClass })` take a store; `connect({ membershipId, clientId })` pins the principal.
- `manifest(provider)` gives mutations `risk` and `effects`, their input without `validate_only` and their results schema as `output`, and lists the two commit tools with `kind: "commit"`.

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
