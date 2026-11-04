# Answerable acceptance

The kit and the journeys that run real Answerable ID and a real browser, using the official MCP OAuth client against MCPs and a pinned OpenID client for application sign-in. Development and test only.

```sh
bun install
(cd packages/acceptance && bun x playwright install chromium)
bun run mcp:test:e2e
```

Requires Bun 1.3.1 and Docker Compose. It starts PostgreSQL 17 in a Compose project on port `47532` and ID on `47600`, and the Toolbox, with the MCPs it serves alone at their paths, on `47604` (a second one on `47605`), runs every `*.journeys.test.ts` in `src/journeys` one after another, and removes PostgreSQL and ID afterwards, including after Ctrl-C. The kit's own unit tests (`cleanup.test.ts`, `id.test.ts`) run in the same command. The kit is test support: no coverage gate.

| File | Job |
| --- | --- |
| `src/id.ts` | `startId`: Compose, the ID fixture (`apps/id/scripts/mcp-e2e-fixture.ts`), which starts the company directories of the plan (`tenants`, `platform`, `spares`) and, given `postmark`, sends ID's sign-in mail to the caller's fake Postmark; the tenants' organisations and every organisation's domain and single sign-on; the manifest, `stop`. `createDatabase(name)`: a database and its runtime login `<name>_runtime` with a generated password, as `{ owner, runtime, role }` |
| `src/admin.ts` | `createAdmin` and the provisioning functions over ID's admin API, including `registerMachine`, `addDomain` and `setSsoProvider` |
| `src/postmark.ts` | `startFakePostmark`, a Postmark that keeps what ID sends it and lets a test (or the kind stack, over its inbox URL) read it, and `readMail`, which reads the link and the 8-digit code out of a mail |
| `src/oauth.ts` | The SDK's OAuth client provider in memory, which `signIn` fills, and `refreshRefused` |
| `src/browser.ts` | `launchBrowser`, `signIn`, `signInRefused` and `verifySignIn`: the SDK challenge and ID's pages in Chromium |
| `src/mcp.ts` | `serve`, `serveCallback`, `connect`, `tool`, `refusal` and the journeys' `intentSchema` |
| `src/cleanup.ts` | What `stop` and Ctrl-C run, and a collection of garbage after them |
| `src/mcps.ts` | `mcpsDatabase`: the shared MCP database `answerable_mcps_acceptance` with its two logins, and every MCP the Toolbox serves provisioned and migrated, once per start |
| `src/toolbox.ts` | `prepareToolbox`: the Toolbox's machine client and database (migrated as the owner, served as the runtime login), and `start(origin)`, a Toolbox on fresh pools serving its generated list in its hub and at `<origin>/<name>/mcp`, with its poller; the e2e journeys start from it. `startToolboxStack`: that, with the Toolbox's resources, host clients and a staff client registered in ID; the Toolbox, MCP and CLI journeys and the host lane start from it |
| `src/admin-mcp.ts` | `startAdminStack`: the admin MCP and the Toolbox registered in ID as the admin MCP's setup page shows, with a database each (migrated as the owner, served as the runtime login) and the Toolbox's poller; the admin journeys and the admin lane start from it |
| `src/journeys/e2e.journeys.test.ts` | The e2e MCP at its path, which the Toolbox serves alone: sign-in, tokens, J4 agent-class mutation, isolation, refresh, revocation |
| `src/journeys/app-sign-in.journeys.test.ts` | Application OIDC using `openid-client` 6.5.0, the version pinned in the audited LibreChat source: confidential POST registration through the admin API, denied login before permission, browser login/organisation selection/consent, S256 PKCE, state/nonce and signed ID-token checks, subject-bound UserInfo, refresh and secret rotation. Chromium also reads both discovery documents across origins with credentials omitted. The callback uses `47603`. |
| `src/journeys/magic-link.journeys.test.ts` | Sign-in by emailed link and code, with ID's sign-in mail going to a fake Postmark: request and mail, mail scanners, confirm, the code from a second browser, an application's authorisation (the token's `authentication_method`, the 24-hour session and 7-day grant), the switch, who may ask (listed and domain modes, removed members, another firm's directory account), one firm against another, two confirmations at once, replay, a link person meeting a directory (the two proofs and their refusals) and stopping someone. Domains are proved by writing what DNS would leave; the switch and the stop tools are called through the admin API they commit to. The callback uses `47603`; the fake Postmark takes a free port |
| `src/journeys/mcp-cli.journeys.test.ts` | The CLI's registrations in real ID (`bun mcp setup` and `bun mcp dev`, from `scripts/mcp`): mcp-dev, the Toolbox's host client, e2e's resource and client, and each organisation's access; then who is calling, from ID, in `example`'s tool, `example` in the Toolbox and e2e at its path, and widening what ID holds |
| `src/journeys/scaffold.journeys.test.ts` | `bun mcp` end to end, as a coding agent runs it, in a copy of the working tree with its own install: `new`, `check`, `add tool` for a read and a mutation, `list` and a refused second `new`, against the development Postgres on 47432; no ID |
| `src/journeys/admin.journeys.test.ts` | The admin MCP on port `47606` and the Toolbox: A1 roles without re-authorisation (`staff_grant` and `staff_revoke` against real ID), A2 onboarding through the tools, A3 the Toolbox outcome, A8 tool-level access (a grant string naming one capability, to a group and to a member), A4 refusals, A5 idempotency, A9 stopping someone (`members_remove` and `members_reinstate`, `users_disable` and `users_enable`, `users_disable` and `users_retireemail`, and an admin refused on a staff target, with the machine client's `platform:users` token), A6 freshness (Verify sign-in) and A7 evidence |
| `src/journeys/toolbox.journeys.test.ts` | The Toolbox on port `47604`: J1 direct list, J2 partial and denied, J6 human class, J7 meta projection, J3 grant change and `tools/list_changed`, J10 evidence, and the admin API (enabling organisations, the catalogue) |

[Test MCPs against real ID](../../apps/web/content/docs/mcp/local-testing.mdx) lists the ports, every kit function, how to write a journey, and the errors you can hit.

The application journey proves ID's browser and library contract. It does not run the LibreChat, OpenCloud or Euro-Office forks, their account creation or their session management. Those integrations still need acceptance against their actual pinned builds. Its HTTP allowance applies only to the disposable loopback fixture; deployed consumers use HTTPS.

The lanes keep ID and the servers up for Claude Code by hand: `bun packages/acceptance/scripts/host-lane.ts` (the Toolbox, with LibreChat) and `bun packages/acceptance/scripts/admin-lane.ts` (the admin MCP and the Toolbox, with the new organisation's person). They start from the same MCP code as the journeys. The host lane uses LibreChat's local credential login; it does not certify LibreChat sign-in through ID. Neither lane runs beside the journeys.
