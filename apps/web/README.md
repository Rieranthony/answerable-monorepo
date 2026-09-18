# Answerable web

The Next.js app serves the public Answerable site and the docs at `/docs`. Answerable ID serves its API and browser pages from `apps/id`.

## Local development

From the repository root, copy `apps/web/.env.example` to `apps/web/.env.local`, then run `bun dev`. The local services use:

| Service | Port |
| --- | ---: |
| Web | 47100 |
| Answerable ID | 47300 |
| PostgreSQL | 47432 |
| Redis | 47379 |

Set `PORT` to override the web port for a preview. Next.js reads the web environment files from this directory, not the repository root.

## Local OAuth test

Open `http://localhost:47100/oauth-test` after starting both apps. This development-only page is an independent confidential OAuth/OIDC client of Answerable ID. ID serves all login, organisation selection, consent, security and error pages at `http://localhost:47300`. Microsoft returns to ID at `/auth/sso/callback`; ID returns to this app at `/api/oauth-test/callback`.

Register a client through the ID admin API with ID `answerable-web-local`, authentication method `client_secret_basic`, grants `authorization_code` and `refresh_token`, scopes `openid profile email offline_access`, and redirect URI `http://localhost:47100/api/oauth-test/callback`. Keep `skipConsent` false. For each participating organisation, create client-only capabilities for both grants and an organisation entitlement for those scopes. Registration alone does not grant access.

Save these server-only values in `apps/web/.env.local`:

```dotenv
OAUTH_TEST_ISSUER=http://localhost:47300
OAUTH_TEST_CLIENT_ID=answerable-web-local
OAUTH_TEST_CLIENT_SECRET=<secret returned once by client registration>
OAUTH_TEST_REDIRECT_URI=http://localhost:47100/api/oauth-test/callback
```

The page supports sign-in, verified identity display, refresh, revocation and local sign-out. Tokens and pending transactions stay in bounded server memory; the browser only receives opaque HttpOnly cookies. Transactions expire after ten minutes and sessions after one hour. Restarting the web process or changing client configuration clears sessions. Production returns 404 for the page and all test handlers.

Local sign-out clears only this app's session. Revocation calls ID's token endpoint for revocation and does not sign the browser out of ID; existing signed access tokens may remain valid until expiry. No root credentials, ID database connection or Microsoft credentials belong in the web environment.
