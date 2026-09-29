# Changelog

## 0.1.0

The acceptance kit, extracted from `mcps/e2e`, and the journeys that use it.

- The kit: `startId({ tenants })` starts a real ID on its own PostgreSQL and returns the manifest, an `admin` caller and `stop`. `registerResource`, `registerClient`, `linkClient`, `grantOrganisation` and `entitle` provision it through the admin API. `serve`, `launchBrowser`, `signIn`, `connect`, `tool`, `refusal` and `step` drive a journey; `connect` takes `onToolsChanged` for a `2026-07-28` client that listens for `tools/list_changed`. Ctrl-C and SIGTERM stop everything the kit opened.
- `src/journeys/e2e.journeys.test.ts`: sign-in through ID's pages, token binding, J4 (agent-class mutation), J5 (controlled class), organisation isolation, refresh and revocation.
- `src/journeys/toolbox.journeys.test.ts`, on port `47604`: J1 (direct list), J2 (partial and denied), J6 (human class), J7 (meta projection), J3 (a grant change without re-authorisation), J10 (evidence) and the admin API.
- `bun run mcp:test:e2e` runs the package with a gate of 100% line and function coverage over `src`.
