# Changelog

## 0.5.0

`UserPrincipal.upstreamAuthTime`: when the person last signed in at their organisation's directory, for a server that asks for a recent sign-in before a critical operation, such as the admin MCP. A server that does not read it changes nothing, unless it writes a `UserPrincipal` by hand.

- It is the token's `upstream_auth_time` in seconds since the epoch, or `null` when the directory reported no time or the token has no claim. ID takes it from the browser session when it creates the authorisation, so a refreshed token keeps the same value.
- A token whose claim is not a whole number of seconds at or after the epoch, or `null`, is rejected.
- The field is required: a principal written by hand must set it. `testPrincipal` in `@answerable/mcp/testing` sets it to the current time.
- `createTestIssuer().sign` puts `upstream_auth_time` in every token, the signing time, unless `claims` replaces it.

## 0.4.1

Documentation only: `UserPrincipal.userId` and `organizationId` have doc comments, which the docs' type tables show. No behaviour changes.

## 0.4.0

One kind of token per verifier, the smallest form the Toolbox's admin API needs. Breaking for a verifier that accepts machine tokens; a person's verifier is unchanged.

- `createIdVerifier({ subjectType })` takes `user` (the default) or `client`, and returns `UserPrincipal` or `MachinePrincipal` to match. It replaces `subjectTypes`: a verifier that accepted both kinds, and the union it returned, are gone, and so are the `SubjectType` export and `MachinePrincipal.subjectType`, which only told the union apart.
- `AuthenticationError`'s message is `A valid Answerable ID access token is required`, without `user`, since a verifier may take a machine client's token.

## 0.3.0

Machine tokens, for a service that authenticates ID's machine clients, such as the Toolbox's admin API. Nothing changes for a verifier that does not ask.

- `createIdVerifier({ subjectTypes })` takes `["user"]` (the default), `["client"]` or both, and returns `UserPrincipal`, `MachinePrincipal` or their union to match; an empty list is refused at construction. `IdVerifierConfig` takes the same type parameter, and `SubjectType` is exported.
- `MachinePrincipal` (`subjectType: "client"`, `clientId`, `organizationId`, `scopes`, `expiresAt`, `authorizationVersion`, `organizationAuthorizationVersion`) is what a `subject_type: "client"` token gives: the token's subject must be its `client_id`, and it must carry the client's `authorization_version` and the organisation's authorisation version. A token of a kind the verifier does not list is refused with `AuthenticationError`.

## 0.2.0

`UserPrincipal` gains `organizationAuthorizationVersion`, the token's `organization_authorization_version`: a positive integer that ID advances when it disables the organisation. Breaking: a token without the claim, or with a value that is not a positive integer, is rejected; ID puts it in every user token. `createTestIssuer` signs it as `1` unless `claims` replaces it.

## 0.1.0

Documentation comments on every export of `@answerable/auth` and `@answerable/auth/testing`, which the generated API reference (`apps/web/content/docs/mcp/reference.mdx`) is built from. `UserPrincipal` and `TestIssuer` document their fields and members, and `createIdVerifier` and `createTestIssuer` carry an example. No behaviour changes.
