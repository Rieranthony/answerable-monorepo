# Magic links: decisions

The owner decided D1 to D4 on 2 November 2026, corrected D4 the same day, then added D5 and D6.

| # | Decision | Owner's answer |
| --- | --- | --- |
| D0 | Magic links and Entra together | **Independent, per firm, set by Answerable staff. Entra is an added benefit on top of magic links, never a replacement, because a firm's IT team may block it. Nothing is forced.** |
| D1 | Who may ask for a link | Effective members by default. A per-firm switch opens it to anyone with an address at a listed domain. Removed members get an error and can never use this path. |
| D2 | A link opened in another browser, on a phone, or by a scanner | Same browser gets one click. Anywhere else asks for the 8-digit code from the same email, on the page where sign-in started. |
| D3 | Lifetimes for this origin | Session capped at 24 hours from creation; grant 7 days. |
| D4 | Starting on magic links and adding Entra | In the first release. A person keeps one account and one `sub`, and both ways keep working. Requiring two proofs once per person prevents takeover. |
| D5 | Stopping someone from the admin MCP | Add `users.disable`, `users.enable`, `members.remove` and `members.reinstate`. ID is the authority, and a directory is only a provider to it. |
| D6 | A disabled person's address | It stays blocked until staff deliberately retire it. A sign-in no longer frees it. |

## What D5 and D6 mean in the design

- **A fifth tool, `users.retireemail`.** D6 makes retiring the only way to free an address, so staff need it in the admin MCP too. Role `owner`, because it is terminal. It was not in the owner's list: the owner can drop it and use the admin API instead.
- **D6 reverses a behaviour ID has had since September.** Sign-in released a disabled holder's address so a firm could reuse it, and the v0 code audit kept that and added an audit event. Now a firm that gives an old address to a new person needs a staff step first: disable and retire the old holder. Until then the new person sees `email_conflict`.
- **Both ship in W0.** Neither depends on magic links, and staff should be able to stop someone before the first firm is on.

## What D1 means in the design

- **Removed members.** A revoked membership is refused at issue and at confirm, in both admission modes, and by the directory. An old link or code shows an error saying access was removed. A new request sends no link: it sends a short "your access was removed, ask your administrator" email. The sign-in page stays uniform, because a visible error there would let anyone check whether an address was removed. The owner can choose the visible error instead.
- **Known limit in domain mode.** A removed person's other address (an alias) is a different address, and ID cannot tell it is the same person. It is why domain mode is off by default, needs DNS proof of the domain, and warns when organisation-wide entitlements exist. In the default mode this cannot happen.

## What D0 means in the design

- Connecting, changing or removing a directory ends directory-origin grants only. Today it ends every grant in the firm.
- With both on, the person chooses on a page, with no automatic redirect.
- A firm that requires Entra only needs staff to turn magic links off. A magic link does not pass through Entra's MFA or conditional access. The admin preview says so.

## Settled by the evidence, unless the owner objects

- Provider row in `sso_providers` with a `kind`, shipped over two releases.
- Precompiled React Email in `packages/emails`.
- Thin `fetch` client for Postmark, not the `postmark` package.
- In-process bounded queue, not a durable outbox: a link lasts 10 minutes, Postmark has no idempotency key, and a retry after a crash could send twice.
- No Postmark webhook in the first release: Postmark suppresses bounced addresses itself, and send errors are stored for diagnosis. It comes with the alerting work.
- Sender `Answerable ID <sign-in@id.answerable.org>`, Reply-To `support@answerable.org`, staging on `id.answerable-staging.uk`.
- A magic-link session has no admin authority.
- Domain mode requires every active domain of the firm to have passed a DNS TXT check.
- ID reads `cf-connecting-ip` first and `x-forwarded-for` otherwise, and Cloudflare's ranges are not in ID's proxy list, though they stay in Traefik's.
- The edge rule fits the free plan: `/login` alone, 60 requests per address in 10 seconds, then a 10-second block. It needs Zone WAF Edit on the Cloudflare token.
- An absent `Origin` on `POST /login` stays allowed: a browser always sends one on a post, and a client without one is not a cross-site victim.
- An image behind the database applies nothing and leaves ID's runtime role grants as the newer image set them.
- The stop tools take an address or an id, both optional in the schema and checked at prepare, because hosts refuse a top-level choice in a tool's input.
