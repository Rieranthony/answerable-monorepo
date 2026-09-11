# Answerable

Monorepo for Answerable's products, program documentation, and the local environment.

**Status:** `apps/web` is live. **The current focus is Answerable ID** — the identity service every app and MCP server will authenticate through. Code is written test-first by AI agents from these docs.

The [enterprise foundation](docs/05-id-enterprise-foundation.md) implementation is integrated; production acceptance remains open. Machine tokens bind immutable identities; administrative changes use a transaction-backed operation journal; durable UUID audit subjects and tenant isolation safeguards are implemented. Production user OAuth and own-tenant SSO are implemented. Production remains no-go until the [release decision checklist](reports/answerable-id-release-decision-plan.md) closes. New installations use one initial migration and immutable bootstrap bindings; see [ID setup](apps/id/README.md#commands).

| Workspace            | What it is                                                                                                                                                          | Status                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`           | Public site (Next.js 16): the waitlist one-pager, the Answerable ID browser pages, and the docs at `/docs` (Fumadocs, Markdown for agents at `.md` and `/llms.txt`) | Live                                                                                                                                                     |
| `apps/id`            | **Answerable ID** — identity broker for client orgs, OIDC login provider for our apps, OAuth 2.1 authorization server for hosted MCP servers                        | User/machine OAuth, own-tenant SSO, linking, administration and soft deletion implemented; not deployed — [acceptance](reports/id-release-acceptance.md) |
| `packages/ui`        | Shared React UI: shadcn base-nova components on Base UI and the Tailwind theme, consumed as source by apps/web                                                      | Live                                                                                                                                                     |
| `packages/countries` | ISO country list, priority order and flag URL helper; framework-free                                                                                                | Live                                                                                                                                                     |
| `apps/community-mcp` | The tutor MCP (the Omni Accelerator community inside OmniChat)                                                                                                      | **Parked** until Answerable ID ships — its docs and Circle mocks stay in that folder, out of the plan                                                    |

## Reading order

| #   | File                                                                                                              | Time  |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | [`docs/00-orientation.md`](docs/00-orientation.md) — glossary, names, the problem                                 | 4 min |
| 2   | [`docs/01-architecture.md`](docs/01-architecture.md) — landscape, the golden rule, stack                          | 5 min |
| 3   | [`docs/02-plan.md`](docs/02-plan.md) — how we build, build order, the open register                               | 6 min |
| 4   | [`docs/03-answerable-id.md`](docs/03-answerable-id.md) — **the Answerable ID design (canonical)** — read in full  | 8 min |
| 5   | [`docs/04-answerable-id-schema.md`](docs/04-answerable-id-schema.md) — implemented schema contract and invariants | 6 min |

Current contracts describe implemented behaviour; historical reports retain implementation evidence. Open items use stable IDs such as `Q-PUBLISHER-VERIFICATION`.

## Local environment

`bun dev` starts Docker (Postgres + Redis) first, then the apps. Requirements: Docker Desktop (Compose v2) and Bun 1.3.1. The web app runs at `http://localhost:47100` and Answerable ID at `http://localhost:47300`.

```bash
bun install
cp .env.example .env
bun dev
```

`apps/web` reads its own env file: `cp apps/web/.env.example apps/web/.env.local`. The waitlist form writes to a Google Sheet through a service account (`GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`). All three are optional locally (without them the form logs the address to the terminal and reports success) and required in production, where the form returns an error if any is missing. The file walks through creating the service account and sharing the sheet.

| Service    | Host port | Purpose                                                       |
| ---------- | --------- | ------------------------------------------------------------- |
| `web`      | 47100     | Public site and Answerable ID browser pages                   |
| `id`       | 47300     | Answerable ID API                                             |
| `postgres` | 47432     | `answerable_id`, plus `answerable_id_test` for the test suite |
| `redis`    | 47379     | Session read-cache — later; unused by v1 code                 |

Uncommon host ports so nothing clashes with other local projects. Answerable ID itself runs on the host at `http://localhost:47300`. Other commands: `bun run env:down` · `bun run env:reset` (wipes data) · `bun run test` (Answerable ID against Postgres, plus the web unit tests) · `bun run build` · `bun run lint`.

## How we build

- **Bun everywhere**, including production. Hono for HTTP. Postgres for all state, including sessions; Redis as a read cache later.
- **Test-driven.** Every change starts with a failing test; CI enforces full coverage of our own code.
- **Admin API first.** Organization, domain, group, client, resource, entitlement, and user changes go through typed Hono routes under `/api/admin`, documented with OpenAPI; routes call services and grouped query modules.
- **No CDN or WAF** in front of our services for now; TLS terminates at the ingress.
- **Better Auth is the base**, pinned per milestone; house-specific behavior ships as custom plugins, never forks.
