# Changelog

## 0.5.1

`startId` and the host lane find `compose.yaml` and `apps/id` in a checkout whose path has a space or a non-ASCII character: they decode the file URL instead of passing its percent-encoded path to Docker Compose and Bun.

- `refreshRefused(session, clientId, resource)`, `serveCallback(callback)` and `intentSchema` are exported: the three journeys each wrote the refused refresh after a disabled organisation, the callback server and a schema of the prepared intent, and the admin lane its own callback server.

## 0.5.0

What the test audit kept of the acceptance. Breaking: `approve` is no longer exported, and the lanes have no `--check`.

- The admin journeys run `staff_grant` and `staff_revoke` against real ID: after root makes the first owner, the owner gives a colleague `team` and takes it away, and makes them `admin` for A4; ID computes each role from real groups. A3 shows the admin MCP answering `401` to the person's Toolbox token. A1 asserts that `admin_commit_confirmed` alone carries `anthropic/requiresUserInteraction`, which the admin lane's `--check` used to.
- `startId`'s `platform.signIns` takes a list of people too, such as `["staff", "colleague", "staff"]`: the platform directory's sign-ins in order, each `<person>@answerable.example.test` (`apps/id/scripts/mcp-e2e-fixture.ts`).
- `src/toolbox.ts`: `startToolboxStack`, from which the Toolbox journeys and the host lane both start. `createDatabase` moved to `src/id.ts`, beside the PostgreSQL it uses.
- Deleted, because a test closer to the code holds the same fact: `kit.journeys.test.ts`; the e2e journeys' repeat, stale, expiry and controlled-class steps (`packages/mcp/src/commit.test.ts`); the Toolbox journeys' trigger and erasure steps (`packages/mcp-postgres/src/evidence.test.ts`) and the admin API's evidence and host-client step (`mcps/toolbox/src/admin.test.ts`).
- The kit is test support: no coverage gate. Its unit tests of `tool`, `refusal`, `approve`, the root caller and `startId`'s failures are gone; `cleanup.test.ts` and `startId`'s happy path stay. `refusal` returns `errorOf`'s answer, which throws when the call succeeded.
- The lanes keep ID and the servers up for Claude Code by hand; the journeys are their proof.

## 0.4.1

- `scripts/host-lane.ts` removes ID, its database and the Toolbox and exits 1 when a step fails, as the admin lane does; before, a failure left the ID fixture running.
- `startAdminStack(…).adminMcp(freshSeconds?)` leaves the default window to `createAdminMcp`.

## 0.4.0

What the admin MCP's journeys and lane need from the kit. Nothing breaks.

- `src/journeys/admin.journeys.test.ts` runs the admin MCP (port `47606`) and the Toolbox against real ID: roles without re-authorisation, onboarding through the tools, the new organisation's person in the Toolbox, refusals, idempotency, freshness with a real Verify sign-in, and evidence joined to ID's audit.
- `src/admin-mcp.ts` registers the admin MCP and the Toolbox as `apps/web/content/docs/admin/setup.mdx` shows, and starts their databases and the Toolbox's poller. `scripts/admin-lane.ts` starts from it and keeps ID, the admin MCP and the Toolbox up for Claude Code by hand; `--check` runs the whole story headlessly.
- `signIn`, `signInRefused` and `approve` take a browser or one of its contexts; through a context, ID's session carries from one sign-in to the next and the email step is skipped. `verifySignIn(context, idOrigin)` chooses Verify sign-in on ID's Security page.
- `createAdmin` answers `{}` for an empty body (a `204`), so `DELETE` works.
- `cleanup` collects garbage after the closers. Without it a collection ran during a later file of a long run and closed the pipes of that file's Chromium, whose sign-ins and `close` then hung.
- The ID fixture stamps each directory sign-in's `auth_time` with the time of the sign-in, not of boot (`apps/id/scripts/mcp-e2e-fixture.ts`), so ID accepts a Verify sign-in.

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
