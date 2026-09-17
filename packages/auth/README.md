# Answerable authentication

Resource-token verification for services that trust Answerable ID. This package does not create login routes, sessions or accounts.

```ts
import { createIdVerifier } from "@answerable/auth"

const verify = createIdVerifier({
  issuer: "https://id.answerable.org",
  jwksUrl: "https://id.answerable.org/auth/jwks",
  resource: "https://example.answerable.org/mcp",
  resourceInstanceId: registeredResourceUuid,
})

const principal = await verify(accessToken)
```

Configure the JWKS endpoint from the trusted ID deployment's discovery metadata; the example is not a deployment claim. Never select an issuer or key endpoint from token claims.

## Contract

- Accept only ID user resource tokens with EdDSA signatures, `at+jwt` type, valid times, the configured issuer/audience and immutable resource UUID.
- Limit `exp - iat` to `maxTokenLifetimeSeconds` (default 900 seconds; configurable from 1 to 3600). Register ID resources with a lifetime within that limit.
- Reject machine tokens, ID tokens, opaque tokens and proof-bound credentials in this user-only version.
- Return a frozen principal with UUID identity, tenant, scopes and expiry. No raw token is included.
- Fetch keys through JOSE's remote JWKS resolver. Defaults: five-minute cache, 30-second unknown-key cooldown and five-second request timeout.
- Existing cached keys can verify tokens during an ID outage until cache expiry. Unknown/expired key state fails closed.

Offline verification does not detect membership or grant revocation before token expiry. Consumers must enforce object-level tenant ownership and scopes. Version claims do not provide an online revocation check.

`allowLocalHttp: true` permits HTTP only for loopback addresses during local testing. Issuer, resource and JWKS URLs otherwise require HTTPS and reject credentials, fragments and query strings.

## Errors

| Error | Meaning | Action |
| --- | --- | --- |
| `AuthenticationError` | Credential cannot be verified or accepted | Return an authentication challenge; obtain a valid ID resource token |
| Configuration error | Invalid URL, resource UUID or time/cache bound | Correct trusted deployment configuration before starting |

## Verification

```sh
bun run --filter @answerable/auth test
bun run --filter @answerable/auth typecheck
bun run --filter @answerable/auth lint
```

Tests use signed fixtures and a real loopback JWKS server. They do not replace the full ID login acceptance test. See [implementation evidence](../../reports/mcp-foundation-evidence.md).

For MCP composition, use the [authoring guide](../../apps/web/content/docs/mcp/authoring.mdx).
