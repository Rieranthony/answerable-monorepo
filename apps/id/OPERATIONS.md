# Operating Answerable ID

These commands cover repository-owned checks. Production topology, traffic targets,
secret delivery, backup retention and recovery objectives have not been supplied.
The [local evidence](../../reports/id-operations.md) cannot establish production capacity or readiness.

## Runtime bounds

| Boundary            | Repository default or behaviour                                            | Limit of the claim                                                         |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Database pool       | 20 connections (1 in tests); checkout 5 seconds; idle 10 seconds           | Multiply pools by processes and include other database users               |
| Database statements | 10 seconds per statement; lock wait 2 seconds; idle transaction 15 seconds | Not a whole-request deadline; transactions may execute multiple statements |
| Request body        | 256 KiB; acquisition deadline 5 seconds                                    | Does not bound response streaming or socket count                          |
| Forwarded IP        | Rightmost untrusted address after listed ingress proxies                   | Requires proxy-only network access and TRUSTED_PROXY_CIDRS                 |

**Runtime summaries.** `OPERATIONAL_LOG_INTERVAL_MS` defaults to 30000; zero disables
reporting, otherwise the minimum is 1000. Each process writes `[id] operations`
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

**Monitoring handoff.** Configure the selected collector/scheduler to route these
signals to an operator. No destination or numerical alert budget is configured here.

| Signal                                                                  | Operator check                                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Rising 503 counts, active work and pool waiters                         | Compare with traffic and database limits; inspect authorised audit/history for context                                                       |
| `admin_denial_audit_unavailable` or `token_rejection_audit_unavailable` | Investigate database/audit availability; refusal remains refusal                                                                             |
| `custody_preflight_failed`                                              | Keep recovery traffic closed and inspect key/source delivery                                                                                 |
| Missing process summaries                                               | Check process health and collector delivery before interpreting demand                                                                       |
| Backup age or retrieval failure                                         | Use the backup service's independently monitored completion/recovery evidence; `/readyz` cannot detect this                                  |

## Deliver and check keys

```bash
# From apps/id, with deployment configuration supplied by its secret store.
# Stop writers and use the restricted runtime DATABASE_URL, never the owner login.
bun run ops:preflight
```

The preflight performs read-only, paged database scans. It decrypts every retained
signing private key with the provider's supported secret configuration, verifies a
local canary against its public key, reads each account's upstream token fields via
the supported storage transform. Only counts are printed. Missing
or incorrect keys, invalid ciphertext, a mismatched key pair or no signing key fails
with exit status 1. It never generates replacement keys or rewrites credentials.
It does not prove backup completeness or validate
cookies, external IdP private keys and every provider credential family.

On a **new installation**, initialise native JWKS in the isolated runtime before
the preflight, using `GET /auth/jwks`. Supply versioned application-secret custody
before that first generation. An unexpectedly empty JWKS after restore is a recovery
failure; do not use initialisation to replace missing restored keys.

| Material                 | Supported configuration and use                                                                                                                                  | Retirement evidence needed                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Application secret       | `BETTER_AUTH_SECRET`; optional native `BETTER_AUTH_SECRETS` ring. Encrypts provider material including signing private keys; active secret signs browser cookies | Retained ciphertext and every required backup; promotion requires fresh browser sign-in                |
| Upstream token keys      | `UPSTREAM_TOKEN_SECRETS`; first version writes, listed versions read account access, refresh and ID tokens                                                       | All surviving fields and required backups decrypt without the retiring version                         |
| Database credentials     | Separate migration and runtime logins                                                                                                        | Provision new credentials and permissions after restore; do not restore owner credentials into runtime |
| Root and IdP credentials | Deployment-managed root bootstrap secret and configured SSO credentials                                                                                          | Separate inventory and provider-specific revocation/rotation checks                                    |

Keep these families independent and outside PostgreSQL backups. The repository
accepts delivered configuration; it does not implement a secret manager, approve
access to one, or prove that every replica received a version.

**Normal rotation.** Inventory current ciphertext, backups and replicas first.
Distribute a new version to every replica while keeping the current active version
first. Run the preflight against stopped
writers with the staged configuration. Coordinate promotion across replicas, then
recheck and exercise a synthetic native sign-in, issuance, refresh and command replay.
Changing the active application secret requires fresh sign-in; staged old cookies
do not establish continuity after promotion. Never reuse a version for different
material. Retain old keys until the inventory and backup retention justify removal.
There is no automatic ciphertext rewrapping or old-key retirement job.

**Signing-key lifecycle.** The pinned provider generates and publishes database-backed
JWKS keys and supports retained application-secret decryption. Tests exercise native
generation after simulated expiry and verification with retained public keys. The
preflight checks stored pairs, not prepublication, downstream JWKS-cache behaviour
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
