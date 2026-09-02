# Answerable

Monorepo for Answerable's products, program documentation, and the local environment.

**Status:** `apps/web` is live. **The current focus is Answerable ID** — the identity service every app and MCP server will authenticate through. Code is written test-first by AI agents from these docs.

| Workspace | What it is | Status |
| --- | --- | --- |
| `apps/web` | Public waitlist one-pager (Next.js 16) | Live |
| `apps/id` | **Answerable ID** — identity broker for client orgs, OIDC login provider for our apps, OAuth 2.1 authorization server for hosted MCP servers | Schema foundation built — design in [`docs/03-answerable-id.md`](docs/03-answerable-id.md) |
| `apps/community-mcp` | The tutor MCP (the Omni Accelerator community inside OmniChat) | **Parked** until Answerable ID ships — its docs and Circle mocks stay in that folder, out of the plan |

## Reading order

| # | File | Time |
| --- | --- | --- |
| 1 | [`docs/00-orientation.md`](docs/00-orientation.md) — glossary, names, the problem | 4 min |
| 2 | [`docs/01-architecture.md`](docs/01-architecture.md) — landscape, the golden rule, stack | 5 min |
| 3 | [`docs/02-plan.md`](docs/02-plan.md) — how we build, build order, the open register | 6 min |
| 4 | [`docs/03-answerable-id.md`](docs/03-answerable-id.md) — **the Answerable ID design (canonical)** — read in full | 30 min |
| 5 | [`docs/04-answerable-id-schema.md`](docs/04-answerable-id-schema.md) — implemented schema contract and invariants | 6 min |

Every doc opens with a three-bullet TL;DR (*Decides / Rule / Not here*). Dates live only in `docs/02-plan.md`; open items carry stable IDs like `Q-PUBLISHER-VERIFICATION`.

## Local environment

`bun dev` starts Docker (Postgres + Redis) first, then the apps. Requirements: Docker Desktop (Compose v2) and Bun 1.3.1.

```bash
bun install
cp .env.example .env
bun dev
```

| Service | Host port | Purpose |
| --- | --- | --- |
| `postgres` | 47432 | `answerable_id`, plus `answerable_id_test` for the test suite |
| `redis` | 47379 | Session read-cache — later; unused by v1 code |

Uncommon host ports so nothing clashes with other local projects. Answerable ID itself runs on the host at `http://localhost:47300`. Other commands: `bun run env:down` · `bun run env:reset` (wipes data) · `bun run test` · `bun run build` · `bun run lint`.

## How we build

- **Bun everywhere**, including production. Hono for HTTP. Postgres for all state, including sessions; Redis as a read cache later.
- **Test-driven.** Every change starts with a failing test; CI enforces full coverage of our own code.
- **Admin API first.** Organization, domain, group, client, resource, entitlement, and user changes go through typed Hono routes under `/api/admin`, documented with OpenAPI; routes call services and grouped query modules.
- **No CDN or WAF** in front of our services for now; TLS terminates at the ingress.
- **Better Auth is the base**, pinned per milestone; house-specific behavior ships as custom plugins, never forks.
