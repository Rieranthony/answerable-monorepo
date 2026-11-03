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
| Request body        | 256 KiB (4 KiB on `POST /login`, `POST /magic-link` and `POST /magic-link/code`, 64 KiB on `POST /auth/sign-in/sso`); acquisition deadline 5 s | Does not bound response streaming or socket count                          |
| Rate limits         | Per client address per process, production only ([docs/06](../../docs/06-deploying-answerable-id.md#operating-it)) | Replicas multiply them; not a volumetric defence                           |
| Sign-in page posts  | 60 per 10 s per client address per process, in every environment: on `POST /login`, a 429 page; on `POST /magic-link` and `POST /magic-link/code` together, their usual refusal with no database work. At most 10,000 clients held per route | Replicas multiply them; not a volumetric defence                           |
| Client address      | `cf-connecting-ip`; else the rightmost untrusted `x-forwarded-for` address after the proxies in `TRUSTED_PROXY_CIDRS` | Requires proxy-only network access ([README](README.md#http-surface))      |

**Runtime summaries.** Every 30 seconds each process writes `[id] operations`
followed by JSON: per route class and HTTP status, the completed handler count,
total and maximum duration since the last report; `active` and `pool` counts are
instantaneous, `peakActive` is the window's high-water mark. There are no URLs,
tenant or user IDs or credentials. Counters are not durable, and a missing summary
is not zero load. Do not derive latency percentiles, tenant fairness or peak pool
usage from these aggregates.

**Protocol sweep.** Every 60 seconds each process deletes expired rows from
`oauth_access_tokens`, `oauth_refresh_tokens` (with the access tokens that name
them), `oauth_client_assertions`, `sessions` and `verifications`, and
`magic_link_requests` seven days after they were made, in transactions of at most
1,000 rows. An advisory lock lets one process delete at a time. A run that deleted
rows writes `[id] protocol sweep` with the count per table; expiry records no audit.

**Magic-link mail.** Each process sends at most 5 at a time, holds at most 500 waiting
and drops the rest; no connection is held through a send. Limits hold across replicas,
in Postgres: per address and client 1 in 60 s and 5 in an hour, per address 50 in a day,
per organisation 5,000 in an hour. An address no user holds, which only domain mode admits,
also has a budget of its own: 100 in an hour per client, at any firm, and 500 in a day per
organisation. Made-up addresses hard-bounce, and Postmark pauses a server past 10%, which
would stop sign-in at every firm. Members and users with no membership there neither count
nor are held back. Both sets of numbers are judgement until staging measures them:
`src/services/magic-link-requests.ts`.

**Magic-link codes.** Three comparisons per request. Wrong codes per client 30 in an hour
and per organisation 1,000 in an hour, added up from `attempts` in Postgres so that they hold
across replicas and checked before comparing; at most the ten newest requests of one browser
are compared per attempt. These too are judgement: `src/services/magic-link-codes.ts`. The
link does not go through these budgets.

**Domain proofs.** One TXT lookup per `POST .../verify`, at most 5 s, with no connection held through it. It uses the resolver in the pod's `/etc/resolv.conf`, so ID needs DNS egress to answer for a firm's domain.

**Member import.** At most 1,000 addresses a call, one import at a time across ID, since it takes one advisory lock per address and the shared lock table is `max_locks_per_transaction` times `max_connections`. Measured against a firm of 1,000 members in a database of 500,000 people: 256 to 320 ms for 1,000 new people, the longest statement 88 ms. A second import waits at most the lock wait, then answers `503 database_busy`, which the same key may retry.

**Shutdown.** On `SIGINT` or `SIGTERM` the process stops listening, waits for
in-flight requests, finishes queued mail for at most 22 s, stops the sweep after its
running batch and closes the pool. The chart's 30 s grace period less its 5 s preStop
sleep leaves 25 s, and one send takes at most 21 s: 10 s, 1 s, then a retry of 10 s.

## Signals

Each event is one line: `[id] <area>`, then JSON that starts with `level` and
`event`. An error names its class as `name` and, for a database error, its
SQLSTATE as `code` and any `constraint`, never its message. No alert destination
or budget is configured here.

| Signal                                                                  | What to do                                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Rising 503 counts, active work and pool waiters                         | Compare with traffic and database limits; inspect authorised audit history for context                                                       |
| `[id] error` `unexpected_error`, or `provider_diagnostic` with an error | Read the class and SQLSTATE; a repeated one is a defect or a database fault                                                                  |
| `[id] page` `page_auth_call_failed`                                     | A sign-in page's in-process authentication call threw; the person saw the friendly message. Check the named auth path, or page for a magic link, and the database |
| `admin_denial_audit_unavailable` or `token_rejection_audit_unavailable` | Investigate database/audit availability; refusal remains refusal                                                                             |
| Rising `token_rejected` or `signin_rejected` (`[id] auth`)              | Refusals that verified no client or identity, logged instead of audited: a misconfigured client or directory, or credential stuffing; compare with 429s and the edge rate limits |
| `[id] admin` `admin_auth_refused`, repeated                             | A missing or invalid credential on `/api/admin` (`reason` `unauthenticated` or `invalid_token`, with request id, address and path); no audit row is written. Compare the addresses with the ingress log |
| `SigningKeyCustodyError` at startup                                     | The configured application secrets cannot decrypt the newest signing key: deliver the version that encrypted it; never delete the key       |
| `[id] mail` `postmark_server_token_missing` at startup                  | Production with no `POSTMARK_SERVER_TOKEN`: ID sends no mail, and every request is a failed send. Deliver the token                          |
| `[id] magic link` `magic_link_send_failed`                              | `errorCode` and `httpStatus` are Postmark's; 406 is a suppressed address, which staff reactivate in Postmark. The address is in that row of `magic_link_requests`, under its `requestId`, for seven days. No code and no status: Postmark was not reached |
| `[id] magic link` `magic_link_request`, `outcome` `limited`             | `limit` names which. `organization_hour`, repeated: someone is requesting mail for many real addresses at that firm. `new_address_client_hour` or `new_address_organization_day`, repeated: someone guessing addresses, or a big start that needed `members_import` first. The person sees the usual page and gets no mail |
| `[id] magic link` `magic_link_queue_overflow`, or `magic_link_queue_abandoned` | Requests were told to check their email and got none. `dropped`, `abandoned` and `running` are counts. Compare with Postmark's status and the pool |
| `[id] magic link` `magic_link_job_failed`                               | A job threw before its row was final; read the class and SQLSTATE. Its row, if any, stays `sending`, which signs nobody in                 |
| `[id] magic link` `magic_link_code_budget_exhausted`                    | `budget` says which: `client`, repeated from one address, is someone guessing or an office with a bad day; `organization`, with its id, someone trying a firm from many addresses. Codes stop being compared and the person sees the usual refusal; the link still works |
| `[id] domains` `domain_lookup_failed`                                   | A DNS check got no answer: `code` is the resolver's, `ETIMEOUT` being the 5 s bound. The caller saw `domain_verification_failed`, and a proved domain lost its proof. A domain with no record is not this, and logs nothing. Repeated, check the pod's DNS egress before re-checking any firm |
| `domain.verification_lost` audit events                                 | A re-check found nothing on a proved domain. In domain mode it admits nobody new until it is proved again; nobody's session ended. Check whether the record was removed, or the resolver failed |
| `[id] magic link` `magic_link_audit_unavailable`                        | A refused sign-in could not write its audit row; read the class and SQLSTATE. The refusal stands                                            |
| Rising `auth.magic_link.refused` or `auth.magic_link.code_exhausted` audit events | Refusals that took a real browser cookie and a real request. `reason` says why: `provider_changed`, repeated, follows a firm switched off and on; `code_attempts` someone guessing or mistyping |
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
| Magic-link keys              | Derived from the application secret that writes, one per label; they hash codes and client addresses            | With that secret. A code issued before a promotion stops matching: ask again |
| Postmark server token        | `POSTMARK_SERVER_TOKEN`, environment only, never in PostgreSQL                                                  | Replace it in Postmark and the environment, then ship                    |
| Database credentials         | Separate migration and runtime logins                                                                           | [Infrastructure runbook](../../infra/README.md#rotate)                   |
| Root secret                  | `ROOT_ADMIN_SECRET`, break-glass only                                                                           | [Infrastructure runbook](../../infra/README.md#rotate)                   |

Keep these families independent and outside PostgreSQL backups: a restored database
is unreadable without the application secrets that were active when its keys were
written.
