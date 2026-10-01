# AGENTS.md

Answerable monorepo. Bun 1.3.1, Turborepo. Two apps: `apps/web` (Next.js 16: the site, the docs at `/docs`) and `apps/id` (Answerable ID: Bun, Hono, Better Auth, Postgres, and its browser pages). Shared packages: `packages/ui` (React components and Tailwind theme), `packages/countries` (ISO country data), `packages/auth` (Answerable ID access-token verification), `packages/mcp` (the SDK for MCP servers, on the official MCP SDK), `packages/id-admin` (a server's machine client on ID's admin API, and the fake ID), `packages/mcp-postgres` (the intent store, evidence chain and migrator for servers with a Postgres database), `packages/acceptance` (the real-ID acceptance kit and journeys) and `scripts` (`bun run mcp:new`). Runnable MCPs live in `mcps/*`; `mcps/e2e` is the reference server and the permanent local acceptance consumer; `mcps/example` is the finished quickstart, whose files the docs include; `mcps/toolbox` is the Toolbox hub, with its own Postgres databases `answerable_toolbox` and `answerable_toolbox_test`. Read `README.md`, then `docs/00-orientation.md`. Decisions live in `docs/`; `docs/02-plan.md` lists what not to re-propose.

## Documentation

Docs are MDX in `apps/web/content/docs`, rendered with Fumadocs at `/docs`. The API reference is generated from `apps/id/openapi.json` and `apps/id/openapi.admin.json`. Never edit those files by hand; run `bun run openapi:export` in `apps/id`.

**Keep code and types in sync.** Never paste code or a type into a page; the build renders them from the repository:

- Code: `<include lang="ts" meta='title="…"'>../relative/path.ts#region</include>`, from a file the repo typechecks and tests, with `//#region name` … `//#endregion` around the part to show. Snippets that no server runs live in `mcps/example/src/docs/`.
- A type's fields: `<AutoTypeTable path="../../packages/…" name="…" type="…" />` (path relative to `apps/web`), from the type and its doc comments. A field without a comment shows a blank: write the comment in the source.
- What the repository computes: `<ScaffoldFile>` (what `mcp:new` writes), `<ManifestEntry>`, `<GrantStrings>`, `<ErrorCodes>` (typed by the SDK's `ErrorCode`, so a new code fails the web typecheck until described) and `<PolicyClasses>`, in `apps/web/components/docs/generated.tsx`.
- Every component has a Markdown form (`asMarkdown()`, `apps/web/components/docs`), so `.md` pages carry the same tables and code: a page and its `.md` show the same words. Use no Fumadocs component without one, and none that hides content until clicked (Fumadocs' own type table does; ours renders every row).
- The Fumadocs packages must share one `fumadocs-core`, or `asMarkdown()` never opts in and every `.md` page prints JSX. `apps/web/lib/fumadocs.test.ts` fails when they do not; declare the optional peer that differs (`@mdx-js/mdx`, `zod`, `lucide-react`) in `apps/web/package.json` at the version the others use.
- `bun --filter web test` fails on a link to a missing page, heading or docs source file. Add every repository path the docs read at build to `web#build`'s inputs in `turbo.json`.

Here's how we write documentation. These are Lee Robinson's ten principles (https://leerob.com/docs), adapted to this repo; read that page before writing a docs page, and keep the numbering below in step with it. Not adopted yet: a feedback widget, an Ask AI sidebar, and shipping the docs as an MCP server.

1. Fast
   - Every docs page is static. No client-side data fetching, no runtime calls to Answerable ID.
   - No image unless it shows something words cannot.
2. Readable
   - Be concise. Make every token count.
   - No jargon, no idioms, no marketing. Sentence-case headings. British spelling.
   - Write for skimming: short paragraphs, a bold lead term, lists and tables over prose.
   - Start simple. Reveal complexity later on the page, or on a linked page.
   - Show a copy-pasteable example (cURL first) before you explain it.
3. Helpful
   - Document what exists. If it is not built yet, write "Not yet." and link the plan. Never describe planned behaviour in the present tense.
   - Document workarounds, even when they expose a product gap.
   - Every error code a person can hit gets a row: code, meaning, what to do.
4. AI-native
   - Prefer cURL over "click here". Prefer a prompt over a tutorial.
5. Agent-ready
   - Every page is Markdown too: append `.md` to the URL, or send `Accept: text/markdown`.
   - `/llms.txt` indexes the docs; `/llms-full.txt` carries all of them. Keep both working when you add pages or routes.
6. Polished
   - Every page has a `title` and a `description`. The build fails without them; they become the canonical tag and the OG image.
   - Headings are anchors. Do not rename one without checking inbound links; the link check test fails on a broken one. A moved page gets a redirect in `apps/web/next.config.mjs`.
   - Cross-link related guides and API pages in both directions.
7. Localized
   - English only for now. No `/en` in URLs; no locale hardcoded in paths.
8. Responsive
   - Keep the mobile menu working.
9. Accessible
   - Alt text on every image. Respect `prefers-reduced-motion`.
10. Universal

- Ship rules files (this one). Keep the OpenAPI contract honest: only routes a client can reach.

## Repo card

- Gates, from the root: `bun run typecheck` · `bun run lint` · `bun run build` · `bun --filter web test` · `bun --filter @answerable/id test:coverage` (needs Postgres: `bun run env:up`, then `bun --filter @answerable/id db:test:migrate`) · `bun --filter @answerable/countries test` · `bun run mcp:test` (the Toolbox's and `mcp-postgres`'s suites reset their own test databases first: `bun --filter @answerable/mcp-toolbox db:test:migrate`) · `bun run mcp:check <workspace>` for the MCP workspace you changed · `bun run mcp:test:e2e` (runs `bun test` in `packages/acceptance`; Docker and Playwright Chromium). CI runs the same.
- First run: Set `ROOT_ADMIN_SECRET`, start the service (the platform organisation is seeded at boot), then with the root bearer add the platform domain and SSO provider, sign in once, and add yourself to the `platform-admins` group; root locks itself afterwards.
- Ports: web 47100 · id 47300 · toolbox 47400 · e2e MCP 47500 · a scaffolded MCP 47510 · postgres 47432 · redis 47379. The acceptance's ports are under MCP kit and Toolbox.
- Style: Prettier without semicolons in `apps/web`, `packages/ui` and `packages/countries`, with semicolons in `apps/id`. No semicolons in `packages/auth`, `packages/id-admin`, `packages/mcp`, `packages/mcp-postgres`, `packages/acceptance`, `mcps/*` and `scripts`. Tests are colocated `*.test.ts`; `apps/id` enforces 100% line and function coverage, integration tests end in `.integration.test.ts`; the MCP workspaces' gates are under MCP kit and Toolbox.
- OpenAPI: `bun --env-file=.env run --filter @answerable/id openapi:export` regenerates `apps/id/openapi.json` and `apps/id/openapi.admin.json`; tests fail when either drifts.
- Env: `default.env` is the tracked inventory of every variable, with empty values; add new variables there and to `.env.example`. `.env` files stay ignored and never hold committed values.
- Commits: imperative, sentence case, no prefix, no trailing period.

## MCP kit and Toolbox

Read `docs/07-mcp-platform-draft.md` (the foundation decisions that still hold) and `docs/08-capability-platform.md` (the platform) before extending the kit; `docs/09-mcp-design-standard.md` holds the rules, `apps/web/content/docs/mcp/quickstart.mdx` shows how to create an MCP and `apps/web/content/docs/toolbox/add-tools.mdx` how to mount one in the Toolbox. Build on the official MCP SDK's primitives rather than re-implementing transport or OAuth. Do not add a Better Auth instance to an MCP.

- **Workspaces.** `packages/auth` verifies tokens. `packages/mcp` is the SDK: `defineTool`, `defineMutation`, `defineProvider`, `createMcpServer`, the conformance kit and the in-process client in `@answerable/mcp/testing`. `packages/id-admin` is `createIdAdmin` and, in `@answerable/id-admin/testing`, the fake ID. `packages/mcp-postgres` is the Postgres intent store, the evidence chain and `migrate(db, directories)`; a server migrates its own directory together with the package's `migrations`, and an applied migration's file name never changes. `packages/acceptance` is the real-ID kit and its journeys. `mcps/e2e` is the reference server. `mcps/example` is the finished quickstart. `mcps/toolbox` is the hub. `scripts` holds `mcp:new` and its templates, `scripts/mcp-templates.ts`, which the docs render.
- **Commands.** `bun run mcp:new <name>` scaffolds `mcps/<name>`; then `bun install`, `UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-<name> test` to write its manifest, and `bun run mcp:check @answerable/mcp-<name>`. `bun run mcp:check <workspace>` typechecks, lints and tests one workspace. `bun run mcp:test` runs the package, server and scaffold suites, and picks up every server under `mcps/`. `bun run mcp:test:e2e` runs the journeys against real ID. Root `bun dev` starts apps only; `bun run mcp:dev` and `bun run toolbox:dev` serve the e2e server and the Toolbox.
- **Gates.** `packages/auth`, `packages/id-admin`, `packages/mcp`, `packages/mcp-postgres`, `packages/acceptance`, `mcps/e2e` and `mcps/toolbox` enforce 100% line and function coverage, and so does every scaffolded server. Every provider runs `assertProviderConformance` and commits its `manifest.json`: after changing a definition, run `UPDATE_MANIFEST=1 bun run --filter <workspace> test` in the workspace and commit the file (Turborepo's strict environment strips the variable, so `mcp:check` cannot write it). `apps/web/content/docs/mcp/reference.mdx` is generated from the documentation comments by `bun run --filter @answerable/mcp reference`, a test fails when it drifts, and every export of `@answerable/auth` and `@answerable/mcp` needs a comment. MCP unit tests run in-process and open no port; the Toolbox's and `mcp-postgres`'s suites also need the development Postgres.
- **Ports and databases.** The Toolbox runs on 47400 with `answerable_toolbox` and `answerable_toolbox_test` (created by `infra/postgres/init`); `packages/mcp-postgres` tests reset `answerable_mcp_postgres_test`. `mcp:test` runs suites concurrently, so no two suites may reset one database. The acceptance owns ports 47532 (its own disposable Postgres, which also holds `answerable_toolbox_acceptance`), 47600, 47602, 47603, 47604 and 47605, and never touches the normal ID database.
- **Agents and worktrees.** Never run `bun run env:up` from a worktree: its Compose project has the main checkout's name, so it recreates the running Postgres; use the one on port 47432. Never run two acceptances at once: the Compose project name is fixed, so one run's cleanup removes the other's Postgres.

## ID and consumer boundaries

All ID login, consent, organisation selection, security and error pages are Hono server-rendered pages in `apps/id`, using `hono-tailwind` and shared UI definitions. Never put identity-provider pages in `apps/web`. The web app is a separate OAuth consumer through its development-only `/oauth-test` page; it must not read ID cookies, root credentials or the ID database.
