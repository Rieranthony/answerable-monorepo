# Magic links: findings

Verified against Better Auth 1.7.15 as installed, and ID at `cfc2b200`. Docs: https://better-auth.com/docs/plugins/magic-link

## Better Auth's plugin (`better-auth/dist/plugins/magic-link/index.mjs`)

- `POST /sign-in/magic-link` makes a 32-character token, stores `magic-link:<stored token>` with value `{type, email, name}` (strict schema, no extra fields), then awaits `sendMagicLink`.
- `GET /magic-link/verify` consumes the token atomically on a plain GET. A mail scanner's pre-fetch would burn it, so ID cannot link to this route directly.
- It calls `internalAdapter.createSession(user.id)` with no hook for origin, and `createUser` without ID's required `status`. So `disableSignUp: true`, and ID provisions the user itself first.
- Options: `expiresIn` (default 300 s), `disableSignUp`, `generateToken`, `storeToken` (`plain` by default; `hashed` or custom hasher), `rateLimit` (default 5 per 60 s on both routes, in-process). `allowedAttempts` is deprecated: always single use.
- `magicLinkIdentifier(stored)` is internal, so a custom hasher lets ID compute the identifier to read a row before consuming it.
- Critical advisory GHSA-965c ("OAuth state can be used as a Magic Link") was fixed in 1.7.7. ID is on 1.7.15.

## What ID assumes

- `auth/sso-origin.ts` `before`: every session needs an origin set in the same transaction, or it throws `authentication_origin_missing`. Only SSO resolution sets one.
- Trigger `protect_session_authentication_origin` (`drizzle/0001_invariants.sql:279`): a session's provider row, revision, organisation and account must all agree, against `sso_providers` and `accounts`.
- `grant_contexts.authentication_provider_id`, `_account_id` and `_revision` are NOT NULL and immutable.
- Grant boundaries join `sso_providers`: `tenant-authentication.ts`, `grant-authentication.ts`, `user-oauth-flow.ts`, `verified-sso.ts`. Each requires revision equality and `deleted_at is null`.
- `sso_providers_organization_id_unique` is partial: one live provider per organisation.
- `users.status` has no default by design. `users.email` is globally unique and normalised.
- `http/principal.ts` loads admin grants from any session, and `freshAuthenticationGuard` reads `upstream_auth_time` and points at `/auth/sso/reauthenticate`.
- `docs/02-plan.md` "do not re-propose": email as a linking key at login. Backlog: "hosted email+password login with MFA", "transactional outbox".
- `auth-allowlist.ts` blocks every route not listed.

## Repo patterns (full map: scratchpad `magic/audits/repo-map.md`)

- **Admin API:** a status toggle is a `POST …/enable` and `…/disable` pair. Copy `enableOrganizationDomain` (`http/admin/domains.ts:110-149`, `services/domains.ts:31-79`). Organisation writes are `platform:write`; reads add `org:read`. Revision bumps by trigger. A no-op writes no audit event.
- **Proposed names:** `POST /organizations/:organizationId/magic-link/enable|disable`, `enableMagicLink`, `disableMagicLink`; field `magicLinkEnabled` on `organizationSchema`; audit `organization.magic_link_enabled|disabled`; admin MCP `magiclink.enable|disable`, role `admin`, effect `permission_change`, copying `entitlementStatus` (`mcps/admin/src/access.ts:194-233`).
- **Fake:** `packages/id-admin/src/testing.ts` gets the field and routes; its test validates every answer against `openapi.admin.json`.
- **Secret:** `defineConfig` field with `secret: true`, `source: "deploy"`; `deploy.test.ts:208-226` forces it into `ID_ENV_NAMES` and both workflows. `POSTMARK_SERVER_TOKEN` is the sixth pasted secret; the docs saying "five" change too.
- **Network:** ID's policy already allows TCP 443 to public addresses on Civo. The kind stack denies it and needs `id.extraEgress`.
- **DNS:** the edge module writes four A records only and its tests assert that; mail records need a new variable and resources with `proxied = false`, public values in tfvars.
- **Migration:** staging applied `0000` and `0001`, so this is `0002`. `db:regenerate` would wipe it and should go first. `migration-catalogue.ts:21-32` hard-codes two files. `capture_audit_subjects()` lists actions and needs `CREATE OR REPLACE` if the disable revokes grants. A new `organizations` column leaks into organisation responses and audit evidence until declared.
- **Mail sink for tests:** a fake Postmark `Bun.serve` beside `startOidcIssuer`, port 0, origin in the fixture manifest.

## Postmark and scanners (full research with links: scratchpad `magic/audits/postmark.md`)

- **Domain:** dedicated subdomain `id.answerable.org`; staging `id.answerable-staging.uk`. From `Answerable ID <sign-in@id.answerable.org>`, Reply-To `support@answerable.org`. Postmark advises against `no-reply@`.
- **DNS:** DKIM TXT at `<selector>._domainkey.id…`, Return-Path CNAME to `pm.mtasv.net` with `proxied = false`, DMARC TXT on the subdomain from `p=none` to `reject`. No SPF on the From domain per Postmark. Exact hosts come from Postmark's DNS Settings page. Check the apex's existing records first.
- **Account:** one Live Server per environment. Sends are limited to verified domains until account approval (error 412); approval under 24 hours on weekdays. A Server's type cannot change later.
- **Sending:** `TrackOpens: false`, `TrackLinks: "None"` on every message; turn tracking off on the Server too, since server-level open tracking overrides a per-message false. No idempotency key. Message content, links included, stays in Activity for 45 days and cannot be disabled, so links must expire quickly and access to Activity must be limited.
- **Client:** thin `fetch` wrapper with a 10 s timeout. `postmark` 5.1.0 has no dependencies and no retries, so it adds little.
- **Scanners:** Safe Links detonates links before delivery. An auto-submitting page failed at Healthchecks.io in 2019. Check Point documents a link analyser that fills forms. Mimecast and Proofpoint publish nothing either way. WorkOS moved to six-digit codes; Stytch and Descope detect scanners. A POST button is the minimum, not a guarantee.
- **Expiry:** 10 minutes. NIST 800-63B-4 caps out-of-band secrets at 10 minutes. Postmark had outbound delays of about 18 and 20 minutes in September 2026.
- **Limits, judgement not standard:** per address 1 per 60 s, 5 per hour, 20 per day; per IP 30 per 5 minutes. Named figures: Supabase 1 per 60 s, WorkOS 3 per 60 s per email, Auth0 50 per hour per IP.
- **Residency:** no EU or UK residency at Postmark; its own SOC 2 or ISO status unconfirmed. Procurement may ask.
- **Cost:** 10k messages a month is about $15 to $18. Bulk-sender rules start at 5,000 a day.

## React Email (measured; full results: scratchpad `magic/audits/react-email.md`)

- Works in ID's bundle run from an empty directory with `bun --no-install`. Runtime rendering adds 1.36 MB (+22.7%), including `react-dom` and Prettier, and React's development build unless `--define` is set. First render 20-26 ms, later 0.6-1.6 ms.
- `render()` under Bun retains about 20 KB of heap per render after a full GC, linear to 5,000 renders.
- **Precompile:** +9.8 KB, 0.2 ms, retains nothing. HTML, text and subject match the runtime renderer on 21 hostile inputs (`<script>`, `&`, `$&`, `{{url}}`, CRLF). Needs a generator, a committed generated file and a drift test, which is the repo's existing habit. Templates are limited to string holes.
- JSX: `bun build` honours each file's tsconfig, but `tsc` and `bun test` in ID apply `hono/jsx`, so each email `.tsx` needs `/** @jsxImportSource react */`. Precompiling keeps ID from importing `.tsx` at all.
- Output: 5,692 bytes of HTML, table layout, `mso` button markup, no external resources, plain text carries the link. Real Outlook and Gmail not tested.
- Packages: individual `@react-email/*` plus `@react-email/render`; `react` 19.2.4 keeps one copy. 24 new registry packages, no install scripts, no audit findings. `react-email dev` installs 142 packages and Next.js, so a script writing HTML to disk is enough. `@react-email/render@2.2.0` was five days old on the day of the probe.
- Must change: `apps/id/Dockerfile` needs `COPY packages/emails`, and images build only on a tag, so a test should check every `workspace:*` dependency has a COPY. `apps/id/bunfig.toml` coverage ignore. `ci.yml` test step.

## DNS today (read 2 November 2026)

- `answerable.org`: MX to Microsoft 365, SPF `include:spf.protection.outlook.com ~all`, DMARC `p=none; rua=mailto:info@answerable.org`, Cloudflare.
- `id.answerable.org`, `answerable-staging.uk`, `id.answerable-staging.uk`: no MX, TXT or DMARC.
- A dedicated `id.` sender does not disturb the apex's Microsoft 365 mail. It inherits the apex's `p=none` until it publishes its own record.

## Prototype results (`cfc2b200`, Better Auth 1.7.15; full evidence: scratchpad `magic/audits/prototype.md`)

- With a magic-link row for every organisation, ID's suite ends at 1543 passing, 0 failing, including 38 probes. Before read filters: 81 fail. After five filters and a definer trigger: 41 fail, all test assumptions, fixed by 29 test edits. No behaviour expectation changed.
- Sign-in, scanner GET and HEAD, replay, race, expiry, full OAuth flow, toggle, firm isolation and every refusal held. Responses are byte-identical across five address states; handler medians 1.24 to 1.31 ms.
- **Failures and gaps found:** pending `prompt=login` or `max_age=0` looped until resumed through the provider's after-hook. A `revision` bump needs a real column change. A plus address let a revoked person back in. A retired address gets a dead link. A removed domain left sessions alive. A removed directory opened the organisation at once. `POST /auth/sso/link` worked from a magic-link session. 50 requests gave 50 mails. The origin check does not run without a cookie, so a cross-site form could sign a browser in.
- **One-proof adoption is a takeover path:** the first directory token asserting the address binds the user, and on Entra `email_verified` is never read. The design rejects it.
- `validateSchema` does not run for ID, since the adapter wrapper hides the instance. Run by hand it reports 35 missing columns, on clean `cfc2b200` too. If that wrapper ever registers the check, set `validateSchema: false` first.

## Both methods for one person (owner's correction, probe on `cfc2b200`, Better Auth 1.7.15)

The owner corrected the design: Entra is added on top of magic links, never replacing them, and staff choose per firm. A focused probe ran one person through both methods.

- **Found:** `putSsoProvider` and `deleteSsoProvider` revoke every grant in the organisation, so connecting Entra cut magic-link people's refresh (400). Narrowed to directory-origin grants: 200 after connecting and after removing.
- **Found:** after a directory is removed, its people were refused a link as `other_account`. Counting this organisation's removed providers as its own fixes it.
- **Magic link first:** connecting Entra leaves the magic-link session and refresh working. An unbound directory sign-in answers `email_conflict`. After binding (a stand-in for the mailbox proof): same `sub`, one user row, two accounts, and the magic link still works.
- **Entra first:** a magic link signs the same user in, with the same `sub`, one user row, two accounts.
- **Magic links off:** the directory session, refresh and new sign-ins continue; the magic-link session and refresh end; no mail; `/login` goes to the directory.
- **Directory removed:** directory session and refresh end; magic-link session and refresh continue; a link is still issued.
- **Removed member:** no mail, old link refused, directory answers `membership_revoked`, refresh refused both ways.
- **Admin:** the same person's directory session gets 200, and their magic-link session 404.
- **Another firm's directory account:** refused as `other_account`.

Not built or run: the choice page, the mailbox-proof step itself, the removed-member email.

Full suite on this probe: 1,539 pass, 9 fail. Eight assert the old rule: four earlier probes, and four tests in `http/pages/pages.integration.test.ts` where a firm with a directory and default-on magic links reached "check your email" instead of the directory. The real build's choice page changes those. The ninth, in `entitlement-audit.integration.test.ts`, was a connection timeout at machine load above 100, and the file passes alone (3 pass).

## Stopping someone (read in code at `b47f276a`, not run)

- **The admin API has the commands:** `disableUser`, `enableUser`, `retireUserEmail` (`http/admin/users.ts`), `removeMember`, `reinstateMember` (`http/admin/members.ts`). All are `platform:users` with `freshAuthentication: true`. `GET /users?email=` finds a person.
- **The admin MCP has no tool for any of them,** and its machine client could not call them. `register.ts` gives `admin-mcp` `platform:read` and `platform:write`, `authorizeCommand` checks the exact scope, and `packages/id-admin` only asks for those two.
- **`register` cannot add the scope alone on a deployed environment.** Client scopes widen, but capabilities are created only when missing, and staging already has this one.
- **Freshness:** `http/admin/command.ts` checks it only for a person's own session, so a machine client's call needs the MCP's `requireFresh`, as `organisations.disable` does.
- **Staff as targets:** `protectPlatformUser` protects only the last platform writer, and `staff.revoke` is owner-only. An `admin`-role tool must therefore refuse a platform-organisation target.
- **Not restored on undo:** `reinstateMember` keeps the membership's id and window, but not its direct grants and group assignments. `enableUser` does not restore sessions. `retireUserEmail` needs a disabled user and is terminal.
- **Address release:** added in `17b49ef7` (4 September), and `446055a2` (20 October) added its audit event. Tests that change: `services/federation.integration.test.ts`, "releases a disabled holder's recycled email for a new identity" and the table of refused holders. Docs: `apps/web/content/docs/id/onboard.mdx`, "Offboard"; `sign-in.mdx`, `email_conflict`.

## Working hypothesis, now proven by the prototype

A magic-link "provider" is a second row in `sso_providers` with a new `kind`. Every grant boundary then applies unchanged. Turning the option off bumps that row's revision, which ends those sessions and grants at once and leaves directory sign-ins alone. Native SSO never sees the row, through the adapter's existing `visible` filter.
