# Decisions for the owner: the admin MCP

Each decision lists the options with the recommendation first and why. Facts are in [`findings.md`](findings.md) (F-numbers). The coordinator takes the recommendations by default.

## D0. The demo, confirmed with two corrections

The coordinator's reading holds: (1) an owner connects Claude Code to the admin MCP and signs in through Answerable ID; (2) through tools they create an organisation, add its domain, set its SSO, enable the Toolbox for it and grant its people access; (3) a person of that organisation signs in to the Toolbox and uses it, while before the grant they cannot; (4) a non-staff person, or staff without the role, cannot use the admin MCP or a write tool. Two corrections from the probes:

- In the **automated journey**, step (2)'s SSO is set by the kit (root), not by `sso.set`: the fixture's directories are generic OIDC issuers that need a client secret (probes 3 and 4 failed without one), and a tool never takes a secret (R29). `sso.set` with Answerable's Google or Microsoft application is proven by unit tests against the fake ID and by the hand demo with Entra.
- Step (3)'s "refuses" is ID's "Access is unavailable for this organisation. Sign in again or ask its administrator to check your access." at the organisation chooser before `toolbox.enable` (F17), and `invalid_grant` on refresh after `organisations.disable` (F14). After `access.revoke`, the Toolbox drops the tools within its 60-second grant cache.

## D1. Standalone, hand-written provider; not the OpenAPI adapter; not mounted in the Toolbox

1. **Hand-written `mcps/admin` with about 24 outcome-level tools** (recommended). Each tool is one semantic operation with a curated preview and its own targets (R1, R6, R17); roles are the only authority. The adapter planned in docs/10 "After the goal" item 2 would generate 81 operations with argument-echo previews and no role model; it stays planned for later and this provider becomes the specification an adapter would have to match.
2. The OpenAPI adapter first, then the admin MCP as its first source. More work before any demo, and the adapter's generality is not what staff need.
3. Mounted in the Toolbox as provider `admin`. The Toolbox's authority is per-capability grant strings per organisation; staff-only roles across every organisation do not fit it, and the owner asked for a standalone MCP.

Record in `docs/10-capability-platform-plan.md` "After the goal" item 2: the admin MCP is built standalone and hand-written; the adapter stays for other OpenAPI sources.

## D2. Roles live in ID as group entitlements with three grant strings

1. **Three entitlement scopes on the admin MCP resource, `answerable-team`, `answerable-admin`, `answerable-owner`, each held by a group of the platform organisation** (recommended; the owner's words, F6 shows ID accepts them). Authority comes from ID's member access view (F5); a group change applies on the next call; only platform-organisation members can hold them because the platform check runs first (F3); slugs confer nothing, the entitlement does. The organisation-wide entitlement `admin` on the resource lets ID issue the token to every staff member, so `admin_whoami` works for all of them and says "no role".
2. The Toolbox grammar, `admin/<domain>.<operation>` per tool. Finer, but the owner asked for three roles, and per-tool strings would be a maintenance burden for a mission-critical server.
3. Roles in ID's admin scopes (`platform:read` → team, `platform:write` → admin). Those scopes gate ID's admin API for sessions and machines; the admin MCP never asks for them on a person's token (F1), and conflating the two would make the admin MCP's roles leak into cURL access.

## D3. Live authority: one access-view read per request, no cache, fail closed

1. **Read `GET /organizations/{platform}/members/{membership}/access` on every request**, shared across the request's `allow` decisions (recommended). Measured 32 ms median, 49 ms max (F5); staff traffic is small; a revoked owner loses the tools at once; ID down means nothing is served (`UPSTREAM_UNAVAILABLE`), unlike the Toolbox, which serves a cached entry during an outage.
2. The Toolbox's 60-second cache with the audit poller. Faster, but a revocation could lag a minute and an outage would serve stale authority; wrong trade for a mission-critical, low-volume server.

## D4. Every write is controlled class; owner-only tools add a freshness rule; the human class is Not yet

1. **All mutations `risk: "normal"` → controlled** (the host shows the preview and commits with the summary), **critical tools owner-only and requiring `upstream_auth_time` within 30 minutes** (recommended). The human class cannot commit anything today (no approval page, F20), so marking critical tools `high` would make the demo impossible. The freshness rule replaces the ID rule the machine client bypasses (F4): a token refresh keeps the original `upstream_auth_time` (F2), so a left-open session cannot run critical operations after the window; the person signs in again from the host. It needs `upstreamAuthTime` on `UserPrincipal` in `packages/auth` (a small, additive change).
2. No freshness rule in the first version: simpler, but a refresh token (Claude Code keeps one) would allow critical operations for its whole life.
3. Five minutes, ID's own window. Too short for a working session through a host with 900-second tokens (the owner would re-authenticate several times per demo).

The window is `ADMIN_FRESH_SECONDS`, default 1,800; the owner can shorten it.

## D5. Durable intents and evidence in the admin MCP's own Postgres, through two extracted packages

1. **Databases `answerable_admin` and `answerable_admin_test`; intents and evidence from `@answerable/evidence`, the ID client from `@answerable/id-admin`, both extracted from the Toolbox** (recommended). The repository rule says to extract when a second consumer appears, and this is the second consumer of `createIdAdmin`, `createPostgresIntentStore`, `withEvidence`, `createEvidence` and `migrate` (F22); the intent store is not even exported today. Durable intents keep the idempotent-replay guarantee across a restart; the chain records who did what, which ID's audit cannot (it names the machine client, F9). Cost: one ordinary brief (B0) that moves files and tests, keeps the migration file names (A6) and leaves the Toolbox behaviour unchanged.
2. In-memory intents and no evidence; rely on ID's audit with `x-request-id`. Smallest, but a restart loses receipts, a retried commit would re-run as a new intent, and the person behind a change would be nowhere durable.
3. Copy the Toolbox's files into `mcps/admin`. Duplication the repository forbids.

Package names: `@answerable/evidence` (`createEvidence`, `createPostgresIntentStore`, `withEvidence`, `migrate`, the two SQL files) and `@answerable/id-admin` (`createIdAdmin`, `IdError`, `found`, and `@answerable/id-admin/testing` with the fake ID). An alternative is one package for both; two keep each one's purpose plain.

## D6. Correlation and idempotency with ID

**Send `x-request-id: <execution id>` on every ID call and `Idempotency-Key: <intent id>` (`<intent id>.<step>` for multi-write commits) on every write; return ID's `Operation-Id` in receipts** (recommended; F9 and F10 verified both). Alternative: random keys as the Toolbox uses today, which makes a lost answer unsafe to retry.

## D7. Targets bind ID's ETags; If-Match where ID takes it

**`prepare` reads each target and binds `{ kind: "etag", value }`; commit re-prepares (SDK) and sends `If-Match` on the PATCH/PUT operations that accept it** (recommended; F11). Creates, disable and enable have no precondition at ID, so for them the SDK's comparison is the guard and the preview says so. Alternative: a `revision` kind with the number; the ETag already is id plus revision.

## D8. The tool set

**24 tools: 10 reads (team), 10 ordinary writes (admin), 4 critical writes (owner), plus the two commit tools; `sso.set` takes platform credentials only; erasure, invitations, own-credential SSO and client registration are Not yet** (recommended; the table is in [`design.md`](design.md)). Cut candidates if the owner wants fewer: `organisations.update`, `groups.dropmember`, `sso.test`. Alternative: the full admin surface (81 operations) — the adapter's job, later.

## D9. Ports, databases, names

**`mcps/admin`, provider id `admin`, port 47520 locally, 47606 in the acceptance; databases `answerable_admin` and `answerable_admin_test`; variables `ADMIN_*` mirroring `TOOLBOX_*`; machine client `admin-mcp`, public client `claude-code-admin`, groups `answerable-team|admin|owner`** (recommended; F24 shows the ports free and unclaimed). The owner's running Postgres needs the two databases created by hand once, as was done for the Toolbox (the init script runs only on a fresh volume).

## D10. The acceptance fixture gains a platform directory and spare directories

**`startId({ tenants, platform?: { signIns }, spares?: [{ slug, signIns }] })`: the fixture gives the platform organisation a domain and a local directory with queued staff sign-ins, and starts spare directories, trusted at boot, exported with their endpoints and queued emails, for organisations the journey creates** (recommended; probe 2 proved both). The fixture is a test-only script under `apps/id/scripts`; it is the only `apps/id` change, so the ID suite is unaffected. Alternative: journeys that never sign staff in and test roles only through the fake ID; that would leave the demo's core unproven against real ID.

## D11. Where the admin MCP's docs live

**A new docs section `apps/web/content/docs/admin/` with `index.mdx` (what it is, roles, the tools table from the manifest, run it locally, Limits, Errors) and `setup.mdx` (register it in ID with cURL, local demo, Claude Code), added to `meta.json`, `/llms.txt` and `generated.tsx`'s manifests; `docs/11-admin-mcp.md` is the design record** (recommended). Alternative: pages under `/docs/mcp`; the admin MCP is a product for staff, not part of the kit.

## D12. The hand demo's upstream directory

1. **Two lanes** (recommended): `packages/acceptance/scripts/admin-lane.ts` runs real ID from the fixture with the platform directory and a spare, the Toolbox and the admin MCP, for Claude Code by hand: the whole story including the new organisation's person signing in to the Toolbox (any company sign-in accepted, as the host lane does). And the owner's ID on 47300 with the real Entra tenant for steps 1, 2 and 4, where the owner is the staff member and `sso.set` uses the platform Microsoft application; step 3 there needs a second real directory (another Entra tenant or a Google Workspace with the platform Google application configured), which the owner may or may not have.
2. Only the owner's ID. Step 3 is then unproven by hand unless a second directory exists.
3. A dev-only local directory server beside the owner's ID. Product-ish test tooling in a non-test path; not needed while the lane exists.

For the owner's ID the setup is a cURL page (`setup.mdx`), as for the Toolbox, plus one root step: add the owner's member to `answerable-owner` (the owner is currently in no group at all, F25).

## D13. Risk accepted: ID's audit names the machine client

The person behind every change is in the admin MCP's evidence, joined to ID's audit by request id and operation id (D6). ID attributing actions to people directly would need user-delegated tokens at its admin API or RFC 8693 token exchange, both on ID's backlog (docs/02); not re-proposed here.
