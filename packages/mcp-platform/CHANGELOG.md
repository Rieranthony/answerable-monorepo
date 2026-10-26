# Changelog

## 0.2.0

- `mcpDatabases(…).assert()` also checks each own MCP's login with `@answerable/mcp-postgres`'s `assertOwnLogin`, so the Toolbox and the standalone server refuse to start on an own MCP's URL that names another login.
- `ownDatabases` names an own MCP's local database and login with `ownMcpDatabase`.
- `traced`, `organisationActions` and `userActions` are no longer exported: nothing outside the package imported them, and `createCalls` and `startAuditPoller` still use them.

## 0.1.0

What the Toolbox and the admin MCP each built by hand, in one package that they and the standalone server use.

- `createCalls`: evidence for every call and every refusal, a refusal because ID did not answer the authority read included (`authority_unavailable`), which closes `Q-SDK-ALLOW-EVIDENCE` with `@answerable/mcp` 0.12.0's `ToolCall.intent`; a commit's row names the intent it applied and its receipt, and its upstream is its intent's capability's.
- The spans of the Toolbox, `createTracer(service, endpoint?)`, `createMemoryTracer` and `traced`, on OpenTelemetry JS SDK 3.0 (`@opentelemetry/sdk-trace` 3.0.0, `@opentelemetry/resources` 3.0.0, `@opentelemetry/exporter-trace-otlp-http` 0.300.0, `@opentelemetry/api` 1.10.0): `TracerProvider` replaces `BasicTracerProvider`, and span processors take `{ exporter }`.
- The Toolbox's audit-log poller as `startAuditPoller({ id, caches })`, which invalidates any number of caches.
- `perRequest`, `health`, `mcpDatabases`, `ownDatabases`, and `testSharedMcps` and `testOwnMcp` in `@answerable/mcp-platform/testing`.
