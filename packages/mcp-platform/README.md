# Answerable MCP platform

What every server Answerable runs shares, so that the Toolbox, the standalone server and the admin MCP record, check and serve the same way: the evidence and spans of every call and every refusal, the audit-log poller, `/health`, and each MCP's database from its server's generated list. Lifted from the Toolbox and the admin MCP ([audit finding 12](../../docs/goals/mcp-cli/briefs/m4.md)). Private to the monorepo; no npm release.

```ts
import { createIdAdmin, createIdProfiles } from "@answerable/id-admin"
import { createMcpServer } from "@answerable/mcp"
import { createCalls, createTracer, health, mcpDatabases, startAuditPoller } from "@answerable/mcp-platform"
import { connect } from "@answerable/mcp-postgres"
import { served } from "./served.generated"

const db = connect(process.env.MY_SERVER_DATABASE_URL!)                            // the server's own database: intents and evidence
const mcps = mcpDatabases(served, { shared: process.env.MY_SERVER_MCPS_DATABASE_URL!, own: {} })
await mcps.assert()                                                                // the serving login holds its MCPs' runtime roles, and nothing more; each own MCP's login is its runtime login
const calls = createCalls({ db, spans: createTracer("my-server").tracer, salt: resource })
const profiles = createIdProfiles(id)
startAuditPoller({ id, caches: [profiles] })
const [{ provider, db: mcp }] = mcps.mount
const server = createMcpServer({ provider, db: mcp, auth, profiles, intents: calls.intents, allow: calls.allow(decide), wrapCall: calls.wrapCall })
const healthy = health({ server: db.$client }, [provider.id], mcps.pools)      // GET /health
```

- **`createCalls({ db, spans?, salt, organisation?, denials?, upstream?, readLimit? })`.** `evidence` and `intents` on the server's database, and the `allow` and `wrapCall` of `createMcpServer`:
  - `allow(decide)` records a refusal of the called tool as `capability.denied` with `decide`'s `{ reason, data }`, and a refusal because `decide` threw, such as ID not answering the authority read, as `capability.denied` with reason `authority_unavailable` and the error's code, before the SDK answers it.
  - `wrapCall` runs every call in a span and records it once it settles: `capability.completed`, a success with `data.result_bytes`, the intent a prepare made or a commit applied (the SDK's `call.intent`, even when the commit fails) and a commit's `receipt_id`, or a failure with its `error_code`; or `capability.denied` for a code `denials` names (the admin MCP's stale sign-in). `upstream(identity)` names the service a capability calls, a commit's from its intent's capability. A read above `readLimit` bytes answers `RESULT_TOO_LARGE`.
  - `attribute(executionId, tool, reason?)`, from inside a hub's own tool, makes the call's span and evidence the capability it ran or, with `reason`, refused.
  - Every row joins `organisation(principal)`'s chain: the caller's organisation, unless a server keeps one chain, as the admin MCP keeps the platform organisation's. Without `spans`, spans go nowhere and rows name no trace.
- **`createTracer(service, endpoint?)`, `createMemoryTracer()`.** The tracer `createCalls` takes as `spans`: one server span per call, named `tools/call <identity>`, with the MCP, GenAI and Answerable attributes and a W3C `traceparent` from `_meta` as its parent; exported over OTLP/HTTP when `endpoint` (`OTEL_EXPORTER_OTLP_ENDPOINT`) is set, on OpenTelemetry JS SDK 3.
- **`startAuditPoller({ id, caches, intervalMs? })`.** Reads ID's audit log of successes every 15 seconds and calls `invalidate(organisationIds, userIds)` on every cache, the Toolbox's grants and every server's `createIdProfiles`, for the organisations and the users the events name. One poll at a time; a failed poll is logged as `[poller] reading ID's audit log failed`, and the next one catches up.
- **`perRequest(read)`.** `read`, once per request: every decision of a request shares one read for its principal.
- **`health(own, providers, mcps?)`.** `GET /health`, the readiness check: `200` with `{ status: "ok", databases, providers }` while each of the server's own databases answers `select 1`, else `503` with `status: "unavailable"`. `databases` names each `ok` or `unavailable`, the MCP databases of `mcps` too: one that fails, or takes more than 250 ms, is `unavailable` and never fails the check, since a busy MCP pool is load, not a fault of the pod.
- **`mcpDatabases(declared, { shared, own, prefix? })`.** From a server's generated list (`Declared`: a provider and `shared`, or `own` with the `variable` its URL comes from): one pool to the shared database as the serving login, one per own MCP, and each MCP's `db` through `mcpDatabase`, with the call's organisation (`callerOrganisation`). `mount` for `createMcpServer` or `createToolbox`, `pools` for `/health`, `assert()` (`assertServingLogin` on the shared pool and `assertOwnLogin` on each own MCP's, to await before listening) and `close()`. `prefix` is `mcp`; a test that serves a database of its own names its own.
- **`ownDatabases(declared)`.** The configuration fields of the own MCPs of a generated list, for `defineConfig`, and `urls(data)`, their parsed values by variable.

`@answerable/mcp-platform/testing` makes the databases a server's suite serves, on the development Postgres, each its own: `testSharedMcps({ name, prefix, mcps })`, a shared MCP database owned by the migrator login with each provider provisioned under the suite's role `prefix` and migrated, and a fresh serving login (`url`); and `testOwnMcp({ name, provider })`, an own MCP's database with its owner and runtime logins (`url`). `close()` drops the database, the logins and the roles the prefix made, so suites with different prefixes run at once.

```sh
bun run --filter @answerable/mcp-platform test
bun run mcp:check @answerable/mcp-platform
```

The suite needs the development PostgreSQL 17 on port 47432: it makes `answerable_mcp_platform_test`, `answerable_mcp_platform_test_empty`, `answerable_mcp_platform_test_own` and `answerable_mcps_test_platform` with the role prefixes `mcp_plt` and `mcp_plte`, and drops them. `bunfig.toml` gates 100% line and function coverage over `src`. Changes: [CHANGELOG](CHANGELOG.md).
