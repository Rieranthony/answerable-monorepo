# example MCP

The finished server of [Build your first MCP](../../apps/web/content/docs/mcp/quickstart.mdx): a read tool, `notes.list`, and a mutation, `notes.add`, over notes kept in memory per organisation. The docs include its files, so every snippet in the guide is code that this workspace typechecks, lints and tests.

```sh
bun --env-file=mcps/example/.env.example run --filter @answerable/mcp-example dev
curl http://localhost:47510/health
```

Run these from the repository root; the second answers `{"status":"ok"}`. Signing in needs the resource and a client registered in Answerable ID, as [Connect Claude Code](../../apps/web/content/docs/mcp/claude-code.mdx#register-the-server) does for the e2e server.

```sh
UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-example test
bun run mcp:check @answerable/mcp-example
```

The first rewrites `manifest.json` after a change to a tool; the second runs the typecheck, the lint and the tests, with the conformance kit and a 100% coverage gate. `exports` makes the provider mountable in the Toolbox: [Add tools to the Toolbox](../../apps/web/content/docs/toolbox/add-tools.mdx).
