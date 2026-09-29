# Changelog

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
