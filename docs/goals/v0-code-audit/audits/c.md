# Audit C: shell, operations, pages, scripts, packages and docs

Auditor C, 20 October 2026, worktree `agent-aeb2610506c643d2c` at main `60c98f65`, Postgres `audit-pg-d` (47436). Probes and logs: `/tmp/v0-code-audit/probes/c/`, numbered below. Nothing was fixed; every spike was reverted (`git status` clean at the end).

## 1. Scope and method

**Files read in full (non-test lines).** `src/server.ts` 18, `runtime.ts` 87, `env.ts` 273, `app.ts` 227, `lib/id.ts` 3, `log.ts` 15, `scopes.ts` 9, `user-agent.ts` 6, `operations/metrics.ts` 75, `preflight.ts` 84, `protocol-sweep.ts` 100; `http/pages/**` 1,189 (index 87, gateway 68, login-routing 30, error-copy 112, routes 372, views 432, ui 72, styles.css 12, assets.d.ts 4), the font (26,636 bytes) and its licence; `scripts/build-css.ts` 10, `export-openapi.ts` 37, `mcp-e2e-fixture.ts` 167, `operations-preflight.ts` 39, `stack-directories.ts` 83, `migrate.ts` 31; `Dockerfile` 43, `bunfig.toml` 10, `eslint.config.mjs` 30, `tsconfig.json` 19, `package.json` 48; `default.env` and `.env.example` (ID's lines); `packages/auth/src/index.ts` 152, `testing.ts` 90; `packages/id-admin/src/index.ts` 191, `testing.ts` 568; `apps/id/README.md` 105, `OPERATIONS.md` 137, `docs/03` 159, `docs/05` 123, `docs/06` 193. The tests that hold a finding were read where they bear on it: `env.test.ts`, `runtime.test.ts`, `protocol-sweep.integration.test.ts`, `openapi.integration.test.ts`, the stylesheet test in `pages.test.ts`, `__tests__/admin.ts`, `access.integration.test.ts`, and the Toolbox's `grants.test.ts` and `test/hub.ts`. The other page tests (about 1,200 lines) were skimmed, not read line by line.

**Read by a delegated reader (Sonnet), then spot-checked by me.** The 11 reports that exist (1,884 lines) and `apps/web/content/docs/id/**` (1,798 lines). I re-checked these claims myself:
- RLS is on 10 tables.
- `deleted_at` is on 15 tables.
- There are 80 operations and 48 mutations.
- No `oauth.user.replayed` event exists.
- `schema_version` is checked equal to 1.
- `staging-evidence.md` does not exist.

**Consumers and deployment read.** `charts/answerable` (values, `_server.tpl`, `id.yaml`, migrations), `charts/platform/values.yaml`, `infra/README.md` (restore and break glass), `infra/k8s/local/stack.ts` (ID's Secret), `infra/pipeline/src/deploy.ts` (id-env), `packages/acceptance/src/id.ts` and its journeys, `mcps/toolbox/src/grants.ts`, and `mcps/admin` tool names.

**Installed sources read.**
- `better-auth` 1.7.2:
  - `dist/plugins/jwt/sign.mjs:25-66`: signing decrypts only the newest live key. A failed decryption throws `"Failed to decrypt private key"`; it never re-mints the key.
  - `dist/plugins/jwt/adapter.mjs:9-54`: latest key by `createdAt`.
- `hono-tailwind` 3.0.1, `dist/index.js:27-67`. With `out` set, every request reads the file and SHA-1 hashes it. The module statically imports `postcss` and `@tailwindcss/postcss`.
- `hono-openapi` 1.3.1: `dist/index.js:2` statically imports `@hono/standard-validator`, and `peerDependenciesMeta` marks that peer optional.

**Probes.** Each is listed with its command and its result.

| # | Command | Result |
|---|---|---|
| 01 | `bun test --timeout 15000` in `apps/id` | 1,558 pass, 0 fail, 133 files, 100% lines and functions, 511 s (on a machine shared with four audits) |
| 02 | `02-metrics-cost.test.ts` | `begin`/`finish` costs 340 ns. `/healthz` in process takes 6.25 µs without metrics and 6.63 µs with them (medians of 5 × 20,000) |
| 03a | today's bundle copied outside the repo, `03-run-bundle.sh` | Does not start: `ENOENT while resolving package 'postcss' from ~/.bun/install/cache/hono-tailwind…`. Bun auto-installed `hono-tailwind` from the registry at run time |
| 03b | spike bundle (`03-pages-spike.diff`), same script | Starts and bootstraps. `/healthz`, `/readyz`, `/login`, `/assets/tailwind.css` (42,831 B), the font (26,636 B) and discovery all answer 200, with no `node_modules` |
| 03c | `03c-rss.sh`, both bundles with `node_modules` reachable, three runs | RSS is 154.4, 154.4 and 155.3 MB today, against 139.2, 138.5 and 137.2 MB for the spike |
| 03e | page and ingress tests, typecheck and lint on the spike | 45 pass. Typecheck and lint are clean. The prebuilt-file branch (`index.ts:70-75`) is uncovered |
| 04 | `04-install-size.sh`: the Dockerfile's `--production --filter @answerable/id` install, as today and with `hono-tailwind` and `tailwindcss` as devDependencies | 96,848 KB (99 packages) → 79,392 KB (75). The 24 packages that go include two native binaries (`@tailwindcss/oxide`, `lightningcss`) |
| 05 | `05-bundled-migrate.sh`: `bun build scripts/migrate.ts scripts/operations-preflight.ts` into `dist/scripts/`, run from `img/apps/id` with no `node_modules` against a fresh database | Migrates, migrates again with nothing to apply, and writes 2 receipts. `../../drizzle` resolves to `apps/id/drizzle` |
| 05b | the bundled preflight, same tree | Runs and prints `custody_preflight_failed` (no key yet), as expected |
| 06 | `06-wrong-secret.sh probe-base2` (today's code) | With the wrong `BETTER_AUTH_SECRET`, the replica starts, `/readyz` is 200 and `/auth/jwks` is 200. Only the manual preflight fails |
| 06b | the same with `06b-startup-check.diff` (decrypt the newest JWKS row before `Bun.serve`) | With the right secret, ready. With the wrong secret, the process exits: `The configured application secrets cannot decrypt the newest signing key` |
| 06c | runtime tests on that spike | 6 pass, 3 fail. The failing tests use the stub database and auth and would need a seam |
| 07 | `07-sweep-race.test.ts`: two pools as two replicas, 200,000 expired rows, batch 1,000, `lock_timeout` 2 s | With the lock: 1,333, 1,502 and 1,421 ms. Without the lock: 1,369, 1,370 and 1,636 ms. No error and no deadlock in either case. The losing sweep deleted 0 rows in its first batch and stopped |
| 08 | env spike (`08-env-constants.diff`, `08b-…`): 13 variables become constants and the production URL default goes | Typecheck clean. Across `env`, `runtime`, `app`, `bootstrap`, `statement-timeout` and `openapi`, only 5 tests fail, all in `env.test.ts`, and each tests the variable itself. `env.ts` loses 45 lines and gains 22 |
| 09 | `09-mcp-suites.sh`, three runs | Toolbox: 81 tests, 14 files, 3.8–4.2 s. Admin MCP: 129 tests (123 pass, 6 skipped), 8 files, 5.2–6.3 s |
| 10 | `10-real-id-grants.test.ts`: one `grants.test.ts` test against a real in-process ID (`createAdminFixture`) | Passes. The fixture takes 769–955 ms and the test 80–96 ms; the file takes 1.26–1.59 s. The fake's whole `grants.test.ts` (9 tests) takes 97–109 ms. It needed `jsxImportSource: hono/jsx` in the Toolbox's tsconfig (`react/jsx-dev-runtime` otherwise) |
| 11 | `11-fake-drift.test.ts`: the same 37 admin calls against the fake and real ID | Statuses match on 36 of 37 (the 37th asks for a resource the fake was not seeded with). Problem codes match except on 403: the fake says `forbidden`, real ID says `insufficient_scope` with `WWW-Authenticate`. Fields: the fake's organisation, domain and group rows lack `deletedAt` and `live`, and its problems lack `detail` (409) and `errors` (400). 25 field-level differences in all |
| 12 | `UPDATE_SNAPSHOT=1 bun test src/openapi.integration.test.ts` with a 2-line spike (`12-openapi-snapshot.diff`) | 2 pass. `git diff` of both snapshots is empty, so the output is byte-identical to `export-openapi.ts` |
| 13 | `13-dependency-importers.sh` | Every dependency has an importer except `@hono/standard-validator` and `tailwindcss`. The first is a static import of `hono-openapi`, which ID's `validator` uses. The second is imported by `packages/ui` `globals.css` and is the peer of `hono-tailwind` |
| 14 | `14-error-copy-codes.sh` | All 24 codes in `error-copy.ts` have an emitter in `src` or in the Better Auth plugins |
| 15 | `count.py` over the five service docs | Sentences, then regex hedges and Not-yet phrases: README 155/4/0, OPERATIONS 115/5/0, docs/03 168/7/7, docs/05 151/11/2, docs/06 143/2/4. The regex is a lower bound; the manual list is in §4 and §3-Q |
| 16 | `buildCss` with `@source not` over `packages/ui/src/components` | 42,831 B (gzip 7,755) → 28,257 B (gzip 5,653) |
| — | `npm view` | No pending major. Minor and 0.x updates: `hono-openapi` 1.3.1→1.5.0, `@hono/standard-validator` 0.2.2→0.4.0, `hono` 4.13.5→4.13.13, `better-auth` 1.7.2→1.7.11, `pg` 8.16.3→8.23.1, `drizzle-orm` 0.45.2→0.45.4 |

## 2. Verdict table

| id | Mechanism | Files | Verdict | Lines | Consumer or threat | Evidence | What holds after |
|---|---|---|---|---|---|---|---|
| C1 | Operational summaries | `operations/metrics.ts`, `app.ts:71-76`, `runtime.ts:62-70` | **keep**; its interval becomes a constant (C4) | 75 + 86 test | `kubectl logs` (docs/12:179). It is the only signal of pool waiters and per-class 503s; no metrics agent exists (docs/12:184) | P02: 0.34 µs per request | `metrics.test.ts` |
| C2 | Custody preflight | `operations/preflight.ts`, `scripts/operations-preflight.ts` | **simplify**: add a startup check that decrypts the newest JWKS row before listening. Delete the preflight's signing-key half. Delete the whole preflight if A-4 removes upstream token storage | −84 −39 −88 test; +~15 and a test | Restore runbook step 2 (`infra/README.md:183`). Threat: a wrong application secret | P06, P06b, `sign.mjs:55-66` | the new runtime integration test |
| C3 | Protocol sweep lock, batch, interval | `operations/protocol-sweep.ts` | **keep** the lock. **Simplify** `PROTOCOL_SWEEP_INTERVAL_MS` and `_BATCH` to constants | 2 variables | The lock turns a row-lock wait (up to one batch) into a clean skip, so a slow batch never logs a false `protocol_sweep_failed` with 55P03 | P07 | `protocol-sweep.integration.test.ts` |
| C4 | Unset environment variables | `env.ts`, `default.env`, `.env.example`, docs/06:91, README:17 | **simplify**: 13 variables become constants (list in §3) and the production default of `BETTER_AUTH_URL` goes. 30 variables become 17 | env.ts −23 net, env.test about −85, default.env −13, .env.example about −20 | Nothing deployed sets them (chart, stack.ts, deploy.ts). Every value change already needs a tag, so a variable with one value everywhere is a constant | P08 | the remaining env tests |
| C5 | Startup and shutdown order | `runtime.ts`, `server.ts` | **keep** | 105 | Real constraints: role check, then bootstrap, then listen. `server.stop()` drains in-flight requests. `preStop: sleep 5` is in `_server.tpl:108-114` | P06 (bootstrap before listen) | `runtime.test.ts` |
| C6 | `hono-tailwind` at runtime | `pages/index.ts`, `package.json`, the build script | **simplify**: serve the prebuilt file. `hono-tailwind` and `tailwindcss` move to devDependencies; `--external` goes | about ±10 in index.ts; 2 dependencies; docs/06:119 | none at runtime | P03a/b/c, P04 | page tests, plus a test for the file branch |
| C6b | `gateway.ts`, `login-routing.ts`, `error-copy.ts`, `lib/user-agent.ts`, the font | pages, lib | **keep** | — | Every page needs them. `?organization=` is documented (sign-in.mdx:8). All 24 error codes are emitted. `user-agent.ts` is not a parser: it bounds audit columns (`principal.ts`, `actor.ts`, `sso-origin.ts`, `signin-audit.ts`). The font is one 26.6 KB variable file | P14 | page tests |
| C6c | Stylesheet scans every `packages/ui` component | `packages/ui/src/styles/globals.css:6` | **optimise** (low) | 1 line | none | P16: −34% | page tests |
| C7 | `mcp-e2e-fixture.ts`, `stack-directories.ts` | `apps/id/scripts` | **keep** where they are | 250 | `packages/acceptance/src/id.ts:84`, `infra/k8s/local/stack.ts:150`. The fixture must run under ID's tsconfig (JSX); it still starts the issuers and ID, and provisions nothing else | P10 (the JSX failure) | the acceptance |
| C8 | `export-openapi.ts` | scripts, package.json | **simplify**: the snapshot test writes the files under `UPDATE_SNAPSHOT=1`, the way `UPDATE_MANIFEST=1` works | −37 +2; AGENTS.md 2 lines, README 1 | one mechanism in the repo, not two | P12 | `openapi.integration.test.ts` |
| C9 | `@answerable/auth` | `packages/auth/src` | **keep** | 152 + 90 | It adds to `jwtVerify`: discovery with a same-origin `jwks_uri`, an HTTPS/loopback check, the claim schemas, the subject-kind split, `cnf: never` (DPoP refused, `Q-DPOP-HALF-BUILT`) and `azp == client_id`. `testing.ts` is used by `packages/mcp/src/test-mcp.ts` | — | `index.test.ts`, ID's `user-oauth.integration.test.ts` |
| C10 | The fake ID | `packages/id-admin/src/testing.ts` | **keep**; fix its drift | 568 | Toolbox and admin MCP unit tests. All its controls are used (`outage`, `unreachable`, `slow`, `failWrite`, `revise`, `operationInProgress`…). Real ID cannot make a member without an SSO sign-in, and shares `answerable_id_test` | P09, P10, P11 | the acceptance covers all 23 admin MCP tools against real ID |
| C11 | Image carries `src`, `scripts` and `node_modules` for the migration | `Dockerfile:32-36`, `charts/answerable/templates/migrations.yaml:63` | **simplify**: bundle `migrate.ts` and `operations-preflight.ts` into `dist/scripts`; the final stage copies `dist` and `drizzle` only | Dockerfile −3 lines; chart command | Today the image also carries two test scripts that cannot run there (their `__tests__` imports are excluded by `.dockerignore`) | P05, P05b | `migrate-script.integration.test.ts` (source); the kind stack (`infra:test`) |
| C12 | Docs and reports | README, OPERATIONS, docs/03/05/06, `reports/` | **simplify**: delete 4 changelog reports, trim 3, fix 10 false statements, remove 3 duplicated passages | about −400 report lines; about −60 doc lines | a second engineer needs the README, the runbook and four evidence reports | §3-Q, §4 | `bun --filter web test` link check (web only) |

## 3. Findings in detail

### C2: custody preflight → a startup check

**Evidence.**
- P06: with today's code and a wrong `BETTER_AUTH_SECRET`, the replica starts and `/readyz` and `/auth/jwks` both answer 200.
- So the brief's premise that "GET /auth/jwks proves decryption" is false. JWKS publishes public keys only.
- Better Auth decrypts only the newest live key, at signing (`sign.mjs:55-66`). A failure throws; it never re-mints.
- Retired keys are only ever used through their public half, so the preflight's decrypt of every row checks material nothing will decrypt again.

**Proposal.**
- In `startRuntime`, after `authFactory` and before `Bun.serve`, decrypt the newest `jwks` row with `(await auth.$context).secretConfig`. Skip the check when there is none.
- Refuse to start on failure, as P06b shows.
- With `maxUnavailable: 0` and the startup probe, a wrong secret then never rolls out: the old pods keep serving.
- Delete the signing half of `checkKeyCustody`.
- If audit A's A-4 removes upstream token storage, delete `preflight.ts`, `scripts/operations-preflight.ts`, `preflight.integration.test.ts`, the `ops:preflight` script, OPERATIONS.md's "Deliver and check keys" (about 25 lines) and `infra/README.md` restore step 2.
- If A-4 keeps upstream token storage, the preflight remains for the account half only.

**What a user would notice.**
- Nothing, unless a secret is wrong.
- Today a wrong secret becomes 500s on every token issuance, plus sign-outs for cookies signed under the old secret.
- With the change, the deploy fails instead.

**Change needed.** About 15 lines, a seam or an integration test for `runtime.ts` (P06c: the three stub-based runtime tests fail), and the runbook line.

**Risk.** One extra query at boot. A database with no key yet passes.

### C4: environment variables

These 13 variables become constants. None is set by the chart, `stack.ts` or `deploy.ts`, and P08 shows only their own `env.test` cases fail:

| Variable | Constant | Note |
|---|---|---|
| `OPERATIONAL_LOG_INTERVAL_MS` | 30 s | |
| `PROTOCOL_SWEEP_INTERVAL_MS` | 60 s | |
| `PROTOCOL_SWEEP_BATCH` | 1,000 | |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | 10,000 | |
| `DATABASE_CONNECTION_TIMEOUT_MS` | 5,000 | |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 10,000 | |
| `DATABASE_LOCK_TIMEOUT_MS` | 2,000 | |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 15,000 | |
| `OPENAPI_ENABLED` | on outside production | |
| `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS` | 0 | `Q-REFRESH-PARALLEL` changes the constant if it ever resolves; a variable changes nothing about the release path |
| `PLATFORM_ORGANIZATION_SLUG` | `answerable` | The chart sets it to its default |
| `PLATFORM_ORGANIZATION_NAME` | `Answerable` | The chart sets it to its default; drop the chart value too |
| `ADMIN_RESOURCE_IDENTIFIER` | always `${BETTER_AUTH_URL}/api/admin` | |

The `Environment` fields the tests set (`databaseLockTimeoutMs`, `oauthRefreshReuseIntervalSeconds`, …) stay as fields, so no test seam is lost.

**Also delete** the production default `https://id.answerable.org` for `BETTER_AUTH_URL` (`env.ts:259-264`).
- The chart always sets the variable.
- The default only lets a mis-set staging pod name production's issuer.

**Keep:**
- `PORT`.
- `DATABASE_POOL_MAX`: the sizing knob in docs/06's formula; the database sizes may differ by environment (owner question 3).
- The secrets, the platform application pairs, the origins, `TRUSTED_PROXY_CIDRS` and `ROOT_ADMIN_BREAK_GLASS`.

**What users notice.** Nothing.

**Risk.** An operator can no longer tune a timeout without a release, but every value change is already a release.

### C6: `hono-tailwind` out of the runtime (C30, deferred twice)

**Evidence.**
- P03a: today's bundle cannot run without `node_modules`, and Bun even tried to auto-install from the registry.
- P03b: the spike runs with none.
- P03c: 16 MB less RSS per replica (about 10%).
- P04: 17.5 MB and 24 packages less in the production install, two of them native.
- Today, every request for the stylesheet re-reads it and SHA-1 hashes it (`hono-tailwind/dist/index.js:43-47`).

**Proposal.**
- Always serve the prebuilt file. `build-css` writes it, and the `dev` and `test` scripts build it first.
- Do not keep the spike's lazy `import("hono-tailwind")` fallback. In a tree without `node_modules`, a fallback would trigger Bun's auto-install from a production pod, whose NetworkPolicy allows public HTTPS. One path also keeps 100% coverage.
- Move `hono-tailwind` and `tailwindcss` to devDependencies, drop `--external hono-tailwind`, and delete docs/06:119.

**Users** notice nothing; the stylesheet is the same 42,831 bytes.

**Test afterwards:** `pages.test.ts`'s asset test, plus P03b in the kind stack.

### C8: OpenAPI export into the snapshot test

P12 proves the output is byte-identical.
- Delete `scripts/export-openapi.ts` (37 lines, and it imports `src/__tests__/support.ts` from a script) and the `openapi:export` script.
- Add two lines to the test.
- Change AGENTS.md lines 7 and 58, README:11 and the test's failure message to `UPDATE_SNAPSHOT=1 bun test src/openapi.integration.test.ts`.
- Turborepo strips the variable, as it does for manifests, so run it in the workspace.

### C11: a final image without `node_modules`

P05 shows the bundled migration runs with no `node_modules` from `apps/id/dist/scripts/migrate.js`, and resolves `../../drizzle` correctly.

**Proposal.**
- Build `server.ts`, `scripts/migrate.ts` and `scripts/operations-preflight.ts` (if it survives C2).
- The final stage copies `apps/id/dist` and `apps/id/drizzle`.
- Drop the `dependencies` stage, `COPY apps/id/src` and `COPY apps/id/scripts`.
- The chart's migration command becomes `bun apps/id/dist/scripts/migrate.js`.
- Expected image saving: about 80 MB of `node_modules` (P04, measured on darwin-arm64; I did not build the Linux image).
- The two test scripts that cannot run in the image disappear with it.

**Risk.** The migration path is proved only by the kind stack; run `infra:test`.

### C10: the fake ID is a second contract, kept

**Who uses it.** 14 Toolbox and admin MCP test files, every control it exports, about 200 tests in about 10 s (P09).

**Could they run against real ID?** P10 says yes, but:
- About 0.8 s of fixture per file, against about 0.1 s for a whole file today.
- The suites would share `answerable_id_test`, which AGENTS.md forbids for concurrent `mcp:test` (each would need its own database).
- Members need an SSO sign-in through a test issuer.
- The tsconfig needs `hono/jsx`.
- Outage, slow, unreachable, `failWrite` and `operationInProgress` would need fetch wrappers.
- All 23 admin MCP tools already run against real ID in `admin.journeys.test.ts`.

**Drift (P11).**
- Statuses and codes match on the 36 comparable calls, except 403.
- Rows lack `deletedAt` and `live`.
- Problems lack `detail` and `errors`.
- No consumer branches on these today. The only code checks are `status === 412` (`mcps/admin/src/calls.ts:77`) and `reauthenticationRequired`.

**Proposal.**
- Fix the 403 code and header, and the row fields, so that line 1's claim "Shapes follow `openapi.admin.json`" is true.
- Optionally keep P11 as a test in `packages/acceptance` so that drift fails a gate. That adds code; the owner decides.

### C12 (Q): documentation

**What a second engineer needs.**
- `apps/id/README.md`: the service, configuration, local run, migrations, rotation.
- `infra/README.md`: the runbook.
- `OPERATIONS.md`, trimmed to the signals table and what to do about each signal.
- docs/03 and docs/05 as design and invariants, without the stale "external inputs" sentences.
- Four evidence reports: the isolation inventory; the mutation inventory, once 49 is corrected to 48 and `setClientOwner` removed; MCP foundation evidence; MCP research.

**Delete.** These four reports are changelogs of states that no longer exist; their own banners say they are superseded:
- `reports/id-initial-migration.md` (74 lines): "28 tables, 26 functions, 61 triggers"; today there are 25 tables.
- `reports/id-operations.md` (174 lines): its harness is removed.
- `reports/id-release-acceptance.md` (75 lines): 49 mutations, 5 RLS tables, broken links to `.json` files.
- `reports/id-soft-deletion.md` (79 lines): migration 0047, `test:restore`.

Links to repoint: `apps/id/README.md:3,105`, `docs/05:3,74`, `docs/02:3`, root `README.md:12`, `OPERATIONS.md:5`, `docs/04:245`.

**Trim.**
- The release plan: keep the E1–E8 checklist at :31-44.
- `id-production-oauth.md`: keep the protocol prose at :14-86.
- `answerable-id-upstream-token-custody.md`: keep :111-117, :149-153 and :196-210. That file also has about 13 broken absolute-path links.

**De-duplicate.**
- The ingress paragraph appears four times, verbatim: `apps/id/README.md:19`, `docs/03:117`, `docs/05:84` and `sign-in.mdx:180`.
- "Not yet. A restore drill against production-shaped data is a release input." appears four times: `docs/03:105`, `docs/05:80,88,113`.
- The last-platform-administrator paragraph appears three times: README:40 and `docs/05:29,92`.

**Not yets in the present tense.**
- `docs/03:19` and `docs/06:18`: "Redis is reserved for later caching". No Redis exists, and docs/02:134 forbids adding one before code reads it.
- `docs/03:115`: the heading "Tailnet hardening"; there is no tailnet.
- index.mdx:99.
- manage.mdx:424.

**Hedges an operator cannot act on.** About 29 by regex across the five docs (P15). Examples: OPERATIONS.md:3-5, `docs/05:88` ("No production capacity … is certified") and `docs/03:113,119`.

**`reports/staging-evidence.md`.** It appears 8 times, always as code font marked Not yet (brief B7a). It is never a link, so it is not a broken link.

**Links.** Every `reports/` link in the docs resolves. The broken ones are inside reports.

## 4. Unsafe or wrong

1. **A replica with the wrong application secret starts and reports ready** (P06).
   - A typo in `BETTER_AUTH_SECRET`, or a wrong `BETTER_AUTH_SECRETS` promotion, rolls to every pod.
   - Then token issuance fails (`sign.mjs:61-66`) and cookies from the old secret are refused.
   - The only guard is a manual preflight after the fact.
   - Fix: C2's startup check, proved by P06b.
2. **The restore runbook cannot do what it says** (`infra/README.md:181-183`, deployment scope).
   - It says to run the preflight "before traffic" with `kubectl exec deploy/id`, but those pods are already serving.
   - `OPERATIONS.md:71` says "Stop writers".
   - The startup check removes the need for that step for the signing key.
3. **The public docs state audit facts that do not exist.**
   - `sign-in.mdx:178` and `manage.mdx:172` describe a "cached response replay" event; there is no `oauth.user.replayed` in `db/schema/audit.ts:59-62`.
   - `manage.mdx:780` says "version-three soft-deletion facts", but `audit_events_schema_version_check` is `= 1` (`audit.ts:69`).
4. **Wrong counts and stale status in the service docs.**
   - `docs/05:102` and `docs/06:29` say "eleven" RLS tables; the migration has 10.
   - `docs/06:192` lists `Q-SECRET-STORE` as not ready, but it was resolved on 19 October (`docs/02:62`).
   - `OPERATIONS.md:3-5,126-137` and `apps/id/README.md:23` say topology and secret delivery are "not supplied", but docs/12 supplies them.
   - `docs/04:243` says 14 product tables carry `deletedAt`, while README:103 and docs/05:72 say 15. The column is on 15 tables, including `grant_contexts`.
5. **The fake ID's 403 differs from real ID** (P11): `forbidden` against `insufficient_scope` with `WWW-Authenticate`. No consumer breaks on it today, but a test written on the fake would pass against the wrong code.
6. **Minor.**
   - Two `jose` (6.2.10 and 6.2.12) and two `zod` (4.5.4 and 4.6.5) are installed, because `packages/auth` and `packages/id-admin` pin newer versions than `apps/id`.
   - The image carries `mcp-e2e-fixture.ts` and `stack-directories.ts`, which cannot run there.

Outside my scope, for audit A: `docs/06:14,178` says rate-limit buckets are per process. With 2–6 replicas, the effective limit is multiplied by the replica count.

## 5. Open questions for the owner

1. **docs/06's "Install, in order"** (psql `CREATE ROLE`, a hand-run `db:migrate`, the preflight, root-bearer cURL) is a manual install. The deployment forbids anything by hand, and the ops Jobs do all of it.
   - Option one: keep it as a generic self-host guide.
   - Option two: keep docs/06 to the requirements table and the Entra and Google console steps, and point at `infra/README.md`.
2. **The four changelog reports:** delete them, or move them under `docs/goals/` as history?
3. **`DATABASE_POOL_MAX`:** keep it as the one sizing variable (staging and production databases may differ), or make it a constant like the rest?
4. **The fake's drift:** fix it by hand, or add P11 as a gate in the acceptance?

## 6. Measured numbers

- **ID suite:** 1,558 tests, 0 fail, 133 files, 511 s (P01, shared machine; the landing record says 322 s).
- **Metrics cost:** 340 ns per request; `/healthz` takes 6.25 against 6.63 µs (P02).
- **Bundle:**
  - `server.js` is 5.79 MB; the stylesheet is 42,831 B; the font is 26,636 B (P03b).
  - RSS is 154.4–155.3 MB today against 137.2–139.2 MB for the spike (P03c).
- **Production `node_modules`:** 96,848 KB / 99 packages → 79,392 KB / 75 packages (P04, darwin-arm64).
- **Sweep, 200,000 rows:**
  - Two sweepers with the lock: 1.33–1.50 s.
  - Two without it: 1.37–1.64 s.
  - One sweeper alone: 2.26 s.
  - Zero errors in every run (P07).
- **Environment:** 30 variables → 17; `env.ts` −45/+22 lines; 5 env tests fail and nothing else (P08).
- **MCP suites:** the Toolbox runs 81 tests in 3.8–4.2 s; the admin MCP runs 129 tests in 5.2–6.3 s (P09).
- **Real-ID fixture:** 769–955 ms per file plus 80–96 ms per test, against 97–109 ms for 9 fake tests (P10).
- **Fake drift:** 37 calls; 1 code differs (403); 25 field-level differences (P11).
- **Stylesheet:** 42,831 → 28,257 B, and gzip 7,755 → 5,653 B (P16).
- **Docs:** sentence counts as in P15; 1,884 report lines, of which about 400 are changelog to delete.
- **Admin API:** 80 operations (`x-kind` read 32, write 43, erase 5) and 48 mutations; RLS on 10 tables; `deleted_at` on 15 tables; 25 tables.
