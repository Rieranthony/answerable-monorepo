# example MCP

Your organisation's notes: list them a page at a time, and add one. The finished quickstart of the MCP docs.

Made with `bun mcp new` and `bun mcp add tool`, as [Build your first MCP](../../apps/web/content/docs/mcp/quickstart.mdx) does. The docs include its files, so every snippet in the guides is code this workspace typechecks, lints and tests; `src/docs/` holds the snippets no tool serves.

- **Where it runs** (`"serve": "toolbox"` in `mcp.json`): in the Toolbox, which mounts it from `mcps/toolbox/src/mounted.generated.ts`; hosts call its tools `example_<domain>_<operation>` at the Toolbox's one URL, `http://localhost:47400/mcp` locally (`bun run toolbox:dev`).
- **Its tables** (`"database": "shared"`): in schema `example` of the shared database `answerable_mcps`, each limited to the caller's organisation by Postgres. Its tests use schema `example` of `answerable_mcps_test`.
- **Its tools:** one file each in `src/tools`, with its test, listed in `src/provider.ts`. `manifest.json` is their contract.

```sh
bun mcp add tool example <domain.operation> --description "<what it does, when to use it, its limits>"
bun mcp check example
bun mcp db example generate
bun mcp db example migrate
```

Run them from the repository root, or from `mcps/example` without the name. `add tool` writes a read tool, or with `--mutation` a change, with its test and its table, then checks the MCP. `check` runs the typecheck, the lint and the tests, with [the conformance kit](../../apps/web/content/docs/mcp/testing.mdx) and a 100% coverage gate; it rewrites a stale `manifest.json` and says to commit it. After a change to `src/db/schema.ts`, `db generate` writes the migration into `drizzle/`: review and commit it. `db migrate` migrates the local development schema. `bun mcp` writes `mcp.json`; change `serve` and `database` there.

Guides: [Build your first MCP](../../apps/web/content/docs/mcp/quickstart.mdx), [Read tools](../../apps/web/content/docs/mcp/tools.mdx), [Mutations](../../apps/web/content/docs/mcp/mutations.mdx), [Test an MCP](../../apps/web/content/docs/mcp/testing.mdx).
