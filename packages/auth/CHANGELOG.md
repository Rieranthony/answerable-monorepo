# Changelog

## 0.3.0

Machine tokens, for a service that authenticates ID's machine clients, such as the Toolbox's admin API. Nothing changes for a verifier that does not ask.

- `createIdVerifier({ subjectTypes })` takes `["user"]` (the default), `["client"]` or both, and returns `UserPrincipal`, `MachinePrincipal` or their union to match; an empty list is refused at construction. `IdVerifierConfig` takes the same type parameter, and `SubjectType` is exported.
- `MachinePrincipal` (`subjectType: "client"`, `clientId`, `organizationId`, `scopes`, `expiresAt`, `authorizationVersion`, `organizationAuthorizationVersion`) is what a `subject_type: "client"` token gives: the token's subject must be its `client_id`, and it must carry the client's `authorization_version` and the organisation's authorisation version. A token of a kind the verifier does not list is refused with `AuthenticationError`.

## 0.2.0

`UserPrincipal` gains `organizationAuthorizationVersion`, the token's `organization_authorization_version`: a positive integer that ID advances when it disables the organisation. Breaking: a token without the claim, or with a value that is not a positive integer, is rejected; ID puts it in every user token. `createTestIssuer` signs it as `1` unless `claims` replaces it.

## 0.1.0

Documentation comments on every export of `@answerable/auth` and `@answerable/auth/testing`, which the generated API reference (`apps/web/content/docs/mcp/reference.mdx`) is built from. `UserPrincipal` and `TestIssuer` document their fields and members, and `createIdVerifier` and `createTestIssuer` carry an example. No behaviour changes.
