# Answerable ID admin client

A server's machine client on Answerable ID's admin API: `createIdAdmin`, `IdError`, `found`, and a fake ID for tests. Used by the Toolbox; the admin MCP is its second consumer. Development and test only.

```ts
import { createIdAdmin, found } from "@answerable/id-admin"

const id = createIdAdmin({
  issuer: "http://localhost:47300",
  adminResource: "http://localhost:47300/api/admin",
  clientId: "my-server",
  clientSecret: process.env.MY_SERVER_ID_CLIENT_SECRET!,
})

const events = await id.get("/audit-events?limit=20") // platform:read
const organisation = await found(id.get(`/organizations/${organisationId}`)) // ID's 404 becomes undefined
const { body, etag: etagOfOrganisation } = await id.read(`/organizations/${organisationId}`) // the JSON and ID's ETag

const { etag, operationId, replayed } = await id.manage("PATCH", `/organizations/${organisationId}`, {
  body: { name: "Newco" },
  ifMatch: etagOfOrganisation, // platform:read platform:write
  requestId: executionId, // x-request-id: ID stores it on the audit row of the write
  idempotencyKey: intentId, // Idempotency-Key: ID replays the receipt of a retry, and refuses a changed input with 409 idempotency_key_reused
})
```

- **Tokens.** Reads use a `platform:read` token, `manage` a `platform:read platform:write` token. Each is reused until 30 seconds before it expires and renewed once when ID answers 401. Calls time out after 5 seconds, or `timeoutMs`.
- **Another audience.** `withToken(resource, scope, send)` runs `send(token)` with a token for another service that trusts the same machine client, such as the Toolbox's admin API (`toolbox:admin` for `<toolbox>/admin`), renewed once when that service answers 401.
- **Idempotency.** `manage` sends `Idempotency-Key` on every method but `GET`: yours, or a random UUID per call. A call resent after a 401 carries the same key and the same `x-request-id`. When ID replays an earlier answer to the key, `replayed` is true and `body` is ID's operation receipt: read the resource's id from `body.resultReference.id`.
- **Preconditions.** `ifMatch` sends the ETag a write expects; `ifNoneMatch: "*"` asserts that nothing exists yet where ID takes it. A stale one answers `412 revision_mismatch`.
- **Correlation.** `requestId` is sent as `x-request-id` when given. `manage` also returns ID's `Operation-Id` (`null` where ID sends none, as on reads), which joins a receipt to ID's audit log.
- **Errors.** A status outside 2xx, a refused token request or no answer at all throws `IdError` with the `status` (0 when ID did not answer) and ID's problem `code`. A refusal of the client credentials names the client id and the capability to check.

`@answerable/id-admin/testing` exports `createFakeId(options?)`: ID's token endpoint and the admin routes the Toolbox and the admin MCP call, in memory, answering the shapes of `apps/id/openapi.admin.json`. `fake.config` goes to `createIdAdmin`; `fake.received` lists every admin request with the `x-request-id`, `Idempotency-Key`, `If-Match` and `If-None-Match` it carried, 401s included.

- **The machine client.** `clientId` and `clientSecret` (default `toolbox-hub`), owned by a fresh organisation, `fake.organizationId`, which `GET /me` marks as the platform organisation unless `platform` is false. `resources` maps each audience the token endpoint issues for to the scopes it may carry; the default is ID's admin resource with `platform:read` or `platform:read platform:write`.
- **What ID holds.** `organisation`, `domain`, `ssoProvider`, `member`, `group`, `join` and `entitlement` add rows with ID's fields and return them; `grant` sets a member's access view, which `listTargetAccess` (`…/access?resource=`) also reads; `event` appends an audit event. Lists are newest first, with ID's filters. `revise(id)` advances a row's revision, as another writer would.
- **Writes.** Organisations (create, update, disable, enable), domains, the SSO provider, groups, group assignments, entitlements (create, disable, enable), resource scopes and client links, each a command as in ID: `Idempotency-Key` required, replayed for the same input (`Idempotency-Replayed: true`, ID's receipt body), `409 idempotency_key_reused` for another, `412 revision_mismatch` for a stale `If-Match`, `409 conflict` for a slug, domain or principal and target that exists. A replay's receipt names ID's `resultReference` and says `noop` for a write that changed nothing. With `operationInProgress`, a write whose key a running write holds answers `409 operation_in_progress`. A method the fake does not implement on a route answers `405`.
- **Another service.** `issued(token)` returns the audience and scope a token was issued for, so that a fake of a service that trusts the client, such as the Toolbox's admin API, can check its bearer. `resources` lists the audiences the token endpoint serves.
- **Failures.** `outage` answers 503, `unreachable` answers nothing, `slow` adds latency, which the caller's `AbortSignal` cuts short, `revoke` refuses every issued token (`401` with `WWW-Authenticate`) and `failWrite` fails one write (`503 database_busy` with `Retry-After: 1`).

```sh
bun run --filter @answerable/id-admin test
bun run mcp:check @answerable/id-admin
```

The suite enforces 100% line and function coverage over `src/index.ts`. `src/testing.test.ts` checks every answer the fake gives against `apps/id/openapi.admin.json`; its consumers' suites exercise the rest. Changes: [CHANGELOG](CHANGELOG.md).
