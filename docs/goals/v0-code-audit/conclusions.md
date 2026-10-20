# Conclusions: the v0 code audit of Answerable ID

Written after the four change sets landed on `claude/v0-code-audit` (20 October 2026). Every number comes from a probe recorded in the five audits under [audits/](audits/a.md), the coordinator's re-runs in [progress.md](progress.md), or a count on the landed tree; the decisions and their reasons are in [report.md](report.md) and [task_plan.md](task_plan.md).

## What the goal was

The last pass over ID's application code before v0, after the test audit, the V0 cleanup and the v0 schema audit. The owner asked what is unnecessary, overly complicated or built on a weak assumption, what can be deleted and what can be simplified once the dead pieces are gone, with the order delete, simplify, optimise, automate, and the reminder that thousands of users will depend on it. The schema, the suite's shape, line-level slop and the deployment were settled by the earlier goals and stayed closed unless an audit brought new evidence.

## How it was done

Fourteen assumptions written down first, then five audits in isolated worktrees, each against its own Postgres 17: A the auth layer, B1 the admin API contract, B2 services, queries and the database runtime, C the shell, operations, pages, packages and docs, D the mechanical baseline and the consumer map. Every proposed delete was spiked and the suite run without the code; every number has a probe. The coordinator re-ran the rate-limit probe, read the break-glass, flood and wrong-secret logs and checked the smaller claims by grep. The owner took all thirteen recommended decisions (D1–D13). Four change sets followed in order, tests first: auth, admin API, services and runtime, docs.

## Measured result

| | Before (main `60c98f65`) | After (branch head) |
| --- | --- | --- |
| `apps/id/src` non-test source | 22,998 lines in 162 files¹ | 21,971 lines in 155 files |
| `apps/id/src` test lines changed | | +1,103 / −2,464 |
| Admin operations (`openapi.admin.json`) | 80 | 77 |
| Admin mutations | 48 | 47 |
| Environment variables in `env.ts`'s schema | 30 | 15 |
| Audit actions (`db/queries/audit.ts`) | 66 | 64 |
| Authorisation layers on the admin API | 2 (tier middleware, `authorizeCommand`) | 1 (`authorizeCommand`, in the transaction) |
| Admin scopes | 6 | 5 (`org:write` gone) |
| Statements per PATCH entitlement | 129 | 53 |
| Audit rows a second from one client with bad bearers | 3,922 | 0 (one log line per request) |
| Default rate limits per address per process | sign-in 3 per 10 s, authorize 30 and token 20 a minute | sign-in 60 per 10 s, callback 300 per 10 s, authorize 300 and token 600 a minute |
| `hono-tailwind` and `tailwindcss` | runtime dependencies | build-time only; `dist` runs without `node_modules` |
| Reports in `reports/` | 11 | 7 (four deleted, three trimmed, the mutation inventory corrected) |
| ID suite | 1,558 tests at 100% line and function coverage | <!-- COORDINATOR: final gate line (tests, files, coverage, time; mcp:test, acceptance, web, typecheck, lint, build, infra:check, infra:test) --> |

¹ The coordinator's baseline, as audit D measured it with `find`. The files git tracks at `60c98f65` count 22,762 lines in 161 files by the same filter, so the tracked change is −791 lines (+635 / −1,426).

Commits: 39 over `main`: the audit record, 31 in change sets 1–3 and 7 in the docs. Outside the planning files: 201 files, +3,331 / −7,808.

## Unsafe or wrong, now fixed

- **Rate limits refused ordinary traffic.** `createAuth` set none, so Better Auth's defaults allowed an office behind one address 18 sign-ins a minute per replica and a host refreshing for 300 users was refused at the 21st token call. Limits are now sized for shared addresses and written into docs/06 as capacity limits.
- **Anonymous requests wrote permanent audit rows.** A missing or invalid admin bearer, a failed client authentication or a forged SSO callback inserted a row before the 401: 3,922 rows a second from one client, up to 12,224 attacker-chosen bytes each, and a legitimate read's p95 rose from 29 to 116 ms. They are log lines now (`admin_auth_refused`, `token_rejected`, `signin_rejected`); a refusal after the credential verified keeps its row.
- **Break-glass recovery added nobody.** `make-admin` and docs/06 reused fixed `Idempotency-Key`s, so ID replayed the first run's receipt. `make-admin` sends keys of its own each run, the docs generate them, and the key is optional with a server key when absent.
- **A replica with a wrong application secret started and reported ready**, then failed every issuance. Startup decrypts the newest signing key and refuses to listen with `SigningKeyCustodyError`.
- **An email taken at sign-in from a disabled user left no trace on that user.** The federation branch records `user.email_retired` with the system actor.
- **A no-op session revocation wrote an audit event.** It writes none; the `noop` receipt is the record.
- Smaller: responses carried `deletedAt` and `live` that no schema declares; the fake ID answered `forbidden` where ID answers `insufficient_scope`, and lacked ID's ETag, `detail` and `errors`; the public docs described a replay event, version-three deletion facts, eleven RLS tables and an open `Q-SECRET-STORE`; `/auth/ok` was allowlisted with no caller.

## Deleted entirely

The issuance assertions (`user-token-assertions.ts` and their bookkeeping) and `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS`; upstream refresh-token storage, `UPSTREAM_TOKEN_SECRETS`, the `offline_access` request to directories and the custody preflight (`preflight.ts`, `operations-preflight.ts`, `ops:preflight`) with their chart, pipeline and kind entries; the `authorize` tier middleware, `tier`, `tierOf`, `x-tier` and `org:write`; the per-lock `revalidate()` at 15 call sites; `getMemberConfiguration`, `getOperationStatus` and `revokeUserSession`; `signin-audit.ts`; ten read services whose body was one query call; `queries/health.ts`; `scripts/test-migrations.ts` and `scripts/export-openapi.ts`; the `organization` plugin; `/auth/ok`; 13 environment variables, now constants with their reasons; four changelog reports.

## Simplified

One authorisation layer: `authorizeCommand` answers 404 for an organisation the caller holds no grant in and the route records `admin.denied` after rollback. Verified SSO checks `current()` once under its locks and carries its state in Better Auth's request state. Bootstrap sets the platform write scope once. Six audit projections became one `evidence(row)`. Client secrets verify with ID's own hasher. SSO discovery tests run the pinned plugin's `discoverOIDCConfig`. The Toolbox poller reads successful events only (26 pages instead of 572). The pages serve a prebuilt stylesheet; the migration script is bundled and the image ships `dist` and `drizzle` only. `UPDATE_SNAPSHOT=1` in the snapshot test writes the OpenAPI files. The docs state the ingress rule, the restore drill and break-glass recovery once each; docs/06 points at the runbook for the install; `OPERATIONS.md` keeps its bounds, signals and keys.

## Challenged and kept

The `native-*` wrappers, the exact-pair evaluator, the machine audit event, the route allowlist, the `BETTER_AUTH_SECRETS` parser, the adapter hooks, freshness, revisions and `If-Match`, the in-transaction authority, `platform:users` and `org:users`, the cookie principal, the root self-lock, `admin.denied`, the three audit list routes, about fifteen routes no consumer calls (disable is the recovery tool), the `withDatabaseScope` savepoint, the start-time role check, bootstrap at every start, the receipt check and lock order, metrics, the sweep lock, the pages, `@answerable/auth`, the fake ID and `DATABASE_POOL_MAX` as the one sizing variable. Each with its measurement in [report.md](report.md#challenged-and-kept).

## Deferred, for the owner

- `scripts/regenerate-migrations.ts` goes at the first staging deploy (brief B7a), once staging holds migration receipts (D11).
- `register` after the root lock needs a hand-placed staff token; its own machine client is `Q-OPS-REGISTER-CLIENT`, in the civo-deploy goal (D13).
- `Q-REFRESH-PARALLEL` is now a change of one constant; `Q-ADMIN-API-RATE-LIMIT` stays open for `/api/admin`; `Q-AID-RECHECK` starts from no stored token.
- Measured, not proposed: `listTargetAccess` reads every tenant's users per page (19 ms at 10,000 users), member search scans all users (7.8 ms), the action-filtered audit list sorts that action's history (20 ms); a `FOR SHARE` on a hot row writes 174 B of WAL and 969 multixacts per 1,000 concurrent transactions.
- Found by the docs pass and left for a later change: `apps/id/src/runtime.test.ts` cites `reports/answerable-id-request-reuse.md`, which no longer exists.
