# MCP foundation evidence

What was run, on which tree, and what it proved. The design is in [MCP foundation](../docs/07-mcp-platform-draft.md); the how-to guides are at [`/docs/mcp`](../apps/web/content/docs/mcp/index.mdx).

## 25 September 2026: rebuilt on the official SDK

Tree: branch `claude/mcp-e2e-audit`. Versions: Bun 1.3.1; MCP TypeScript SDK (server, client, core) 2.1.0; MCP Apps 2.0.0; JOSE 6.2.12; Zod 4.6.5; Playwright 1.63.0 Chromium; Better Auth 1.7.2 in ID.

| Check | Result |
| --- | --- |
| `bun run mcp:test` | 56 pass, 0 fail: verifier, base in both protocol versions, e2e records, Chromium Apps view |
| `bun run mcp:test:e2e` | Pass in about 10 seconds, three runs in a row |
| Ctrl-C or SIGTERM during sign-in | Exit 130 or 143; no container, process, port or temporary directory left |
| Root typecheck, lint and build | Pass |
| `bun --filter web test` | 78 pass |
| `bun --filter @answerable/id test:coverage` | 2,025 pass, 0 fail, 100% line and function coverage |

**What the acceptance proved.** ID ran from production migrations behind its restricted runtime role and was provisioned only through its admin API. The official MCP client discovered ID from the MCP's 401 and signed in through ID's pages in Chromium, with PKCE S256, the MCP URL as `resource` and ID's `iss` in the callback. For each of two organisations: tokens are audience-bound with the resource's 60-second lifetime; 2025 and 2026-07-28 clients both reach the tools, prompt and resource; records stay within the organisation; a second MCP refuses the token; the client refreshes by itself; disabling the organisation stops refresh while the issued token lasts until expiry.

**Against the owner's local ID.** With the e2e MCP registered through the documented admin commands, the SDK client discovered local ID from the MCP challenge, and ID accepted the authorisation request for `claude-code-local` and redirected to its login page.

**Claude Code, by hand.** Claude Code 2.1.281, added with `--client-id claude-code-local --callback-port 47700`, signed the owner in through local ID and the Answerable Microsoft Entra tenant. It called `identity_get`, created a record and listed it, speaking protocol version 2026-07-28 without sessions. ID's audit log shows one authorisation and one code exchange for the resource `http://localhost:47500/mcp`. With a 300-second lifetime, Claude Code then refreshed before every request (15 refreshes in 70 seconds). With 900 seconds, it made three calls after one refresh. [Connect Claude Code](../apps/web/content/docs/mcp/claude-code.mdx) now registers 900 seconds.

**Found by testing.**

- An organisation entitled to only some of an MCP's scopes is refused at organisation selection. This happens whether or not the MCP advertises scopes. Open as [`Q-SCOPE-SUBSET`](../docs/02-plan.md#open-register).
- An in-process `Bun.build` breaks the suite on Bun 1.3.1 (the bundler reads the wrong files), so view builds keep their separate process.
- Playwright's own signal handlers exited the acceptance before its cleanup ran; the browser now launches without them.
- Claude Code refreshes a token close to expiry before each request, so a 300-second resource lifetime costs one refresh per request. Resources used from Claude Code are registered with 900 seconds.

## Limits

The acceptance uses local test issuers for company directories, a pre-registered public client and loopback HTTP. It does not certify Claude.ai, another host, another company directory or a production deployment.
