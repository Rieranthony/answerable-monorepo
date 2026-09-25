# AGENTS.md

Answerable monorepo. Bun 1.3.1, Turborepo. Two apps: `apps/web` (Next.js 16: the site, the docs at `/docs`) and `apps/id` (Answerable ID: Bun, Hono, Better Auth, Postgres, and its browser pages). Shared packages: `packages/ui` (React components and Tailwind theme), `packages/countries` (ISO country data), `packages/auth` (Answerable ID access-token verification) and `packages/mcp-base` (MCP servers on the official SDK). Runnable MCPs live in `mcps/*`; `mcps/e2e` is the permanent local acceptance consumer. Read `README.md`, then `docs/00-orientation.md`. Decisions live in `docs/`; `docs/02-plan.md` lists what not to re-propose.

## Documentation

Docs are MDX in `apps/web/content/docs`, rendered with Fumadocs at `/docs`. The API reference is generated from `apps/id/openapi.json` and `apps/id/openapi.admin.json`. Never edit those files by hand; run `bun run openapi:export` in `apps/id`.

Here's how we write documentation. These are Lee Robinson's ten principles (https://leerob.com/docs), adapted to this repo; read that page before writing a docs page, and keep the numbering below in step with it. Not adopted yet: a feedback widget, a broken-link check on push, an Ask AI sidebar, and shipping the docs as an MCP server.

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
   - Headings are anchors. Do not rename one without checking inbound links.
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

- Gates, from the root: `bun run typecheck` · `bun run lint` · `bun run build` · `bun --filter web test` · `bun --filter @answerable/id test:coverage` (needs Postgres: `bun run env:up`, then `bun --filter @answerable/id db:test:migrate`) · `bun --filter @answerable/countries test`. CI runs the same.
- First run: Set `ROOT_ADMIN_SECRET`, start the service (the platform organisation is seeded at boot), then with the root bearer add the platform domain and SSO provider, sign in once, and add yourself to the `platform-admins` group; root locks itself afterwards.
- Ports: web 47100 · id 47300 · postgres 47432 · redis 47379.
- Style: Prettier without semicolons in `apps/web`, `packages/ui` and `packages/countries`, with semicolons in `apps/id`. Tests are colocated `*.test.ts`; `apps/id` enforces 100% line and function coverage, integration tests end in `.integration.test.ts`.
- OpenAPI: `bun --env-file=.env run --filter @answerable/id openapi:export` regenerates `apps/id/openapi.json` and `apps/id/openapi.admin.json`; tests fail when either drifts.
- Env: `default.env` is the tracked inventory of every variable, with empty values; add new variables there and to `.env.example`. `.env` files stay ignored and never hold committed values.
- Commits: imperative, sentence case, no prefix, no trailing period.

## MCP foundation

Read `docs/07-mcp-platform-draft.md` before extending the base; `apps/web/content/docs/mcp/authoring.mdx` shows how to create an MCP and `mcps/e2e` is the reference. Build on the official MCP SDK's primitives rather than re-implementing transport or OAuth. Root `bun dev` starts apps only. Run `bun run mcp:test` for the package and browser suites and `bun run mcp:test:e2e` for the real-ID acceptance (Docker and Playwright Chromium). The acceptance owns ports 47532, 47600, 47602, 47603 and 47605 and never touches the normal ID database. Do not add a Better Auth instance to an MCP.

## ID and consumer boundaries

All ID login, consent, organisation selection, security and error pages are Hono server-rendered pages in `apps/id`, using `hono-tailwind` and shared UI definitions. Never put identity-provider pages in `apps/web`. The web app is a separate OAuth consumer through its development-only `/oauth-test` page; it must not read ID cookies, root credentials or the ID database.
