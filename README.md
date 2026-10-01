# Answerable

Monorepo for Answerable's products, program documentation, and the local environment.

**Status:** `apps/web` is live. **The current focus is Answerable ID** — the identity service every app and MCP server will authenticate through. Code is written test-first by AI agents from these docs.

The [enterprise foundation](docs/05-id-enterprise-foundation.md) implementation is integrated; production acceptance remains open. Machine tokens bind immutable identities; administrative changes use a transaction-backed operation journal; durable UUID audit subjects and tenant isolation safeguards are implemented. Production user OAuth and own-tenant SSO are implemented. Production remains no-go until the [release decision checklist](reports/answerable-id-release-decision-plan.md) closes. New installations use one initial migration and immutable bootstrap bindings; see [ID setup](apps/id/README.md#commands).

| Workspace            | What it is                                                                                                                                                          | Status                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`           | Public site (Next.js 16): the waitlist one-pager and the docs at `/docs` (Fumadocs, Markdown for agents at `.md` and `/llms.txt`)                                   | Live                                                                                                                                                     |
| `apps/id`            | **Answerable ID** — identity broker for client orgs, OIDC login provider for our apps, OAuth 2.1 authorisation server for hosted MCP servers; serves the sign-in pages | User/machine OAuth, own-tenant SSO, linking, administration and soft deletion implemented; not deployed — [acceptance](reports/id-release-acceptance.md) |
| `packages/ui`        | Shared React UI: shadcn base-nova components on Base UI and the Tailwind theme, consumed as source by apps/web                                                      | Live                                                                                                                                                     |
| `packages/countries` | ISO country list, priority order and flag URL helper; framework-free                                                                                                | Live                                                                                                                                                     |
| `packages/auth` | Verify Answerable ID access tokens, for a person or a machine client, in any service; an in-process test issuer | Locally tested |
| `packages/mcp` | The SDK for MCP servers, on the official MCP TypeScript SDK: `defineTool`, `defineMutation`, `defineProvider`, `createMcpServer`, the error envelope, the manifest, the conformance kit and the in-process test client | Locally tested |
| `packages/id-admin` | A server's machine client on ID's admin API (`createIdAdmin`, with `x-request-id` and a caller-chosen `Idempotency-Key`) and the fake ID for tests | Locally tested |
| `packages/mcp-postgres` | Postgres storage for MCP servers: the intent store, the hash-chained evidence and the migrator, shared by the Toolbox | Locally tested |
| `mcps/e2e` | Reference MCP: five tools (one a prepared mutation), a prompt, a resource and an MCP Apps view; every new MCP is compared with it | Local acceptance passes |
| `mcps/toolbox` | The Toolbox: one MCP endpoint serving each person the capabilities their organisation granted, with intents, evidence, spans and an admin API | Local acceptance passes |
| `mcps/admin` | The admin MCP: a staff-only server that reads and changes organisations, domains, SSO providers, groups, access and staff roles in ID, and enables the Toolbox, each tool behind a role read live from ID and each change a prepared intent the person confirms | Locally tested |
| `packages/acceptance` | The acceptance kit and journeys: real ID, the official MCP OAuth client, a browser and ID's pages | Locally tested |
| `scripts` | Repository scripts: `bun run mcp:new <name>` scaffolds an MCP server | Locally tested |
| `apps/community-mcp` | The tutor MCP (the Omni Accelerator community inside OmniChat)                                                                                                      | **Parked** until Answerable ID ships — its docs and Circle mocks stay in that folder, out of the plan                                                    |

## Reading order

| #   | File                                                                                                              | Time  |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | [`docs/00-orientation.md`](docs/00-orientation.md) — glossary, names, the problem                                 | 4 min |
| 2   | [`docs/01-architecture.md`](docs/01-architecture.md) — landscape, the golden rule, stack                          | 5 min |
| 3   | [`docs/02-plan.md`](docs/02-plan.md) — how we build, build order, the open register                               | 6 min |
| 4   | [`docs/03-answerable-id.md`](docs/03-answerable-id.md) — **the Answerable ID design (canonical)** — read in full  | 8 min |
| 5   | [`docs/04-answerable-id-schema.md`](docs/04-answerable-id-schema.md) — implemented schema contract and invariants | 6 min |
| 6   | [`docs/06-deploying-answerable-id.md`](docs/06-deploying-answerable-id.md) — what a production deployment needs and why   | 6 min |

Current contracts describe implemented behaviour; historical reports retain implementation evidence. Open items use stable IDs such as `Q-PUBLISHER-VERIFICATION`.

## Local environment

`bun dev` starts Docker (Postgres + Redis) first, then the apps. Requirements: Docker Desktop (Compose v2) and Bun 1.3.1. The web app runs at `http://localhost:47100` and Answerable ID at `http://localhost:47300`.

```bash
bun install
cp .env.example .env
bun run env:up
bun --env-file=.env run --filter @answerable/id db:migrate
bun dev
```

`default.env` lists every variable the monorepo reads, with empty values. Add a new variable there as well as to the working template; the ID test suite checks it.

`apps/web` reads its own env file: `cp apps/web/.env.example apps/web/.env.local`. The waitlist form writes to a Google Sheet through a service account (`GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`). All three are optional locally (without them the form logs the address to the terminal and reports success) and required in production, where the form returns an error if any is missing. The file walks through creating the service account and sharing the sheet.

| Service    | Host port | Purpose                                                       |
| ---------- | --------- | ------------------------------------------------------------- |
| `web`      | 47100     | Public site                                                   |
| `id`       | 47300     | Answerable ID API and browser pages                           |
| `toolbox`  | 47400     | The Toolbox MCP (`bun run toolbox:dev`)                       |
| `e2e MCP`  | 47500     | The reference MCP (`bun run mcp:dev`); a scaffolded MCP uses 47510 |
| `admin MCP` | 47520    | The admin MCP (`bun run admin:dev`)                           |
| `postgres` | 47432     | `answerable_id`, plus `answerable_id_test` for the test suite; `answerable_toolbox` and `answerable_toolbox_test` for the Toolbox; `answerable_admin` and `answerable_admin_test` for the admin MCP; `answerable_mcp_postgres_test` for `packages/mcp-postgres` |
| `redis`    | 47379     | Session read-cache — later; unused by v1 code                 |

The MCP acceptance (`bun run mcp:test:e2e`) owns 47532 (its own disposable PostgreSQL), 47600, 47602, 47603, 47604, 47605 and 47606 (the admin MCP), and never touches the normal ID database; run one acceptance at a time. `bun packages/acceptance/scripts/admin-lane.ts` keeps ID, the admin MCP and the Toolbox up on the same ports for trying the onboarding story from Claude Code by hand ([Set up the admin MCP](apps/web/content/docs/admin/setup.mdx)); it cannot run beside the acceptance. Uncommon host ports so nothing clashes with other local projects. Answerable ID itself runs on the host at `http://localhost:47300`. Other commands: `bun run env:down` · `bun run env:reset` (wipes data) · `bun run test` (Answerable ID against Postgres, plus the web unit tests) · `bun run build` · `bun run lint`.

The development-only [OAuth test](apps/web/README.md#local-oauth-test) lets the web app exercise ID as an independent OAuth client at `http://localhost:47100/oauth-test`. ID owns every authentication page at `http://localhost:47300`.

## How we build

### MCP kit

- [`packages/auth`](packages/auth/README.md) verifies Answerable ID access tokens.
- [`packages/mcp`](packages/mcp/README.md) is the SDK: define tools, mutations and providers, serve them on the official MCP TypeScript SDK, check them with the conformance kit and test them in-process.
- [`packages/id-admin`](packages/id-admin/README.md) is the machine client on ID's admin API, with the fake ID for tests.
- [`packages/mcp-postgres`](packages/mcp-postgres/README.md) is the Postgres intent store, evidence chain and migrator that servers with a database share.
- [`mcps/e2e`](mcps/e2e/README.md) is the reference server.
- [`mcps/toolbox`](mcps/toolbox/README.md) is the Toolbox, with its own Postgres databases `answerable_toolbox` and `answerable_toolbox_test`.
- [`mcps/admin`](mcps/admin/README.md) is the admin MCP for Answerable staff, with its own databases `answerable_admin` and `answerable_admin_test`.
- [`packages/acceptance`](packages/acceptance/README.md) holds the real-ID acceptance kit and journeys.

| Command | Does |
| --- | --- |
| `bun run mcp:new <name>` | Scaffold `mcps/<name>`: a server with one tool and its conformance test; it prints the commands that install it, write its manifest and check it |
| `bun run mcp:check <workspace>` | Typecheck, lint and test one workspace, such as `@answerable/mcp-e2e` |
| `bun run mcp:test` | The suites of `packages/auth`, `packages/id-admin`, `packages/mcp`, `packages/mcp-postgres`, every server under `mcps/` and the scaffold; the Toolbox, the admin MCP and `packages/mcp-postgres` need the development Postgres |
| `bun run mcp:test:e2e` | The journeys against real ID, a browser and the official MCP OAuth client (Docker) |
| `bun run toolbox:dev` | Serve the Toolbox on 47400; `bun run mcp:dev` serves the reference server on 47500 and `bun run admin:dev` the admin MCP on 47520 |

Create an MCP with `mcp:new` and [Build your first MCP](apps/web/content/docs/mcp/quickstart.mdx), and mount it in the Toolbox with [Add tools to the Toolbox](apps/web/content/docs/toolbox/add-tools.mdx); the [standard](apps/web/content/docs/mcp/standard.mdx) says which rules the SDK, the conformance kit and the Toolbox enforce. [Connect Claude Code](apps/web/content/docs/mcp/claude-code.mdx) covers a real host; [The admin MCP](apps/web/content/docs/admin/index.mdx) covers the server for Answerable staff. Decisions: [MCP foundation](docs/07-mcp-platform-draft.md) and [the capability platform](docs/08-capability-platform.md); results: [evidence](reports/mcp-foundation-evidence.md). Normal `bun dev` starts apps only.

### Repository principles

- **Bun everywhere**, including production. Hono for HTTP. Postgres for all state, including sessions; Redis as a read cache later.
- **Test-driven.** Every change starts with a failing test. CI enforces full line/function coverage for ID and runs the shared-package, browser and real-ID MCP checks.
- **Admin API first.** Organisation, domain, group, client, resource, entitlement, and user changes go through typed Hono routes under `/api/admin`, documented with OpenAPI; routes call services and grouped query modules.
- **No CDN or WAF** in front of our services for now; TLS terminates at the ingress.
- **Better Auth is the base**, pinned per milestone; house-specific behaviour ships as custom plugins, never forks.
