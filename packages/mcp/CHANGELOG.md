# Changelog

## 0.9.0

The V0 cleanup of the kit.

- A request that fails outside a tool, such as `allow`, `project` or `policyClass` throwing something other than a `ToolError`, is logged as `[mcp] request failed` with the error; it answered HTTP 500 with nothing in the log. The SDK's refusals of a malformed request, such as an unsupported protocol version, are logged on the same line.
- When `allow` throws a `ToolError`, the call answers its envelope only for a name a tool could have: lowercase letters, digits and underscores, up to 64. Any other name answers unknown tool. The server used to register the name as sent, and the SDK printed it, newlines included, in five warning lines.

## 0.8.0

`Intent` loses `approval`, which the policy class gives and nothing read. Breaking for a custom `IntentStore` and for code that builds an `Intent`. A prepare tool still returns `approval` to the caller, derived from the class.

## 0.7.0

The conformance kit keeps only the checks a provider built with the SDK can fail, and the server closes three gaps the test audit found. Breaking: ten kit checks and the three todo entries are gone, a JSON-RPC batch answers `400`, and `errorOf` reports a malformed envelope with the parser's own error.

- The kit runs `output_schema_declared`, `list_paginates`, `read_has_no_side_effect`, `manifest_matches_snapshot`, `prepare_has_no_side_effect`, `preview_is_semantic`, `targets_have_versions`, `commit_rejects_stale`, `receipt_is_structured` and `descriptions_operational`. `identity_is_stable`, `name_is_host_safe`, `input_schema_is_closed`, `timeout_bounded`, `deprecations_mirrored`, `errors_use_envelope`, `commit_requires_token`, `commit_rejects_expired`, `commit_is_idempotent` and `commit_rejects_other_principal` are gone: the SDK enforces each on every provider, and this package's own tests hold them. The todo entries `approval_bound_to_digest`, `secrets_declared` and `egress_guarded` are gone; the design standard keeps them as Not yet.
- For a mutation that prepares no targets, `targets_have_versions` and `commit_rejects_stale` are registered as skipped, with the reason in their names, instead of passing having checked nothing. The kit prepares each mutation once while it registers the checks, to see whether it has targets.
- Inside the kept checks, the assertions the SDK makes impossible to fail are gone: an object output, a version kind, the receipt's shape and the description's length.
- A commit reruns `policyClass` for the caller: when the class is stricter than the intent's, it answers `APPROVAL_REQUIRED` with the class and commit tool a fresh prepare would give, and the intent stays prepared (R19).
- A JSON-RPC batch at the MCP endpoint answers `400` with the JSON-RPC error `-32600`, so that `allow` always learns which tool a call names.
- The memory intent store removes, at an insert at most once a minute by its clock, the intents that can no longer be committed (expired, failed and stale) and committed ones a day after their commit; a repeated commit replays its receipt for a day.
- The tool context's signal is the SDK's request signal, which already aborts when the HTTP request does.

## 0.6.2

`testPrincipal` sets `upstreamAuthTime`, which `@answerable/auth` 0.5.0 makes a required field of `UserPrincipal`: the current time in seconds, as for a person who has just signed in at their directory, unless `overrides` replace it.

## 0.6.1

Documentation only: the docs now render their type tables from these types, so every field says what it is. No behaviour changes.

- Every field of what `defineTool`, `defineMutation` and `defineProvider` take, of `ToolContext`, `Target`, `Preview` and `McpServerConfig` has a doc comment; the inline options of the three `define*` functions (`timeoutMs`, `errors`, `risk`, `effects`, `id`, `version`, `tools`, `prompts`, `resources`) are written out one per line with theirs.
- `input` and `output` carry `@remarks \`ZodObject\``, the short type a docs table shows.
- `execute` says what it receives and returns.

## 0.6.0

What the Toolbox's meta projection, its intents in Postgres and `tools/list_changed` need from `createMcpServer`. Breaking: `createMcpServer` returns `McpServerHandle`, and `wrapCall` runs around commit calls too.

- `project(principal, usable)`: which of the tools a caller may use are served to them as tools, for a hub that offers some capabilities through its own tools. The others stay usable: their intents commit, and `call` runs them. A tool the caller may not use is never served, whatever it returns.
- `createMcpServer` returns `{ fetch, toolsChanged, call }`, typed `McpServerHandle`. `toolsChanged()` sends `notifications/tools/list_changed` to every caller that listens with `subscriptions/listen` (2026-07-28); a 2025 caller has no stream to carry it. `call(tool, args, context)` runs a served tool exactly as its direct call runs it, for a hub's own tools; it does not decide whether the caller may use the tool and runs inside the calling tool's `wrapCall`.
- Every server advertises `tools.listChanged: true` on every request, a hub's `initialize` included. Listen streams send a keep-alive every 5 seconds, since `Bun.serve` closes a connection idle for 10 seconds by default.
- `wrapCall` runs around commit calls: `ToolCall.tool` is then `{ kind: "commit", identity, version }`, at the provider's version.
- `APPROVAL_REQUIRED` for a human-class intent carries `details.approval.status: "pending"`.
- A tool that runs another served tool passes on the custom codes that tool declares, instead of answering `INTERNAL`.

## 0.5.0

The kit judged as one: fewer options, one definition of each helper. Breaking: three server options and the options of `createTestMcp` are gone.

- `RESULT_TOO_LARGE` joins the standard codes, retry `after_fix_input`: a result above 100 KiB; the caller narrows the request. The Toolbox answers it for a read, in place of the truncation notice.
- `riskClass` is exported: the policy class each risk gives a mutation by default.
- `@answerable/mcp/testing` gains `errorOf(result)`, which reads the error envelope of a failed call and says what is wrong with one that is not, and `testPrincipal(overrides?)`, a verified caller for unit tests. The conformance kit reads envelopes with `errorOf`.
- `tools/list` always tells 2026-07-28 hosts they may keep it for 30 seconds, for that caller alone. The `cacheHints` option is gone.
- `allowedHosts` and `allowedOrigins` are gone: the Host header and a browser Origin must name the resource URL's host.
- `createTestMcp` takes only a provider or a function that builds the server; pass `intents`, `policyClass` or another resource through `createMcpServer` in that function. The MCP's URL is `https://mcp.test/mcp`.
- `wrapCall` returns what `run` returns or throws; it no longer promises that a replacement is sent.
- `Intent` no longer carries `committed_at`; its `receipt` has it.
- Definition errors name the definition and say what to change: a bad view, prompt or resource name, an empty view, a `ui://` or invalid resource URI, a provider mounted twice, two views at one URI, and a view that bundles to extra files.

## 0.4.0

What a hub such as the Toolbox needs from `createMcpServer`, each option off by default, and `createTestMcp` for a hub.

- `mount`: providers served beside `provider` at one endpoint. Their tools are named `<provider id>_<wire name>` and listed after `provider`'s own, which keep their names; every mutation commits through `provider`'s commit tools; views keep their `ui://` URIs, and two providers that define different views at one URI are refused, as is a provider mounted twice. Mounted prompts and resources are not served, and `scopes_supported` lists `provider`'s scopes only.
- `allow(principal, tool, called)`: decides which tools a caller sees and may call, in place of the scope rule, for each request that lists or calls tools or reads views; other requests, such as `initialize`, see no tools and run no decision. `called` is true for the tool a `tools/call` names, so a hidden tool that was asked for can be recorded. A `ToolError` thrown by `allow` answers any call with its envelope, whatever the call names; a list fails. A commit rechecks the same decision. With `allow`, the server reads a copy of each request's body to learn its method and tool.
- `wrapCall(call, run)`: runs around every call of a tool or a prepare tool, with `ToolCall` (`tool`, `name`, `principal`, `executionId`, the JSON-RPC `requestId` and the request's `meta`). `run` parses, executes and checks the output; the wrapper returns that content or a replacement the output schema accepts, and what it throws answers the call. Commit calls do not pass through it.
- `cacheHints`: the 2026-07-28 revision's cache hints for list results, passed to the MCP SDK.
- `policyClass` may return a promise.
- `createTestMcp` also takes `(auth) => server` in place of a provider, to serve a hub in-process.
- A commit refused because the caller can no longer use the mutation says `Your access no longer covers <identity>`, without the scopes, since `allow` may decide instead of scopes.
- `UserPrincipal` has `organizationAuthorizationVersion` (`@answerable/auth` 0.2.0); the conformance kit's caller has version 1.

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
