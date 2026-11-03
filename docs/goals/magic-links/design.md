# Magic links: design

Draft for the owner's review. Nothing is built. Measured against Better Auth 1.7.15 with a throwaway prototype, then attacked independently. Open choices are marked and listed in `decisions.md`.

## The two methods are independent

Magic links and a directory (Entra) are separate, per firm, and Answerable staff set each. Connecting a directory never changes magic links, and magic links never block a directory. Entra is an added benefit on top, because a firm's IT team may block or delay it.

| Magic links | Directory | Result |
| --- | --- | --- |
| On | None | Email link only |
| On | Connected | Either: the person chooses |
| Off | Connected | Directory only. This is how a firm requires Entra |
| Off | None | Nobody can sign in |

## Rules it keeps

- `(issuer, subject)` is the identity key. A bare email claim never links identities: linking needs proof of the mailbox, within one firm.
- No user token without that user's own authentication as evidence (the golden rule).
- Every grant boundary keeps its locks and checks. Nothing about a directory sign-in changes.
- The platform organisation can never use magic links.
- A disabled person keeps their address until staff retire it. No sign-in frees it, on either method.
- Migrations are expand, then contract. The previous image keeps working.

## Who may ask for a link (decision D1)

The provider row has `admission`: `listed` by default, or `domain`.

**Listed** (default): an effective member of that organisation, however they joined, staff import or a directory sign-in, at one of its active domains, whose user is active. Importing refuses an address outside the organisation's domains or on the public mail list.

This is what makes "on by default" safe. An organisation with no members admits nobody, so a new organisation or a domain added too early opens nothing. No mail goes to an unknown address, so random addresses cannot create bounces. A code cannot create a member. An alias is a stranger unless staff list it.

Import creates the user and membership at once, so `sub` exists before the first sign-in. The OmniChat migration needs exactly that for firms with no directory.

**Domain:** additionally, anyone with an address at a listed domain, and first sign-in creates them. Turning it on requires every active domain to have passed a DNS TXT check, and is refused otherwise. The admin preview warns when organisation-wide entitlements exist, because a new person would then have app access at once. A per-organisation cap drops excess requests, since mail can now reach made-up addresses. An alias of a removed person is a different address, which ID cannot recognise; the warning and named assignments are the protection.

**Removed members and disabled users get an error in both modes.** A revoked membership or a disabled user is refused at issue and at confirm. An old link or code shows that access was removed. A new request sends no link: it sends a short "your access was removed, ask your administrator" email, within the same limits. The sign-in page stays uniform, so a stranger cannot check whether an address was removed.

## Provider row

A magic-link origin is a row in `sso_providers` with `kind = 'magic_link'`. Directory rows are `kind = 'oidc'`.

- One live row per organisation and kind (partial unique index). A database trigger creates the row with the organisation.
- `kind` is immutable. A live `oidc` row has config, and a `magic_link` row has none (check constraint).
- `enabled` is a column on this row. Any change to the row bumps `revision` through the existing guard, so the setting and the revision cannot disagree.
- `admission` is the exception, in the guard's ignored columns. It decides who may ask for a link, and narrowing it leaves existing members as members, so changing it ends nobody's session.
- Issuer is the constant `urn:answerable:magic-link`. `provider_id` is `magic-link:<organisation id>`, and a colon can never collide with a slug.
- Native SSO never sees these rows: the adapter's `visible` filter adds `kind = 'oidc'`. Direct reads that mean "the directory" filter too: `providerQuery`, `readSsoIssuer`, `readSsoEndpoints`, `deleteSsoProvider`, the link target in `verified-sso.ts`. Origin checks do not filter.

Sessions and grants already name a provider row and revision, so turning the option off ends those sessions' authority and those grants' renewal at once, and touches nothing else. A service token already issued lives to its expiry, which is why its lifetime is set per resource.

## Rollout: two releases

Old code reads `sso_providers` with `limit(1)` and native SSO reads by organisation, so a magic-link row breaks the previous image. Measured: directory sign-in answered `Invalid SSO provider` once the row came first.

- **Release N:** `kind`, the new index, every filter, and the refusals that only matter once rows exist: no admin authority from a magic-link session, and `/auth/sso/link` and `/reauthenticate` refused by kind. No magic-link rows exist. N is the previous image during N+1's rollout and after a tag back, so it must be safe on N+1's data.
- **Release N+1:** the trigger, the backfill and the feature.

Also, `runMigrations` must accept a database ahead of its image, or a tag back fails. That landed in W0. An image from before W0 refuses a newer database, so the first tag should be a commit with W0 and no migration.

## States

- A new organisation has it on. The platform organisation has it off, and a trigger refuses turning it on.
- Staff turn it on or off at any time, with or without a directory.
- Turning it off ends magic-link sessions and grants only. Directory sign-ins continue.
- **Connecting, changing or removing a directory ends directory-origin grants only.** Today those commands revoke every grant in the organisation, which would cut magic-link people's app access. Measured with the narrowed revocation: a magic-link grant still refreshes after connecting and after removing a directory.
- An account from this organisation's directory never blocks a magic link, even after that directory is removed. An account from another organisation's directory is refused.
- Removing or disabling a domain revokes the sessions and grants of that domain's addresses, and leaves the rest of the firm signed in.

## Request

`POST /login` refuses an address over 254 characters before any pattern runs, checks the origin, and applies the per-client limit. It then routes by the domain's firm:

- **Directory only:** to the directory, as today.
- **Magic links only:** the "check your email" page.
- **Both:** a page with "Continue with Microsoft" and "Email me a sign-in link". There is no automatic redirect, because a person blocked by IT must be able to reach the link. After a failed directory sign-in that returns to ID, the error page offers the link too.

Asking for a link always answers the same "check your email" page whatever the address's state. It keeps an unexpired browser cookie, `__Host-answerable-sign-in` (`SameSite=Lax`), or sets a new random one for 10 minutes. Address-dependent work runs after the response, in a bounded in-process queue that drains on SIGTERM. An overflow is dropped and counted.

The job:

1. Checks admission. An account from another firm's directory or magic-link row, or one no provider row names, makes a stranger.
2. In one transaction, under an advisory lock on the address, takes limits in Postgres so they hold across replicas: per address and client 1 per 60 s and 5 per hour; per address 50 per day; per organisation 5,000 per hour.
3. In the same transaction, calls Better Auth's `auth.api.signInMagicLink` (`disableSignUp`, custom hasher, 10-minute `expiresIn`), which stores the hashed token, and writes a `magic_link_requests` row marked `sending`: organisation, the provider row and its revision, address, token hash, browser-cookie hash (indexed), an HMAC of the client address, HMAC of the code, attempts, pending OAuth query and expiry. Only `sent` can sign in, so a paused Postmark stops guesses as well as mail.
4. Sends one email through Postmark with the link and an 8-digit code, outside any transaction.
5. Marks the row `sent`, or `failed` with Postmark's code and status. A failed row loses its token in the same commit and counts against no limit.

Requests write log lines, not audit rows. Confirms and refusals at confirm write audit rows. A sweep removes rows after 7 days, and diagnosis reads them, so staff can see a suppressed address (Postmark 406).

## Link and code (decision D2)

`GET /magic-link?token=…` consumes nothing, at any count, for any client. `HEAD` likewise. The native `GET /auth/magic-link/verify` stays off the allowlist.

- **Same browser:** the page names the address and shows Continue. `POST /magic-link` signs in.
- **Another browser, device, scanner or forwarded link:** the page signs nobody in and says to enter the code where sign-in started. A form-filling scanner has no cookie, so it cannot burn the link.

`POST /magic-link/code` is taken on the page where sign-in started. It needs the cookie. Three wrong codes end that request, the count commits outside the sign-in transaction, and a per-client failure budget applies. Using the link or the code ends both.

## Confirm

An internal endpoint, not on the public allowlist, reached only through the pages. One transaction, lock order as the SSO callback, plus `FOR UPDATE` on the request row and an advisory lock on the address:

1. **Compare the browser cookie's hash with the row, in this transaction.** A token alone never signs in.
2. Re-check admission against current state, holding the provider row `FOR SHARE` and refusing when it is off. A boundary compares the revision only, so this is what stops a sign-in racing a disable: either the disable commits first and this refuses, or the session names the old revision and the disable ends it. The session trigger also refuses an origin on an off row.
3. Establish the origin through `createSsoOriginBoundary`, with `upstream_auth_time` null. That column means a directory sign-in, and null keeps sensitive admin commands and `POST /auth/sso/link` closed.
4. Consume by identifier and create the session and cookie through Better Auth (`consumeVerificationValue`, `createSession`, `setSessionCookie`).
5. Resume the pending authorisation through the provider's after-hook with `oauth_query`, so `prompt=login` and `max_age=0` do not loop.

The endpoint refuses cross-site requests itself, since Better Auth checks origin only when a session cookie is present. Replay, expiry and unknown tokens answer identically.

## What Better Auth does, and what ID does

- **Better Auth:** token generation and hashed storage, atomic consumption, sessions, cookies, per-client rate-limit rules, the provider's after-hook. The plugin's `verify` route stays off the allowlist because it consumes on GET.
- **ID:** admission, browser binding, the code, the origin, limits, sending.

Better Auth's `emailOTP` plugin is not used. It keys one code per address and has its own session path, and the code here belongs to one browser's request.

## Authority

- A magic-link session has no admin authority, even with an entitlement: one condition in `effectiveGrants`. The same person's directory session keeps theirs (measured: 200 against 404).
- It cannot use `POST /auth/sso/link` or `/reauthenticate`; both refuse by kind.
- Tokens and UserInfo carry `authentication_method: "magic_link"`, and `packages/auth` passes it on.
- Lifetimes (decision D3): a session capped at 24 hours from creation, through a session update hook, because Better Auth's refresh extends it otherwise (measured: 24 hours became 168 after one GET), and a 7-day grant for this origin.
- Pages treat a magic-link session with a stale revision as signed out. `/security` hides directory actions. `diagnoseSignIn` understands this origin.

## Stopping someone (decisions D5 and D6)

ID decides who signs in, and a directory is only a provider to it. Staff can stop anyone from the admin MCP, on both methods, without the firm's IT team.

| To | Admin MCP | Admin API | Effect | Undo |
| --- | --- | --- | --- | --- |
| Remove someone from one firm | `members.remove` | `DELETE /organizations/{org}/members/{memberId}` | No sign-in at that firm on either method, and that firm's grants end. Other memberships stay. | `members.reinstate`. Direct grants and group assignments are not restored |
| Cut someone off everywhere | `users.disable` | `POST /users/{userId}/disable` | Every session, grant and stored token ends, and no sign-in works at any firm. | `users.enable`. Revoked sessions are not restored |
| Give their address to someone else | `users.retireemail`, after disabling | `POST /users/{userId}/retire-email` | The address is free again. The next holder is a new user with a new `sub`. | None: terminal |

**A disabled person's address.** A new directory identity asserting it answers `email_conflict`, the same as for an active holder, and the holder's row does not change. When a firm really reuses an address, staff disable and retire the old holder, and only then can the new person sign in. Retiring or erasing a person also rewrites the magic-link account key, so the address can be listed again.

**Authority.**

- `users.disable`, `users.enable`, `members.remove` and `members.reinstate` need role `admin`. `users.retireemail` needs role `owner`, because it is terminal.
- A target in the platform organisation needs role `owner` for all five, because `staff.revoke` is owner-only and ID itself protects only the last platform writer.
- Each needs a recent directory sign-in through the kit's `requireFresh`, because ID checks freshness on a person's own session and not on a machine client's.
- Each takes an address or an id, and finds the person with `GET /users?email=`. The preview names the person and their firms, says whether it reaches one firm or all of them, and says what it does not reach.
- The admin MCP's machine client holds `platform:read` and `platform:write`, and these routes need `platform:users`, which `platform:write` does not include. `register` grants it, and must widen the capability that already exists on a deployed environment, since it only creates capabilities when missing. `packages/id-admin` asks for a token with that scope, and the fake enforces it on these routes.

**What stopping does not reach.** A service token already issued lives to its expiry, and each app's own session is the app's to end. That removal belongs to each app's integration. No directory can report a leaver, so staff must remove the member in ID. This goes in the onboarding docs.

## One person, both methods (decision D4)

In the first release. A person has one user and one `sub`, with up to two accounts in the firm: one per method. Sessions and grants each name the method that made them, so each ends independently. Measured: `sub` equal across both, one user row, two accounts.

**Magic link first, Entra added later.** Needs two proofs in one browser, once per person, because the prototype's one-proof adoption let the first token asserting an address take the user.

1. A person's directory sign-in finds their address held by a user with an effective membership here and no directory account here. Anything else keeps today's `email_conflict`.
2. ID stores the verified directory identity for 10 minutes against the browser cookie, emails an 8-digit code to the address, and shows a page asking for it. No session yet.
3. The right code adds the directory account to the same user and writes an audit event. The magic-link account stays, so both ways keep working.
4. The person is sent through the directory again, and now signs in normally. No new session path exists.

This works whether magic links are on or off, since it never signs in from mail alone, so turning magic links off strands nobody.

**Entra first, magic link later.** A mailbox proof by an effective member adds a magic-link account to the same user, with an audit event (`identity.linked`). Only in the same firm: an account from another firm's directory is refused.

**What the firm accepts by having both.** A magic link does not pass through Entra's MFA or conditional access, and someone disabled in Entra can still use a link while their mailbox works. Removing the member in ID stops both. Staff turn magic links off for a firm that requires Entra only. The admin preview says this when a directory is connected with magic links on.

## Emails

`packages/emails` (`@answerable/emails`) holds every email: React Email components, one shared dead-simple layout, per-email templates. Three today: `magic-link`, `access-removed` and `mailbox-code`. A generator precompiles each template to committed `*.generated.ts` strings for HTML and text, with escaped holes. A drift test fails when they differ. ID imports only the generated strings, so React stays out of its production bundle: 28 KB for the three emails and the transport, against +1.36 MB measured for rendering one email at run time, and no per-render memory growth. Each `.tsx` carries `/** @jsxImportSource react */`. A script writes previews to disk.

The type is calm: `heading-h2` (24 px Bold) rather than `heading-h1`, `body-sm` for the text, and the code at 24 px Bold.

The transport lives in the same package: a thin `fetch` client for Postmark with a 10-second timeout and one retry on 429, 5xx, a network error or a timeout, plus a log transport for local development and a memory transport for tests. A send returns a result, never throws on Postmark's answer, and carries numbers only, so neither a link nor a token reaches a log. `TrackOpens: false`, `TrackLinks: "None"`. Nothing secret in `Tag` or `Metadata`. Local development prints the link. Production refuses to start without the token.

## Admin

- API: `POST /organizations/{id}/magic-link/enable` and `/disable`, `platform:write`, idempotent, audited (`organization.magic_link_enabled`, `organization.magic_link_disabled`), a no-op writes no event. `PATCH /organizations/{id}/magic-link` sets `admission`. The organisation's reads show `magicLink`: enabled, admission and the listed count. `POST /organizations/{id}/members/import` takes a list of addresses. `POST /organizations/{id}/domains/{domainId}/verify` checks a DNS TXT record.
- Admin MCP: `magiclink.enable`, `magiclink.disable`, `magiclink.admission`, `members.import` and `domains.verify`, role `admin`, effect `permission_change`; `magiclink.admission` to `domain` needs role `owner`. `organisations.get` shows magic links and the directory side by side, each with its own state. `sso.set`'s preview says magic links stay as they are.
- Admin MCP, to stop a person: `users.disable`, `users.enable`, `users.retireemail`, `members.remove` and `members.reinstate`, as set out in "Stopping someone". They ship in W0, since none depends on magic links.
- The fake (`packages/id-admin`) and `openapi.admin.json` keep parity.
- The public mail list is a generated file from a maintained upstream, checked when a domain is added, when one is enabled, at import and at admission.

## Housekeeping

`verifications` joins the protocol sweep and `verification.disableCleanup` is set, so a sign-in's transaction does not delete expired rows under its locks.

## Tests

ID's 100% gate holds. Added: unit and integration tests for each rule above, and an acceptance journey with real Chromium and a fake Postmark server: request, read mail, scanner GET and HEAD, form-filling scanner POST, confirm, code from a second browser, app flow, toggle, firm isolation, race, replay. Every refusal is asserted both at issue and between issue and confirm. A rollout test runs the previous image's code against the new schema. For stopping someone: each tool end to end against real ID with the machine client's real scopes, the role and platform-target refusals, `register` widening an existing capability, a disabled holder's address answering `email_conflict` with the holder unchanged, and disable, retire, then a new identity signing in as a new user. Real Postmark and a real Microsoft 365 mailbox behind a gateway are checked by hand on staging.
