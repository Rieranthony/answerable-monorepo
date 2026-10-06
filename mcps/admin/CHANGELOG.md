# Changelog

## 0.2.5

Answerable ID dropped the columns nothing wrote. `organisations_update` renames an organisation only: its input requires `name` and no longer takes `logo` or `metadata`. Group tools no longer take or report a directory id, and client reads no longer carry the registration fields ID never stored. `manifest.json` regenerated.

## 0.2.4

`@answerable/mcp-postgres` 0.3.0. No tool changes. Recreate a database migrated before this version: drop its `public` schema, then run `db:migrate`, which records `mcp-postgres/0001_evidence.sql` and `mcp-postgres/0002_intents.sql` with their checksums. Intents are swept like the memory store's, so a committed one leaves the table a day after its commit; payload bodies are verified; evidence events lose four columns nothing wrote.

## 0.2.3

ID asking to be asked again is no longer a refusal. No tool changes its schema.

- `409 operation_in_progress` (a write with the same key still running) and `503 database_busy` answer `UPSTREAM_UNAVAILABLE` with `retry.after_ms` from ID's `Retry-After` when it sends one, else 1,000. `409 operation_in_progress` used to answer `UPSTREAM_REJECTED`. A write that meets it is not sent again: the commit says ID may or may not have applied it.
- The test audit's tables: every tool that takes an organisation is refused on the platform organisation to an admin and to an owner with a stale sign-in, and each critical tool needs a recent sign-in at prepare and at commit. Dropping the guard from `access_grant`, or freshness from `staff_revoke`, failed no test before. A test reads the workspace's imports: nothing comes from `apps/id`.
- The test helper for the test database comes from `@answerable/mcp-postgres/testing`; the read tests are one table of the query string each read sends to ID.

## 0.2.2

The goal's cleanup pass. No tool changes behaviour or schema.

- `access_list`'s description says that a row with a `clientId` reaches its resource through that client only, such as the one `toolbox_enable` makes for each host client beside the grants for people.
- `ADMIN_FRESH_SECONDS` unset leaves the window to `createAdminMcp`, whose default, 1,800 seconds, is now the only one.
- One rule for what confers a role, `grantString` and `confers` in `src/roles.ts`, serves both the role read and the staff tools; the slug and member id schemas and the missing-organisation and missing-member messages are shared by the reads and the writes.

## 0.2.1

The package exports `./admin` (`createAdminMcp`) and `./platform` (`readPlatform`), which the acceptance imports to run the admin MCP in its journeys and its lane. Nothing else changes.

## 0.2.0

The writes, each a prepared intent of the controlled class: the host shows the preview and commits with `admin_commit_confirmed` and its summary.

- Eleven ordinary writes for `admin` and above: `organisations_create`, `organisations_update`, `domains_add`, `sso_set` (Answerable's Microsoft or Google application only), `groups_create`, `groups_addmember`, `groups_dropmember`, `access_grant`, `access_revoke` (disables), `access_enable` (enables again; `access_grant` names it for a disabled entitlement) and `toolbox_enable` (the Toolbox's enable call, with a `toolbox:admin` token from the same machine client).
- Four critical operations for `owner` with a directory sign-in within `ADMIN_FRESH_SECONDS`: `organisations_disable`, `organisations_enable`, `staff_grant` and `staff_revoke`. Older or unknown answers `ADMIN_REAUTHENTICATION_REQUIRED`, at prepare and again at commit, recorded as `capability.denied` with reason `stale_authentication`.
- Every write to the platform organisation is critical too, whatever the tool: an admin could otherwise add themselves to the owner group.
- Targets bind ID's ETags; commit sends them as `If-Match`, or `If-None-Match: *` for a first SSO provider or membership, where ID takes one, and the preview says when ID takes none. Every write sends the intent's key, minted at prepare, as `Idempotency-Key` (`<key>.<step>` for several), and the execution id as `x-request-id`; a write ID does not answer is sent once more with the same key. Receipts carry ID's `Operation-Id`.
- `admin_whoami` lists the commit tools with the writes.

## 0.1.0

The read side of the admin MCP, for Answerable staff.

- Only members of the platform organisation get a tool; the server learns that organisation at start from ID's `GET /me` and refuses to start when its machine client belongs to another.
- Roles `team`, `admin` and `owner`, conferred by `answerable-team`, `answerable-admin` and `answerable-owner` on an entitlement to the admin MCP's resource with no client, read from ID's member access view once per request and never cached. ID not answering fails closed.
- `admin_whoami` for every platform member, and nine reads for `team` and above: `organisations_list`, `organisations_get`, `members_list`, `members_get`, `groups_list`, `access_list`, `audit_list`, `sso_test` and `staff_list`. They take ID's parameter names and answer ID's field names.
- Every call and refusal is evidence on the platform organisation's chain in `answerable_admin`; every ID call carries the execution id as `x-request-id`.
