# Answerable

Monorepo for Answerable's products, program documentation, and the local environment.

**Status:** `apps/web` is live. **The current focus is Answerable ID** — the identity service every app and MCP server will authenticate through. Code is written test-first by AI agents from these docs.

The [enterprise foundation](docs/05-id-enterprise-foundation.md) implementation is integrated; production acceptance remains open. Machine tokens bind immutable identities; administrative changes use a transaction-backed operation journal; durable UUID audit subjects and tenant isolation safeguards are implemented. Production user OAuth and own-tenant SSO are implemented. Production remains no-go until the [release decision checklist](reports/answerable-id-release-decision-plan.md) closes. New installations use a generated initial migration, reviewed invariants and immutable bootstrap bindings; see [ID setup](apps/id/README.md#commands).

| Workspace            | What it is                                                                                                                                                          | Status                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`           | Public site (Next.js 16): the waitlist one-pager, the docs at `/docs` (Fumadocs, Markdown for agents at `.md` and `/llms.txt`) and the design system at `/design` | Live                                                                                                                                                     |
| `apps/id`            | **Answerable ID** — identity broker for client orgs, OIDC login provider for our apps, OAuth 2.1 authorisation server for hosted MCP servers; serves the sign-in pages | User/machine OAuth, own-tenant SSO, linking, administration and soft deletion implemented; not deployed — [release checklist](reports/answerable-id-release-decision-plan.md) |
| `packages/ui`        | Shared React UI: shadcn base-nova components on Base UI and the Tailwind theme, consumed as source by apps/web                                                      | Live                                                                                                                                                     |
| `packages/countries` | ISO country list, priority order and flag URL helper; framework-free                                                                                                | Live                                                                                                                                                     |
| `packages/auth` | Verify Answerable ID access tokens, for a person or a machine client, in any service; an in-process test issuer | Locally tested |
| `packages/mcp` | The SDK for MCP servers, on the official MCP TypeScript SDK: `defineTool`, `defineMutation`, `defineProvider`, `createMcpServer`, the error envelope, the manifest, the conformance kit and the in-process test client | Locally tested |
| `packages/id-admin` | A server's machine client on ID's admin API (`createIdAdmin`, with `x-request-id` and a caller-chosen `Idempotency-Key`) and the fake ID for tests | Locally tested |
| `packages/mcp-postgres` | Postgres storage for MCP servers and MCPs: the intent store, the hash-chained evidence, the drizzle base schema, and each MCP's schema and migrations | Locally tested |
| `mcps/e2e` | Reference MCP: five tools (one a prepared mutation), a prompt, a resource and an MCP Apps view; every new MCP is compared with it | Local acceptance passes |
| `mcps/toolbox` | The Toolbox: one MCP endpoint serving each person the capabilities their organisation granted, with intents, evidence, spans and an admin API | Local acceptance passes |
| `mcps/admin` | The admin MCP: a staff-only server that reads and changes organisations, domains, SSO providers, groups, access and staff roles in ID, and enables the Toolbox, each tool behind a role read live from ID and each change a prepared intent the person confirms | Local acceptance passes |
| `packages/acceptance` | The acceptance kit and journeys: real ID, the official MCP OAuth client, a browser and ID's pages | Locally tested |
| `scripts` | Repository scripts: `bun mcp`, which makes MCPs and tools and checks them, and `bun run env:inventory` | Locally tested |
| `infra/civo` | Terraform for the two Civo environments, one root and a var file each: network, cluster, PostgreSQL 17, firewalls, the platform chart, the deployer, the Cloudflare zone with its certificates, and the GitHub environment's own settings and deploy secrets | Validated and tested with mocked providers; not applied |
| `charts/answerable` | The Helm chart of ID, the Toolbox, which serves every MCP of `mcps.json`, and the admin MCP, with their migrations and the ops Jobs | Proved in the kind stack |
| `charts/platform` | The Helm chart of the cluster's edge: Traefik with the TLS option that demands Cloudflare's origin-pull certificate | Proved in the kind stack |
| `infra/k8s` | The kind stack (`infra/k8s/local`): both charts and the images of `infra/pipeline/images.json` in a local cluster, `bun run infra:test`; and the chart tests | Locally tested |
| `infra/ops` | The ops image: `bootstrap` (the database's certificate, databases and logins), `register` (the MCPs in ID, the staff domain and SSO provider) and `make-admin` (the first administrator), run as Kubernetes Jobs | Locally tested |
| `infra/pipeline` | The scripts the workflows call: `deploy`, `run-job`, `smoke` | Locally tested |
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
| 7   | [`docs/12-deployment.md`](docs/12-deployment.md) — where Answerable runs: Civo, Kubernetes, Cloudflare, the pipeline | 7 min |

Current contracts describe implemented behaviour; historical reports retain implementation evidence. Open items use stable IDs such as `Q-PUBLISHER-VERIFICATION`.

## Local environment

`bun dev` starts Docker (Postgres) first, then the apps. Requirements: Docker Desktop (Compose v2) and Bun 1.3.1. The web app runs at `http://localhost:47100` and Answerable ID at `http://localhost:47300`. Run these from the main checkout, never from a worktree, where `env:up` recreates the running Postgres:

```bash
bun install
bun run env:up
bun --filter @answerable/id db:migrate
bun dev
```

No `.env` is needed, `db:migrate` included: every variable has a local value in code. A root `.env` (git-ignored), which ID reads when it starts, holds only what another system issues, which `.env.example` lists, and any value you override. [`packages/config/inventory.json`](packages/config/inventory.json) describes every variable the services read, and the docs render it as tables. Both files are generated by `bun run env:inventory` from each service's definition ([`packages/config`](packages/config/README.md)). Signing in to a local ID needs a company directory's credentials there, or the host lane: [Run an MCP on your machine](apps/web/content/docs/mcp/run-locally.mdx#signing-in-needs-a-company-directory).

`apps/web` reads its own env file: `cp apps/web/.env.example apps/web/.env.local`. The waitlist form writes to a Google Sheet through a service account (`GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`). All three are optional locally (without them the form logs the address to the terminal and reports success) and required in production, where the form returns an error if any is missing. The file walks through creating the service account and sharing the sheet.

| Service    | Host port | Purpose                                                       |
| ---------- | --------- | ------------------------------------------------------------- |
| `web`      | 47100     | Public site                                                   |
| `id`       | 47300     | Answerable ID API and browser pages                           |
| `toolbox`  | 47400     | The Toolbox MCP, and every standalone MCP at its path, e2e at `/e2e/mcp` (`bun run toolbox:dev`) |
| `admin MCP` | 47520    | The admin MCP (`bun run admin:dev`)                           |
| `kind stack` | 48443  | Traefik in the local cluster of `bun run infra:test`, with 47710 and 47700 below |
| `postgres` | 47432     | `answerable_id`, plus `answerable_id_test` for the test suite; `answerable_toolbox` and `answerable_toolbox_test` for the Toolbox; `answerable_admin` and `answerable_admin_test` for the admin MCP; `answerable_mcp_postgres_test` for `packages/mcp-postgres`; `answerable_mcps` and `answerable_mcps_test` for every MCP made by `bun mcp`, a schema each |

The kind stack (`bun run infra:test`, cluster `answerable-local`, one per machine) owns `127.0.0.1:48443` (Traefik), `[::1]:48443` (the browser's edge), 47710 (the stand-in company directory) and 47700 (the OAuth callback), which the acceptance's lanes also use, so it runs on its own. The MCP acceptance (`bun run mcp:test:e2e`) owns 47532 (its own disposable PostgreSQL), 47600, 47602, 47603, 47604, 47605 and 47606 (the admin MCP), and never touches the normal ID database; run one acceptance at a time. `bun packages/acceptance/scripts/admin-lane.ts` keeps ID, the admin MCP and the Toolbox up on the same ports, with 47700 and 47701 for Claude Code's callbacks, for trying the onboarding story from Claude Code by hand ([Set up the admin MCP](apps/web/content/docs/admin/setup.mdx)); the admin journeys run the same story headlessly, and the lane cannot run beside the acceptance. Uncommon host ports so nothing clashes with other local projects. Answerable ID itself runs on the host at `http://localhost:47300`. Other commands: `bun run env:down` · `bun run env:reset` (wipes data) · `bun run test` (Answerable ID against Postgres, plus the web unit tests) · `bun run build` · `bun run lint`.

The development-only [OAuth test](apps/web/README.md#local-oauth-test) lets the web app exercise ID as an independent OAuth client at `http://localhost:47100/oauth-test`. ID owns every authentication page at `http://localhost:47300`.

## How we build

### MCP kit

```sh
bun mcp new acme --description "Notes for construction projects: list, read and add notes on a project." --serve toolbox
bun mcp add tool acme notes.add --mutation --description "Prepare a new note on a project; commit it to save it. Use notes.list first to avoid duplicates."
bun mcp check acme
bun mcp dev acme
git tag staging/acme-notes && git push origin staging/acme-notes   # then production/acme-notes
```

Every MCP gets a database linked to it and its sign-in through Answerable ID, set up for you. Read [Make an MCP](apps/web/content/docs/mcp/create.mdx), [Add a tool](apps/web/content/docs/mcp/add-a-tool.mdx), [Ship an MCP](apps/web/content/docs/mcp/deploy.mdx) and [the `bun mcp` reference](apps/web/content/docs/mcp/cli.mdx).

- [`packages/auth`](packages/auth/README.md) verifies Answerable ID access tokens.
- [`packages/mcp`](packages/mcp/README.md) is the SDK: define tools, mutations and providers, serve them on the official MCP TypeScript SDK, check them with the conformance kit and test them in-process.
- [`packages/id-admin`](packages/id-admin/README.md) is the machine client on ID's admin API, with the fake ID for tests.
- [`packages/mcp-postgres`](packages/mcp-postgres/README.md) is the Postgres side of every MCP: the intent store, the evidence chain, the drizzle base schema and a database for each MCP.
- [`packages/mcp-platform`](packages/mcp-platform/README.md) is what every server Answerable runs shares: evidence, spans, health and each MCP's database.
- [`scripts`](scripts) holds `bun mcp`: `new`, `add tool`, `list`, `check`, `db`, `setup`, `dev` and the generator of the lists the Toolbox and the chart read.
- [`mcps/toolbox`](mcps/toolbox/README.md) is the Toolbox, which also serves every MCP that runs on its own URL, and [`mcps/admin`](mcps/admin/README.md) is the admin MCP for Answerable staff, each with databases of its own.
- [`mcps/e2e`](mcps/e2e/README.md) is the reference server and [`mcps/example`](mcps/example) the finished example, exactly as `bun mcp` writes it.
- [`packages/acceptance`](packages/acceptance/README.md) holds the real-ID acceptance kit and journeys.

| Command | Does |
| --- | --- |
| `bun mcp help` | Every command; [the reference](apps/web/content/docs/mcp/cli.mdx) says the rest |
| `bun run mcp:check <workspace>` | Typecheck, lint and test one workspace, such as `@answerable/mcp-e2e` |
| `bun run mcp:test` | The suites of `packages/auth`, `packages/id-admin`, `packages/mcp`, `packages/mcp-postgres`, every server under `mcps/` and `bun mcp`'s; the Toolbox, the admin MCP, `packages/mcp-postgres`, `bun mcp` and every MCP with a database need the development Postgres |
| `bun run mcp:test:e2e` | The journeys against real ID, a browser and the official MCP OAuth client (Docker) |
| `bun run toolbox:dev` | Serve the Toolbox on 47400, with every standalone MCP at its path; `bun run admin:dev` serves the admin MCP on 47520 |

The [standard](apps/web/content/docs/mcp/standard.mdx) says which rules the SDK, the conformance kit and the Toolbox enforce. [Connect Claude Code](apps/web/content/docs/mcp/claude-code.mdx) covers a real host; [The admin MCP](apps/web/content/docs/admin/index.mdx) covers the server for Answerable staff. Decisions: [MCP foundation](docs/07-mcp-platform-draft.md), [the capability platform](docs/08-capability-platform.md) and [the admin MCP](docs/11-admin-mcp.md); results: [evidence](reports/mcp-foundation-evidence.md). `mcps/retired.json` lists the names of MCPs that were removed: `bun mcp new` refuses them for ever, because what a name had in the databases and in ID would come back with it. Normal `bun dev` starts apps only.

### Deploying

[`docs/12-deployment.md`](docs/12-deployment.md) says what runs where and why: Civo London, one account per environment, one Helm chart on Civo Kubernetes, Civo Database PostgreSQL 17, Cloudflare in front, every secret in a GitHub environment or generated where it is used, a tag `staging/<name>` shipping staging and a tag `production/<name>` shipping production behind the owner's approval, nothing done from a laptop. Staging has run on Civo; production: Not yet. [`infra/README.md`](infra/README.md) is the runbook: the first run, every ship, rollback, scaling, rotation, restore and break glass. `bun run infra:check` (charts, Terraform, workflows; no cloud, no Docker) and `bun run infra:test` (the kind stack; Docker) are the local gates, and CI runs both.

### Repository principles

- **Bun everywhere**, including production. Hono for HTTP. Postgres for all state, including sessions; Redis as a read cache later.
- **Test-driven.** Every change starts with a failing test. CI enforces full line/function coverage for ID and runs the shared-package, browser and real-ID MCP checks.
- **Admin API first.** Organisation, domain, group, client, resource, entitlement, and user changes go through typed Hono routes under `/api/admin`, documented with OpenAPI; routes call services and grouped query modules.
- **Cloudflare in front** of the deployed services, with Traefik verifying its origin pulls; no challenges and no caching where machines call ([`docs/12`](docs/12-deployment.md#network-and-ingress)).
- **Better Auth is the base**, pinned per milestone; house-specific behaviour ships as custom plugins, never forks.
