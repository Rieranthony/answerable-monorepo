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

## 29 September 2026: the conformance kit and the reference page (brief B2)

Tree: branch `claude/toolbox-goal` on `main` 3ac5614, brief B2 of the Toolbox goal. Versions as above; `@answerable/mcp` 0.3.0, `@answerable/auth` 0.1.0.

| Check | Result |
| --- | --- |
| Root typecheck, lint and build | Pass with `--force` (7, 7 and 3 tasks) |
| `bun --filter web test` | 78 pass |
| `bun run mcp:test` | auth 37 pass, 100% lines and functions; mcp 157 pass and 5 todo across 15 files, 100% lines and functions; e2e 44 pass and 4 todo across 4 files, the conformance kit included |
| `bun run mcp:check @answerable/mcp-e2e` | 3 tasks pass |
| `bun run mcp:test:e2e` | Pass: 9.4 seconds by the agent, 8 seconds by the coordinator |

**What changed.** `assertProviderConformance(provider, fixture)` in `@answerable/mcp/testing` registers one test per check of the standard's three lists; the e2e provider runs it (44 pass, 4 todo: human approvals, secrets and egress are Not yet). Custom error codes are declared per definition (`errors`), prefixed with the provider id in capitals, and listed in the manifest; an undeclared custom code answers `INTERNAL`. `bun run mcp:check <workspace>` runs typecheck, lint and tests. Every export of `@answerable/mcp` and `@answerable/auth` carries a documentation comment, and `reference.mdx` is generated from them with a drift test. `testing.mdx` is new; `authoring.mdx` follows the plan's order. The per-provider manifest script and drift test are gone: `manifest_matches_snapshot` compares, and `UPDATE_MANIFEST=1 bun run test` in the provider's workspace rewrites.

**Found by testing.**

- `list_paginates` found a real R10 defect: `records.show` returned an `items` array cut to 20 without `next_cursor` or `has_more`. It now takes `limit` and `cursor` and paginates like `records.list`.
- Six mutate checks (`commit_requires_token`, `commit_rejects_expired`, `commit_is_idempotent`, `commit_rejects_other_principal`, `receipt_is_structured`, the envelope checks) are enforced by the SDK itself, so a provider cannot fail them; their failure tests stub the calls, and the docs say a failure there is an SDK defect.
- A read that returns a different result on a second call also fails every mutation's `prepare_has_no_side_effect`; a target with an empty version also fails `commit_rejects_stale`. Every other fault fails exactly one check, pinned in tests.
- The kit runs a `risk: "high"` mutation as `controlled`, because a human-class commit cannot succeed until approvals exist.
- Turbo's strict environment strips `UPDATE_MANIFEST`, so the manifest is regenerated from the workspace, not through `mcp:check`. The R13 lint does not follow `$ref` or `$defs`; Zod inlines schemas today.

**Size.** `packages/mcp/src` source 1,558 lines (was 1,043), tests 2,048 (was 1,492); the reference generator 104 lines; `reference.mdx` 946 lines for 49 exports.

## 29 September 2026: the acceptance kit (brief B4)

Tree: branch `claude/toolbox-goal` on `main` 3ac5614, brief B4 of the Toolbox goal. Versions as above.

| Check | Result |
| --- | --- |
| Root typecheck, lint and build | Pass with `--force` (8, 8 and 3 tasks; `packages/acceptance` is the eighth workspace) |
| `bun --filter web test` | 78 pass |
| `bun run mcp:test` | Unchanged: auth 37, mcp 85, e2e 14 on the B3 tree the brief started from; no Docker |
| `bun run mcp:test:e2e` | 30 pass (14 journeys, 16 unit tests), 100% lines and functions over `packages/acceptance/src`; 9.20, 7.90 and 7.75 seconds at one-minute load averages 18, 17 and 15, and 9.46 seconds on the final tree; Docker, ports and the temporary directory clean after each |
| Interrupted runs | SIGINT to the runner during sign-in: exit 130, nothing left; SIGINT to the whole process group and SIGTERM to the runner: the outer process dies and the cleanup finishes in the background, nothing left |
| `bun --filter @answerable/id test:coverage` | 2,040 pass, 0 fail, 100% line and function coverage in 529 seconds; load average 10.15 at the start and 21.07 at the end (the fixture script changed) |
| Coordinator, after merging B2 and B4 | Typecheck, lint and build pass with `--force` (8, 8 and 3 tasks); web 78 pass; `mcp:test` auth 37, mcp 162 across 15 files at 100%, e2e 48; `mcp:check @answerable/mcp-e2e` 3 tasks; `mcp:test:e2e` 30 pass at 100% in 10 seconds, nothing left behind |

**What changed.** `packages/acceptance` holds the kit: `startId({ tenants })` boots ID on the Compose Postgres through the generic fixture and returns the manifest, an `admin` caller and `stop`; `registerResource`, `registerClient`, `linkClient`, `grantOrganisation` and `entitle` provision through the admin API; `serve`, `oauthProvider`, `launchBrowser`, `signIn`, `connect`, `tool`, `refusal` and `step` drive a journey. The journeys are `bun test` files; `bun run mcp:test:e2e` runs the package with its 100% gate. `e2e.journeys.test.ts` keeps every earlier check and adds J4 and J5. The fixture takes a plan file and writes its manifest atomically.

**What the journeys proved.** J4: prepare returns a preview and a commit token; commit returns a receipt whose `results` is the record; a repeat returns the same `receipt_id` with `idempotent_replay: true` and creates nothing; a record changed after prepare makes the delete `INTENT_STALE` with `expected "1"` and `current "2"`; an intent past its expiry answers `INTENT_EXPIRED`. J5: a delete names `e2e_commit_confirmed`; `e2e_commit` answers `APPROVAL_REQUIRED`; a summary one character short is refused with a message containing "differs"; the exact summary commits and the record is gone. The read-only organisation lists no records and every write is an unknown tool to it.

**Found by testing.**

- A real Ctrl-C (SIGINT to the process group) through `bun run mcp:test:e2e` killed the outer runner at once; `docker compose down` then died writing to the closed stderr and left the container. Cleanup now runs `down` with stderr ignored.
- `[test] timeout` in `bunfig.toml` is ignored on Bun 1.3.1; `--timeout 120000` on the script works.
- A failing `beforeAll` still runs `afterAll` with the handle unassigned, so `startId` cleans up its own failure.
- `signIn` must request exactly the scopes the MCP advertises; narrowing belongs in `entitledScopes`.
- Against real ID, a resource-only entitlement with no client and a group entitlement are both accepted; a scope outside the resource's allowed scopes is refused with a 400 naming it.
- The second-MCP check was weaker than it looked: the token could have been refused for expiry alone. The journey now first proves the issuing MCP accepts the same token.

**Size.** `packages/acceptance/src` source 330 lines, tests 485; the deleted `mcps/e2e/scripts/acceptance.ts` was 267.

## 29 September 2026: the Toolbox core (brief B5)

Tree: branch `claude/toolbox-goal` on `main` 3ac5614, brief B5 of the Toolbox goal. Versions as above, plus OpenTelemetry `api` 1.9.1, `sdk-trace-base` 2.11.0, `exporter-trace-otlp-http` 0.222.0 and `resources` 2.11.0; `@answerable/mcp` 0.4.0, `@answerable/auth` 0.2.0, `@answerable/mcp-toolbox` 0.1.0.

| Check | Result |
| --- | --- |
| Root typecheck, lint and build | Pass with `--force` (9, 9 and 3 tasks; `mcps/toolbox` is the ninth workspace) |
| `bun --filter web test` | 78 pass |
| `bun run mcp:test` | auth 41 pass, 100%; mcp 167 pass and 5 todo across 16 files, 100%; e2e 44 pass and 4 todo; Toolbox 64 pass and 2 todo across 11 files, 100% lines and functions |
| `bun run mcp:check @answerable/mcp-toolbox` | 4 tasks pass |
| `bun run mcp:test:e2e` | 42 pass (e2e and Toolbox journeys), acceptance 100%: 32.3 and 30.5 seconds by the agent, 32 seconds by the coordinator; nothing left behind |
| `bun --filter @answerable/id test:coverage` | Not required (no change under `apps/id`); the coordinator's run on the B4 tree gave 2,040 pass, 100%, in 523 seconds |

**What changed.** `mcps/toolbox`: one MCP endpoint on Answerable ID that mounts providers (the e2e provider first), ingests their manifests into `providers` and `capabilities` (a changed contract under an old version refuses the boot), reads each caller's grant strings from ID's member access view through a machine client (cached 60 seconds per organisation, member and authorisation version; an audit-log poller every 15 seconds invalidates the organisations named), projects exactly the granted capabilities in a deterministic order with `toolbox_whoami` first, records an evidence row and an OpenTelemetry span for every call, and answers `/health` from the database. `evidence_events` is a hash chain per organisation assigned by a `BEFORE INSERT` trigger under an advisory lock; updates, deletes and truncates are refused; `verify` recomputes the chain. `@answerable/mcp` gains `mount`, `allow`, `wrapCall` and `cacheHints` on `createMcpServer` and a server form of `createTestMcp`; `@answerable/auth` exposes `organizationAuthorizationVersion`. New page `toolbox.mdx`; the acceptance owns port 47604 and creates `answerable_toolbox_acceptance` on its Compose Postgres.

**What the journeys proved.** J1: alpha lists `toolbox_whoami`, the three e2e reads, the two prepare tools and the two commit tools, in that order, with honest annotations and `_meta`; `toolbox_whoami` returns the person, organisation and grant strings; a call leaves a `capability.completed` row and a span. J2: beta (grant `e2e/records`) lists only the records domain; gamma (no grant) lists only `toolbox_whoami`, its call is the unknown-tool error and leaves a `capability.denied` row; disabling gamma stops refresh. J3: an entitlement added through ID's admin API is listed on the same token 15.1 seconds later in every run (polling every 5 seconds; the real arrival is between 10 and 15 seconds). J10: alpha's chain verifies with length 2; an `UPDATE` and a `DELETE` on `evidence_events` are refused by the trigger.

**Measured.** 11 grant reads answered by 4 access-view calls (63.6% cache hits); access-view latency median 31 to 34 ms, maximum 45 to 67 ms; 2 token requests and 2 audit-log reads per journey file.

**Found by testing.**

- OpenTelemetry works on Bun 1.3.1: the in-memory exporter held a span whose parent came from a `traceparent`, and a local `Bun.serve` received `POST /v1/traces` as JSON with the same trace and parent span ids; `spans.test.ts` repeats the proof.
- `Bun.sql`: a query runs only when awaited (`expect(query).rejects` hangs unless wrapped); objects go into `jsonb` directly and `JSON.stringify` stores a JSON string; numbers and booleans cannot be bound to `jsonb`, arrays cannot be bound as `text[]`, and `bigint` comes back as a string.
- `seq::text as seq` made `order by seq` sort as text and broke `verify` at seq 10; the column is qualified now.
- ID facts: a `client_credentials` client needs `organizationId` (the platform organisation), a link to the admin resource and a `client_credentials` capability with `platform:read`; `clientSecret` is returned once; audit event ids are UUIDv7, which the poller relies on.
- Bun 1.3.1's `toMatchObject` reports a frozen object as not frozen afterwards; frozenness is asserted when the call is received.

**Decisions recorded.** `toolbox_whoami` is `toolbox/toolbox.whoami` (R2 needs two parts); the hub's own provider is unprefixed. Evidence and spans wrap the whole call, not `execute`, so `INVALID_INPUT` and `TIMEOUT` are recorded. `allow` runs only for requests that list or call tools or read views, so `initialize` needs no grant read. Mounted providers' prompts and resources are not served through the hub. J3 enables the e2e provider for gamma too, since the catalogue is the ceiling. Left for B6: evidence and spans on commit calls; for the cleanup pass: the truncation of results above 100 KiB, which rewrites read schemas into a union.

**Size.** `mcps/toolbox/src` source 663 lines in 12 files, tests 814 in 11 files, test support 83; migrations 137.

## 29 September 2026: the cleanup pass after B5

Tree: branch `claude/toolbox-goal` on `main` 3ac5614, the whole-tree cleanup pass the goal prescribes after B5, run as its own brief on Opus 5.5 over `packages/auth`, `packages/mcp`, `packages/acceptance`, `mcps/e2e`, `mcps/toolbox` and the docs pages. `@answerable/mcp` 0.5.0.

| Check | Result |
| --- | --- |
| Root typecheck, lint and build | Pass with `--force` (9, 9 and 3 tasks) |
| `bun --filter web test` | 78 pass |
| `bun run mcp:test` | auth 41 pass, 100%; mcp 168 pass and 5 todo, 100%; e2e 44 pass and 4 todo; Toolbox 62 pass and 2 todo, 100% |
| `bun run mcp:check` | e2e 3 tasks, Toolbox 4 tasks |
| `bun run mcp:test:e2e` | 42 pass at 100%: 37.1 and 45.4 seconds by the agent at load average 22 to 24 (32.5 and 32.3 seconds earlier at load 10 to 11), 48 seconds by the coordinator; nothing left behind |

**What the pass removed or simplified.** One envelope parser (`errorOf` in `@answerable/mcp/testing`) replaces the conformance kit's, the acceptance kit's and seven hand-written ones; one `testPrincipal` replaces principals built by hand in five places; `riskClass` is exported once and the Toolbox's copy is gone. `createMcpServer` loses `allowedHosts`, `allowedOrigins` and `cacheHints` (every server now sends `tools/list` a 30-second private hint, tested at 29 and 31 seconds); `createTestMcp` loses its options (the function form covers them); `createGrantsReader` loses `ttlMs`; `createToolbox` requires `spans`; the acceptance kit loses `admin`'s headers, `entitle`'s member and group forms, the `oauthProvider` export and an unreachable PKCE branch; `createE2eMcp` is gone (one-line wrapper); `Intent.committed_at` is gone (the receipt carries it); the unread `policy_class_default` column is gone. The truncation of results above 100 KiB is now the error `RESULT_TOO_LARGE` (`after_fix_input`, `details: { bytes, limit }`, pinned at 102,400 accepted and 102,401 refused) in place of a union on every read's output schema; `docs/08` and `docs/09` say so. Error messages for views, prompts, resources, duplicates and mounted providers now name the definition and say what to change. Docs say each thing once: the envelope's "why text only" lives on the errors page, the custom-code rules on the authoring page; the `@answerable/mcp` README went from 88 to 51 lines.

**Kept after consideration.** `mount`, `allow` with `called` and the request peek (the Toolbox needs each; `called` records the denial row J2 checks; the peek keeps `initialize` from reading grants); `wrapCall` (spans must wrap the run); `startId`'s `spawn` and `timeoutMs`; the poller's `intervalMs` (Bun 1.3.1's fake timers do not mock `setInterval`); the written-out `Target`, `Preview`, `Change` and `Receipt` types (the reference page); `expiresInMs`; the auth test issuer's `outage` and `jwksRequests`.

**Size.** Source across the five workspaces 3,144 to 3,159 lines (`packages/mcp` grew by 47 for `errorOf` and `testPrincipal` with their documentation, in place of the copies deleted elsewhere), tests 4,290 to 4,270.

## 29 September 2026: Toolbox administration (brief B7)

Tree: branch `claude/toolbox-goal` on `main` 3ac5614, brief B7 of the Toolbox goal, built beside B6. Versions as above; `@answerable/auth` 0.3.0, `@answerable/mcp-toolbox` 0.2.0.

| Check | Result |
| --- | --- |
| Root typecheck, lint and build | Pass with `--force` (9, 9 and 3 tasks) |
| `bun --filter web test` | 78 pass |
| `bun run mcp:test` | auth 52 pass, 100%; mcp 168 pass and 5 todo, 100%; e2e 44 pass and 4 todo; Toolbox 89 pass and 2 todo across 13 files, 100% lines and functions |
| `bun run mcp:check @answerable/mcp-toolbox` | 4 tasks pass |
| `bun run mcp:test:e2e` | 46 pass at 100%: 33.8 and 34.3 seconds by the agent, 38 seconds by the coordinator at load average 35; nothing left behind |

**What changed.** The platform-tier admin API under `/admin/v1`, served by the Toolbox's own `fetch`: providers, an organisation's catalogue (`PUT` validates identities against the provider and a policy class against mutations), the enable operation, host clients and evidence verification. It authenticates a machine client's token for the Toolbox's admin resource (`<resource origin>/admin`) carrying `toolbox:admin`; `@answerable/auth` gains `subjectTypes` and `MachinePrincipal` for that, with `UserPrincipal` unchanged. The enable operation reads what ID holds, plans, then writes in order: the Toolbox resource's `allowedScopes` (a union, with `If-Match`), each host client's link, the organisation's login and `toolbox` capabilities and entitlements for both grant kinds, and the catalogue rows; a repeat reports everything as existing and writes nothing. New capabilities in an already enabled pack join `overrides.disabled` at ingest (`Q-TOOLBOX-NEW-CAPABILITIES`, resolved as the design assumed). New page `toolbox-admin.mdx`. The journey now enables alpha and beta through the operation, repeats it, and hides a capability through the catalogue route.

**Measured.** One organisation, one host client, one provider: 11 admin API calls (3 reads, 8 writes) plus one cached token request; a repeat makes the 3 reads only; two hosts and two providers make 4 reads and 15 writes. A capability disabled through the catalogue disappeared from a 2025 client's list 4 to 14 ms after the `PUT` in eight runs.

**Found by testing.**

- ID mints two signing keys when its first two tokens are requested concurrently; a verifier that read the keys between them refuses the second key's tokens for 30 seconds (`jose` waits that long before re-reading). Seen in about 1 of 7 cold runs as a 401 on the second enable call, with the token's `kid` 9 ms newer than the cached one. The journey requests one token before the Toolbox starts; 0 failures in 14 later runs. An ID backlog item.
- A 2026-07-28 client keeps `tools/list` for the 30-second cache hint, so the catalogue journey observes the change with a 2025 client.
- ID's writes need an `Idempotency-Key` and accept `If-Match` on the resource patch; `GET /resources/{r}` lists the linked clients; the capabilities list has no client filter and pages at 200; the entitlements list filters by `clientId`; a capability or entitlement whose scopes are outside the resource's `allowedScopes` is refused, so the patch comes first; machine capabilities must sit in the client's owning organisation.
- Two agents running the acceptance at the same time destroy each other's run: the kit's Compose project name is fixed, so one run's cleanup removes the other's Postgres. Both reruns were clean. A backlog item for the kit.
- `bun.lock` records workspace versions and stays behind the bumps; `bun install --frozen-lockfile` still accepts it.

**Decisions recorded.** A machine token without `toolbox:admin` answers 403; a failure of ID answers 502 `id_failed` and says a repeat skips what exists. Deterministic idempotency keys were rejected (ID replays its journal, so a recreated row would silently not be recreated). Admin calls are not written to evidence, there is no OpenAPI description of the admin API and no tenant tier; the docs say so.

**Size.** `mcps/toolbox/src` source 1,026 lines in 17 files, tests 1,285 in 13 files, test support 238; migrations 143.

## 29 September 2026: Toolbox mutations, the meta projection and list_changed (brief B6)

Tree: branch `claude/toolbox-goal` on `main` 3ac5614, brief B6 of the Toolbox goal, built beside B7. Versions as above; `@answerable/mcp` 0.6.0, `@answerable/mcp-toolbox` 0.2.0.

| Check | Result |
| --- | --- |
| Root typecheck, lint and build | Pass with `--force` (9, 9 and 3 tasks) |
| `bun --filter web test` | 78 pass |
| `bun run mcp:test` | auth 41 pass, 100%; mcp 171 pass and 5 todo, 100%; e2e 44 pass and 4 todo; Toolbox 88 pass and 2 todo across 15 files, 100% lines and functions (run against a private Postgres on port 47442 while B7 held the shared test database) |
| `bun run mcp:check @answerable/mcp-toolbox` | 4 tasks pass |
| `bun run mcp:test:e2e` | 48 pass at 100%: 33.2 and 35.8 seconds by the agent; nothing left behind |
| Coordinator, after merging B6 over B7 | Typecheck, lint and build pass with `--force` (9, 9 and 3 tasks); web 78; `mcp:test` auth 52, mcp 176 at 100%, e2e 48, Toolbox 117 across 17 files at 100%; `mcp:check` 4 tasks; `mcp:test:e2e` 52 pass at 100% in 36 seconds at load average 57, nothing left behind; J3 listed after 15.0 seconds; 45 grant reads answered by 4 access-view calls (91.1%), median 34.2 ms and maximum 38.1 ms; 3 token requests, 2 audit-log reads; 46 evidence events in 3 chains |

**What changed.** The Toolbox keeps intents in Postgres (`intents`, compare-and-set per transition, expiry judged by the database's clock or an injected one) and records every transition as evidence through a decorator over the store: `intent.prepared` with the preview as an erasable payload, `intent.approval_requested`, `intent.committed` and `receipt.issued`, `intent.stale`, `intent.expired`. Every granted mutation's prepare tool is served prefixed and commits through `toolbox_commit` and `toolbox_commit_confirmed`, with the organisation's policy-class override applied. `host_clients` chooses the projection (`direct`, `meta` or `auto` with a `direct_limit` of 40); the meta projection serves `toolbox_whoami`, `toolbox_search` (Postgres full text over the caller's usable capabilities, ranked identity over title over description, paginated), `toolbox_describe` (up to 5 identities, schemas from the manifest), `toolbox_execute` (reads only) and `toolbox_prepare`, plus the two commit tools. A grant change invalidates the cache and publishes `tools/list_changed` to every 2026-07-28 listener. `@answerable/mcp` gains `project`, a `McpServerHandle` with `toolsChanged` and `call`, `wrapCall` over commit calls, `tools.listChanged` advertised and a 5-second keep-alive on `subscriptions/listen`.

**What the journeys proved.** J3: the listening client heard `tools/list_changed` 10.8 to 11.8 seconds after the entitlement change and listed the new tool; a 2025 client polling every 5 seconds saw it at 15.0 seconds. J6: with `policy_class` overridden to `human` for `e2e/records.delete`, beta's prepare returns `policy_class: "human"`, the confirmed commit tool and a pending approval; both commit tools answer `APPROVAL_REQUIRED`; the intent is `awaiting_approval`; evidence holds `intent.prepared` and `intent.approval_requested`. J7: through a host client set to `meta`, alpha sees exactly the seven meta tools; search finds `e2e/records.list` by a word from its description; describe returns its schemas; execute runs it; prepare and `toolbox_commit` create a record; prepare and `toolbox_commit_confirmed` with the summary delete it. J10: erasing the preview payload keeps the chain valid and the row's `payload_hash` unchanged.

**Measured.** `toolbox_search` median 7.5 to 10.6 ms, maximum 11.5 to 20.7 ms over 20 calls; the grant cache answered 45 reads with 4 access-view calls (91.1% hits) in each of three runs.

**Found by testing.**

- A 2025 client cannot receive `list_changed`: the SDK serves that revision statelessly and a GET answers 405, so there is no stream. Documented as Not yet, with per-organisation targeting.
- `Bun.serve` closes a connection idle for 10 seconds; the SDK's 15-second keep-alive on `subscriptions/listen` cut the stream at about 12 seconds and the client re-sent the request. A 5-second keep-alive held one stream for 20 seconds.
- Bun 1.3.1's `toMatchObject` writes asymmetric matchers into the object it checks: `expect.stringMatching` replaced a commit token and broke the next call.
- `Bun.sql` stores a string bound as `::jsonb` as a JSON string; binding JSON text as `::text::jsonb` and reading it back as text round-trips every value, including null against absent. Arrays cannot be bound for `= any()`.
- Two agents running the acceptance at the same time destroy each other's run through the fixed Compose project name; both reruns were clean.

**Decisions recorded.** `toolbox_search` pages for real (`cursor`, a true `has_more`), because a fixed `has_more: false` would be silent truncation and the conformance kit refuses it; `toolbox_describe` answers `{ capabilities }`, bounded at 5, for the same reason. A meta call that names a hidden capability records that capability's denial, as a direct call does. Prepare and commit rows carry `intent_id`, and commits `receipt_id`. An intent that expires unseen gets its `intent.expired` row when next read; there is no sweep. Catalogue, host-client and manifest changes send no `list_changed` yet.

**Size.** `mcps/toolbox/src` source 942 lines in 16 files, tests 1,298 in 15 files, test support 110; migrations 166.

## Limits

The acceptance uses local test issuers for company directories, a pre-registered public client and loopback HTTP. It does not certify Claude.ai, another host, another company directory or a production deployment.
