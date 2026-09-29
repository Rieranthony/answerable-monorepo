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

## 25 September 2026: authoring API and in-process tests

Tree: branch `claude/mcp-sdk-dx` (pull request 11), rebased on `main` d55220d. `@answerable/mcp-base` became `@answerable/mcp`, `createMcpApp` became `createMcpServer`. Audit and decisions: [report](https://claude.ai/artifact/6x1jjfwhZgqUhx7PseJ9Cj).

| Check | Result |
| --- | --- |
| `bun run mcp:test` | auth 37 pass, 100% lines and functions; mcp 27 pass, 100% lines and functions; e2e 7 pass, including Chromium Apps |
| `bun run mcp:test:e2e` | Pass, three runs in a row after the rebase: 9, 8 and 9 seconds, three organisations including the partially entitled `mcp-gamma`; no container, process or port left |
| Root typecheck, lint and build | Pass (7, 7 and 3 tasks) |
| `bun --filter web test` | 78 pass |
| `bun --filter @answerable/id test:coverage` | 2,040 pass, 0 fail, 100% line and function coverage, after the rebase at load average 10 to 15 |

**Found by testing.**

- A valid call was refused whenever an input schema transformed its value. SDK 2.1 already passes the parsed arguments to the handler and the base parsed them again: `z.string().transform(s => s.split(","))` with `"a,b,c"` returned `tool_failed`, and a prompt argument transformed into a `Date` failed. The handler now uses the SDK's parsed value; both cases are regression tests.
- `GET /health` answered 403 to any Host but the resource's (`10.0.0.5:47500`, `localhost:47500`), so container probes by address would fail. It is now answered before the Host check.
- Claude Code 2.1.282 shows the model only `structuredContent` when a tool returns it. Three runs against a probe server: the model read a value that existed only in `structuredContent`, printed the raw result as that JSON alone, and never saw a phrase placed only in the text block. Tools now return their output and the server sends the same JSON as text.
- The output schema already dropped undeclared fields: a tool returning `{ id, passwordHash }` sent `{ "id": "r1" }`. Kept, with a test.
- Codex's `workspace-write` sandbox cannot listen on a port (`EADDRINUSE`); 24 of 35 verifier tests failed there. The verifier takes an optional `fetch` and the test issuer is in-process, so the auth, MCP and e2e unit suites open no port. The Chromium test and the acceptance still need ports.
- One server per request costs 0.83 ms per tool call with 5 tools and 1.86 ms with 100, in-process with token verification (200 calls). No caching is needed.

**Size.** Source in `packages/mcp`, `packages/auth` and the e2e server went from 658 to 618 lines with the test harness added; tests went from 56 to 71.

## 29 September 2026: pull request 11 rebased for the Toolbox goal

Tree: branch `claude/toolbox-goal` on `main` 3ac5614, carrying pull request 11 (5b7ff19 and 6b06214). Versions: Bun 1.3.1; MCP TypeScript SDK (server, client, core) 2.1.0; MCP Apps 2.0.0; JOSE 6.2.12; Zod 4.6.5; Playwright 1.63.0 Chromium; Better Auth 1.7.2 in ID.

| Check | Result |
| --- | --- |
| Root typecheck, lint and build | Pass with `--force`, so nothing came from the Turbo cache (7, 7 and 3 tasks) |
| `bun --filter web test` | 78 pass |
| `bun run mcp:test` | auth 37 pass, 100% lines and functions; mcp 27 pass, 100% lines and functions; e2e 7 pass, including Chromium Apps |
| `bun run mcp:test:e2e` | Pass, three runs in a row: 9, 8 and 7 seconds, three organisations including the partially entitled `mcp-gamma`; no container, volume, network, temporary directory, process or port left |
| `bun --filter @answerable/id test:coverage` | 2,040 pass, 0 fail, 100% line and function coverage in 559 seconds; one-minute load average 15.02 at the start, 7.03 to 14.43 over 55 samples during the run |

**Found by testing.**

- `bun run env:up` from a worktree recreates the main checkout's running Postgres: the Compose project name is the same and the init directory's bind mount path differs (`docker compose --dry-run up -d --wait` printed `Container answerable-postgres-1  Recreate`). The ID suite ran against the Postgres already on port 47432, in its disposable `answerable_id_test` database, without `env:up`.

## 29 September 2026: the SDK tool model (brief B1)

Tree: branch `claude/toolbox-goal` on `main` 3ac5614, brief B1 of the Toolbox goal. Versions as above; `@answerable/mcp` 0.1.0.

| Check | Result |
| --- | --- |
| Root typecheck, lint and build | Pass with `--force` (7, 7 and 3 tasks) |
| `bun --filter web test` | 78 pass |
| `bun run mcp:test` | auth 37 pass, 100% lines and functions; mcp 53 pass across 9 files, 100% lines and functions in every file; e2e 10 pass across 4 files, including Chromium Apps |
| `bun run mcp:test:e2e` | Pass on five runs: 9.6, 8.8 and 7.4 seconds by the agent, 7.7 seconds after the review delta, and 9 seconds by the coordinator; three organisations, all fully entitled for now; nothing left behind |
| `bun --filter @answerable/id test:coverage` | 2,040 pass, 0 fail, 100% line and function coverage in 526 seconds; one-minute load average 6.09 at the start and 7.92 at the end (the fixture script lost `e2e:write`) |

**What changed.** `defineTool` takes five fields and defaults the rest; `defineProvider` fills identity, version and scopes; `createMcpServer({ provider, auth })`; wire names with `_`, derived annotations and `_meta["com.answerable/capability"]`; the error envelope with `retry.policy` and a `request_id`; the pagination contract on `records.list`; `manifest(provider)` with a committed `mcps/e2e/manifest.json` and a drift test; `createTestMcp(provider)`. The e2e MCP serves three read tools until prepared mutations bring the writes back.

**Found by testing.**

- The MCP TypeScript SDK 1.30.0 client (the version LibreChat uses) checks `structuredContent` against the tool's output schema even when `isError` is true: with the envelope in `structuredContent`, `callTool` threw `Structured content does not match the tool's output schema` for a `NOT_FOUND` and for an `INVALID_INPUT`, while the raw `tools/call` result was correct and the 2.1.0 client skipped the check. Error results now carry the envelope as JSON in their one text block and no `structuredContent`; probed again, both clients return the envelope for both errors.
- The SDK validates tool input before the handler and turns a failure into a plain-text `isError` result (`validateToolInput`, `dist/mcp-*.mjs` lines 1768 to 1774). `tools/list` and registration read `schema["~standard"].jsonSchema[io]()`, and validation reads only `schema["~standard"].validate`, so the server registers a Standard Schema that keeps Zod's JSON form and accepts every value, then validates with Zod in the handler and answers `INVALID_INPUT` with one field violation per issue. Transforms run once; the previous pass's regression tests still pass in both protocol eras.
- Zod 4.6.5 emits no `additionalProperties` for a plain `z.object`; `.strict()` emits `false` and `.passthrough()` emits `{}`. `defineTool` closes the top level only; `.strict()` also drops a top-level `.describe()`, while field descriptions survive.
- `Bun.randomUUIDv7()` is not strictly monotonic: 10,000 values generated in a loop did not come out sorted. Record ids stay UUIDv4 and the list cursor is the last returned id in insertion order; an unissued cursor answers `INVALID_INPUT`.
- In Bun, `AbortSignal.timeout` does not keep the process alive while `setTimeout` held it for 3.0 seconds, so the per-call deadline uses `AbortSignal.timeout`; after it fires the answer is `TIMEOUT` whatever the handler throws.
- The 2026-07-28 era adds `_meta["io.modelcontextprotocol/serverInfo"]` to every result, and the MCP Apps helper writes the legacy `_meta["ui/resourceUri"]` beside `_meta.ui.resourceUri` on a view tool.
- `bun.lock` records `@answerable/mcp` at 0.0.0 after the bump to 0.1.0, and `bun install` reports no change, so the lockfile is untouched.

**Decisions recorded.** A deprecated tool names a current replacement in the same provider and ships with the deprecation sentence; two versions of one name served side by side are Not yet (the design's "at most one deprecated version beside the current one" cannot hold with one wire name per identity). The error envelope travels as text only, and `docs/08` and `docs/09` now say so.

**Size.** `packages/mcp/src` source 541 lines (was 318), tests 768 (was 402); `mcps/e2e/src` source 198 (was 250), tests 183 (was 146).

## 29 September 2026: prepared mutations (brief B3)

Tree: branch `claude/toolbox-goal` on `main` 3ac5614, brief B3 of the Toolbox goal. Versions as above; `@answerable/mcp` 0.2.0.

| Check | Result |
| --- | --- |
| Root typecheck, lint and build | Pass with `--force` (7, 7 and 3 tasks) |
| `bun --filter web test` | 78 pass |
| `bun run mcp:test` | auth 37 pass, 100% lines and functions; mcp 85 pass across 12 files, 100% lines and functions; e2e 14 pass across 4 files, including Chromium Apps |
| `bun run mcp:test:e2e` | Pass on three runs: 9.1 and 7.4 seconds by the agent, 9 seconds by the coordinator; three organisations, `mcp-gamma` read-only again; nothing left behind |
| `bun --filter @answerable/id test:coverage` | 2,040 pass, 0 fail, 100% line and function coverage in 535 seconds by the agent (load average 9.60 to 12.35); the coordinator's run on the B1 tree, before this brief, gave 2,040 pass in 522 seconds |

**What changed.** `defineMutation` with `prepare` and `commit`; intents with single-use `act_` commit tokens stored as SHA-256; policy classes from `risk` (`low` agent, `normal` controlled, `high` human) with 10-minute, 30-minute and 24-hour expiries; the state machine `prepared`, `awaiting_approval`, `committing`, `committed`, `failed`, `expired`, `stale`; staleness by running `prepare` again at commit and comparing every target's version; idempotent replay; receipts; the two commit tools `<id>_commit` and `<id>_commit_confirmed` (the confirmed one carries `anthropic/requiresUserInteraction`); the in-memory intent store with an injectable clock; `createMcpServer({ intents?, policyClass? })`. The e2e MCP regains `records.create` (agent class, no target) and `records.delete` (controlled class, a serial-versioned target), its view creates and deletes through prepare and commit, and the acceptance regains the write steps and the partially entitled organisation. New docs page `errors.mdx`.

**Found by testing.**

- Bun's coverage never counts the closing brace of a `for (;;)` retry loop, so the lost-claim retry in the commit procedure is recursion, tested with a store whose first compare-and-set loses.
- In Zod 4.6.5 a missing `z.unknown()` key fails at runtime while its TypeScript type is optional, so `from` and `to` in a preview change default to `null`; `.extend()` keeps `.strict()`, so the prepare input with `validate_only` stays closed.
- The test issuer mints a random membership per token, so two `connect()` calls could never be one principal; `connect` gained `membershipId` and `clientId`.
- TypeScript carries the type of `plan` from `prepare` into `commit`, so the e2e's `commit` typechecks `plan.title` and `plan.id`.
- A commit past `timeoutMs` answers `TIMEOUT` while the commit carries on: a repeat answers `COMMIT_IN_PROGRESS`, then the receipt.

**Decisions recorded.** Commit rechecks authority: a token that lost the mutation's scopes answers `PERMISSION_DENIED`, and an intent for a capability version the server no longer serves answers `INTENT_NOT_FOUND`. The intent keeps the arguments as sent and commit parses them again, so input transforms survive storage. A `prepare` that throws during the re-run marks the intent `failed`. The commit tools are visible when the caller can use at least one mutation. The memory store never evicts intents (documented as a limit).

**Size.** `packages/mcp/src` source 1,043 lines (was 549), tests 1,492 (was 767); `mcps/e2e/src` source 310 (was 187), tests 297 (was 187).

## Limits

The acceptance uses local test issuers for company directories, a pre-registered public client and loopback HTTP. It does not certify Claude.ai, another host, another company directory or a production deployment.
