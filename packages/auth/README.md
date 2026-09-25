# Answerable authentication

Verify Answerable ID access tokens in any service. This package creates no login routes, sessions or accounts.

```ts
import { createIdVerifier } from "@answerable/auth"

const verify = createIdVerifier({
  issuer: "https://id.answerable.org",
  resource: "https://example.answerable.org/mcp",
})

const principal = await verify(accessToken)
// { userId, organizationId, membershipId, grantId, clientId, scopes, expiresAt }
```

## Contract

- **Keys.** Read from the issuer's RFC 8414 metadata on first use; `jwks_uri` must share the issuer's origin. Never take an issuer or key URL from a token.
- **Token.** `at+jwt`, signed with EdDSA, ES256 or RS256, from the configured issuer, with the resource URL in its audience, unexpired, with ID's user and organisation claims and no `cnf`.
- **URLs.** HTTPS, or HTTP on `localhost`, `127.0.0.1` or `[::1]`. No credentials, query or fragment.
- **Failures.** Every rejection throws `AuthenticationError` with no detail. Answer it with a `401` challenge.
- **Revocation.** Verification is offline: an issued token stays valid until it expires. Constrain every query by `organizationId`.
- **HTTP client.** `fetch` replaces the client for discovery and key requests; the default is the global `fetch`.

`@answerable/auth/testing` exports `createTestIssuer()`, an in-process issuer that signs ID-shaped tokens for tests. Pass its `fetch` to the verifier; nothing listens on a port.

```sh
bun run --filter @answerable/auth test
```

MCP servers use this package through [`@answerable/mcp`](../mcp/README.md).
