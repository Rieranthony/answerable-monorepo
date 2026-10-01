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

const { body, etag, operationId } = await id.manage("PATCH", `/organizations/${organisationId}`, {
  body: { name: "Newco" },
  ifMatch: etagOfOrganisation, // platform:read platform:write
  requestId: executionId, // x-request-id: ID stores it on the audit row of the write
  idempotencyKey: intentId, // Idempotency-Key: ID replays the receipt of a retry, and refuses a changed input with 409 idempotency_key_reused
})
```

- **Tokens.** Reads use a `platform:read` token, `manage` a `platform:read platform:write` token. Each is reused until 30 seconds before it expires and renewed once when ID answers 401. Calls time out after 5 seconds.
- **Idempotency.** `manage` sends `Idempotency-Key` on every method but `GET`: yours, or a random UUID per call. A call resent after a 401 carries the same key and the same `x-request-id`.
- **Correlation.** `requestId` is sent as `x-request-id` when given. `manage` also returns ID's `Operation-Id` (`null` where ID sends none, as on reads), which joins a receipt to ID's audit log.
- **Errors.** A status outside 2xx, a refused token request or no answer at all throws `IdError` with the `status` (0 when ID did not answer) and ID's problem `code`. A refusal of the client credentials names the client id and the capability to check.

`@answerable/id-admin/testing` exports `createFakeId(options?)`: ID's token endpoint and the admin routes the Toolbox and the admin MCP call, in memory, answering the shapes of `apps/id/openapi.admin.json`. `fake.config` goes to `createIdAdmin`; `fake.received` lists every admin request with the `x-request-id` and `Idempotency-Key` it carried, 401s included.

- **The machine client.** `clientId` and `clientSecret` (default `toolbox-hub`), owned by a fresh organisation, `fake.organizationId`, which `GET /me` marks as the platform organisation unless `platform` is false. `resources` maps each audience the token endpoint issues for to the scopes it may carry; the default is ID's admin resource with `platform:read` or `platform:read platform:write`.
- **What ID holds.** `organisation`, `domain`, `ssoProvider`, `member`, `group`, `join` and `entitlement` add rows with ID's fields and return them; `grant` sets a member's access view, which `listTargetAccess` (`…/access?resource=`) also reads; `event` appends an audit event. Lists are newest first, with ID's filters.
- **Failures.** `outage` answers 503, `unreachable` answers nothing, `slow` adds latency, `revoke` refuses every issued token and `failWrite` fails one write.

```sh
bun run --filter @answerable/id-admin test
bun run mcp:check @answerable/id-admin
```

The suite enforces 100% line and function coverage over `src/index.ts`; the fake is exercised through the suites of its consumers. Changes: [CHANGELOG](CHANGELOG.md).
