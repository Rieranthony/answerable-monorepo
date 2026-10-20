# Operating Answerable ID

These commands cover repository-owned checks. Production topology, traffic targets,
secret delivery, backup retention and recovery objectives have not been supplied.
The [local evidence](../../reports/id-operations.md) cannot establish production capacity or readiness.

## Runtime bounds

| Boundary            | Repository default or behaviour                                            | Limit of the claim                                                         |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Database pool       | 20 connections; checkout 5 seconds; idle 10 seconds                        | Multiply pools by processes and include other database users               |
| Database statements | 10 seconds per statement; lock wait 2 seconds; idle transaction 15 seconds | Not a whole-request deadline; transactions may execute multiple statements |
| Request body        | 256 KiB; acquisition deadline 5 seconds                                    | Does not bound response streaming or socket count                          |
| Forwarded IP        | Rightmost untrusted address after listed ingress proxies                   | Requires proxy-only network access and TRUSTED_PROXY_CIDRS                 |

**Runtime summaries.** Every 30 seconds each process writes `[id] operations`
followed by JSON. Route classes and HTTP statuses are the only request dimensions.
There are no URLs, queries, tenant/user IDs, credentials or per-request buffers.
`requests` contains completed handler count, total duration and maximum duration per
class/status since the last report. `active` and `pool` counts are instantaneous;
`peakActive` is the handler high-water mark in that window. Duration ends when Hono
finishes the handler, before any later response-body streaming. A slow handler appears
as active until completion. Process shutdown stops reporting; counters are not durable.

Use the deployment log collector's process identity when combining summaries. Do not
derive latency percentiles, tenant fairness or peak pool usage from these aggregates.
An absent summary requires checking the process and collector; it is not zero load.
Measure representative traffic and database sizing before changing existing limits.

**Protocol sweep.** Every 60 seconds each run deletes rows whose `expires_at` has
passed from `oauth_access_tokens`, `oauth_refresh_tokens` (with the access tokens
that name them), `oauth_client_assertions` and `sessions`, as the runtime role, in
transactions of at most 1,000 rows. Rotated refresh
tokens stay until their own expiry. An advisory lock lets one process delete at a
time; a process that finds it taken skips the rest of that run. A run that deleted
rows writes `[id] protocol sweep` followed by JSON with the count per table; expiry
records no audit. A failed run writes only `protocol_sweep_failed`, with the
error's class and its SQLSTATE when the database gave one, and the next interval retries. Better Auth deletes
expired `verifications` itself.

**Shutdown.** On `SIGINT` or `SIGTERM` the process stops listening, waits for in-flight
requests, stops the sweep after its running batch and closes the pool. A failed shutdown
writes `shutdown_failed` with the error's class and exits with status 1.

**Monitoring handoff.** Configure the selected collector/scheduler to route these
signals to an operator. No destination or numerical alert budget is configured here.
Each event is one line: `[id] <area>`, then JSON that starts with `level` and `event`.
An unexpected request error writes `[id] error` with `unexpected_error`; a sign-in page
whose in-process authentication call throws writes `[id] page` with
`page_auth_call_failed` and the auth path, then shows its friendly message. These,
`provider_diagnostic` for a thrown error, `protocol_sweep_failed`, `shutdown_failed`
and the `admin_denial_audit_unavailable` and `token_rejection_audit_unavailable`
events name the error's class as `name` and, for
a database error, its SQLSTATE as `code` and any `constraint`, never its message.

| Signal                                                                  | Operator check                                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Rising 503 counts, active work and pool waiters                         | Compare with traffic and database limits; inspect authorised audit/history for context                                                       |
| `admin_denial_audit_unavailable` or `token_rejection_audit_unavailable` | Investigate database/audit availability; refusal remains refusal                                                                             |
| Rising `token_rejected` or `signin_rejected` (`[id] auth`)              | Refusals that verified no client or identity, logged instead of audited: a misconfigured client or directory, or credential stuffing; compare with 429s and the edge rate limits |
| `[id] admin` `admin_auth_refused`, repeated                             | A missing or invalid credential on `/api/admin` (`reason` `unauthenticated` or `invalid_token`, with request id, address and path); no audit row is written. Compare the addresses with the ingress log |
| `SigningKeyCustodyError` at startup                                    | The configured application secrets cannot decrypt the newest signing key: deliver the version that encrypted it; never delete the key       |
| `protocol_sweep_failed`, repeated                                       | Check database availability and lock waits; expired protocol rows accumulate until a sweep succeeds                                          |
| Missing process summaries                                               | Check process health and collector delivery before interpreting demand                                                                       |
| Backup age or retrieval failure                                         | Use the backup service's independently monitored completion/recovery evidence; `/readyz` cannot detect this                                  |

## Keys

Startup decrypts the newest stored signing key with the configured application
secrets before it listens; a wrong or missing version stops the process with
`SigningKeyCustodyError`, so the previous replicas keep serving. A database with no
key yet passes; the first `GET /auth/jwks` generates one. An unexpectedly empty JWKS
after restore is a recovery failure; do not use that generation to replace missing
restored keys.

| Material                 | Supported configuration and use                                                                                                                                  | Retirement evidence needed                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Application secret       | `BETTER_AUTH_SECRET`; optional native `BETTER_AUTH_SECRETS` ring. Encrypts provider material including signing private keys; active secret signs browser cookies | Retained ciphertext and every required backup; promotion requires fresh browser sign-in                |
| Platform application secrets | `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_SECRET`: environment only, never in PostgreSQL | Provider console shows the new secret and every replica has restarted; keep both secrets valid throughout rotation |
| Database credentials     | Separate migration and runtime logins                                                                                                        | Provision new credentials and permissions after restore; do not restore owner credentials into runtime |
| Root and IdP credentials | Deployment-managed root bootstrap secret and configured SSO credentials                                                                                          | Separate inventory and provider-specific revocation/rotation checks                                    |

Keep these families independent and outside PostgreSQL backups. The repository
accepts delivered configuration; it does not implement a secret manager, approve
access to one, or prove that every replica received a version.

**Normal rotation.** Inventory current ciphertext, backups and replicas first.
Distribute a new version to every replica while keeping the current active version
first. Coordinate promotion across replicas, then
recheck and exercise a synthetic native sign-in, issuance, refresh and command replay.
Changing the active application secret requires fresh sign-in; staged old cookies
do not establish continuity after promotion. Never reuse a version for different
material. Retain old keys until the inventory and backup retention justify removal.
There is no automatic ciphertext rewrapping or old-key retirement job.

**Signing-key lifecycle.** The pinned provider generates and publishes database-backed
JWKS keys and supports retained application-secret decryption. Tests exercise native
generation after simulated expiry and verification with retained public keys. The
startup check decrypts the newest key only; it does not check prepublication, downstream JWKS-cache behaviour
or an emergency signing-key cutover. Do not edit JWKS rows or delete a key to force
rotation. A production emergency rotation procedure, verification overlap and
offline token exposure window still require a deployment rehearsal. In a custody
incident, close traffic and preserve recovery evidence before changing keys.

## Retention and external decisions

Product deletion remains terminal `deletedAt` soft deletion with immediate credential
clearing and durable UUID/identifier reservations. Physical domain-data purge jobs and
durations are deferred.

Before deployment, assign owners and supply:

1. Process/pool topology, database capacity, ingress limits and `TRUSTED_PROXY_CIDRS`.
   Restrict service access to those proxies; refuse other traffic at the network boundary.
   Production auth/admin requests with no resolvable address receive `403 untrusted_ingress`.
2. Representative traffic mix, burst/concurrency targets and acceptable refusal/latency
   budgets for each flow, including unauthenticated traffic and tenant B OAuth.
3. Secret-store delivery, access control, version inventory, promotion/rollback and
   signing-key emergency rotation/verification overlap.
4. Backup/key retention, a complete post-snapshot recovery source, independent
   acknowledgement evidence, recovery RTO/RPO, and authority to reopen traffic.
5. Monitoring and incident ownership. Domain-data purge policy remains a separate deferred decision.
