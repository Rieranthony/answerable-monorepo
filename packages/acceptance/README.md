# Answerable acceptance

The kit and the journeys that run real Answerable ID, a real browser and the official MCP OAuth client against an MCP. Development and test only.

```sh
bun install
(cd packages/acceptance && bun x playwright install chromium)
bun run mcp:test:e2e
```

Requires Bun 1.3.1 and Docker Compose. It starts PostgreSQL in a Compose project on port `47532` and ID on `47600`, runs every `*.journeys.test.ts` in `src/journeys` one after another, and removes both afterwards, including after Ctrl-C. The unit tests of the kit run in the same command; `bunfig.toml` gates 100% line and function coverage over `src`.

| File | Job |
| --- | --- |
| `src/id.ts` | `startId`: Compose, the ID fixture (`apps/id/scripts/mcp-e2e-fixture.ts`), the manifest, `stop` |
| `src/admin.ts` | `createAdmin` and the provisioning functions over ID's admin API |
| `src/oauth.ts` | The SDK's OAuth client provider in memory, which `signIn` fills |
| `src/browser.ts` | `launchBrowser` and `signIn`: the SDK challenge and ID's pages in Chromium |
| `src/mcp.ts` | `serve`, `connect`, `tool` and `refusal` |
| `src/cleanup.ts` | What `stop` and Ctrl-C run |
| `src/journeys/e2e.journeys.test.ts` | The e2e MCP: sign-in, tokens, J4 agent-class mutation, J5 controlled class, isolation, refresh, revocation |
| `src/journeys/toolbox.journeys.test.ts` | The Toolbox on port `47604`: J1 direct list, J2 partial and denied, J3 grant change, J10 evidence |

[Test MCPs locally](../../apps/web/content/docs/mcp/local-testing.mdx) lists what each journey proves, the ports, every kit function, how to write a journey, and the errors you can hit.
