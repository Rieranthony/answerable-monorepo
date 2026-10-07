# Audit D: the MCP kit packages

Tree `436909e` on `claude/v0-cleanup`, 2026-10-07. Read-only. Every claim below names its evidence: a grep, a tool run or a probe. Probes are throwaway scripts in the session scratchpad (`probes-d/`), run in-process against the worktree's source; none opened a port or touched a database.

Gates measured on this tree, before any change: `packages/mcp` 109 pass, 2 skip, 100% lines and functions (3.86 s); `packages/auth` 62 pass, 100%; `packages/id-admin` 16 pass, 100% of `src/index.ts`; `scripts` 16 pass. `tsc --noUnusedLocals --noUnusedParameters` on `packages/mcp`, `auth`, `id-admin`, `mcp-postgres` and `scripts`: one hit, in a test (`hub.test.ts:129`). `packages/mcp-postgres`'s tests were not run (they reset a shared database).

## 1. Scope read

Read in full:

| File | Lines |
| --- | --- |
| `packages/mcp/src/index.ts` | 11 |
| `packages/mcp/src/testing.ts` | 4 |
| `packages/mcp/src/definitions.ts` | 71 |
| `packages/mcp/src/tool.ts` | 114 |
| `packages/mcp/src/mutation.ts` | 155 |
| `packages/mcp/src/provider.ts` | 82 |
| `packages/mcp/src/server.ts` | 329 |
| `packages/mcp/src/call.ts` | 95 |
| `packages/mcp/src/errors.ts` | 63 |
| `packages/mcp/src/prepare.ts` | 55 |
| `packages/mcp/src/commit-tools.ts` | 48 |
| `packages/mcp/src/commit.ts` | 121 |
| `packages/mcp/src/intents.ts` | 116 |
| `packages/mcp/src/manifest.ts` | 72 |
| `packages/mcp/src/kit.ts` | 48 |
| `packages/mcp/src/schema-lint.ts` | 22 |
| `packages/mcp/src/conformance.ts` | 181 |
| `packages/mcp/src/test-mcp.ts` | 85 |
| `packages/mcp/src/environment.ts` | 23 |
| `packages/mcp/src/build.ts` | 37 |
| `packages/mcp/src/build-worker.ts` | 11 |
| `packages/mcp/src/testing-asset.fixture.ts`, `testing-assets.d.ts`, `testing-view.fixture.ts`, `.css`, `.svg` | 2, 4, 7, 1, 1 |
| `packages/mcp/src/build.test.ts`, `environment.test.ts`, `reference.test.ts` (to see what holds the build, the environment and the reference) | 17, 15, 18 |
| `packages/mcp/scripts/reference.ts` | 104 |
| `packages/mcp/package.json`, `tsconfig.json`, `bunfig.toml`, `README.md` | 31, 16, 8, 37 |
| `packages/auth/src/index.ts` | 152 |
| `packages/auth/src/testing.ts` | 90 |
| `packages/auth/package.json`, `tsconfig.json`, `bunfig.toml`, `README.md` | 26, 16, 8, 43 |
| `packages/id-admin/src/index.ts` | 172 |
| `packages/id-admin/src/testing.ts` | 569 |
| `packages/id-admin/package.json`, `tsconfig.json`, `bunfig.toml`, `README.md` | 25, 16, 8, 47 |
| `packages/mcp-postgres/src/index.ts` | 4 |
| `packages/mcp-postgres/src/testing.ts` | 22 |
| `packages/mcp-postgres/src/migrate.ts` | 46 |
| `packages/mcp-postgres/src/intents.ts` | 93 |
| `packages/mcp-postgres/src/evidence.ts` | 96 |
| `packages/mcp-postgres/src/intent-evidence.ts` | 44 |
| `packages/mcp-postgres/scripts/test-migrate.ts` | 13 |
| `packages/mcp-postgres/package.json`, `tsconfig.json`, `bunfig.toml`, `README.md` | 26, 16, 8, 33 |
| `scripts/mcp-new.ts` | 47 |
| `scripts/mcp-templates.ts` | 75 |
| `scripts/package.json`, `tsconfig.json` | 18, 15 |
| Consumers: `mcps/e2e/src/server.ts`, `mcp.ts`, `records.ts`, `scripts/build.ts`, `package.json` | 18, 98, 51, 8, 35 |
| Consumers: `mcps/example/src/provider.ts`, `notes.ts`, `provider.test.ts`, `server.ts`, `README.md`, `package.json`, config files | 46, 27, 48, 7, 17, 24 |
| Consumers: `mcps/toolbox/src/toolbox.ts`, `environment.ts`, `spans.ts` | 146, 34, 61 |
| Consumers: `mcps/admin/src/admin.ts`, `environment.ts`, `roles.ts` | 74, 38, 64 |
| Docs: `apps/web/content/docs/mcp/index.mdx` | 96 |
| Docs: `docs/07-mcp-platform-draft.md`, `docs/08-capability-platform.md`, `docs/09-mcp-design-standard.md`, `docs/goals/test-audit/conclusions.md`, `docs/goals/schema-audit/task_plan.md` | 31, 288, 146, 80, 44 |

Read in part, by grep: `packages/mcp/src/hub.test.ts` (293; its test names and fixtures), `commit.test.ts` (test names), `mcp-postgres/src/intents.test.ts` (which store methods it calls), `apps/web/content/docs/mcp/servers.mdx` (132), `toolbox/add-tools.mdx` (165), `apps/web/components/docs/generated.tsx` (imports), `docs/goals/schema-audit/audits/d-toolbox-mcp-postgres.md` rows 16 to 26, the official SDK's `createMcpHandler`, `oauthMetadataResponse`, `buildOAuthProtectedResourceMetadata` and `validateAndWarnToolName` in `node_modules/.bun/@modelcontextprotocol+server@2.1.0`.

## 2. Summary

| Category | Findings |
| --- | --- |
| dead | 3 (D1, D7, D9) |
| duplicated | 2 (D6, D11) |
| complicated | 1 (D8) |
| unsafe | 3 (D3, D4, D5) |
| ugly | 5 (D2, D10, D12, D13, D14) |
| **total** | **14** |

Estimated source change if every proposal is taken: about 55 lines removed and 22 added (net about −33), plus three short test cases (D3, D4, D5) and the move of four `mcp-postgres` store tests if D8 is taken. The kit is in good shape: most of it is "keep" (section 5), and none of the findings is a breach of identity or tenancy.

The five changes that matter most:

1. **D3** `createMcpServer` passes no `onerror` to the SDK's `createMcpHandler`, so anything other than a `ToolError` thrown by `allow`, `project` or `policyClass` (the Toolbox's catalogue read from Postgres, the evidence write in `allow`) answers HTTP 500 with no log line at all. Measured: 0 `console.error` calls for a 500 on `tools/list` and `tools/call`. One line fixes it.
2. **D5** A commit checks the intent's status before the commit token, so a replay of a committed intent returns the receipt for any token (measured), and an expired or in-progress intent answers without one. Same principal only; move one line up.
3. **D6** Three copies of the environment reader (SDK, Toolbox, admin MCP): the same Zod error formatting, a verifier built only to validate two URLs, and the variable picked by `message.startsWith("resource")`. One `parseEnvironment` helper in `packages/mcp/src/environment.ts`.
4. **D4** When `allow` refuses with a `ToolError` (ID unavailable), the server registers the caller's raw tool name, and the SDK prints it in five `console.warn` lines: an authenticated caller can write arbitrary lines, newlines included, into the server log (measured). One guard on the name's grammar.
5. **D8** `createPostgresIntentStore`'s own `get` and `transition` run only in tests; both servers always wrap the store in `withEvidence`, which re-implements both on `expire`, `read` and `move`. Merge the two into one store that takes the evidence.

## 3. Findings

| ID | file:line | category | finding | evidence | proposal | lines −/+ | risk | confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | `packages/mcp/src/tool.ts:110` | dead | `deprecationSentence` is exported, but only `wireDescription` on line 112 calls it. | knip baseline: `deprecationSentence packages/mcp/src/tool.ts:110:14`; `grep -rnF deprecationSentence --include=*.ts --include=*.mdx .` → only `tool.ts:110` and `tool.ts:112`. Not re-exported by `index.ts`, so not in `reference.mdx`. | Drop `export`. | 0/0 | None; `tool.test.ts` holds the sentence through `wireDescription`. | high |
| D2 | `packages/mcp/src/conformance.ts:36` | ugly | `as unknown as PreparedIntent` where a single cast compiles. | Probe `probes-d/cast`: `declare const result: Record<string, unknown>; result as PreparedIntent` typechecks under `packages/mcp`'s compiler options (and a planted error is still reported, so the check ran). | `return await ok(…) as PreparedIntent`. Removes the kit's only `as unknown as` (baseline counted 4 in the repo). | 0/0 | None; `conformance.test.ts`. | high |
| D3 | `packages/mcp/src/server.ts:217`, `:301` | unsafe (swallowed error) | `createMcpHandler(factory, { keepAliveMs })` has no `onerror`, and the SDK reports factory and serving failures only through it, so a non-`ToolError` thrown by `allow`, `project` or `policyClass` becomes a 500 with nothing logged. | SDK `createMcpHandler` (`index.mjs:1316-1320`, `:1423-1428`): `reportError` calls `onerror?.(error)` then answers `internalServerErrorResponse`. Probe `probes-d/factory-throw.ts` (`allow` throws `new Error("grants database down")`): `tools/list 500`, `tools/call 500`, `console.error calls: 0`. Real paths: Toolbox `authority()` (`mcps/toolbox/src/toolbox.ts:44-52`) reads `readCatalogue(db…)` and `readHostClient(db…)` inside `allow`, `project` and `policyClass`; `allow` writes `evidence.record` (`toolbox.ts:86`, `admin.ts:46`). Only the ID reads log themselves (`grants.ts:60`, `roles.ts:36`). | Pass `onerror: error => console.error("[mcp] request failed", error)` to `createMcpHandler`. The SDK also reports client rejections through it (unsupported protocol version, 415, bad standard headers), which would then log too; if that is unwanted, wrap the factory's body in a `try` that logs every non-`ToolError` before rethrowing. | 0/+1 | A noisier log for malformed client requests. Add one case to `hub.test.ts` ("a ToolError from allow…", line 127) spying on `console.error` for a plain `Error`. | high |
| D4 | `packages/mcp/src/server.ts:229-232` | unsafe (log injection, low) | On a `ToolError` from `allow`, the server registers a tool under the name the caller sent, and the SDK's name check prints that raw name in five `console.warn` lines. | SDK `registerTool` → `validateAndWarnToolName(name)` → `console.warn(\`Tool name validation warning for "${name}":\`)` (`src-D-y6h4N7.mjs:7238-7253`). Probe `probes-d/refusal-name.ts` (`allow` throws `UPSTREAM_UNAVAILABLE`, call name `"x\n[admin] forged log line zzz…"`, 140 characters): `isError true`, 5 warn lines, the second line of the log reads `[admin] forged log line …`. Reachable whenever ID or the grants read is down, by any caller with a valid token. | Answer with the envelope only for a name a served tool could have: `if (!/^[a-z0-9_]{1,64}$/.test(called)) return server` before `registerTool` (the SDK then answers unknown tool, which reveals nothing: no served name breaks that grammar; hub names are at most 46 characters). | 0/+1 | None for real names. Add a case to `hub.test.ts:127`. | medium-high |
| D5 | `packages/mcp/src/commit.ts:97` (before `:102`, `:103`) | unsafe (low) | `if (intent.status !== "prepared") return settled(intent, id)` runs before the permission and token checks, so the same principal gets a committed intent's receipt with any commit token, and the expiry time, "in progress" and "stale" answers without one, even after losing the mutation. | Probe `probes-d/replay-token.ts`: commit, then `probe_commit` with `commit_token: "act_wrong"` → `receipt idempotent_replay=true`. R21 (docs/09): tokens are "bound to one intent and principal, single use". The token hash is stored for every status, so checking it first costs nothing. | Move the `hashToken(…) !== intent.commit_token_hash` check (line 103) above line 97. Whether `permitted(mutation)` should also precede a replay is an owner call (Q1). | 0/0 (reorder) | A client that replays with a lost token gets `COMMIT_TOKEN_INVALID` instead of its receipt. `commit.test.ts:198` (replay with the right token) holds; add a wrong-token replay to `commit.test.ts:256`. | medium |
| D6 | `packages/mcp/src/environment.ts:11-23`; `mcps/toolbox/src/environment.ts:16-26`; `mcps/admin/src/environment.ts:17-27` | duplicated | The same environment reader three times: `safeParse`, `Invalid <X> configuration: <path>: <message>; …`, `createIdVerifier(auth)` built only to validate the issuer and resource, and the variable chosen by `message.startsWith("resource")`, a dependency on the wording of `@answerable/auth`'s errors. | `grep -rnF 'path.join(".")'` → the three files (plus unrelated `toolbox/src/problem.ts:13`, `apps/id/src/env.ts:273`); `grep -rnF 'startsWith("resource")'` → the same three. | One helper, section 4. `readMcpEnvironment` becomes three lines; the Toolbox and admin readers call it with their own schema and variable names. | −27/+12 | Error text stays byte-identical, so `environment.test.ts` and the servers' environment tests hold. Touches area E files: coordinate. | medium |
| D7 | `packages/auth/src/testing.ts:44`, `:58` | dead | `createTestIssuer`'s `issuer` option: no caller sets it. | `grep -rn createTestIssuer --include=*.ts` → `packages/auth/src/index.test.ts:8` (`{ algorithm }`) and `packages/mcp/src/test-mcp.ts:41` (no options); nothing else. | Remove the option; `const issuer = "https://id.test"`. The `TestIssuer.issuer` comment stays true. | −1/0 | `reference.mdx` regenerates (the signature changes). | high |
| D8 | `packages/mcp-postgres/src/intents.ts:85-91`; `intent-evidence.ts:29-35` | complicated | The bare Postgres store's `get` and `transition` run only in tests: both servers wrap it in `withEvidence`, which re-implements both on top of `expire`, `read` and `move`, and so needs the widened `PostgresIntentStore` type. | `grep -rnF "createPostgresIntentStore("` → production: `mcps/toolbox/src/toolbox.ts:81`, `mcps/admin/src/admin.ts:42`, both `withEvidence(createPostgresIntentStore(db), evidence)`; every other call is in `intents.test.ts` and `intent-evidence.test.ts`. `get` = `expire ?? read` and `transition` = expire-if-open then `move`, at both sites. | `createPostgresIntentStore(db, evidence, { now })` returns an `IntentStore` that records evidence; `expire`, `read`, `move` and the `PostgresIntentStore` type become private; `withEvidence` goes. Keeps schema audit #21's "one expire per call, recorded". | −20/+6 | `intents.test.ts` cases 1 to 4 and 7 call `store.get`, `transition`, `expire`, `read`, `move`; they would go through the merged store (they already need the database). README and `docs/toolbox` snippets change. Owner call (Q2): this structure landed last week. | medium |
| D9 | `packages/mcp-postgres/src/index.ts:1-2` | dead | `EvidenceKind` and `PostgresIntentStore` are exported from the package entry; nothing imports them. | `bunx knip@6.40.0 --include exports,types --include-entry-exports` → `EvidenceKind type packages/mcp-postgres/src/index.ts:1:51`, `PostgresIntentStore type …index.ts:2:42`. The servers use `EvidenceEvent["kind"]` / `Pick<EvidenceEvent, "kind" …>`. | Drop both from the export list (moot for `PostgresIntentStore` if D8 is taken). | 0/0 | None. | medium |
| D10 | `packages/mcp/src/server.ts:236-274` | ugly | The per-call handler (`const call = context(sdkContext.mcpReq.signal); return wrapped(tool, name, call, sdkContext.mcpReq, …)`) is written three times, the read and prepare registrations differ in four fields, and `names.get(tool)!` appears four times. | Lines 248-251, 258-261, 267-273; registration blocks 245-251 and 255-261. | One `handle(tool, name, run)` that builds the context and runs `wrapCall`, and one `registerAppTool` per tool with `inputSchema`, `outputSchema` and the `_meta` capability computed from `tool.kind`; `const name = names.get(tool)!` once. | −12/+4 | `server.test.ts`, `hub.test.ts` and `commit.test.ts` cover every branch (100%). | medium |
| D11 | `mcps/admin/src/admin.ts:51`; `mcps/toolbox/src/toolbox.ts:114`; `mcps/toolbox/src/spans.ts:56`; SDK `packages/mcp/src/call.ts:91-93` | duplicated | Each server re-derives the SDK's rule for the code a failure answers: `failure instanceof ToolError ? failure.code : "INTERNAL"`. | `grep -rnF 'instanceof ToolError ?'` → the three server sites; `call.ts:91-93` applies the same rule. | `errorCodeOf(failure)` in `errors.ts`, exported, section 4. | 0/+2 | None; the servers' `wrapCall` tests. Area E call sites. | low |
| D12 | `packages/mcp/src/build.ts:5`; `scripts/mcp-new.ts:5`; `packages/mcp/scripts/reference.ts:3` (and in area E: `packages/acceptance/src/id.ts:10-11`, `scripts/host-lane.ts:21`, `mcps/e2e/scripts/build.ts:4`) | ugly (portability) | `new URL(…, import.meta.url).pathname` keeps percent-encoding, so a checkout under a path with a space or non-ASCII character spawns or reads a file that does not exist. | `bun -e 'new URL("./x.ts","file:///Users/a%20b/dir/").pathname'` → `/Users/a%20b/dir/x.ts`; `Bun.fileURLToPath(…)` → `/Users/a b/dir/x.ts`. `grep -rnF "import.meta.url).pathname"` (non-test) → the 7 sites. | `Bun.fileURLToPath(new URL(…))`, or `import.meta.dir` (`build.ts`: `` `${import.meta.dir}/build-worker.ts` ``). | 0/0 | None; `build.test.ts`, `mcp-new.test.ts`, `reference.test.ts`. | medium |
| D13 | `packages/id-admin/README.md:3`; `packages/mcp-postgres/README.md:3` | ugly (doc contradicts code) | Both say "Development and test only", yet the Toolbox and the admin MCP use them at runtime. | `mcps/toolbox/src/server.ts` and `mcps/admin/src/server.ts` import `createIdAdmin`; `toolbox.ts:4` and `admin.ts:4` import `createEvidence`, `createPostgresIntentStore`, `withEvidence`. | "Private to the monorepo; no npm release." (as `docs/mcp/index.mdx` says of every package). | 0/0 | None. | medium |
| D14 | `mcps/example/README.md:17` (area E file; found comparing the scaffold with the example) | ugly (stale doc) | "`exports` makes the provider mountable in the Toolbox" reads as if the workspace has an `exports` map; it has none. | `mcps/example/package.json` has no `exports`; `apps/web/content/docs/toolbox/add-tools.mdx:34`: "`mcps/example` has none, since nothing mounts it". | "It has no `exports` map; add one to mount it in the Toolbox: [Add tools to the Toolbox](…)". | 0/0 | None. | medium |

## 4. Shared helper proposals

**`parseEnvironment` (D6), in `packages/mcp/src/environment.ts`, exported from `@answerable/mcp`.**

```ts
/** Parse `env` with `schema` and check the ID issuer and resource it names; throws `Invalid <label> configuration: <VARIABLE>: <problem>`. */
export function parseEnvironment<Schema extends z.ZodObject>(label: string, schema: Schema, env: Record<string, string | undefined>,
  names: { issuer: string; resource: string }): { data: z.output<Schema>; auth: IdVerifierConfig }
```

The body is today's `readMcpEnvironment` lines 12-21 with `label` and `names` in place of the literals. Call sites:

| Site | Today | After |
| --- | --- | --- |
| `packages/mcp/src/environment.ts:11-23` | 13 lines | `const { data, auth } = parseEnvironment("MCP", schema, env, { issuer: "MCP_ID_ISSUER", resource: "MCP_RESOURCE_URL" }); return { auth, port: data.MCP_PORT }` |
| `mcps/toolbox/src/environment.ts:17-26` | 10 lines | 1 line, then the existing `return` |
| `mcps/admin/src/environment.ts:18-27` | 10 lines | 1 line, then the existing `return` |

Removes about 27 lines for 12 (the helper and three calls), and the `startsWith("resource")` coupling to `@answerable/auth`'s wording lives in one place. An alternative is to export `@answerable/auth`'s `trustedUrl(value, name)` and call it with the variable name, which removes the sniffing entirely but changes the error text, so the three environment tests change.

**`errorCodeOf` (D11), in `packages/mcp/src/errors.ts`, exported from `@answerable/mcp`.**

```ts
/** The code a failure answers: a `ToolError`'s own, anything else `INTERNAL`. */
export const errorCodeOf = (failure: unknown) => failure instanceof ToolError ? failure.code : "INTERNAL"
```

Call sites: `mcps/admin/src/admin.ts:51`, `mcps/toolbox/src/toolbox.ts:114`, `mcps/toolbox/src/spans.ts:56`, and `packages/mcp/src/call.ts:91-93` (the SDK's own `answer`). No lines saved; the gain is that the servers stop restating an SDK rule. Take it only if area E agrees.

Considered and below the threshold of three: the SHA-256 one-liner (three copies, see section 5), the provider-id regex (`provider.ts:52`, `scripts/mcp-new.ts:11`), the `/health` database check (`toolbox.ts:133-140`, `admin.ts:63-70`), `run().then(data => ({ data }), failure => ({ failure }))` (`toolbox.ts:100`, `admin.ts:50`) and the once-per-request `WeakMap<UserPrincipal, Promise>` (`toolbox.ts:43`, `roles.ts:29`).

## 5. Challenged and kept

| Mechanism | Why it stays | Evidence |
| --- | --- | --- |
| View builds in a child process (`build.ts` + `build-worker.ts`, 48 lines) | docs/07 records the decision: an in-process `Bun.build` breaks the test suite on Bun 1.3.1, and Bun is pinned at 1.3.1. The e2e server itself never builds: it reads `dist/records.html` built by `mcps/e2e/scripts/build.ts`; the worker matters for `build.test.ts` and `mcps/e2e/src/apps.test.ts`, which build inside `bun test`. | `docs/07-mcp-platform-draft.md` "Views"; `mcps/e2e/src/server.ts:6-8`. |
| `bundleBrowser` as a public export of `@answerable/mcp/build` | One consumer, a test (`mcps/e2e/src/apps.test.ts:10`, bundling the Apps test host), but the export is three lines and `buildView` is built on it. | grep `bundleBrowser`. |
| The hub options (`mount`, `allow`, `project`, `wrapCall`, `policyClass`, `call`, `toolsChanged`) and `hub.test.ts` | "Hub" is the Toolbox's shape: every option has a production user. | `mcps/toolbox/src/toolbox.ts:37, 63, 77-138`; `mcps/admin/src/admin.ts:40-62`; documented in `docs/mcp/servers.mdx:44-52`. |
| `peek()` re-reading the body, and the batch refusal | The SDK's 2025 stateless fallback accepts JSON-RPC batches of up to 100 (`MAX_BATCH_SIZE`, `index.mjs:254`, `:719`), which would hide calls from `allow`, and the factory never receives the parsed message. Passing the parsed body on as the handler's `parsedBody` would save one parse; optimising is the lowest preference. | SDK source. |
| The hand-written protected-resource metadata (`server.ts:308-311`) | The SDK's `buildOAuthProtectedResourceMetadata` needs the full RFC 8414 `oauthMetadata` (the server knows only the issuer) and omits `bearer_methods_supported`; `oauthMetadataResponse` also serves the AS metadata verbatim. Four fields. `requireBearerAuth`, host and origin validation and `createMcpHandler` are the SDK's own, as AGENTS.md asks. | SDK `index.mjs:616-625`, `:707-714`. |
| `advertised()` (`call.ts:8-10`) bypassing the SDK's input validation | Deliberate and commented: the SDK would answer a plain-text protocol error, the standard wants an `INVALID_INPUT` envelope. It uses the public Standard Schema `~standard.jsonSchema`, the same conversion the manifest uses. | `call.ts:6-7`; docs/08 "Errors". |
| The `declared` WeakSet (`call.ts:25`) | Lets `call()` pass a mounted tool's declared custom codes through the calling tool, a documented contract, though no production provider declares custom codes yet. | `docs/mcp/servers.mdx:52`; `hub.test.ts:253`. |
| `!==` on the commit-token digest (`commit.ts:103`) | Schema audit row 23 kept it: comparing SHA-256 digests leaks nothing useful; single use comes from the compare-and-set. | `docs/goals/schema-audit/audits/d-toolbox-mcp-postgres.md` row 23. |
| JWT verification in `@answerable/auth` | Allow-list EdDSA, ES256, RS256; `typ: at+jwt`; `iss`; `aud` = the resource; `exp`, `iat`, `sub` required; jose's default zero clock tolerance; `cnf` refused; `azp` must equal `client_id`; keys only from the issuer's RFC 8414 metadata, same origin, `redirect: "error"`, 5 s timeout, discovery retried after a failure; jose's JWKS cache and cooldown. RFC 9068 lists `jti` as required and the verifier does not require it; nothing keys on `jti`, so requiring it would add nothing. An ID outage at first use answers 401, documented ("Failures") and tested. | `packages/auth/src/index.ts:109-151`; `README.md:25-35`; test audit conclusions (algorithm allow-list, zero tolerance). |
| `@answerable/id-admin`'s client | One token per audience and scope, reused until 30 s before expiry, renewed once on 401 with the same `Idempotency-Key` and `x-request-id`; 5 s timeouts; errors carry status, problem code and `Retry-After`, never the secret. `manage("GET")` has a user. | `index.ts:77-170`; `mcps/toolbox/src/admin-enable.ts:45, 52`; `mcps/admin/src/calls.ts:10` reads `retryAfterMs`. |
| The fake ID (569 lines) | Every helper has a consumer (grep of each method across `mcps/*` and `packages/id-admin/src/index.test.ts`); every admin route it implements is one a server calls (grep of the servers' paths); its own suite covers 98.36% of its lines, and the uncovered `revise()` is used by `mcps/admin/src/provider.test.ts` and `writes.test.ts`. The test audit made it faithful and checks it against `openapi.admin.json`. | Probe with a bunfig that does not ignore `src/testing.ts`: `src/testing.ts 94.19% funcs, 98.36% lines, uncovered 415, 557-563`. |
| SDK options no production provider sets (`deprecated`, `errors`, `expiresInMs`, `timeoutMs`, prompt and resource `scopes`) | The standard promises each (R33, R37, section 5 custom codes, R22 expiry), `packages/mcp`'s tests hold them, and `mcps/example/src/docs/*.ts` renders them in the docs. | grep of `mcps/*/src` (non-test): only `mcps/example/src/docs/custom-error.ts:13` sets `errors`. |
| Type exports knip reports with `--include-entry-exports` (`Plan`, `Preview`, `Change`, `Risk`, `Effect`, `Resource`, `View`, `Manifest`, `Retry`, `ConformanceFixture`) | They type documented public signatures (`defineMutation`'s `prepare` and `commit`, `manifest()`, `ToolError`), `reference.mdx` renders them, and `Preview` and `ConformanceFixture` are `AutoTypeTable`s in the docs. Every value export of `index.ts` and `testing.ts` has a consumer or a documented role. | knip run; grep of `<AutoTypeTable` in `apps/web/content/docs`. |
| Three SHA-256 one-liners (`prepare.ts:21`, `mcp-postgres/src/migrate.ts:12`, `evidence.ts:43`) | A shared export would add a public SDK symbol for one expression and turn `mcp-postgres`'s type-only import of `@answerable/mcp` into a runtime one. | grep `CryptoHasher("sha256")`. |
| The view-conflict check in both `defineProvider` (`provider.ts:68-73`) and `wireNames` (`server.ts:120-132`) | The first fails at definition time (a manifest never reaches a server) and feeds the view-versus-resource URI check; the second is the only one that sees mounted providers together. | `provider.ts:74`. |
| The sweep policy in both intent stores | Two stores, one contract; the schema audit added the Postgres sweep so they behave alike (row 20). | Schema audit rows 20, 21. |
| `unsafe()` in `migrate.ts:40` and `scripts/test-migrate.ts:9` | The migrator runs `.sql` files from the repository's own directories with parameterised names and checksums; the test reset is a constant statement behind `assertDisposable`. | `migrate.ts:19-46`; `testing.ts:9-12`. |
| The scaffold (`mcp-new.ts`, `mcp-templates.ts`) against `mcps/example` | No drift: `src/server.ts` and `.env.example` from `scaffoldSources("example", …)` are byte-identical to the example's; `tsconfig.json`, `bunfig.toml` and `eslint.config.mjs` are byte-identical copies of `mcps/e2e`'s; the test's shape matches. The copied `tsconfig.json` enables JSX and DOM, which a scaffolded server only needs once it adds a view; harmless. | Probe `probes-d/scaffold-diff.ts`; `cmp`. |
| Prompt and resource failures (`server.ts:277-293`) | Logged under `[mcp]`, answered as a protocol `INTERNAL_ERROR` with "Content could not be read": no internals reach the client. | Source. |
| Commit-token minting (`prepare.ts:38`) | `act_` and 32 random bytes, base64url; only the SHA-256 is stored. | Source; `commit.test.ts:366`. |

## 6. Questions for the coordinator

1. **D5, what a replay requires.** Should a replay of a committed intent (and the expired, stale and in-progress answers) require the commit token? Recommendation: yes, check the token first; it is one line and matches R21. Leave the permission check after the replay: the receipt is the caller's own record of a change they made.
2. **D8, merging the Postgres store with `withEvidence`.** It removes a test-only path and an exported type, but restructures code the schema audit landed last week (row 21). Recommendation: merge now, in the same change as D9, since both servers already pair them and nothing else would.
3. **D6, a new public SDK export.** `parseEnvironment` adds an export to `@answerable/mcp` (and a section to `reference.mdx`), and its call sites are in area E. Recommendation: take it, keep the error text identical so no test changes, and tell area E's auditor.
4. **D3, `onerror` or a factory `try`.** `onerror` is one line but also logs malformed client requests; the `try` logs only our own failures. Recommendation: `onerror`, since a 500 without a log line is the worse failure and client rejections are rare.
5. **D11.** Worth an export only if area E takes it at its three sites. Recommendation: take it together with D6, which touches the same servers.
