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

- An organisation entitled to only some of an MCP's scopes is refused at organisation selection. This happens whether or not the MCP advertises scopes. Open as [`Q-SCOPE-SUBSET`](../docs/02-plan.md#open-register). Resolved the same day; see below.
- An in-process `Bun.build` breaks the suite on Bun 1.3.1 (the bundler reads the wrong files), so view builds keep their separate process.
- Playwright's own signal handlers exited the acceptance before its cleanup ran; the browser now launches without them.
- Claude Code refreshes a token close to expiry before each request, so a 300-second resource lifetime costs one refresh per request. Resources used from Claude Code are registered with 900 seconds.

## 25 September 2026: entitled scope subsets

Tree: branch `claude/id-scope-subset` on `main` 8fa5833. Versions as above.

| Check | Result |
| --- | --- |
| `bun run mcp:test` | 56 pass, 0 fail |
| `bun run mcp:test:e2e` | Pass on six runs in 10 to 13 seconds, three organisations; one run under load average 132 timed out starting ID |
| Root typecheck, lint and build | Pass |
| `bun --filter web test` | 78 pass |
| `bun --filter @answerable/id test:coverage` | 2,040 pass, 0 fail, 100% line and function coverage |

**What the acceptance proved.** `mcp-gamma` is entitled to `e2e:identity` and `e2e:read` only. The SDK still asked for all three scopes plus `offline_access`. ID's consent page listed `e2e:identity`, `e2e:read` and offline access, and named `e2e:write` as not approved. The token response `scope` and the JWT `scope` were `e2e:identity e2e:read offline_access`. Both protocol versions listed only `identity_get`, `records_list` and `records_show`; the prompt and the resource still worked, and `records_create` failed. After the SDK refreshed, the token still lacked `e2e:write`, and disabling the organisation stopped refresh. The two fully entitled organisations saw every scope and no "Not approved" line.

**Found by testing.**

- Before the change, a probe through the production provider reproduced the refusal: with a client and resource offering `mail:read` and `mail:send` and an organisation entitled to `mail:read`, `/oauth2/continue` answered 403 `access_denied`.
- A client registered to skip consent gets its code at organisation selection, from the original request, so narrowing only at consent would miss it. The flow narrows every code it mints; a probe confirmed Better Auth issues exactly the narrowed code's scopes.
- The full ID suite is sensitive to machine load. With unrelated video rendering on the same machine (load average 25 to 195), runs failed 5 to 55 admin and query tests on statement timeouts and deadlocks. Those files passed alone, and the suite passed 2,040 of 2,040 on a quiet machine.
- Three tests in `user-oauth.integration.test.ts` flaked: a cached refresh replay whose `expires_in` crossed a second, and two company sign-ins through the local test issuer (a 500 at sign-in and a 403 after linking). The refresh test also flaked on `main` here, and it and the linking test flaked in CI for pull request 10; the failing steps are outside the changed code. Interleaved, the branch passed that file 5 of 5 times and `main` 4 of 5.

**Not yet tried.** A partial entitlement in Claude Code by hand.

## Limits

The acceptance uses local test issuers for company directories, a pre-registered public client and loopback HTTP. It does not certify Claude.ai, another host, another company directory or a production deployment.
