# Magic links in Answerable ID: task plan

Opened 2 November 2026 by the owner. Report before any code. Probes are throwaway and never land.

## Goal

An organisation can sign its people in with an emailed link, sent through Postmark, limited to that organisation's listed email domains. On by default, with a per-organisation switch. Staff toggle it and read its state through the admin MCP. All emails live in one shared package using React Email, with a dead-simple shared layout. Production scale, enterprise customers, everything tested, Better Auth wherever it fits.

## Owner's requirements, verbatim in substance

1. Option per organisation, toggled on and off, default enabled.
2. Limited to that organisation's whitelisted email domains.
3. Lean on Better Auth.
4. Production scale for enterprise customers. No corners cut.
5. React Email. All emails centralised in one place in the monorepo, sharing logic and layouts. Layout dead simple.
6. New Postmark sender, with a guide for maximum deliverability.
7. Admin MCP toggles the option and shows the organisation's current state.
8. Plan with files, use the Better Auth docs, everything tested. Report before coding. Sonnet 5.5 may take delegated work.
9. Staff can stop anyone from the admin MCP. ID is the authority, and a directory is only a provider to it.

## Phases

1. [complete] Repo state, Better Auth docs and installed source.
2. [complete] Everywhere ID assumes a company sign-in.
3. [complete] Admin API, admin MCP, config, secrets, chart, DNS patterns (delegated, Sonnet 5.5).
4. [complete] React Email inside ID's Bun bundle, measured (delegated, Sonnet 5.5).
5. [complete] Postmark and enterprise scanner research (delegated, Sonnet 5.5).
6. [complete] Throwaway end-to-end prototype of the sign-in core, in a worktree. Rerun by the coordinator: 1,543 pass, 0 fail.
7. [complete] Independent attack on the design and prototype. Design rewritten: `design.md`.
8. [complete] Report with decisions, published privately. The owner decided D1 to D6: `decisions.md`.
9. [in_progress] The steps below. W0 to W9 landed on main by 4 November 2026. W10 waits for the owner.

## Build order, after approval

| Step | What | Builder |
| --- | --- | --- |
| W0 | Fix what exists: bound the login address before any pattern, origin check on `POST /login`, body cap on the sign-in routes, client address from `cf-connecting-ip`, edge rate rule, `runMigrations` accepts a newer database, delete `db:regenerate`. A disabled person keeps their address until staff retire it. Admin MCP `users.disable`, `users.enable`, `users.retireemail`, `members.remove`, `members.reinstate`, with `platform:users` for its machine client | Sonnet 5.5 |
| W1 | `packages/emails`: templates, generator, drift test, Postmark transport, and a test that fails when an image misses a COPY | Sonnet 5.5 |
| W2 | Release N: `kind`, index, filters, the refusals by kind, rollout test | Opus 5.5 |
| W3 | Release N+1: provider row, trigger, backfill, toggle, admin API, fake, OpenAPI | Opus 5.5 |
| W4 | Issue: requests table, limits, queue, sending, drain, sweep. ID first imports `@answerable/emails` here: its dependency under `dependencies`, `COPY packages/emails packages/emails` in the Dockerfile, the package in `apps/id/bunfig.toml`'s coverage ignore | Opus 5.5 |
| W5 | Link, code, confirm, pages, authority, session cap, `authentication_method`. The member access view (`queries/access.ts`) must stop reporting admin for a magic-link member; `/security` hides directory actions. Nothing that grants authority reads `enabled` yet: confirm takes the row `FOR SHARE` and refuses when it is off, and the session trigger refuses an origin on an off row. Remove `magicLinkNotYet` from the admin routes | Opus 5.5 |
| W6 | Import, admission setting, DNS proof of domains, admin MCP tools, manifest. Changing `admission` moves no revision, through a guard of the row's own, so it ends nobody's session | Opus 5.5, since it changes admission and confirm |
| W7 | Both methods for one person: choice page, two-proof first Entra sign-in, mailbox proof for Entra-first people, directory commands end directory grants only | Opus 5.5 |
| W8 | Deployment: sixth secret, Terraform mail records, kind stack, docs | Sonnet 5.5 |
| W9 | Public docs, acceptance journey, `docs/02` register | Sonnet 5.5 |
| W10 | Staging proof by hand: real Postmark, real Microsoft 365 mailbox | Owner with coordinator |

The coordinator reviews every change and runs the gates. The owner pushes tags.

**No staging release yet (owner, 3 November 2026).** Work lands on `main` and nothing is tagged. W0 is not deployed.

- **Release (owner, 4 November 2026):** one tag on the newest commit of `main`. Staging has no users, the migrations are squashed, and `staging/fourth`'s image was measured staying healthy while they applied. A fault is fixed forward.
- **W8:** `POSTMARK_SERVER_TOKEN` must be in the GitHub environment before that tag.
- **W10:** needs a release to staging, so it waits for the owner.

## Constraints

- No staging or Postmark change without the owner. The owner pushes tags.
- Repo is public. This directory holds design only, no unfixed findings. Unfixed findings stay in the root `findings.md` and the private report.
- Never read the root `.env`. Never run the firecrawl CLI. Never `bun run env:up` from a worktree.
- ID's rules hold unless the owner changes them: `(issuer, sub)` is the identity key, the golden rule, expand then contract migrations, an applied migration is never edited.

## Errors

| Error | Resolution |
| --- | --- |
