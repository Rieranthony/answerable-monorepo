# Test audit: the MCP kit (area C)

Tree `491c9e9`, audited in a worktree on 2026-10-03 with Postgres on port 47435. Every number below comes from a run; probes were restored and `git status --short` printed nothing at the end.

## Summary

- **Verdict.** Fast (10.6 s and 10.8 s for the whole area, run twice) and mostly about real rules: 84 INV and 101 CON tests, and 44 of 54 mutation probes were caught. But 125 of 360 tests restate facts held elsewhere or pin detail (99 DUP, 20 FILL, 6 IMPL), and ten probes on security or correctness guards were caught by nothing.
- **Counts.** 372 test cases in 32 files: 360 run, 12 `todo`. INV 84 · CON 101 · BEH 50 · DUP 99 · FILL 20 · IMPL 6.
- **Finding 1: the conformance kit mostly re-runs the SDK.** 11 of its 21 implemented checks cannot fail for a provider built with `defineTool`/`defineMutation`/`createMcpServer`. They make up 66 of the 99 DUP tests here, plus 81 more in the admin MCP. The docs justify them by "the hub's adapters", which are Not yet. Two checks pass vacuously for mutations with no targets.
- **Finding 2: untested guards.** Nothing tests the JWT algorithm allow-list: without it, PS256, ES384 and RS512 tokens signed by a published key are accepted. Nothing tests zero clock tolerance: a 10-minute tolerance passes every test. Storing the raw commit token instead of its hash passes all six suites. Also untested: the evidence chain's link check, the migrator's lock, and both 5 s timeouts in the ID client. The concurrent double-commit guard is held only by a spy test.
- **Finding 3: code that contradicts the docs, shown by running it.**
  - R19 says commit rechecks the policy: it does not. An agent-class intent commits after the policy becomes `human`.
  - A JSON-RPC batch reaches `allow` with `called = false`, so a hub records no denial.
  - The memory intent store never evicts, and every standalone server uses it by default.
  - docs/09 labels R24, R29, R32 and the upstream parts of R33 and R35 `[SDK]`, but no code implements them.
  - The fake ID diverges from real ID: it ignores abort signals, never answers `operation_in_progress`, sends no `Retry-After`, and answers DELETE and PATCH on four routes as if they were other methods.
- **Effect.** About 105 of the 360 tests can go without losing coverage or a caught probe. About twelve short tests would close the gaps.

## Inventory

Times are wall seconds for the file alone (`bun test <file>`, Bun start-up included), measured twice. Layers: *in-process MCP* means the official MCP client against `createMcpServer`'s fetch handler with the in-process test issuer, so no port and no network.

| File | Tests | Alone (s) | Layer | What it proves |
| --- | --- | --- | --- | --- |
| `packages/auth/src/index.test.ts` | 56 | 0.11 / 0.18 | verifier + in-process issuer | Token verification: claims, issuer, audience, type, keys, discovery, URL rules |
| `packages/mcp/src/commit.test.ts` | 20 | 0.56 / 0.69 | in-process MCP | The prepared-mutation protocol: tokens, principal, expiry, staleness, classes, replay |
| `packages/mcp/src/conformance.test.ts` | 65 + 5 todo | 1.24 / 1.48 | in-process MCP | Kit self-tests (24) and the kit run on a demo provider (41) |
| `packages/mcp/src/server.test.ts` | 25 | 0.40 / 0.42 | HTTP + in-process MCP | Routes, Host/Origin, audience, scope filtering, envelope, timeouts, minimisation |
| `packages/mcp/src/hub.test.ts` | 12 | 0.28 / 0.34 | in-process MCP | `mount`, `allow`, `project`, `wrapCall`, `call`, `toolsChanged` |
| `packages/mcp/src/manifest.test.ts` | 3 | 0.08 / 0.08 | pure | Manifest JSON shape |
| `packages/mcp/src/testing.test.ts` | 6 | 0.15 / 0.17 | in-process MCP | `createTestMcp`, `errorOf`, `testPrincipal` |
| `packages/mcp/src/provider.test.ts` | 6 | 0.08 / 0.08 | pure | `defineProvider` rules |
| `packages/mcp/src/tool.test.ts` | 9 | 0.07 / 0.08 | pure | `defineTool` rules |
| `packages/mcp/src/mutation.test.ts` | 7 | 0.08 / 0.09 | pure | `defineMutation` rules |
| `packages/mcp/src/definitions.test.ts` | 3 | 0.13 / 0.16 | pure + in-process MCP | Prompts, resources, views, composition |
| `packages/mcp/src/intents.test.ts` | 3 | 0.07 / 0.08 | memory store | Copy, expiry, compare-and-set |
| `packages/mcp/src/declared.test.ts` | 2 | 0.15 / 0.18 | in-process MCP | Declared and undeclared custom codes |
| `packages/mcp/src/errors.test.ts` | 3 | 0.07 / 0.08 | pure | Error table and retry defaults |
| `packages/mcp/src/reference.test.ts` | 2 | 1.67 / 1.93 | TypeScript compiler over the sources | `reference.mdx` equals the generated reference |
| `packages/mcp/src/build.test.ts` | 3 | 0.10 / 0.10 | Bun subprocess (bundler) | `buildView` output and refusals |
| `packages/mcp/src/environment.test.ts` | 2 | 0.08 / 0.08 | pure | `readMcpEnvironment` |
| `packages/mcp-postgres/src/evidence.test.ts` | 8 | 0.26 / 0.21 | Postgres | Chain, row hash, append-only trigger, verify, erasure |
| `packages/mcp-postgres/src/intent-evidence.test.ts` | 4 | 0.13 / 0.13 | Postgres | Transitions become evidence |
| `packages/mcp-postgres/src/intents.test.ts` | 5 | 0.09 / 0.08 | Postgres | Store round trip, compare-and-set, expiry |
| `packages/mcp-postgres/src/migrate.test.ts` | 5 | 0.21 / 0.13 | Postgres | Migrator order, idempotence, name rule |
| `packages/mcp-postgres/src/test/database.test.ts` | 1 | 0.02 / 0.01 | pure | Only the disposable database is reset |
| `packages/id-admin/src/index.test.ts` | 18 | 0.04 / 0.07 | client against the in-memory fake ID | Tokens, renewal, keys, preconditions, errors |
| `mcps/e2e/src/apps.test.ts` | 1 | 2.20 / 2.63 | real browser (Chromium) + `Bun.serve` host + in-process MCP | The Apps view prepares, commits and hides writes |
| `mcps/e2e/src/conformance.test.ts` | 31 + 4 todo | 0.34 / 0.28 | in-process MCP | The kit on the reference server |
| `mcps/e2e/src/mcp.test.ts` | 8 | 0.36 / 0.35 | in-process MCP | Reference server's tools, paging, mutations, isolation |
| `mcps/e2e/src/records.test.ts` | 4 | 0.10 / 0.09 | store | Record store paging and isolation |
| `mcps/e2e/src/server.test.ts` | 1 | 0.22 / 0.17 | subprocess + real port | Entry point serves, answers `/health`, stops on SIGTERM |
| `mcps/example/src/provider.test.ts` | 23 + 3 todo | 0.26 / 0.28 | in-process MCP | The kit on the quickstart, add-then-list |
| `mcps/example/src/errors.test.ts` | 2 | 0.16 / 0.16 | in-process MCP | Refusals the docs show |
| `mcps/example/src/intents.test.ts` | 3 | 0.18 / 0.22 | in-process MCP | Expiry, policy class, confirmed commit (docs regions) |
| `scripts/mcp-new.test.ts` | 19 | 3.63 / 2.77 | filesystem + subprocesses (`bun test`, `tsc`, `eslint`) + real port | The scaffold, and that its server passes its own gates |

## Classification

One class per `test(...)` call. Table-driven calls are grouped, with the class of each row.

### `packages/auth/src/index.test.ts` (56): INV 25, CON 17, BEH 11, DUP 1, FILL 2

| Test | Class | Why |
| --- | --- | --- |
| valid tokens return only a frozen principal and de-duplicated scopes | CON | The `UserPrincipal` shape every server reads |
| accepts ES256, accepts RS256 (2) | CON | ID's resources may sign with either (`apps/id/src/http/admin/resources.ts:59`) |
| rejects … with a safe authentication error (18 rows) | 12 INV, 6 CON | INV: issuer, audience, expired, future nbf, missing exp, missing iat, client subject, missing membership, non-UUID subject, different azp, proof-bound, missing org authorisation version. CON: non-string scope, zero or fractional version, text, negative or fractional `upstream_auth_time` |
| rejects the wrong type, an unpublished signature and opaque tokens | INV | `typ at+jwt` and signature (probe A2 caught only here) |
| the organisation's authorisation version is the token's | CON | Claim mapping |
| the upstream authentication time is the token's, null when … | CON | Claim mapping |
| a client token is refused by a user verifier … | INV | Subject-type separation |
| a client verifier refuses a user token | INV | Subject-type separation |
| rejects a client token with … (8 rows) | 5 INV, 3 CON | INV: subject not the client, azp, missing client id, missing organisation, proof-bound. CON: missing or zero client version, missing org version |
| a rejection says only that a valid … token is required | DUP | Every `rejects …` row already compares with `new AuthenticationError()` |
| does not require resource pins or cap the token lifetime | CON | docs/07 "no resource UUID pin … no second cap" |
| concurrent verification fetches JWKS once | BEH | Load on ID |
| picks up a rotated key after the default JOSE cooldown | INV | Key rotation |
| cached keys survive an outage, but unseen keys fail | BEH | Availability |
| failed discovery is retried | BEH | Availability |
| discovery rejects a different issuer / origin (2) | INV | Metadata trust (probes A6, A10) |
| discovery inserts the well-known path before an issuer path | CON | RFC 8414 |
| issuer / resource rejects HTTPS, credentials, query, fragment, valid URL (10) | 2 INV, 8 BEH | HTTPS rule is docs/07's invariant; the rest are configuration errors |
| loopback HTTP needs no opt-in and construction performs no discovery | CON | docs/07 |
| uses the global fetch by default | FILL | Drives the default `fetch` branch by mocking `globalThis.fetch` |
| test issuer routes are in-process and origin-bound | FILL | Tests the test-only issuer |

### `packages/mcp` (171 run + 5 todo): INV 38, CON 45, BEH 16, DUP 61, FILL 8, IMPL 3

**`commit.test.ts` (20): INV 13, CON 4, DUP 1, IMPL 1, BEH 1**

| Test | Class | Why |
| --- | --- | --- |
| 2025: tools/list shows each prepare tool read-only … | CON | Annotations, `_meta`, `anthropic/requiresUserInteraction` (docs/08 Projections) |
| 2026-07-28: the same | DUP | No probe distinguished the eras (see Mutation probes) |
| prepare returns the intent … | CON | Intent wire format |
| validate_only runs prepare and records nothing | CON | docs/08; asserts with an `insert` spy |
| commit applies the intent once …; a repeat … replay | INV | R20 |
| the wrong commit tool or a different summary answers APPROVAL_REQUIRED | INV | R22, controlled class |
| a human-class intent waits for an approval | INV | R23 |
| a wrong token answers COMMIT_TOKEN_INVALID | INV | R21 |
| another person, membership or client answers PRINCIPAL_MISMATCH | INV | R19 (only test catching probe M2) |
| an intent past its expiry answers INTENT_EXPIRED | INV | R19 |
| a moved, missing or new target answers INTENT_STALE | INV | R19 |
| a second commit while the first runs answers COMMIT_IN_PROGRESS | INV | R20 |
| a commit that loses the claim to a concurrent commit reads the new status | IMPL | `mockImplementationOnce` on `transition`; the only test catching probe M8 |
| a commit that throws marks the intent failed … | INV | Single use after failure |
| a plan that breaks the contract answers INTERNAL | BEH | Author error surfaces as INTERNAL; asserts log wording too |
| a caller who can use no mutation sees no commit tools | INV | docs/08 invariant 3 |
| commit rechecks the mutation's scopes | INV | R27 |
| an intent for a version this server does not serve | INV | R37 "intents never survive across versions" |
| policyClass decides the class for each caller | CON | Hub API |
| timeoutMs bounds prepare, and re-prepare with commit | INV | R33 |

**`server.test.ts` (25): CON 6, INV 7, DUP 10, BEH 2**

| Test | Class | Why |
| --- | --- | --- |
| HTTP routes expose health, discovery and a bearer challenge | CON | RFC 9728 metadata, `no-store` (probe S4) |
| rejects untrusted hosts, origins and a token for another audience | INV | DNS rebinding, docs/08 invariant 1 (only test catching probe M13) |
| a 2026-07-28 client may keep tools/list for 30 seconds … | CON | docs/08 cache hints (probe S3); the 2025 half asserts SDK behaviour |
| default 2025: tools/list carries the wire name … | CON | R3, R4, R37 on the wire |
| default 2025: scopes filter tools and views | INV | docs/07 "Scopes decide visibility" |
| default 2025: concurrent clients retain separate organisations | INV | Tenant isolation |
| default 2025: invalid input answers INVALID_INPUT … | CON | Envelope, R8 |
| default 2025: tool errors answer the envelope … INTERNAL without detail | INV | No leakage; also asserts log wording |
| default 2025: handlers receive a frozen context … UUIDv7 | CON | `ToolContext` |
| default 2025: a handler that exceeds timeoutMs … TIMEOUT | INV | R33 |
| default 2025: prompts and resources are scope-filtered … | INV | Scope filtering, redaction |
| 2026-07-28: the same eight | 8 DUP | Same code path; every probe that failed one era failed both (M10, M11, M14, M16, M19) |
| server info is the provider's id and version | DUP | `hub.test` "mounted tools …" asserts `getServerVersion` |
| the resource URL is the endpoint and the challenge names the metadata route | CON | RFC 9728 path insertion |
| aborting the HTTP request aborts the tool context | BEH | Holds with our code removed (probe S1): the SDK's `mcpReq.signal` already aborts |
| 2025: input transforms run once and output is minimised | INV | R9, docs/08 invariant 7 |
| 2026-07-28: the same | DUP | Era copy |
| health accepts internal hosts while the MCP endpoint rejects them | BEH | Deployment health checks |

**`hub.test.ts` (12): CON 8, INV 3, BEH 1.** INV: "allow decides, per request …" (docs/08 invariant 2), "a ToolError from allow answers any call …" (invariant 3; its 405 and 400 assertions are SDK behaviour), "a commit rechecks allow". BEH: "a hub refuses a provider mounted twice …". CON: the other eight: naming, mounted mutation, `called`, `wrapCall`, async `policyClass`, `project`, `call`, `toolsChanged`.

**`conformance.test.ts` (65 run + 5 todo): DUP 44, INV 9, FILL 6, CON 4, BEH 2**

- The 41 tests that `assertProviderConformance(good.provider, …)` registers at line 108 are **DUP**. The self-test "the good provider fails no check …" runs every one of these checks on the same provider and expects none to fail. They exist to cover `register` and `assertProviderConformance`: line 108 is that function's only call in the package (grep).
- The 24 self-tests split as follows:
  - **INV (9):** the good provider fails no check …; `output_schema_declared`; `list_paginates`; `read_has_no_side_effect`; `commit_requires_token`; `commit_rejects_expired`; `commit_is_idempotent`; `commit_rejects_other_principal`; `receipt_is_structured`.
  - **CON (4):** the checks are the ones the standard lists; `errors_use_envelope` (the `errorOf` envelope reader); `manifest_matches_snapshot`; `descriptions_operational` (the prepare/intent word rule).
  - **BEH (2):** the kit signs in as one caller; `commit_rejects_stale` (skip message, missing `moveTarget`).
  - **DUP (3):** `prepare_has_no_side_effect`, `preview_is_semantic`, `targets_have_versions`. Each repeats a row of the "good provider" self-test.
  - **FILL (6):** `identity_is_stable`, `name_is_host_safe`, `input_schema_is_closed`, `timeout_bounded`, `deprecations_mirrored`, "an error answered in place of a result names the tool …". The first five fail only for hand-built provider objects (`withTools`/`withManifest`) that the SDK refuses to make. The sixth asserts message wording.

**Small files (73).**

| File | Classes |
| --- | --- |
| `provider.test.ts` (6) | INV 1 (id and version rules, R2/R3), CON 4 (identity, version and scope filling; deprecation replacement; write scope default; error prefix, the only test catching probe M22), BEH 1 (duplicates) |
| `manifest.test.ts` (3) | CON 2, IMPL 1 ("the manifest carries no code" pins `Object.keys` order; `manifest_matches_snapshot` compares with `toEqual`, which ignores order) |
| `errors.test.ts` (3) | CON 2 (the table, `after_ms` default), BEH 1 (custom-code refusals) |
| `reference.test.ts` (2) | CON 1 (drift), BEH 1 (every author-facing function keeps an example) |
| `tool.test.ts` (9) | INV 2 (names R2/R3, timeouts R33), CON 6, BEH 1 (scopes refusal) |
| `mutation.test.ts` (7) | INV 1 (expiry may only shorten), CON 4, DUP 2 ("the tool rules apply, naming the mutation" and "errors declare …" re-test `checkShared`, already held by `tool.test.ts`) |
| `definitions.test.ts` (3) | CON 1 (definitions run without a server), BEH 2 |
| `intents.test.ts` (3) | CON 1 (JSON copy), INV 2 (expiry decided by the store; compare-and-set) |
| `declared.test.ts` (2) | CON 2 (the only tests catching probe M17) |
| `build.test.ts` (3) | FILL 1 ("build errors fail with an actionable message" asserts only `toThrow()`, for the `code !== 0` branch), BEH 2 |
| `environment.test.ts` (2) | BEH 2 (operator configuration messages; not FILL) |
| `testing.test.ts` (6) | DUP 4 (connect defaults, Host handling, `errorOf`, pinned principal; every in-process test relies on them), IMPL 1 (close after a failed connect, by spying on `Client.prototype`), FILL 1 (`testPrincipal` defaults) |

### `packages/mcp-postgres` (23): INV 12, CON 7, BEH 3, DUP 1

| File | Classes |
| --- | --- |
| `evidence.test.ts` (8) | INV 5 (chain links, concurrent gapless chain (only catch of probe P2), append-only trigger, verify finds tampering, erasure keeps the chain), CON 2 (row-hash byte layout, 4 KiB data), BEH 1 (chains longer than one batch) |
| `intent-evidence.test.ts` (4) | INV 3 (prepare, commit and stale, expiry once), CON 1 (a refused transition writes nothing) |
| `intents.test.ts` (5) | CON 1 (round trip), INV 4 (compare-and-set, concurrent claim, injected clock, database clock) |
| `migrate.test.ts` (5) | CON 3 (once and in order, several directories, name rule), DUP 1 ("a fresh schema receives every migration": the test script resets and migrates from scratch before every run), BEH 1 (duplicate names refused) |
| `test/database.test.ts` (1) | BEH (never reset another database) |

### `packages/id-admin/src/index.test.ts` (18): CON 9, BEH 4, INV 1, DUP 1, FILL 3

- **INV:** "the request id and the idempotency key … stay the same when the call is resent after a 401" (the only catch of probe I2).
- **CON:** `found`, `manage` scopes and keys (probe I4), `manage` failure, `x-request-id`, a caller-chosen key, `Operation-Id`, `read` ETag, `If-None-Match` and replay, `withToken`.
- **BEH:** token reuse until 30 s before expiry (the only catch of probe I3), renewal after a refused token, wrong credentials named, no answer.
- **DUP:** "a token that was refused is renewed once for manage too", which is the same `withToken` path.
- **FILL:**
  - "wrong client credentials name both scopes for manage" asserts wording.
  - "the fake ID answers 412 …" and "the fake ID replays …" test the test-only fake. The second pins the fake's `resultReference.type: "organizations"`; real ID says `"organization"` (`apps/id/src/http/admin/organizations.ts:384`).

### `mcps/e2e` (45 run + 4 todo): DUP 23, CON 8, INV 5, BEH 5, FILL 4

- **`conformance.test.ts` (31 + 4 todo): DUP 15, CON 7, INV 4, FILL 3, BEH 2.**
  - Read checks: DUP 5 (`identity_is_stable`, `name_is_host_safe`, `input_schema_is_closed`, `errors_use_envelope`, `timeout_bounded`), CON 3 (`output_schema_declared`, `list_paginates`, `manifest_matches_snapshot`) and INV 1 (`read_has_no_side_effect`).
  - Mutate checks for `records.create` and `records.delete`: DUP 5 each (`commit_requires_token`, `commit_rejects_expired`, `commit_is_idempotent`, `commit_rejects_other_principal`, `errors_use_envelope`) and BEH 1 each (`receipt_is_structured`: the provider's commit works on its example). `prepare_has_no_side_effect` is INV for both and `preview_is_semantic` CON for both.
    - For `records.create`, `targets_have_versions` and `commit_rejects_stale` are FILL: there are no targets, so one loops over nothing and the other is skipped, and both pass.
    - For `records.delete`, `commit_rejects_stale` is INV and `targets_have_versions` is CON.
  - Provider checks: `descriptions_operational` is CON. `deprecations_mirrored` is FILL: no tool is deprecated, so it asserts nothing.
- **`mcp.test.ts` (8): DUP 6, CON 1, BEH 1.**
  - CON: "2025: entitled clients see …" pins the reference server's tools and `_meta`.
  - BEH: "records_list pages 20 at a time …" (paging, unknown cursor, `limit` 101 and `records_show`). The acceptance does not test these.
  - DUP:
    - The 2026 copy.
    - "records_create … e2e_commit applies once" duplicates acceptance J4 and `commit.test.ts`.
    - "records_delete … e2e_commit_confirmed" duplicates acceptance J5.
    - "a record touched … makes the delete stale" duplicates acceptance J4 and the kit's `commit_rejects_stale`.
    - "the prompt and the resource" duplicates the acceptance's protocol journey.
    - "scopes filter the tools, and organisations never share records" duplicates the acceptance's two isolation journeys and `apps.test.ts` (no buttons for readers).
- **`records.test.ts` (4): DUP 2, INV 1, FILL 1.**
  - INV: "a cursor this organisation's list did not issue answers INVALID_INPUT", which is unique: another organisation's cursor.
  - DUP: "records stay within the caller's organisation" and "pages run oldest first", both held by `mcp.test.ts` closer to the caller.
  - FILL: "get reads one record, touch moves its version …", because `touch` serves only tests.
- **`apps.test.ts` (1):** BEH, unique: the view runs in Chromium through `AppBridge`.
- **`server.test.ts` (1):** BEH, unique: the acceptance calls `createMcpServer` directly, never `src/server.ts`.

### `mcps/example` (28 run + 3 todo): DUP 12, CON 10, FILL 3, INV 2, BEH 1

- **Conformance (21 + 3 todo).** The read and provider checks classify as for e2e: DUP 5, CON 4 (`output_schema_declared`, `list_paginates`, `manifest_matches_snapshot`, `descriptions_operational`), INV 1, FILL 1. The `notes.add` checks give INV 1, CON 1, DUP 5, BEH 1, and FILL 2 for the vacuous `targets_have_versions` and the skipped `commit_rejects_stale`.
- **Own tests.** The five tests the docs include (`#add-then-list`, `#refusal`, `#expiry`, `#policy-class`, `#confirmed`) are CON: the docs show them as working code. "each organisation reads its own notes, a page at a time" and "an unknown argument answers INVALID_INPUT naming the field" are not in the docs. They are DUP of `mcps/e2e/src/mcp.test.ts` and `server.test.ts` (probe M19 fails both).

### `scripts/mcp-new.test.ts` (19): BEH 10, CON 5, IMPL 3, INV 1

- **INV:** "a 12-character name works: … typecheck, lint and tests pass unchanged" (the scaffold's promise).
- **CON:**
  - "writes the workspace, and nothing else".
  - `package.json` pins.
  - `tsconfig`, `eslint` and `bunfig` are e2e's.
  - `.env.example`, whose port 47510 is in AGENTS.md.
  - "the README runs and tests the server", with its links checked.
- **IMPL:** the exact-text pins of `src/provider.ts`, `src/server.ts` and `src/provider.test.ts`. Any wording edit to the template fails them. The gate test proves the files work, and the docs render `<ScaffoldFile>` from the same template.
- **BEH:**
  - The six refused names and the existing-directory refusal.
  - "the new server starts from its .env.example and answers /health".
  - "prints the three commands".
  - "bun run mcp:new prints the refusal and exits 1".

## Mutation probes

Each probe made one edit, ran the listed suites (`packages/auth`, `packages/mcp`, `mcps/e2e`, `mcps/example`, `scripts`, `packages/mcp-postgres`, `packages/id-admin`, and for wider effect `mcps/toolbox` and `mcps/admin` on port 47435), recorded the failing tests and restored the file. Runner and outputs: scratchpad `audit-c/probe.ts`, `probes-*.txt`.

| # | Broke | Where | Failed | Verdict |
| --- | --- | --- | --- | --- |
| A1 | Drop the audience check | `packages/auth/src/index.ts:133` | auth "rejects audience …", mcp "rejects untrusted hosts, origins and a token for another audience" | Held |
| A2 | Drop `typ: "at+jwt"` | `index.ts:134` | auth "rejects the wrong type …" only | Held by one INV test |
| A3 | Drop the algorithm allow-list | `index.ts:133` | **nothing** | **Gap.** A script signing with published PS256, ES384 and RS512 keys: all refused as is, all **accepted** without the list; `alg: none` refused either way |
| A4 | Drop the issuer check in `jwtVerify` | `index.ts:133` | auth "rejects issuer …" | Held |
| A5 | Drop `azp = client_id` | `index.ts:137` | 2 auth tests | Held |
| A6 | Accept a `jwks_uri` on another origin | `index.ts:123` | auth "discovery rejects a different origin" | Held |
| A7 | Follow redirects during discovery | `index.ts:119` | **nothing** | **Gap** |
| A8 | Allow plain HTTP on any host | `index.ts:90` | 2 auth, mcp environment test | Held |
| A9 | Add `clockTolerance: 600` | `index.ts:134` | **nothing** | **Gap**: the expired-token row uses `exp: 1` (1970) |
| A10 | Accept any issuer in the metadata | `index.ts:121` | auth "discovery rejects a different issuer" | Held |
| A11 | Client token: drop `sub = client_id` | `index.ts:80` | 1 auth | Held |
| M1 | Drop the principal check at commit | `packages/mcp/src/commit.ts:90` | commit.test, kit self-test, `commit_rejects_other_principal` in demo (3), e2e (2), example (1), admin MCP (15) | Held (21 DUP copies) |
| M2 | Compare `user_id` only | `commit.ts:90` | commit.test "another person, membership or client …" only | Held by one INV test |
| M3 | Drop the commit-token check | `commit.ts:99` | commit.test, kit self-test, `commit_requires_token` ×21 | Held |
| M4 | Drop the authority recheck | `commit.ts:98` | commit.test, hub.test, admin MCP 1 | Held |
| M5 | Skip the version comparison | `commit.ts:47` | commit.test 2, kit 2, e2e 2, admin MCP 13 | Held |
| M6 | Skip the `preview_summary` check | `commit.ts:106` | commit.test, e2e, example, admin MCP | Held |
| M7 | Accept either commit tool | `commit.ts:101` | commit.test, Toolbox 1 | Held |
| M8 | Ignore a lost claim | `commit.ts:110` | commit.test "a commit that loses the claim …" only | **Caught only by an IMPL spy test** |
| M9 | Memory store never expires | `packages/mcp/src/intents.ts:76` | intents.test, commit.test, example, `commit_rejects_expired` ×21 | Held |
| M10 | Serve every tool whatever the scopes | `packages/mcp/src/server.ts:187` | 9 mcp, e2e 1 | Held |
| M11 | Serve prompts and resources unfiltered | `server.ts:282` | server.test ×2 | Held |
| M12 | Drop the Host check | `server.ts:303` | 3 mcp | Held |
| M13 | Drop the Origin check | `server.ts:310` | server.test "rejects untrusted hosts, origins …" only | Held by one INV test |
| M14 | Send output unfiltered | `server.ts:201` | 4 mcp, admin MCP 7 | Held |
| M15 | `validate_only` records anyway | `server.ts:210` | commit.test, hub.test, Toolbox 1 | Held |
| M16 | No timeout race | `packages/mcp/src/call.ts:35` | 3 mcp | Held |
| M17 | Let undeclared custom codes through | `call.ts:39` | declared.test ×2 only | Held |
| M18 | INTERNAL carries the exception text | `call.ts:103` | 5 mcp | Held |
| M19 | Drop `.strict()` on inputs | `packages/mcp/src/tool.ts:70` | 16 mcp, 3 e2e, 4 example, 4 Toolbox, 3 admin MCP, 3 scripts | Held (plus 13 conformance copies) |
| M20 | Commit tools for callers who can use no mutation | `server.ts:261` | 10 mcp, e2e 1, Toolbox 8, admin MCP 9 | Held |
| M21 | Store the raw commit token (`hashToken` = identity) | `packages/mcp/src/prepare.ts:21` | **nothing** in mcp, e2e, example, Toolbox, admin MCP, mcp-postgres | **Gap** (R21 "stored hashed") |
| M22 | Accept another provider's error prefix | `packages/mcp/src/provider.ts:63` | provider.test 1 | Held |
| M23 | `allow`'s ToolError answers only for a served name | `server.ts:227` | hub.test 1 | Held |
| S1 | Tool signal ignores the HTTP request signal | `server.ts:219` | **nothing**; "aborting the HTTP request aborts the tool context" still passes | **Our code is redundant**; the test holds an SDK fact |
| S2 | No keep-alive on listen streams | `server.ts:298` | **nothing** | **Gap** (low) |
| S3 | No cache hints | `server.ts:217` | server.test 1 | Held |
| S4 | No `Cache-Control: no-store` | `server.ts:316` | server.test 1 | Held |
| S5 | Never peek, so `called` is never true | `server.ts:313` | 3 mcp, 3 Toolbox, 6 admin MCP | Held |
| K1 | `read_has_no_side_effect` checks nothing | `packages/mcp/src/conformance.ts:113` | 4 kit self-tests; e2e, example, scaffold pass | Held by the kit's tests only |
| K2 | `commit_rejects_stale` always skips | `conformance.ts:165` | 2 kit self-tests; e2e, example, Toolbox, admin MCP pass | Held by the kit's tests only; a provider suite cannot tell a skip from a pass |
| K3 | `timeout_bounded` checks nothing | `conformance.ts:126` | its FILL self-test only | The check cannot fail for an SDK-built provider |
| K4 | `input_schema_is_closed` checks nothing | `conformance.ts:90` | its FILL self-test only | Same |
| P1 | Transition without compare-and-set | `packages/mcp-postgres/src/intents.ts:65` | 5 mcp-postgres | Held |
| P2 | No per-organisation lock in the evidence trigger | `migrations/0002_evidence.sql:67` | mcp-postgres "concurrent events …" only | Held by one INV test |
| P3 | Verify ignores `prev_hash` | `packages/mcp-postgres/src/evidence.ts:81` | **nothing** | **Gap**: the tamper test never recomputes a row hash, so the link check is never needed |
| P4 | Migrator without its advisory lock | `packages/mcp-postgres/src/migrate.ts:29` | **nothing** | **Gap** (concurrent replicas migrating) |
| P5 | Expiry ignores `expires_at` | `intents.ts:39` | 3 mcp-postgres | Held |
| I1 | No renewal after a 401 | `packages/id-admin/src/index.ts:107` | 4 id-admin, admin MCP 1 | Held |
| I2 | A new Idempotency-Key on the resend | `index.ts:120` | id-admin 1 only | Held by one INV test |
| I3 | No 30 s renewal margin | `index.ts:93` | id-admin 1 only | Held |
| I4 | `manage` with the read-only token | `index.ts:151` | 10 id-admin, 10 Toolbox, 45 admin MCP | Held |
| I5 | No 5 s timeout on admin calls | `index.ts:126` | **nothing** (id-admin, Toolbox, admin MCP) | **Gap** |
| I6 | No 5 s timeout on the token request | `index.ts:81` | **nothing** | **Gap** |

Ten probes were caught by nothing: A3, A7, A9, M21, S1, S2, P3, P4, I5 and I6. One was caught only by an IMPL test (M8). The Toolbox suite caught none of the commit-path probes M1 to M6, M8 or M9. It relies on the SDK's suite for those; the Toolbox's coverage is another area's to judge.

## Gaps

### The brief's questions

**1. What does `packages/auth` prove?**

| Property | Proved by | Probe |
| --- | --- | --- |
| Issuer match | "rejects issuer …", "discovery rejects a different issuer" | A4, A10 caught |
| Audience match, string | "rejects audience …"; mcp server test; acceptance "a second MCP at another URL refuses the token with 401" | A1 caught |
| Audience match, array | **Nothing**: no test signs an array `aud` | not probed |
| `typ` `at+jwt` | "rejects the wrong type …" | A2 caught |
| Expiry and `nbf` | `exp: 1` and `nbf` +1 h only; **no boundary, no skew** | A9 uncaught |
| `alg` allow-list | Acceptance of ES256 and RS256 only; **no refusal test** | A3 uncaught; the allow-list is load-bearing (script) |
| `kid` lookup, refresh on an unknown kid | "picks up a rotated key after the default JOSE cooldown", "cached keys survive an outage, but unseen keys fail" | — |
| JWKS fetch failure and caching | "concurrent verification fetches JWKS once", "failed discovery is retried" | — |
| User vs client subject | Four tests | A11 caught |
| Required claims | `sub`, `membership_id`, `organization_authorization_version`, `exp`, `iat`, `cnf`, `azp`, typed `upstream_auth_time` (optional by design). **Not tested on a user token:** missing `organization_id`, `grant_id`, `client_id`, `scope` (the client table covers `organization_id` and `client_id`) | — |
| Loopback vs HTTPS | Ten URL-rule tests and the loopback test | A8 caught |
| Metadata from RFC 8414 | "discovery inserts the well-known path before an issuer path" | — |
| Metadata from `.well-known/openid-configuration` | Not implemented: the verifier reads only RFC 8414 | — |
| Discovery redirects refused | **Nothing** | A7 uncaught |

The claims the verifier accepts are written by hand in the test issuer (`packages/auth/src/testing.ts`). Nothing in `apps/id` imports `@answerable/auth` (grep). Drift between the claims ID really issues and the verifier's schema is caught only by the Docker acceptance.

**2. The conformance kit.** Every check in docs/09's list is implemented except the three "Not yet" ones (`approval_bound_to_digest`, `secrets_declared`, `egress_guarded`). Those are registered as `todo`: 12 entries in this area.

`conformance.test.ts` proves each implemented check fails a bad provider. For ten checks the bad provider exists only as a hand-built object that bypasses the SDK (`withTools`, `withManifest`, five checks) or as a faked server answer (`intercept`, five checks). The table says, for an SDK-built provider:

| Check | Can it fail for an SDK-built provider? |
| --- | --- |
| `identity_is_stable`, `name_is_host_safe`, `input_schema_is_closed`, `timeout_bounded`, `deprecations_mirrored` | No. `defineProvider`/`defineTool` compute or refuse the same thing (K3 and K4 caught only by self-tests). `deprecations_mirrored` also passes vacuously when nothing is deprecated (e2e, example) |
| `errors_use_envelope` (read and mutate), `commit_requires_token`, `commit_rejects_expired`, `commit_is_idempotent`, `commit_rejects_other_principal` | Only if the SDK regresses, and then `commit.test.ts`/`server.test.ts` fail first (M1, M3, M9, M19). The kit uses its own memory store, never the provider's |
| `output_schema_declared` (R13 lint), `list_paginates`, `read_has_no_side_effect`, `manifest_matches_snapshot`, `prepare_has_no_side_effect`, `preview_is_semantic`, `targets_have_versions`, `commit_rejects_stale`, `receipt_is_structured`, `descriptions_operational` (prepare/intent word) | Yes. These are the kit's real value |

- **`commit_rejects_stale`** returns early, printing a log line, when the example prepares no targets. That happens for e2e `records.create`, example `notes.add` and demo `notes.create`/`notes.wipe`. The check then passes, so a provider's suite cannot see that it was skipped (K2).
- **The human class** is not covered by any provider's conformance run: high-risk mutations run as controlled (`kit.ts:41`).

docs/09 MUST rules marked `[SDK]` or `[conformance]` that have no enforcement, each shown by a run:

- **R8 [SDK]:** only closure is enforced. An undescribed free-string field is accepted (scratchpad `limits-experiment.test.ts`).
- **R10 [conformance]:** `list_paginates` checks field names only. A list with `limit` defaulting to 500 and no maximum passes, and so does one whose array is not called `items`.
- **R19 [SDK]:** "rechecking … policy" is not implemented. An intent prepared as agent was committed after `policyClass` turned `human`.
- **R21 [SDK]:** hashed storage is implemented but unproven (M21).
- **R24, R29, R32 [SDK]:** no code. Grep finds no operations, no egress client and no `Retry-After` in `packages/mcp/src`.
- **R33 and R35 [SDK]:** the 25 s and 55 s per-call limits and the execution id exist. The "10 s per upstream call" and the upstream correlation header have no code.
- **R37 [conformance]:** `manifest_matches_snapshot` detects drift only. `UPDATE_MANIFEST=1` rewrites a breaking change and passes (the self-test proves the rewrite).
- **R15 [hub]:** only the Toolbox applies the 100 KiB limit (`mcps/toolbox/src/toolbox.ts:26`). Standalone servers have none.

**3. Do `server`, `hub` and `commit` test the SDK rather than our code?** Mostly they test ours. Of the 23 SDK-side probes M1 to M23, 20 were caught in these three files (M17, M21 and M22 were not). Of their 57 tests:

- One holds with our code deleted: "aborting the HTTP request aborts the tool context" (probe S1).
- Three carry SDK-only assertions besides ours:
  - The 2025 half of the cache-hint test.
  - The 405 for GET and the 400 for bad JSON in hub "a ToolError from allow …".
  - Notification delivery in hub `toolsChanged`.
- Nine are protocol-era copies (8 in server, 1 in commit). They re-run the SDK's second transport over identical code of ours: every probe that failed one era failed both.

**4. The e2e server beyond conformance, and the reverse.**

What the in-process e2e tests prove that the acceptance does not:

- Paging through MCP: `limit` 101 refused, an unknown cursor, `records_show` paging.
- `_meta` per tool, including `anthropic/requiresUserInteraction` on `e2e_commit_confirmed`.
- That the text mirror equals the structured content.
- The Apps view in a real browser (`apps.test.ts`). The acceptance uses a placeholder view.
- The entry point `src/server.ts` (`server.test.ts`). The acceptance builds the server itself.
- Another organisation's cursor refused (`records.test.ts`).

Everything else in `mcp.test.ts` is in acceptance J4, J5 or the isolation journeys.

What only the acceptance proves:

- That the verifier accepts tokens real ID issues (claims, `typ`, keys).
- The 60 s token lifetime.
- The audience refused by a second MCP over real HTTP.
- SDK refresh and rotation.
- That a disabled organisation stops refresh while issued tokens keep working.
- Browser sign-in.

**5. Does the scaffold test prove its gates?** Yes, apart from installation and Turbo. "a 12-character name works …" runs `test` with `UPDATE_MANIFEST=1`, then `typecheck`, `lint` and `test` in the scaffolded workspace, and checks the manifest. It symlinks `mcps/e2e/node_modules` instead of running `bun install`, and it does not run Turbo's `mcp:check`. The quickstart's end state is `mcps/example`: scaffolding `example` into a temporary root gives byte-identical `.env.example`, `bunfig.toml`, `eslint.config.mjs`, `tsconfig.json` and `src/server.ts` (scratchpad `scaffold-diff.ts`). `package.json` differs only by an `exports` entry that nothing imports. Together the two cover the quickstart.

**6. How faithful is the fake ID?** It is a reasonable model of the happy paths the consumers use. Where it matches real ID:

- ETag format `"id:revision"` (`apps/id/src/http/admin/revision.ts:5`).
- `412 revision_mismatch` and `400 invalid_revision`.
- Idempotency fingerprinting with `409 idempotency_key_reused`.
- `Idempotency-Replayed` and `Operation-Id` headers.
- 401 then renewal.
- A problem `503 database_busy`.

Divergences, each shown by running the fake (scratchpad `fake-experiment.ts`, `fake-routes.ts`) against grep of `apps/id`:

| Behaviour | Fake | Real ID |
| --- | --- | --- |
| Client timeouts | Ignores `AbortSignal`: with `slow(6000)` a call answered after 6,001 ms despite the client's 5 s timeout | Honoured |
| Same key, concurrent | One applies, the other `409 conflict` (slug) | `409 operation_in_progress`, retryable (`services/operations.ts`) |
| Replay of a no-change write | `outcome: "applied"`, `resultReference.type: "organizations"` | `outcome: "noop"`, `type: "organization"` |
| `503 database_busy` | No `Retry-After` | `Retry-After: 1` (`http/problem.ts:40`) |
| 401 | `{"code":"invalid_token"}`, no `WWW-Authenticate` | Problem document with `WWW-Authenticate: Bearer error="invalid_token"` |
| Member access without a grant | 404 | `{ effective, targets: [] }` for an existing member |
| Unsupported methods | `DELETE /organizations/{id}` and `DELETE /resources/{id}` act as PATCH; `PATCH`/`DELETE …/members/{id}` and `DELETE …/sso-provider` return the GET body, all 200 | Different commands |
| Coverage of the contract | Routes 39 of the 81 operations in `openapi.admin.json`; nothing validates its answers against that file | — |

- **What the consumers rely on that real ID lacks:** nothing found. The admin MCP reads only `resultReference.id`, and both consumers treat a 404 access view as no grants.
- **What real ID has that the fake lacks:** `409 operation_in_progress` and the timeouts. `mcps/admin/src/calls.ts` maps any non-5xx refusal to `UPSTREAM_REJECTED`, so a retryable in-progress answer would be reported as final. No test can show it, because the fake never sends one.

**7. Are `build`, `environment`, `reference` and `declared` FILL?**

- `build.test.ts`: one of three (the bare `toThrow()`).
- `environment.test.ts`: none. Its operator-facing messages are unique.
- `reference.test.ts`: none. The drift check is CON; the generator also throws for an export without a comment.
- `declared.test.ts`: none. It holds the only catch of probe M17.

### What nothing proves

| Gap | Worth a test? | What it would assert |
| --- | --- | --- |
| JWT algorithm allow-list (A3) | Yes | A token signed with a published PS256 or ES384 key is refused |
| Expiry boundary and skew (A9) | Yes | A token with `exp = now − 1` is refused and `exp = now + 5` accepted: zero tolerance, documented |
| Discovery redirect (A7) | Yes, one line | Metadata answering 302 fails verification |
| Commit tokens stored hashed (M21) | Yes | The stored `commit_token_hash` is the SHA-256 of the returned token and differs from it |
| Double commit under concurrency (M8) | Yes; replaces the spy test | Two concurrent commits of one intent apply once: one receipt, one `COMMIT_IN_PROGRESS` or replay |
| R19 policy recheck | Decide first (implement or change the rule) | After the class changes, an older intent answers `APPROVAL_REQUIRED` |
| JSON-RPC batch and `called` | Yes | A batched `tools/call` of a hidden tool reaches `allow` with `called = true`, or batches are refused. Run: today `called` is false |
| Evidence chain link (P3) | Yes | Rewriting a row with a recomputed `row_hash` breaks `verify` at the next row |
| Concurrent migrators (P4) | Yes | Two `migrate()` on a fresh schema at once: each file applied once, both succeed |
| ID client timeouts (I5, I6) | Yes, once the fake honours signals or the timeout is injectable | A slow ID answers `IdError` status 0 within the timeout |
| Memory store growth | Yes, after a fix | Expired and committed intents leave the store. Today nothing deletes them (grep: no `delete` in `intents.ts`), and it is the default for e2e, example and every scaffolded server |
| Real ID claims vs the verifier | Yes, in ID's own integration suite | A token ID issues passes `createIdVerifier`, so claim drift is caught without Docker |
| Keep-alive on listen streams (S2) | Low | A listen stream survives 12 s of silence on `Bun.serve` |
| Oversized requests | No | The SDK refuses bodies above 4 MiB with 413 (run); per-field limits are the author's (R39 review) |
| Rate limits, budgets | Not in this area | docs/08 puts them in the hub; standalone servers have none |

## Dead and test-only code

- **`AbortSignal.any([signal, requestInfo.signal])`** in `packages/mcp/src/server.ts:219`. Probe S1: removing it changes no test. The SDK's request signal already aborts on a dropped connection.
- **`exports: { "./provider" }`** in `mcps/example/package.json`. Grep finds no importer of `@answerable/mcp-example`.
- **Conformance checks the SDK makes unfailable** (11, listed under question 2), with five FILL self-tests whose bad providers are hand-built objects. docs testing.mdx justifies them by "providers built by other means, such as the hub's adapters". docs/08 lists adapters as Not yet.
- **The demo provider's registration** at `conformance.test.ts:108` (41 tests). Its only purpose is covering `register` and `assertProviderConformance` (grep: the only call in the package).
- **`RecordStore.touch`** (`mcps/e2e/src/records.ts`). Used only by tests: the kit's `moveTarget`, the acceptance and `records.test.ts`.
- **`TestIssuer.rotate`, `outage`, `jwksRequests`.** Public in `@answerable/auth/testing`, used only by `packages/auth`'s own tests (grep).
- **`IdVerifierConfig.fetch`.** No production caller sets it. docs/07 says it exists for the in-process issuer; that is justified, but it is a test-only knob.
- **The fake ID** (`packages/id-admin/src/testing.ts`, 464 lines). It is larger than the client it serves (166 lines) and is excluded from coverage. Only two tests check it, and one pins a divergence from ID.
- **Twelve `test.todo` registrations** for Not yet checks. They pass silently and say nothing the docs do not.

## Simplifications

- **Conformance kit (`packages/mcp/src/conformance.ts`).**
  - Keep the ten checks that can fail for a real provider.
  - Make `commit_rejects_stale` and `targets_have_versions` say "not applicable" instead of passing when a mutation has no targets.
  - Drop the `todo` registrations.
  - This removes about 140 lines across `conformance.ts` and `conformance.test.ts`, and two rows per check from docs/09 and testing.mdx.
- **Protocol eras.** One 2026-07-28 smoke test (list, call, refusal) instead of nine copies. The nine measured 283 ms with load.
- **`conformance.test.ts` line 108.** Register a one-read-tool provider, which still covers `register`. The demo block measured 344 ms with load.
- **`scripts/mcp-new.test.ts`.** Delete the three exact-text template pins (about 55 lines); the gate test and `<ScaffoldFile>` hold the files.
- **`mutation.test.ts`.** Fold the two `checkShared` repeats into `tool.test.ts` as one row each.
- **Fake ID.**
  - Answer 405 for methods it does not implement.
  - Honour `AbortSignal`.
  - Return ID's singular `resultReference.type`, `outcome: "noop"` and `Retry-After`.
  - Add `operation_in_progress`.
  - Better still, validate every fake answer against `apps/id/openapi.admin.json` in one table-driven test, and delete the two fake-specific tests.
- **docs/09.**
  - Mark R24, R29, R30, R32 and the upstream parts of R33 and R35 as Not yet.
  - Restate R8 and R10 as what the SDK and kit check.
  - Restate R37 as drift detection.
  - Settle R19 (policy recheck).

## Recommendations

### Delete

Measured effects only where stated. "Coverage held" means I ran the suite without the file and it stayed at 100%.

1. **Eleven SDK-duplicating checks from the kit, with their self-tests:** `identity_is_stable`, `name_is_host_safe`, `input_schema_is_closed`, `timeout_bounded`, `deprecations_mirrored`, `errors_use_envelope` ×2, `commit_requires_token`, `commit_rejects_expired`, `commit_is_idempotent`, `commit_rejects_other_principal`.
   - **Here:** −48 registered tests (demo 21, e2e 16, example 11) and −9 self-tests. Keep `errorOf`'s envelope cases.
   - **Elsewhere:** −81 in the admin MCP and −6 per scaffolded server.
   - **Why it is safe:** M1, M3, M9 and M19 show `commit.test.ts`, `tool.test.ts` and `server.test.ts` catch every regression these checks would.
2. **The demo provider's 41 registered checks** (`conformance.test.ts:108`). Replace them with a one-tool provider: −36 tests net, about 0.25 s.
3. **Eight of the nine 2026-07-28 copies** (`server.test.ts`, `commit.test.ts`): −8 tests.
4. **`packages/mcp/src/testing.test.ts`:** −6 tests, 97 lines. Coverage held: 100% without it.
5. **`mcps/e2e/src/mcp.test.ts`:** the 2026 copy and the four mutation, prompt and isolation tests (−5). **`records.test.ts`:** all but the cross-organisation cursor test (−3); coverage held at 100% without the file.
6. **`mcps/example`:** the two tests the docs do not include (−2).
7. **Single duplicates:**
   - `mutation.test.ts` ×2.
   - `server.test.ts` "server info".
   - `migrate.test.ts` "a fresh schema …".
   - `auth` "a rejection says only …".
   - `id-admin` "renewed once for manage too" and "name both scopes".
   - −8 tests in all.
8. **`scripts/mcp-new.test.ts`:** the three template pins (−3).
9. **Code:** the redundant signal combination (`server.ts:219`) and the unused `exports` in `mcps/example/package.json`.

Total: about 105 of the 360 tests in this area, and 12 `todo` entries. Time saved is under 1 s of 10.6 to 10.8 s; the cost is in three files that earn it:

- the scaffold gate, 2.8 s;
- the Chromium view, 1.9 to 2.6 s;
- the reference drift check, 1.7 to 1.9 s.

No probe in this audit is caught only by a test on this list. Re-run the coverage gate after items 1, 2, 3 and 7, which I did not run.

### Simplify

10. The fake ID changes listed above. The first step is an `openapi.admin.json` contract test.
11. Vacuous kit checks report "not applicable" instead of passing.
12. docs/09 states what is enforced; R19 is decided.

### Add

Each is a few lines in an existing file.

13. **`packages/auth/src/index.test.ts`:**
    - A PS256 token from a published key is refused (A3).
    - The `exp` boundary (A9).
    - A redirected discovery fails (A7).
    - A user token without `organization_id`, `grant_id`, `client_id` or `scope` is refused.
14. **`commit.test.ts`:**
    - The stored hash is not the token (M21).
    - Two concurrent commits apply once. This replaces the spy test (M8).
15. **`hub.test.ts`:** a batched `tools/call` is seen as called, or refused.
16. **`evidence.test.ts`:** a recomputed rewrite breaks the chain at the next row (P3). **`migrate.test.ts`:** concurrent migrators (P4).
17. **`packages/id-admin`:** the 5 s timeouts (I5, I6), after the fake honours abort signals.
18. **Memory intent store:** evict expired and settled intents, then test it; or make the scaffold pass a Postgres store.
19. **`apps/id` integration suite:** verify a real issued access token with `createIdVerifier`, so the claim contract is held without Docker.
