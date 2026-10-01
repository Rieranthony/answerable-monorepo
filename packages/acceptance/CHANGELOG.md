# Changelog

## 0.3.0

What the admin MCP's journeys need from the kit. Nothing breaks.

- `startId` takes `platform: { signIns }`, which gives the platform organisation (Answerable staff) a domain and a company directory with queued sign-ins, and `spares: [{ slug, signIns }]`, company directories that ID trusts from boot and no organisation uses yet, for organisations a journey creates later. The manifest gains `platform` (`organizationId`, `domain`, `email`) and `spares` (each directory's `slug`, `domain`, `email`, `issuer`, endpoints, `clientId` and `clientSecret`). The fixture finds the platform organisation through ID's system binding, not by its slug.
- `registerMachine(admin, organizationId, clientId, audiences)` replaces the copies in the Toolbox journey and the host lane. `audiences` maps each resource to the scopes the client may ask there, so one machine client can ask ID's admin resource and another resource for tokens. It returns `{ clientId, clientSecret }`, which spreads into `createIdAdmin`.
- `setSsoProvider(admin, organizationId, spare)` points an organisation's single sign-on at a spare directory.
- `signInRefused(browser, target, tenant)` returns the refusal ID shows at the organisation chooser ("Access is unavailable for this organisation. …") at once, where `signIn` waits 30 seconds for a consent page that never comes.
- `src/journeys/kit.journeys.test.ts` runs all of it against real ID: staff sign in, an organisation created through the admin API signs its person in through a spare directory after ID refused it, and a machine client gets a token for each of two audiences.

## 0.2.0

A smaller kit: what a journey can say as plainly with ID's admin API or the MCP client goes. Breaking for journeys that used them.

- `entitle` is gone: call ``id.admin("POST", `/organizations/${organizationId}/entitlements`, { resource, scopes })``.
- `connect` takes no `onToolsChanged`: a `2026-07-28` client listens with the MCP client's own `setNotificationHandler` and `listen({ toolsListChanged: true })`, as the Toolbox's J3 does.
- `startId` takes no `spawn`, and the `Spawn` type is gone: the kit's tests replace `Bun.spawn` with `spyOn`.
- `startId`'s failures say what to do: check Docker and port 47532, read the fixture's output, or pass a larger `timeoutMs`.
- The Toolbox journey shares one machine client between the Toolbox and its poller, asserts that the Toolbox asks ID for exactly two tokens, and sets J6's policy class through the admin API.

## 0.1.0

The acceptance kit, extracted from `mcps/e2e`, and the journeys that use it.

- The kit: `startId({ tenants })` starts a real ID on its own PostgreSQL and returns the manifest, an `admin` caller and `stop`. `registerResource`, `registerClient`, `linkClient`, `grantOrganisation` and `entitle` provision it through the admin API. `serve`, `launchBrowser`, `signIn`, `connect`, `tool`, `refusal` and `step` drive a journey; `connect` takes `onToolsChanged` for a `2026-07-28` client that listens for `tools/list_changed`. Ctrl-C and SIGTERM stop everything the kit opened.
- `src/journeys/e2e.journeys.test.ts`: sign-in through ID's pages, token binding, J4 (agent-class mutation), J5 (controlled class), organisation isolation, refresh and revocation.
- `src/journeys/toolbox.journeys.test.ts`, on port `47604`: J1 (direct list), J2 (partial and denied), J6 (human class), J7 (meta projection), J3 (a grant change without re-authorisation), J10 (evidence) and the admin API.
- `bun run mcp:test:e2e` runs the package with a gate of 100% line and function coverage over `src`.
