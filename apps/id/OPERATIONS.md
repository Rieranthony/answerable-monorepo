# Operating Answerable ID

The runtime bounds, the log signals and the keys of one ID process. Answerable's
topology, secret delivery and backups are in [`docs/12`](../../docs/12-deployment.md)
and the [infrastructure runbook](../../infra/README.md); traffic targets and recovery
objectives wait for the first staging run (E6 and E7 in the
[release checklist](../../reports/answerable-id-release-decision-plan.md)).

## Runtime bounds

Constants in `src/env.ts` and `src/http/request-limits.ts`, each with its reason;
a change ships as a release. Only the pool size is a variable.

| Boundary            | Value                                                                      | Limit of the claim                                                         |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Database pool       | `DATABASE_POOL_MAX` connections (default 20); checkout 5 s; idle 10 s      | Multiply pools by processes and include other database users               |
| Database statements | 10 s per statement; lock wait 2 s; idle transaction 15 s                   | Not a whole-request deadline; transactions may execute multiple statements |
| Request body        | 256 KiB; acquisition deadline 5 s                                          | Does not bound response streaming or socket count                          |
| Rate limits         | Per client address per process, production only ([docs/06](../../docs/06-deploying-answerable-id.md#operating-it)) | Replicas multiply them; not a volumetric defence                           |
| Forwarded IP        | Rightmost untrusted address after the proxies in `TRUSTED_PROXY_CIDRS`     | Requires proxy-only network access ([README](README.md#http-surface))      |

**Runtime summaries.** Every 30 seconds each process writes `[id] operations`
followed by JSON: per route class and HTTP status, the completed handler count,
total and maximum duration since the last report; `active` and `pool` counts are
instantaneous, `peakActive` is the window's high-water mark. There are no URLs,
tenant or user IDs or credentials. Counters are not durable, and a missing summary
is not zero load. Do not derive latency percentiles, tenant fairness or peak pool
usage from these aggregates.

**Protocol sweep.** Every 60 seconds each process deletes expired rows from
`oauth_access_tokens`, `oauth_refresh_tokens` (with the access tokens that name
them), `oauth_client_assertions` and `sessions`, in transactions of at most 1,000
rows. An advisory lock lets one process delete at a time. A run that deleted rows
writes `[id] protocol sweep` with the count per table; expiry records no audit.
Better Auth deletes expired `verifications` itself.

**Shutdown.** On `SIGINT` or `SIGTERM` the process stops listening, waits for
in-flight requests, stops the sweep after its running batch and closes the pool.

## Signals

Each event is one line: `[id] <area>`, then JSON that starts with `level` and
`event`. An error names its class as `name` and, for a database error, its
SQLSTATE as `code` and any `constraint`, never its message. No alert destination
or budget is configured here.

| Signal                                                                  | What to do                                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Rising 503 counts, active work and pool waiters                         | Compare with traffic and database limits; inspect authorised audit history for context                                                       |
| `[id] error` `unexpected_error`, or `provider_diagnostic` with an error | Read the class and SQLSTATE; a repeated one is a defect or a database fault                                                                  |
| `[id] page` `page_auth_call_failed`                                     | A sign-in page's in-process authentication call threw; the person saw the friendly message. Check the named auth path and the database       |
| `admin_denial_audit_unavailable` or `token_rejection_audit_unavailable` | Investigate database/audit availability; refusal remains refusal                                                                             |
| Rising `token_rejected` or `signin_rejected` (`[id] auth`)              | Refusals that verified no client or identity, logged instead of audited: a misconfigured client or directory, or credential stuffing; compare with 429s and the edge rate limits |
| `[id] admin` `admin_auth_refused`, repeated                             | A missing or invalid credential on `/api/admin` (`reason` `unauthenticated` or `invalid_token`, with request id, address and path); no audit row is written. Compare the addresses with the ingress log |
| `SigningKeyCustodyError` at startup                                     | The configured application secrets cannot decrypt the newest signing key: deliver the version that encrypted it; never delete the key       |
| `protocol_sweep_failed`, repeated                                       | Check database availability and lock waits; expired protocol rows accumulate until a sweep succeeds                                          |
| `shutdown_failed`                                                       | The process exited with status 1 before closing cleanly; read the class                                                                      |
| Missing process summaries                                               | Check process health and collector delivery before interpreting demand                                                                       |
| Backup age or retrieval failure                                         | Use the backup service's own monitoring; `/readyz` cannot detect this                                                                        |

## Keys

Startup decrypts the newest stored signing key with the configured application
secrets before it listens; a wrong or missing version stops the process with
`SigningKeyCustodyError`, so the previous replicas keep serving. A database with no
key yet passes; the first `GET /auth/jwks` generates one. An unexpectedly empty JWKS
after restore is a recovery failure; do not use that generation to replace missing
restored keys, and never edit or delete a JWKS row to force rotation.

| Material                     | Where it lives                                                                                                  | Rotation                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Application secret           | `BETTER_AUTH_SECRET` and the optional `BETTER_AUTH_SECRETS` ring; encrypts the signing keys, signs browser cookies | [README](README.md#application-secret-rotation); promotion signs everyone out |
| Platform application secrets | `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_SECRET`, environment only, never in PostgreSQL                     | [docs/06](../../docs/06-deploying-answerable-id.md#operating-it)        |
| Database credentials         | Separate migration and runtime logins                                                                           | [Infrastructure runbook](../../infra/README.md#rotate)                   |
| Root secret                  | `ROOT_ADMIN_SECRET`, break-glass only                                                                           | [Infrastructure runbook](../../infra/README.md#rotate)                   |

Keep these families independent and outside PostgreSQL backups: a restored database
is unreadable without the application secrets that were active when its keys were
written.
