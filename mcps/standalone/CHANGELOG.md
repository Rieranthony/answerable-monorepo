# Changelog

## 0.2.0

- `scripts/migrate-mcps.ts` and `migrateDeclared`: every MCP of the chart's list, migrated in turn by the deployment's Job `mcps-migrate`, a failure naming the MCP.
- It runs from the `mcps` image, with the Toolbox and the admin MCP (`mcps/Dockerfile`); `pg` is a runtime dependency.
- The entry point exits once it has closed on SIGINT or SIGTERM, so `bun run standalone:dev` (`bun --hot`) leaves no process behind.

## 0.1.0

The standalone server ([D2](../../docs/goals/mcp-cli/decisions.md)): every `standalone` or `both` MCP of `src/served.generated.ts` at `<origin>/<name>/mcp`, on `@answerable/mcp-platform`, with its database `answerable_standalone`, the shared MCP database as `answerable_mcps_standalone`, its `platform:read` machine client and the audit-log poller. It serves e2e.
