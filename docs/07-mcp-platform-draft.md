# MCP foundation

## Purpose and status

Make MCP workspaces small compositions of reusable tools, prompts and MCP Apps views. Shared packages own authentication and protocol setup. The permanent `mcps/e2e` consumer proves the complete local journey through Answerable ID.

The foundation is implemented and locally tested. The “95% setup” target is an architectural aim, not a measured percentage. Admin MCP work, machine principals and production deployment are outside this foundation. External chat-host compatibility remains unverified.

Use the [authoring guide](../apps/web/content/docs/mcp/authoring.mdx) to create a consumer and the [evidence report](../reports/mcp-foundation-evidence.md) to assess acceptance.

## Package responsibilities

| Workspace | Responsibility |
| --- | --- |
| `packages/auth` | Verify Answerable ID user resource tokens using trusted issuer, audience, resource UUID and JWKS configuration |
| `packages/mcp-base` | Hono transport, discovery challenge, scope checks, typed definitions, Apps registration and browser builds |
| `mcps/e2e` | Executable reference: injected tenant-owned storage, reusable definitions, React Apps view and isolated real-ID tests |

MCPs live under `mcps/*`. Better Auth remains in Answerable ID; MCPs do not create identity accounts or sessions. Domain services own tenant filtering, storage and idempotency. Shared tool packages should be extracted when a second consumer needs the same domain operation.

Workspace generation is deferred until a second real MCP establishes what repeats. There is no parallel template implementation to maintain.

## Public interfaces

- `createMcpApp({ name, version, auth, services, tools, prompts?, resources? })` returns a Hono app. The consumer starts and stops its listener and services.
- `defineTool` accepts Zod input/output schemas, scopes, annotations, an optional view and an execution function. Results include structured data and text so tools remain useful without UI support.
- `definePrompt` returns official MCP prompt results; `defineResource` exposes fixed-URI text. Both check scopes before invoking handlers. Retrieval must not perform writes.
- `defineView` registers compiled HTML as a `ui://` resource through the official MCP Apps SDK. Browser code imports `/apps` or `/apps/react`; `/build` produces standalone HTML.
- `readMcpEnvironment` parses common trusted ID settings and the port. Consumers add their own domain settings.

Every HTTP request has its own SDK server and immutable principal. Handler context contains `principal`, `services`, `requestId` and `signal`. Shared services must not store a mutable current user.

The base retains host/origin checks, duplicate registration checks, input/output validation, safe errors, liveness and bounded request logs. Deadlines default to 30 seconds after authentication, configurable up to five minutes. Abort signals are cooperative; stateless requests do not share a cancellation registry.

Browser bundling runs in a separate Bun process because same-process browser/server imports reproduced a Bun 1.3.1 module-cache failure. Keep this workaround until the runtime can pass the existing bundle tests without it.

## Authentication flow

1. A client receives an HTTP 401 challenge pointing to protected-resource metadata.
2. The metadata identifies the configured Answerable ID issuer and resource. The client discovers ID's OAuth endpoints.
3. The user signs in through ID and their organisation's upstream provider. The client obtains a resource-bound access token using authorisation code and PKCE.
4. The MCP verifies the signature, issuer, audience, immutable resource UUID, token type and user claims. Scope checks precede handler execution; services constrain object access to the verified tenant.
5. Apps actions travel through the authenticated host bridge and the same tool checks. The iframe receives no bearer token.

The local client is pre-registered. Registration support must be tested separately for each external host.

Offline verification cannot detect grant or membership revocation before access-token expiry. Default maximum token lifetime is 900 seconds; key-cache lifetime is 300 seconds, unknown-key cooldown 30 seconds and key-fetch timeout five seconds. Cached valid keys can survive a temporary ID outage; unverifiable tokens fail closed.

## Test acceptance

- Signed-token tests prove issuer/audience/type/time/claim rejection, JWKS rotation and outage behaviour.
- SDK-over-HTTP tests prove discovery, schema checks, scopes, concurrent identity isolation, prompts/resources, redacted errors, deadlines and cancellation.
- The reference service proves tenant ownership and durable create/delete receipts. Retrying an uncertain response uses the same operation key and cannot create a duplicate effect.
- Chromium renders the actual Apps resource and performs allowed and denied actions. A second composition reuses read tools and omits write tools entirely.
- `bun run mcp:test:e2e` authenticates through real local ID and web pages, obtains real issued tokens, checks wrong-resource and cross-tenant denial, refreshes, disables the test organisation, checks refresh denial and waits for actual access-token expiry.
- The runner owns an isolated database, temporary files and processes. Startup and browser-phase interruption checks prove cleanup releases its container and reserved ports.

Run foundation tests, typecheck, lint, build and the real-ID journey after shared changes. Local harness success does not certify an external chat host, a real corporate provider or production deployment. Record the selected host, version, registration mode, reachable origins, OAuth result, text fallback and Apps actions before claiming that host works.
