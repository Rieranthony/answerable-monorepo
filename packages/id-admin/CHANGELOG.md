# Changelog

## 0.2.0

The fake ID serves a second consumer, the admin MCP. `createIdAdmin` is unchanged.

- `createFakeId` takes the machine client (`clientId`, `clientSecret`), its organisation (`fake.organizationId`, the platform organisation unless `platform` is false) and the audiences it may get tokens for (`resources`), with the Toolbox's values as defaults. A token works only at the admin API of the audience it was issued for.
- New routes, with ID's shapes: `GET /me`, organisations, domains, the SSO provider and its connectivity test, members, a member, groups, `listTargetAccess`; entitlements and audit events take ID's filters. Every list is newest first, as ID's are; capabilities and entitlements were oldest first.
- New helpers that add ID's rows: `organisation(id, fields?)` returns the full row, and `domain`, `ssoProvider`, `member`, `group`, `join` and `entitlement` join it; `grant` takes a target's `via`, and `event` the fields of an audit event.

## 0.1.0

`createIdAdmin`, `IdError` and `found` moved out of the Toolbox (`mcps/toolbox/src/id.ts`) so that a second server can use them, with two additions. Nothing else changes.

- `requestId` on every call (`get` and `manage`) is sent as `x-request-id`. ID stores it on the audit row of a write and echoes it.
- `idempotencyKey` on `manage` is sent as `Idempotency-Key` on every method but `GET`, in place of the random UUID per call that is still the default. The key, chosen or random, stays the same when the call is resent after a 401.
- `manage` returns ID's `Operation-Id` header as `operationId` beside `body` and `etag`.
- The error for refused client credentials names the client id instead of the Toolbox.
- `@answerable/id-admin/testing` exports the fake ID moved from `mcps/toolbox/src/test/fake-id.ts`. It adds `received` (every admin request with the `x-request-id` and `Idempotency-Key` it carried) and an `Operation-Id` on the answer to every write, and drops `keys`, which `received` replaces.
