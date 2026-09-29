# Changelog

## 0.2.0

`UserPrincipal` gains `organizationAuthorizationVersion`, the token's `organization_authorization_version`: a positive integer that ID advances when it disables the organisation. Breaking: a token without the claim, or with a value that is not a positive integer, is rejected; ID puts it in every user token. `createTestIssuer` signs it as `1` unless `claims` replaces it.

## 0.1.0

Documentation comments on every export of `@answerable/auth` and `@answerable/auth/testing`, which the generated API reference (`apps/web/content/docs/mcp/reference.mdx`) is built from. `UserPrincipal` and `TestIssuer` document their fields and members, and `createIdVerifier` and `createTestIssuer` carry an example. No behaviour changes.
