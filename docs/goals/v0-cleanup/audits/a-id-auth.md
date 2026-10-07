# Audit A: the ID auth layer

Read-only audit of `apps/id/src/auth.ts` and every non-test file in `apps/id/src/auth/`, tree 436909e, worktree `claude/v0-cleanup`, 2026-10-07. Better Auth claims were checked against the installed 1.7.2 sources (`apps/id/node_modules/{better-auth,@better-auth/*}` and `better-call@1.4.0`), not their docs. No file other than this one was written.

## 1. Scope read

Every in-scope file was read in full.

| File | Lines |
| --- | ---: |
| `apps/id/src/auth.ts` | 290 |
| `auth/member-permission.ts` | 436 |
| `auth/verified-sso.ts` | 428 |
| `auth/user-token-boundary.ts` | 423 |
| `auth/user-oauth-flow.ts` | 390 |
| `auth/user-provider.ts` | 227 |
| `auth/sso-origin.ts` | 193 |
| `auth/user-token-assertions.ts` | 185 |
| `auth/user-token-revocation.ts` | 173 |
| `auth/machine-provider.ts` | 173 |
| `auth/create-resource-grant.ts` | 169 |
| `auth/machine-audit.ts` | 142 |
| `auth/machine-identity.ts` | 129 |
| `auth/tenant-authentication.ts` | 127 |
| `auth/database-adapter.ts` | 124 |
| `auth/user-resource-policy.ts` | 95 |
| `auth/native-refresh-family.ts` | 90 |
| `auth/native-code-replay.ts` | 85 |
| `auth/answerable-schema.ts` | 85 |
| `auth/platform-applications.ts` | 80 |
| `auth/upstream-token-storage.ts` | 76 |
| `auth/lock-resource-grant-policy.ts` | 75 |
| `auth/machine-capability.ts` | 74 |
| `auth/native-client-authentication.ts` | 72 |
| `auth/grant-authentication.ts` | 72 |
| `auth/user-oauth-audit.ts` | 46 |
| `auth/fresh-authentication.ts` | 43 |
| `auth/audit-hooks.ts` | 41 |
| `auth/grant-scopes.ts` | 37 |
| `auth/native-token-cleanup.ts` | 34 |
| `auth/narrow-authorization-code.ts` | 28 |
| `auth/grant-error.ts` | 22 |
| **32 files** | **4,664** |

Context read for understanding, not audited: `app.ts` (248, full), `http/auth-allowlist.ts` (190, full), `http/authorize.ts` (100, full), `services/federation.ts` (264, full), `operations/preflight.ts` (79, full), `db/{organization,client,resource}-lock.ts` (65, full), `docs/05-id-enterprise-foundation.md` (123, full); excerpts of `http/principal.ts` (150-200), `http/problem.ts` (95-150), `env.ts` (25-80, 180-260), `db/isolation.ts`, `db/queries/{grant-contexts,audit,capabilities,access,grants}.ts`, `docs/03-answerable-id.md` (20-110), `reports/id-production-oauth.md` (1-200), `docs/goals/test-audit/audits/id-auth.md` (probes and appendix C), `apps/id/openapi.json` (User schema). Better Auth sources by line: `better-auth/dist/db/internal-adapter.mjs` 20-60, 248-293, 440-540; `db/with-hooks.mjs` 115-175; `api/index.mjs` 170-215; `api/routes/session.mjs` 140-160; `@better-auth/core/dist/db/adapter/factory.mjs` 143-183; `core/dist/error/index.mjs`; `better-call/dist/router.mjs` 81-98, `utils.mjs` 4-44; `@better-auth/oauth-provider/dist/authorize-BmTe2VYG.mjs` 40-75, 4190-4230, 4261-4275, 4436-4500, 4580-4610, 5320-5345; `introspect-C6P1zrTr.mjs` 225-260, 1300-1348, 1525-1545, 1790-1815, 1888-1905; `utils-C2yu_zRr.mjs` 215-240, 636-677; `@better-auth/sso/dist/index.mjs` 570-600, 900-965, 2040-2060.

## 2. Summary

| Category | Findings |
| --- | ---: |
| dead | 6 |
| duplicated | 7 |
| complicated / weak assumption | 4 |
| unsafe | 0 |
| ugly | 9 |
| **total** | **26** |

**Estimated lines:** about 225 removed and 110 added (net about −115), of which about 40 removed and 30 added fall in modules owned by other areas (`http/problem.ts`, `db/queries/grant-contexts.ts`, a new `lib/log.ts`, a new `db/user-lock.ts`). Test edits are listed per finding and not counted.

**Unsafe: none found.** Token issuance, PKCE, redirect handling, consent, refresh rotation, client authentication and the SSO callback were each traced into the installed sources. Two findings (A15, A17) are correctness defects, not security holes: OAuth endpoints answer 500 where the admin API answers 503 for the same database condition, and an expired-session cleanup is audited as a sign-out.

**The five changes that matter most**

1. **A1:** delete the SSO provider-revision map that `sso-origin.ts` writes into the OAuth state. Commit 56e668f9 deleted its only reader and left the writer, its `AsyncLocalStorage` and the `run` wrapper (about 25 lines).
2. **A15:** `rethrowGrantError` treats two Postgres codes as retryable. `mapDatabaseError` treats four conditions as retryable: deadlock 40P01 and pool checkout timeouts as well. Share one predicate so OAuth answers 503 `temporarily_unavailable` like the admin API, not 500.
3. **A17:** every session delete is audited as `auth.signout`. Better Auth also deletes expired sessions on `GET /auth/get-session`, so expiry cleanup is recorded as a user sign-out. Check `context.path` (one line).
4. **A16:** `sso-origin.before` still has a lenient branch that creates sessions with null provenance outside `/sso/callback`. Only tests reach it, because the callback is the only route that creates sessions. Fail closed instead (about −15 lines).
5. **A6 + A7 + A8:** three helpers for the grant-transaction code repeated in 4, 5 and 6 places: `temporarilyUnavailable`, `grantTransaction` and `withAdapter` (about −60/+25). `grantTransaction` also makes the 503 mapping impossible to forget.

## 3. Findings

| ID | file:line | category | finding | evidence | proposal | lines −/+ | risk (test that holds it) | confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | `auth/sso-origin.ts:30-56`, `auth.ts:81,286`, `auth/database-adapter.ts:19,59,69` | dead | `answerableSsoProviderRevisions` is written to the OAuth server context at SSO start and never read; the request map and `ssoOrigin.run` exist only to build it | `grep -rn ProviderRevisions --exclude-dir=node_modules .` returns only `sso-origin.ts:54` and `federation.integration.test.ts:389-399`. `git show 56e668f9 -- apps/id/src/auth/sso-origin.ts` deleted the reader (`getOAuthState()?.serverContext?.answerableSsoProviderRevisions` → `SSO_PROVIDER_CHANGED`) as "the SSO provider-revision rejection the plugin already performs". The plugin's fingerprint covers domain, issuer, organisation, OIDC config and record id (`sso/dist/index.mjs:916-963`) | Delete `requests`, `run`, and the body of `observeProviders` after `verifiedSso.observe()`, plus the `addOAuthServerContext` import. Pass `verifiedSso.observe` to `authDatabaseAdapter` as `onProviderRead: () => Promise<void>` (no rows). `auth.ts` handler becomes `verifiedSso.run(() => auth.handler(request))` | −25/+3 | Held by `federation.integration.test.ts` (native SSO matrix) and `verified-sso.integration.test.ts` (observe path). Test edits: delete `sso-origin.test.ts:4-20` and the stored-context assertion at `federation.integration.test.ts:396-400` | high |
| A2 | `auth/machine-provider.ts:25` | dead | Parameter `options` is never read; the body uses `provider.options` | tsc `noUnusedParameters` baseline hit; the only reads are `provider.options` at :75 and :131 | Drop the parameter; update `user-provider.ts:84` and `machine-provider.integration.test.ts:105` | −1/0 | Machine suites | high |
| A3 | `auth/user-oauth-flow.ts:100,108` | dead | `start()` handles a POST authorise body, but POST `/auth/oauth2/authorize` never reaches it | The allowlist has only `GET /auth/oauth2/authorize` (`http/auth-allowlist.ts:37-43`); `app.test.ts:208` asserts POST is 404. The native code re-runs authorise through its own endpoint object (`authorize-BmTe2VYG.mjs:4393` `runOAuth2Authorize` → `oauth2AuthorizeEndpoint`), never through the wrapper | `const query = ctx.query;` and `run({ ...ctx, query: next })` | −2/+1 | `user-oauth.integration.test.ts` authorise cases; `app.test.ts:208` | high |
| A4 | `auth/platform-applications.ts:6,11` | dead | The `kind` fields of `platformApplications` are never read | Reads of the constant: `.scopes` (`http/admin/sso-providers.ts:291`) and `.tokenEndpointAuthentication` (`db/queries/sso-providers.ts:253`, `platform-applications.ts:77`) only. `platformApplicationFor` derives the kind from `classifyIssuer` | Delete both `kind:` lines | −2/0 | typecheck | high |
| A5 | `auth/fresh-authentication.ts:6`, `auth/platform-applications.ts:17`, `auth/tenant-authentication.ts:17` | dead | `freshAuthenticationSeconds`, `PlatformApplication` and `TenantAuthentication` are exported but used only in their own file | baseline `knip.txt` lines 53 and 71 flag the first two; `grep -rnw TenantAuthentication apps/id/src` finds only `tenant-authentication.ts:17,41` (knip does not flag it) | Drop the three `export` keywords | 0/0 | typecheck | high |
| A6 | `auth/grant-error.ts:12-20`, `native-token-cleanup.ts:24-31`, `user-oauth-audit.ts:36-44`, `machine-audit.ts:69-77` | duplicated | The same 8-line `APIError("SERVICE_UNAVAILABLE", {error:"temporarily_unavailable", …}, {"Retry-After":"1"})` appears 4 times; only the description changes | `grep -rn '"Retry-After": "1"' apps/id/src/auth`: 4 hits | Add `temporarilyUnavailable(description)` to `grant-error.ts` (§4) | −24/+9 | `grant-locks.integration.test.ts`, `machine-audit.integration.test.ts`, `user-oauth.integration.test.ts` assert the 503 body | high |
| A7 | `user-token-revocation.ts:31-35,168`; `user-token-boundary.ts:163-164,177` and `:191-195,416`; `user-oauth-flow.ts:157-159,387`; `machine-provider.ts:92-94,144` | duplicated | 5 copies of `runWithTransaction(ctx.context.adapter, async () => { const adapter = await getCurrentAdapter(…); const tx = authTransaction(adapter); … }).catch(rethrowGrantError)` | Read in each file | `grantTransaction(adapter, (bound, tx) => …)` in `database-adapter.ts` (§4) | −15/+9 | user-oauth, machine-provider, machine-audit and grant-locks suites | medium |
| A8 | `user-token-boundary.ts:165-170, 202-220, 381-387`; `user-oauth-flow.ts:341-343`; `machine-provider.ts:124-129`; `user-token-revocation.ts:40-60` | duplicated | 6 copies of `{ ...ctx, context: { ...ctx.context, adapter: { ...ctx.context.adapter, ...adapter } } }` (some add a `create` or `findOne` override) | Read in each file | `withAdapter(ctx, adapter)` next to `authTransaction` (§4) | −24/+6 | Same suites as A7 | medium |
| A9 | `auth/user-token-boundary.ts:381-387` | ugly | The context passed to `assertUserTokenResponse` re-spreads `adapter` over `bound.context.adapter`, which already contains it. The only effect is to undo the `create` wrapper, which the assertion never calls | `bound.context.adapter = { ...ctx.context.adapter, ...adapter, create }` (:205-218). The assertion uses only `adapter.findOne`, `api.hashToken` (storeToken, no context) and `getIssuer` | Pass `ctx: bound` | −6/+1 | `user-oauth.integration.test.ts:568`, `:607` | high |
| A10 | `auth/user-token-assertions.ts:179`; `auth/user-oauth-flow.ts:218` | complicated | Two hard-coded copies of Better Auth defaults. (1) The ID-token check `id.exp !== id.iat + (options.idTokenExpiresIn ?? 36_000)` is the one expiry-arithmetic check left after 56e668f9 "deleted the checks that re-derived Better Auth's own expiry"; `createAuth` never sets `idTokenExpiresIn`, so the copied default is the live path. (2) The grant lifetime (docs/03: 30 days) is `options.refreshTokenExpiresIn ?? 2_592_000`. `createUserOAuthFlow` receives the raw options, not `native.options`, which already holds the default (`authorize-BmTe2VYG.mjs:4204`) | `git show 56e668f9 -- …/user-token-assertions.ts` removed the access and refresh expiry arithmetic but kept line 179. Native default: `introspect-C6P1zrTr.mjs:1394` `opts.idTokenExpiresIn ?? 36e3` | Delete line 179. Name the grant lifetime as a constant in `user-oauth-flow.ts` and pass the same value as `refreshTokenExpiresIn` in `createAuth`, so grant and refresh lifetime cannot drift | −2/+3 | `user-oauth.integration.test.ts` happy-path ID token cases; the earlier fault test for lifetime is already gone (only `access-scope`, `id-nonce` remain at :585) | medium |
| A11 | `native-refresh-family.ts:39-47`, `user-token-revocation.ts:137-146`, `native-code-replay.ts:46-61` (+7 in `db/queries/grant-contexts.ts:20-136`) | duplicated | `update(grantContexts).set({ revokedAt: statement_timestamp() }).where(and(…, isNull(revokedAt)))` is written 10 times in ID, 3 of them in auth; two auth copies are identical | `grep -rn 'revokedAt: sql\`statement_timestamp()\`' apps/id/src`: 10 hits | `revokeGrantContexts(executor, where)` in `db/queries/grant-contexts.ts` (§4) | auth −9/+3 (ID total −21/+8) | user-oauth replay and revocation tests (UO:1168, :1238, revocation cases) | medium |
| A12 | `native-client-authentication.ts:8-9`, `user-oauth-flow.ts:37`, `user-token-assertions.ts:11-15`, `user-token-revocation.ts:21`, `user-token-boundary.ts:29-33`, `native-code-replay.ts:6`, `native-refresh-family.ts:7`, `native-token-cleanup.ts:4`, `user-oauth-flow.ts:224-227` | ugly | Local type aliases repeated: `Context = Parameters<typeof getOAuthProviderApi>[0]` ×5, `Adapter = …["context"]["adapter"]` ×4, `Extract<Awaited<ReturnType<typeof userResourcePolicy>>, {allowed:true}>` ×3 | grep `^type Context\|^type Adapter\|Extract<` | Export `NativeContext`/`NativeAdapter` once (from `native-client-authentication.ts`) and `UserResourceDecision` from `user-resource-policy.ts` | −12/+4 | typecheck | high |
| A13 | `auth/machine-identity.ts:87-118` (and `:50-51`) | complicated | The machine `accessToken` claim re-reads and re-compares the organisation and client rows that `prepareMachineGrant` locked FOR SHARE and compared a few statements earlier in the same transaction. Of the comparisons, id and organisation equality are immutable by trigger, and the `isSafeInteger`/`< 1` test repeats a CHECK constraint | Share locks block updates until commit. `protect_oauth_client_identity` (`drizzle/0001_invariants.sql:21-41`) forbids changing `id`, `client_id`, `organization_id`; `organizations_authorization_version_check` is `> 0` (`0000_initial.sql:66`). The claim runs only through `machine-provider.ts:123-137` (`authTransaction` throws outside it). `recordMachineIssuance` then compares every claim with the decision again | In claims: parse `client` (the row `prepareMachineGrant` returned), read only `organizations.authorizationVersion`, and build the claims. In `prepareMachineGrant`, compare only `authorizationVersion` | −22/+4 | `machine-provider.integration.test.ts`, `machine-audit.integration.test.ts` (claim/decision match), token tests | medium |
| A14 | `auth/native-code-replay.ts:80`, `auth/verified-sso.ts:195` | ugly | `error instanceof APIError` where 5 other auth sites use `isAPIError`. `better-auth/api`'s `APIError` is a subclass (`@better-auth/core/dist/error/index.mjs`) of better-call's, and the native provider throws both (`import { APIError as APIError$1 } from "better-call"`, introspect:5, authorize:11), so `instanceof` misses base-class throws | The invalid_grant replay path throws the subclass today (introspect:1898), so this is not a live bug. `isAPIError` = `instanceof \|\| name === "APIError"` | Use `isAPIError` at both sites | 0/0 | UO:1168 code-replay tests | medium |
| A15 | `auth/grant-error.ts:5-11` vs `http/problem.ts:105-127` | ugly | Two classifications of retryable database errors disagree. `mapDatabaseError` maps 57014, 55P03, 40P01 and pool checkout timeouts to 503. `rethrowGrantError` maps only 55P03 and 57014, so a deadlock or a pool timeout in an OAuth grant transaction reaches `onAPIError.onError` and answers 500 `authentication_unavailable` | Read both. A pool timeout is thrown unwrapped by `db.transaction` (problem.ts:106-117 comment), so `error.cause.code` never matches in `rethrowGrantError` | Extract `isRetryableDatabaseError(error)` from `mapDatabaseError` in `http/problem.ts`; `rethrowGrantError` throws `temporarilyUnavailable(…)` when it holds | −8/+10 | `grant-locks.integration.test.ts` (55P03), `db/statement-timeout.integration.test.ts` (57014); a 40P01 or pool case would be new | medium |
| A16 | `auth/sso-origin.ts:133-191` | complicated | The session `before` hook accepts a session with no SSO origin unless the path is `/sso/callback`, writing null provenance. No production route reaches that branch: the callback is the only allowlisted route that creates sessions, and the only out-of-endpoint `createSession` is a test. `session.id ??` is also dead: Better Auth sets `id` before hooks only with secondary storage | Allowlist `http/auth-allowlist.ts:29-182`: no email, social or other session-creating route. `grep -rn "createSession(" apps/id/src` returns only `db/schema.integration.test.ts:139`. `internal-adapter.mjs:256-263` sets `sessionId` only when `secondaryStorage && !storeInDb` | Refuse every session without an origin (`authentication_origin_missing`), then drop the five `origin?.… ?? null` operands, the two `if (origin)` branches and `session.id ??` | −15/+3 | `tenant-authentication.integration.test.ts:747` (origin faults), federation SSO matrix. Test edits: `sso-origin.test.ts:22-61` (expect refusal for all contexts), `schema.integration.test.ts:131-145` (stop creating a raw session) | medium-high |
| A17 | `auth/audit-hooks.ts:35-40` | complicated | Every session deletion is audited as `auth.signout`. Better Auth also deletes an expired session when `GET /auth/get-session` (pages: `routes/login.ts:49`, `routes/security.ts:18`) or `auth.api.getSession` (admin principal, `http/principal.ts:163`) sees one, so expiry cleanup becomes a user sign-out in the audit trail | `better-auth/dist/api/routes/session.mjs:148-156` calls `deleteSession` on expiry; `deleteSession` → `deleteWithHooks` → `delete.after` with the endpoint context (`with-hooks.mjs:115-151`) | `after: (session, context) => context?.path === "/sign-out" ? record(…) : undefined` | 0/+1 | `federation.integration.test.ts:831-850` holds the sign-out row; an expiry case would be new | medium |
| A18 | `auth.ts:159-160` | ugly | The comment says every user Better Auth creates, "including one created by a successful upstream login", starts inert. Federation creates them `status: "active"` | `services/federation.ts:242-251`; the comment dates from 2026-09-02 and the active create from 2026-09-04 (`git log -L`) | Reword: the default applies to rows created without a status (imports); federation activates on first login | −2/+1 | none | high |
| A19 | `auth.ts:162` (also `:210`, `:236`) | ugly | `type: [...userStatuses]` puts an invalid JSON Schema node into the public contract: `User.status.type = ["inert","active","disabled"]` (`apps/id/openapi.json:66-73`). It is the only such node in the document | Python walk over `openapi.json` finds one non-primitive `type` list | Declare `type: "string"` for the three status fields (the DB `vocabularyCheck` constraints hold the vocabulary), then `openapi:export` | 0/0 + regenerated file | OpenAPI drift test; `principal.ts:338` still compiles (string compare) | medium |
| A20 | `auth/user-oauth-flow.ts:289-294` | ugly | The `authenticated` flag is raw SQL naming 11 columns by hand. It repeats the session-origin predicate of `tenant-authentication.ts:76-123` (account owner, provider revision, issuer, provider id, organisation, expiry), so typecheck cannot see a rename | Read both | Express the `exists` with Drizzle column references, or compute it from one `tenantAuthentication` call for the session's organisation | −6/+6 | `user-oauth.integration.test.ts` flow-details cases | low-medium |
| A21 | `auth/user-provider.ts:76-79` | ugly | Six non-null assertions (`claims!`, `accessToken!`) exist because `machineIdentity()` (`machine-identity.ts:75`) and `extension` (`user-token-boundary.ts:140`) are annotated as the loose `OAuthProviderExtension` | Read | Use `satisfies OAuthProviderExtension` at both definitions so the concrete members are typed | 0/0 | typecheck | high |
| A22 | `auth/user-provider.ts:37-57` vs `auth/user-oauth-flow.ts:321-329` | ugly | `flowResponse` documents `/auth/oauth2/flow` in the public OpenAPI but nothing ties it to the object `resume("details")` returns | Read | Type the details return as `z.infer<typeof flowResponse>` (export the schema from the flow module) | 0/+1 | typecheck | medium |
| A23 | `auth.ts:54-57, 70-73`; `machine-provider.ts:159-165`; `platform-applications.ts:57-64` (+ `operations/protocol-sweep.ts:79`, `http/problem.ts:168`, `http/denial-audit.ts:12`, `http/signin-audit.ts:45`) | duplicated | 8 hand-written `console.error("[id] <area>", JSON.stringify({…}))` operational logs in ID, with inconsistent fields (`level` present in 5, `requestId` in 2, one free-form string) | `grep -rn 'console.error(' apps/id/src` (non-test): 8 | `logEvent(area, event, fields?)` in a new `lib/log.ts` (§4) | auth −8/+4 (ID −16/+12) | `auth/logging.test.ts` and `federation.integration.test.ts:695` assert the exact output: keep `{level, event}` key order | medium |
| A24 | `lock-resource-grant-policy.ts:25-30`; `verified-sso.ts:158-162, 306-310` (+ `db/queries/users.ts:121-125`) | duplicated | User row locks are written inline 4 times, while organisation, client and resource each have a lock helper | `ls apps/id/src/db/*lock*.ts`: client, organization, resource | `lockUser(executor, id, mode)` in a new `db/user-lock.ts` (§4) | −12/+13 | `grant-locks.integration.test.ts`, verified-sso suites | low |
| A25 | `create-resource-grant.ts:37`, `member-permission.ts:201`, `machine-capability.ts:71`, `grant-scopes.ts:9`; scope parsing at `machine-audit.ts:34`, `user-token-boundary.ts:248,285`, `user-oauth-flow.ts:87-89,190,195`, `user-token-assertions.ts:75`, `machine-provider.ts:107`, `narrow-authorization-code.ts:15-18` | duplicated | `[...new Set(x)].sort()` appears 19 times in ID (4 in auth). A scope string is split 9 times in auth; 3 sites omit `.filter(Boolean)` | `grep -rn '\[\.\.\.new Set(' apps/id/src \| grep 'sort()'`: 19 | `uniqueSorted` and `parseScope` in `grant-scopes.ts` (§4) | −10/+4 | `grant-scopes.test.ts`, user-oauth scope cases | low |
| A26 | `answerable-schema.ts:75,79-80`; `auth.ts:167-171, 203-208, 215-224, 241-251` | dead | Better Auth field declarations that no Better Auth path reads or writes: `organizationDomain.createdAt/updatedAt/references`, `user.disabledAt`, `organization.authorizationVersion/disabledAt/updatedAt`, `member.revokedAt/validFrom/validUntil` | `transformOutput` maps declared fields only (`core/.../factory.mjs:143-177`). The only Better Auth reads of these models are in `federation.ts` (status, deletedAt, organizationId, domain); `user.disabledAt` is visible only in the public `get-session` schema (`openapi.json:76`) | Delete the declarations (regenerate `openapi.json`), or keep them; see question 4 | −25/0 | `schema.integration.test.ts` (updates `member.validUntil` through the Better Auth adapter); OpenAPI drift test | low |

## 4. Shared helper proposals

All extend an existing module except `lib/log.ts` and `db/user-lock.ts`, which follow existing sibling patterns.

**`temporarilyUnavailable(description: string): APIError`** in `auth/grant-error.ts`.
```ts
export const temporarilyUnavailable = (description: string) =>
  new APIError("SERVICE_UNAVAILABLE",
    { error: "temporarily_unavailable", error_description: description },
    { "Retry-After": "1" });
```
Call sites: `grant-error.ts:12-20`, `native-token-cleanup.ts:24-31`, `user-oauth-audit.ts:36-44`, `machine-audit.ts:69-77`. About −24/+9.

**`grantTransaction<T>(adapter: NativeAdapter, run: (bound: NativeAdapter, tx: Executor) => Promise<T>): Promise<T>`** in `auth/database-adapter.ts`, beside `authTransaction`.
```ts
export const grantTransaction = <T>(adapter, run) =>
  runWithTransaction(adapter, async () => {
    const bound = await getCurrentAdapter(adapter);
    return run(bound, authTransaction(bound));
  }).catch(rethrowGrantError);
```
Call sites: `user-token-revocation.ts:31`, `user-token-boundary.ts:163` and `:191`, `user-oauth-flow.ts:157`, `machine-provider.ts:92`. About −15/+9.

**`withAdapter<C extends { context: { adapter: object } }>(ctx: C, adapter: object): C`** in `auth/database-adapter.ts`. Returns `{ ...ctx, context: { ...ctx.context, adapter: { ...ctx.context.adapter, ...adapter } } }`. Call sites: `user-token-boundary.ts:165`, `:202` (with `create` override), `:381` (A9 removes it), `user-oauth-flow.ts:341`, `machine-provider.ts:124`, `user-token-revocation.ts:40,57`. About −24/+6.

**`revokeGrantContexts(executor: Executor, where: SQL)`** in `db/queries/grant-contexts.ts` (area B owns the module). Returns `executor.update(grantContexts).set({ revokedAt: sql\`statement_timestamp()\` }).where(and(where, isNull(grantContexts.revokedAt)))`, so callers can add `.returning(…)`. Call sites: `native-refresh-family.ts:39`, `user-token-revocation.ts:138`, `native-code-replay.ts:46`, and `grant-contexts.ts:20, 38, 56, 74, 94, 115, 136`. About −21/+8.

**`isRetryableDatabaseError(error: unknown): boolean`** in `http/problem.ts`, extracted from `mapDatabaseError`. Only 2 sites (`mapDatabaseError`, `rethrowGrantError`), below the 3-site rule; proposed because the two copies diverge (A15).

**`logEvent(area: string, event: string, fields: Record<string, string | number | null> = {}, level: "error" | "warn" = "error")`** in a new `apps/id/src/lib/log.ts`. Writes `console.error(\`[id] ${area}\`, JSON.stringify({ level, event, ...fields }))`. Call sites: `auth.ts:54`, `auth.ts:70` (`level` from the logger), `machine-provider.ts:159`, `platform-applications.ts:57`, `operations/protocol-sweep.ts:79`, `http/problem.ts:168`, `http/denial-audit.ts:12`, `http/signin-audit.ts:45`. About −16/+12. Areas B and C own four of the sites.

**`lockUser(executor: Executor, id: string, mode: "update" | "share" = "update")`** in a new `apps/id/src/db/user-lock.ts`, a copy of `lockClient`'s shape with a `deletedAt is null` filter. Call sites: `lock-resource-grant-policy.ts:25`, `verified-sso.ts:158` (it does not filter `deletedAt` today; the later `current()` refuses a deleted user either way), `verified-sso.ts:306`, `db/queries/users.ts:121` (inside its context guard). About −12/+13: marginal, consistency only.

**`uniqueSorted(values: Iterable<string>): string[]` and `parseScope(value: string | null | undefined): string[]`** in `auth/grant-scopes.ts`. Sites: the 19 unique-sort occurrences (4 in auth: `create-resource-grant.ts:37`, `member-permission.ts:201`, `machine-capability.ts:71`, `grant-scopes.ts:9`; 15 in `http/admin`, `services`, `db/queries/access.ts`) and the 9 scope splits listed in A25. About −10/+4 in auth.

**Types:** `NativeContext`, `NativeAdapter` (exported once) and `UserResourceDecision` (from `user-resource-policy.ts`) replace 12 local aliases (A12).

## 5. Challenged and kept

- **`user-token-assertions.ts` (all but line 179).** docs/05 §3 requires that "actual signed/opaque token outputs, persisted token/grant state and mandatory user outcome facts must agree before commit". On replay (`OAUTH_REFRESH_REUSE_INTERVAL_SECONDS > 0`) the native code returns a cached response minted under an older decision. The scope, identity-claim, resource and refresh-presence comparisons are the only place where a narrowed policy or a bumped authorisation version refuses that replay. `reports/id-production-oauth.md` §"Issuance assertion correction" measured two divergences that returned 200 before the module existed.
- **`recordMachineIssuance` claim comparison.** Same contract for machines; it must decode the JWT anyway to audit `jti`, `iat` and `exp`.
- **`native-code-replay.ts` and `native-refresh-family.ts`.** Both match native query shapes, which is a dependency on library internals, but `native-shapes.test.ts` pins those shapes and the revocation barrier is a documented contract (docs/05 §4). The two copies keep different conditions (code vs family, `invalid_request` on revocation), so a shared helper would need a parameter per difference: below the 3-site rule.
- **`withNativeClientAuthentication`.** The native token endpoint authenticates the client again inside the issuance transaction. Without the consumed-marker replay, a `private_key_jwt` assertion would fail as a replay or roll back with the grant (docs/05 §4). The autocommit guard enforces that ordering.
- **`withNativeTokenCleanup`.** The native code swallows `deleteMany` errors during code-replay cleanup (`introspect-C6P1zrTr.mjs:1529-1540`); without the wrapper a failed revocation answers success.
- **Duplicate `resource` detection with `formData()` (`machine-provider.ts:81-91`).** better-call collapses repeated form keys, last one wins (`better-call/dist/utils.mjs:33-39`), so the zod string check cannot see `resource=a&resource=b`. The endpoint sets `cloneRequest: true`.
- **`grant_type !== "client_credentials"` refusal (`machine-provider.ts:59`).** The native body schema accepts any string (`authorize-BmTe2VYG.mjs:4586`), so unknown grant types do reach it.
- **`client.grantTypes` re-check after the lock (`machine-provider.ts:100`).** A grant-type edit does not bump `authorization_version` (`0001_invariants.sql:33-38`), so this catches a race the native pre-lock check misses.
- **`onAPIError.onError` and the redacting `logger`.** Without them better-call prints the raw error (`router.mjs:93`, `console.error("# SERVER_ERROR: ", error)`), which can carry SQL parameters or tokens. Throwing an `APIError` from `onError` produces a 500 response (`router.mjs:84-90`).
- **`encryptOAuthTokens: false`, `storeClientSecret: "hashed"`.** Both equal the defaults (`oauth2/utils.mjs:12`; `authorize-BmTe2VYG.mjs:4209`). The first records why the storage plugin owns encryption; the second pins the digest `hashClientSecret` mirrors. One line each.
- **`providersLimit: 0`, `allowUserToCreateOrganization: false`, `disableDefaultReference: true`.** The allowlist already closes those endpoints, and nothing calls them server-side (the only `auth.api` calls are `getOpenIdConfig`, `generateOpenAPISchema`, `getJwks`, `getSession`). Kept as one-line protection if the allowlist widens.
- **`upstream-token-storage.ts` (D12).** Live: the output transform runs on every Better Auth `account` read (`federation.ts:170-205`) and in `checkKeyCustody`. No dead read path and no dead option.
- **`answerableSchema` `deletedAt` fields and `visible()`.** `visible()` needs the field declared to filter on it. Consents are soft-deleted at erasure (`db/queries/users.ts:265`, `oauth-clients.ts:334`). The `organizationDomain` model is read through Better Auth at `federation.ts:155`.
- **The provider `update` interceptor and `hydrateSsoProviderRow`.** The native lock writes only `{ providerId }` (`sso/dist/index.mjs:2042-2054`), so the platform secret injected at read time is never persisted.
- **`sessionAuditHooks` fires.** Unlike the oauth-provider's own hooks, which are gated on `hookCtx` (the earlier gotcha), a user `delete.after` hook runs on sign-out: `internal-adapter.mjs:452-489` → `with-hooks.mjs:140-149`. Only its attribution is wrong (A17).
- **Three `current()` calls in one verified-SSO callback** (`beforeTransaction`, `resolve`, `beforeSession`) and the second `tenantAuthentication` in `endpoint()`. They are probably redundant under the locks `beforeTransaction` holds, but proving all three share one transaction needs a probe, and the flow is rare.
- **The eligibility `WHERE` in `create-resource-grant.ts:135-161`.** It repeats `member-permission.ts`'s eligibility, and `userResourcePolicy` re-runs right after it in `resume`. Kept as protection on the only grant insert; 2 copies.
- **P3 and P15 (redundant guards behind triggers, test audit).** One SQL condition each; kept.
- **`grant-authentication.ts` join conditions on immutable relations.** Cheap; the revision condition is load-bearing (probe P4).
- **Per-statement `.catch(rethrowGrantError)` in `lock-resource-grant-policy.ts`.** Redundant for every current caller (each is inside a mapped transaction) but harmless.
- **One user and one machine provider.** They share `grantScopes`, `identityScopes` and `rethrowGrantError` and nothing else of substance. Member policy and machine capability have different inputs and evidence; merging them would be re-architecture.
- **`throw new Error("Accepted SSO provider/account is no longer available")`.** Unreachable, but explicit; a `!` would hide the assumption.
- **The `narrowAuthorizationCode` throw, the `active` flag in `withNativeClientAuthentication`, `Object.freeze` in `tenantAuthentication`.** Small protections against our own code (4, 3 and 1 lines). The test audit kept the first's unit test.

## 6. Questions for the coordinator

1. **A16: fail closed for sessions without an origin?** Production behaviour does not change, because no reachable route creates sessions outside `/sso/callback`; two tests change. Recommend yes.
2. **A10: delete the leftover ID-token expiry arithmetic** in line with 56e668f9's decision, and make the 30-day grant lifetime explicit? Recommend yes.
3. **A19: `type: "string"` or post-process `http/openapi.ts`?** The change alters the public `openapi.json` (`User.status` loses its invalid literal list). Recommend `type: "string"`, plus an `enum` added during post-processing if consumers want it.
4. **A26: delete unread Better Auth declarations?** Deleting `user.disabledAt` changes the public `get-session` schema; `status`, `disabledAt` and `retiredEmail` are returned to the browser today though pages read only `email`. Recommend: delete the organisation, member and domain ones; for the user, either delete or mark `returned: false`. Owner's call; low value.
5. **Upstream `auth_time` with zero clock tolerance.** `sso-origin.ts:80-91` rejects `auth_time > now` (whole seconds), and `isFreshAuthentication`'s upper bound is `statement_timestamp()`. An IdP clock 1 s ahead would refuse a fresh login or reauthentication. Better Auth's own ID-token check sets no `maxTokenAge`, so it does not reject a future `iat` (`sso/dist/index.mjs:580-583`). Nothing is measured, so no change is proposed; decide whether to allow a stated skew (for example 60 s) in both places.
6. **Placement across areas:** `logEvent` (lib, area C), `revokeGrantContexts` (`db/queries/grant-contexts.ts`, area B), `isRetryableDatabaseError` (`http/problem.ts`, area B/C) and `uniqueSorted` (15 of 19 sites in area B) need one owner each.
7. **Stale docs (area G):** docs/05 §5 still says user outcomes use audit version 4 and machine issuance version 2; after schema-audit D7, `recordAuditEvent` always writes `schemaVersion: 1` (`db/queries/audit.ts:148`).
