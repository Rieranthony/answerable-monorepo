# AGENTS.md

Answerable monorepo. Bun 1.3.1, Turborepo. Two apps: `apps/web` (Next.js 16: the site, the Answerable ID browser pages, the docs at `/docs`) and `apps/id` (Answerable ID: Bun, Hono, Better Auth, Postgres). Read `README.md`, then `docs/00-orientation.md`. Decisions live in `docs/`; `docs/02-plan.md` lists what not to re-propose.

## Documentation

Docs are MDX in `apps/web/content/docs`, rendered with Fumadocs at `/docs`. The API reference is generated from `apps/id/openapi.json`. Never edit that file by hand; run `bun run openapi:export` in `apps/id`.

Here's how we write documentation:

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
8. Responsive, accessible
   - Alt text on every image. Respect `prefers-reduced-motion`. Keep the mobile menu working.
9. Universal
   - Ship rules files (this one). Keep the OpenAPI contract honest: only routes a client can reach.

## Repo card

- Gates, from the root: `bun run typecheck` · `bun run lint` · `bun run build` · `bun --filter web test` · `bun --filter @answerable/id test:coverage` (needs Postgres: `bun run env:up`, then `bun --filter @answerable/id db:test:push`). CI runs the same.
- Ports: web 47100 · id 47300 · postgres 47432 · redis 47379.
- Style: Prettier without semicolons in `apps/web`, with semicolons in `apps/id`. Tests are colocated `*.test.ts`; `apps/id` enforces 100% line and function coverage, integration tests end in `.integration.test.ts`.
- OpenAPI: `bun --env-file=.env run --filter @answerable/id openapi:export` regenerates `apps/id/openapi.json`; a test fails when it drifts.
- Commits: imperative, sentence case, no prefix, no trailing period.
