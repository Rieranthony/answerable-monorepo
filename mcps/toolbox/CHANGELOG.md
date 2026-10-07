# Changelog

## 0.3.4

No tool changes. `readToolboxEnvironment` is built on `@answerable/mcp`'s `parseEnvironment`, with the same messages, and the error code that evidence and spans record comes from its `errorCodeOf`.

## 0.3.3

The schema audit's reset of the Toolbox's tables, with `@answerable/mcp-postgres` 0.3.0. Recreate a database migrated before this version: drop its `public` schema, then run `db:migrate`.

- `migrate(db)` applies `@answerable/mcp-postgres`'s migrations, then `migrations/0001_initial.sql`, which holds the catalogue and the host clients (`0001_catalogue.sql` and `0003_host_clients.sql` before). `schema_migrations` lists `mcp-postgres/<file>` and `toolbox/<file>`, each with its checksum.
- `providers` keeps only `id`: `version`, `manifest`, `registered_at` and `status` were written at every boot and never read, since the manifest in process is the source of truth.
- `capabilities.status`, never written, and the GIN index on `capabilities.search`, which the planner never used at this size, are gone; the generated column stays.
- Intents are swept like the memory store's, payload bodies are verified, and evidence events lose four columns nothing wrote.

## 0.3.2

The poller reads every audit event that can change what a member may use.

- `capability.*` events invalidate the organisation they name: a capability is the organisation's ceiling.
- `user.*` events, such as `user.disabled` and `user.erased`, name no organisation; they invalidate the user they name in every organisation. `GrantsReader.invalidate(organisationIds, userIds?)` takes the users, and each cached entry keeps its user id.
- The action prefixes are exported (`organisationActions`, `userActions`), and a test fails when one of them names no action ID's source emits.

## 0.3.1

Uses the extracted packages. No behaviour changes except one message.

- `createIdAdmin`, `IdError`, `found` and the fake ID come from `@answerable/id-admin`; `createEvidence`, `createPostgresIntentStore` and `withEvidence` from `@answerable/mcp-postgres`. The files `id.ts`, `evidence.ts`, `intents.ts`, `intent-evidence.ts`, `test/fake-id.ts` and the migrations `0002_evidence.sql` and `0004_intents.sql` moved there with their tests, and the migrator now reads the Toolbox's `migrations/` and the package's. `migrate(db)` still applies `0001` to `0004` in order, and a database that applied them before applies none again.
- The `./evidence` and `./id` exports are gone; `./migrate` stays and still migrates a Toolbox database in full.
- ID refusing the machine client's credentials now reads `Answerable ID refused the client credentials of <client id> (<status>)…` instead of naming the Toolbox's variables.

## 0.3.0

One machine client, and one place for each thing the merge of 0.2.0 left twice. Breaking for code that builds the Toolbox.

- `createToolbox`, `createGrantsReader` and `startGrantsPoller` take `id: IdAdmin`, made once with `createIdAdmin(config)` and shared, in place of `IdConfig`: the grants reader and the poller share one `platform:read` token, and the Toolbox asks ID for two tokens in all where it asked for three. `@answerable/mcp-toolbox/id` exports `createIdAdmin`.
- `IdAdmin.get` fails on ID's 404 like every other call; `found(answer)` turns a 404 into `undefined` where it is an answer, for the grants reader and the enable operation alike.
- Host client settings live in `catalogue.ts` alone: `hostClientSettings` holds the defaults (`auto`, 40) and bounds (1 to 128) the admin API and `writeHostClient` both apply, and `listHostClients` and `removeHostClient` join `readHostClient` and `writeHostClient`. The admin API reuses the catalogue's `overridesSchema`, now strict.
- The `./catalogue` export is gone: the acceptance sets a policy class through the admin API.
- `admin-catalogue.ts`, `id-client.ts` and `whoami.ts` are merged into `admin.ts`, `admin-enable.ts` and `meta.ts`, their only callers; the two test hubs are one.
- The admin API verifies its tokens with `@answerable/auth` 0.4.0's `subjectType: "client"`. `host_client_not_found` and `organisation_not_found` say where the ids that exist are listed.

## 0.2.0

A person's whole capability surface and its administration: mutations through the hub on Postgres, the meta projection, host client settings, `tools/list_changed`, the platform-tier admin API and the operation that enables an organisation.

- Intents live in Postgres: `createPostgresIntentStore(db, { now? })` on the `intents` table (migration `0004_intents.sql`), each status change a compare-and-set, expiry judged on the database's clock unless a test injects one. `withEvidence(store, evidence)` records every transition: `intent.prepared` with the preview as an erasable payload, `intent.approval_requested`, `intent.committed` and `receipt.issued`, `intent.stale`, and `intent.expired` once.
- Commit calls leave a `capability.completed` row and a span like every other call; a prepare or a commit row names its intent, and a commit its receipt.
- An organisation's `policy_class` override sets a mutation's class through the hub; a human-class intent waits as `awaiting_approval`, and both commit tools answer `APPROVAL_REQUIRED` with the approval pending. Approval pages: not yet.
- Host clients: `host_clients` (migration `0003_host_clients.sql`) holds each host client's `projection` (`direct`, `meta` or `auto`, the default) and `direct_limit` (40 by default), read on every request; `readHostClient` and `writeHostClient` in `./catalogue`.
- The meta projection: `toolbox_search` (Postgres full text, paged), `toolbox_describe` (manifest schemas for up to 5 identities), `toolbox_execute` (a read) and `toolbox_prepare` (a mutation) join `toolbox_whoami`. `auto` serves it above `direct_limit` granted tools. A meta call's evidence and span are those of the capability it ran or refused.
- A grants invalidation that names an organisation sends `tools/list_changed` to every listening 2026-07-28 caller.
- `/admin/v1`, served by the same `fetch` as the MCP endpoint: `GET /providers`, `GET` and `PUT` an organisation's catalogue entry, `POST /organisations/{id}/enable`, host clients (`GET`, `PUT`, `DELETE`) and `GET /organisations/{id}/evidence/verify`. It answers `{ error: { code, message } }` and needs a machine client's token for the admin resource, `toolboxAdminResource(TOOLBOX_RESOURCE_URL)` (the origin and `/admin`), with `toolbox:admin`; it needs `@answerable/auth` 0.3.0. A person's token is refused with `401`. There is no new variable.
- The enable operation reads what ID holds, stops on a row that does not fit, then makes what is missing: the Toolbox resource's allowed scopes (a union, never a replacement), each host client's link, the organisation's login and `toolbox` capabilities and entitlements, and the catalogue rows. Repeating it changes nothing. The Toolbox's machine client needs `platform:write` besides `platform:read`; the enable operation uses a token of its own for both, and reads still use `platform:read` alone.
- `createIdAdmin` gains `manage`, and every failure of ID's admin API or token endpoint is an `IdError` with the status and ID's problem code (status 0 when ID did not answer).
- `ingest` appends the identities of capabilities a provider never had before to `overrides.disabled` of every organisation that has the provider enabled (`Q-TOOLBOX-NEW-CAPABILITIES`: off until enabled).
- `@answerable/mcp-toolbox/admin` exports `toolboxAdminResource`.

## 0.1.0

The Toolbox core: one MCP endpoint that mounts providers, reads each caller's grant strings from ID with a cache and an audit-log poller, holds the catalogue, serves the direct projection with `toolbox_whoami`, records a hash-chained evidence row and a span for every call, and answers `/health`.
