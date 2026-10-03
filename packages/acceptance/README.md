# Answerable acceptance

The kit and the journeys that run real Answerable ID, a real browser and the official MCP OAuth client against an MCP. Development and test only.

```sh
bun install
(cd packages/acceptance && bun x playwright install chromium)
bun run mcp:test:e2e
```

Requires Bun 1.3.1 and Docker Compose. It starts PostgreSQL in a Compose project on port `47532` and ID on `47600`, runs every `*.journeys.test.ts` in `src/journeys` one after another, and removes both afterwards, including after Ctrl-C. The kit's own unit tests (`cleanup.test.ts`, `id.test.ts`) run in the same command. The kit is test support: no coverage gate.

| File | Job |
| --- | --- |
| `src/id.ts` | `startId`: Compose, the ID fixture (`apps/id/scripts/mcp-e2e-fixture.ts`) with its plan (`tenants`, `platform`, `spares`), the manifest, `stop` |
| `src/admin.ts` | `createAdmin` and the provisioning functions over ID's admin API, including `registerMachine` and `setSsoProvider` |
| `src/oauth.ts` | The SDK's OAuth client provider in memory, which `signIn` fills |
| `src/browser.ts` | `launchBrowser`, `signIn`, `signInRefused` and `verifySignIn`: the SDK challenge and ID's pages in Chromium |
| `src/mcp.ts` | `serve`, `connect`, `tool` and `refusal` |
| `src/cleanup.ts` | What `stop` and Ctrl-C run, and a collection of garbage after them |
| `src/toolbox.ts` | `startToolboxStack`: the Toolbox registered in ID with its host clients, its machine client and a staff client, its database and its poller; the Toolbox journeys and the host lane start from it |
| `src/admin-mcp.ts` | `startAdminStack`: the admin MCP and the Toolbox registered in ID as the admin MCP's setup page shows, with a database each and the Toolbox's poller; the admin journeys and the admin lane start from it |
| `src/journeys/e2e.journeys.test.ts` | The e2e MCP: sign-in, tokens, J4 agent-class mutation, isolation, refresh, revocation |
| `src/journeys/admin.journeys.test.ts` | The admin MCP on port `47606` and the Toolbox: A1 roles without re-authorisation (`staff_grant` and `staff_revoke` against real ID), A2 onboarding through the tools, A3 the Toolbox outcome, A4 refusals, A5 idempotency, A6 freshness (Verify sign-in) and A7 evidence |
| `src/journeys/toolbox.journeys.test.ts` | The Toolbox on port `47604`: J1 direct list, J2 partial and denied, J6 human class, J7 meta projection, J3 grant change and `tools/list_changed`, J10 evidence, and the admin API (enabling organisations, the catalogue) |

[Test MCPs locally](../../apps/web/content/docs/mcp/local-testing.mdx) lists what each journey proves, the ports, every kit function, how to write a journey, and the errors you can hit. Changes: [CHANGELOG](CHANGELOG.md).

The lanes keep ID and the servers up for Claude Code by hand: `bun packages/acceptance/scripts/host-lane.ts` (the Toolbox, with LibreChat) and `bun packages/acceptance/scripts/admin-lane.ts` (the admin MCP and the Toolbox, with the new organisation's person). They start from the same code as the journeys, which are their proof. Neither runs beside the journeys.
