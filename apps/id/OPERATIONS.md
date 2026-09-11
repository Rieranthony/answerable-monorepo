# Operating Answerable ID

These commands cover repository-owned checks. Production topology, traffic targets,
secret delivery, backup retention and recovery objectives have not been supplied.
The [local evidence](../../reports/id-operations.md) cannot establish production capacity or readiness.

## Observe capacity

```bash
# From apps/id. Destructive: exclusive ownership of answerable_id_test is required.
bun run measure:audit ../../reports/id-operations-capacity.json mixed
```

The finite workload runs two production-mode Bun processes through loopback HTTP,
each with a restricted four-connection pool. Native SSO fixtures supply tenant
sessions; the workload exercises resource-bearing code exchange, refresh, cached
refresh replay across processes, administrative commands and unknown-client rejection.
Controlled database barriers hold tenant A work while B attempts requests. Every
refused command retries with its original key and input. Measurements contain
statuses, elapsed times and fixed pool/request summaries; credentials stay in memory.

This tests contention behaviour, including overload refusal and recovery. It is not
a sustained throughput test, a percentile estimate or evidence about a real ingress.
Do not run it alongside migrations, coverage, another workload or restore rehearsal.

| Boundary                       | Repository default or behaviour                                                       | Limit of the claim                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Active request handlers        | 64 per process; excess receives 503 and `Retry-After: 1`                              | No cluster quota; bodyless liveness bypasses it                            |
| Public authentication handlers | `max(1, pool maximum − 1)` per pool                                                   | A shared lane; B OAuth can be refused when A fills it                      |
| Tenant administrative commands | Two per organisation per pool after authentication                                    | Global commands and authentication are outside this bound                  |
| Machine issuance               | Two per owner organisation across the database, after authentication and policy locks | Does not bound checkout, lock waits or rejected-token audits               |
| Database pool                  | Five connections; checkout 5 seconds; idle 10 seconds                                 | Multiply pools by processes and include other database users               |
| Database statements            | 10 seconds per statement                                                              | Not a whole-request deadline; transactions may execute multiple statements |
| Request body                   | 256 KiB; acquisition deadline 5 seconds                                               | Does not bound response streaming or socket count                          |
| Forwarded IP                   | Untrusted; no forwarded-IP extraction                                                 | No claim of real client-IP rate limiting                                   |

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
| Rising 503 counts, active work and pool waiters                         | Compare with traffic and the specific admission boundary; inspect authorised audit/history for context                                       |
| `admin_denial_audit_unavailable` or `token_rejection_audit_unavailable` | Investigate database/audit availability; refusal remains refusal                                                                             |
| `custody_preflight_failed` or `recovery_verification_failed`            | Keep recovery traffic closed and inspect key/source delivery                                                                                 |
| Missing process summaries                                               | Check process health and collector delivery before interpreting demand                                                                       |
| Expiry job nonzero exit or missed scheduled run                         | Inspect scheduler state and repeat the existing bounded purge; successful nonempty batches retain atomic `operation.results_purged` evidence |
| Backup age or retrieval failure                                         | Use the backup service's independently monitored completion/recovery evidence; `/readyz` cannot detect this                                  |

**Global lifecycle pressure.** The separate `user-erasure` density mode observed one
B read returning `503 database_busy` while eight global deletions each retired two
memberships with 1000 assignments and 1000 direct grants per membership. Those
commands bypass tenant admission. Completion and replay succeeded, but this workload
does not support a claim that B reads always progress under global lifecycle pressure.

## Deliver and check keys

```bash
# From apps/id, with deployment configuration supplied by its secret store.
# Stop writers and use the restricted runtime DATABASE_URL, never the owner login.
bun run ops:preflight
```

The preflight performs read-only, paged database scans. It decrypts every retained
signing private key with the provider's supported secret configuration, verifies a
local canary against its public key, reads each account's upstream token fields via
the supported storage transform, and decrypts retained, unexpired command results.
It also checks availability of their fingerprint keys. It does not validate the
unknown original request against its fingerprint. Only counts are printed. Missing
or incorrect keys, invalid ciphertext, a mismatched key pair or no signing key fails
with exit status 1. It never generates replacement keys or rewrites credentials.
It does not detect an absent result row, prove backup completeness, or validate
cookies, external IdP private keys and every provider credential family.

On a **new installation**, initialise native JWKS in the isolated runtime before
the preflight, using `GET /auth/jwks`. Supply versioned application-secret custody
before that first generation. An unexpectedly empty JWKS after restore is a recovery
failure; do not use initialisation to replace missing restored keys.

| Material                 | Supported configuration and use                                                                                                                                  | Retirement evidence needed                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Application secret       | `BETTER_AUTH_SECRET`; optional native `BETTER_AUTH_SECRETS` ring. Encrypts provider material including signing private keys; active secret signs browser cookies | Retained ciphertext and every required backup; promotion requires fresh browser sign-in                |
| Upstream token keys      | `UPSTREAM_TOKEN_SECRETS`; first version writes, listed versions read account access, refresh and ID tokens                                                       | All surviving fields and required backups decrypt without the retiring version                         |
| Command replay keys      | `OPERATION_REPLAY_CONFIG`; active key writes encrypted results and fingerprint MACs                                                                              | All live replay windows, retained backups and recovery requirements                                    |
| Database credentials     | Separate migration, runtime and expiry-maintenance logins                                                                                                        | Provision new credentials and permissions after restore; do not restore owner credentials into runtime |
| Root and IdP credentials | Deployment-managed root bootstrap secret and configured SSO credentials                                                                                          | Separate inventory and provider-specific revocation/rotation checks                                    |

Keep these families independent and outside PostgreSQL backups. The repository
accepts delivered configuration; it does not implement a secret manager, approve
access to one, or prove that every replica received a version.

**Normal rotation.** Inventory current ciphertext, backups and replicas first.
Distribute a new version to every replica while keeping the current active version
first (or retaining the current `activeKeyId`). Run the preflight against stopped
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

## Restore with a known gap

```bash
# From apps/id. Resets only the guarded local answerable_id_test database.
bun run test:restore ../../reports/id-operations-recovery.json
```

The rehearsal acknowledges membership revocation and client creation, rotation and
soft deletion **after** the first snapshot. Restoring that snapshot leaves the member
active and the client/operation receipts absent. A closed loopback listener refuses
the original keyed request with 503. The verifier refuses reopening. It then restores
a complete later dump of the still-available synthetic source, checks the barriers,
and replays all four original operations with the same IDs and response bodies.
The other tenant's membership and the global user UUID remain intact.

This later full dump is an explicit reconciliation source. It is not a simulation
of losing the source database, managed point-in-time recovery, WAL archiving or
repairing individual receipts. Phase timings are local elapsed observations, not
production RTO or RPO.

**Retain listed evidence outside the backup.** While a trusted source is available
and writers are stopped, prepare an input file listing acknowledged operation IDs
and the specific membership/client barriers that must survive. Use immutable row
UUIDs, not public client identifiers:

```json
{
  "operationIds": ["<operation UUID>"],
  "revokedMemberIds": ["<membership UUID>"],
  "deletedClientIds": ["<client row UUID>"]
}
```

```bash
bun run ops:capture-recovery /secure/acknowledged-ids.json /secure/new-evidence.json
# After recovery, using restored restricted runtime credentials and retained keys:
bun run ops:preflight
bun run ops:verify-recovery /secure/new-evidence.json
```

Capture creates a new mode-0600 file and refuses to overwrite it. The version-1
format hashes each listed permanent receipt, its audit events and ordered subject
references; it checks listed membership revocations, client tombstones and identifier
reservations. Files are limited to 1 MiB and each list to 1000 entries. Use multiple
files if needed and verify every one. Pin the application/schema version used for
capture and verification. Evidence contains internal identifiers; retain it in an
independent controlled location with provenance and integrity protection.

**Reopening procedure.** Stop writers, scheduled jobs and external traffic before
restore. Preserve the damaged source and available logs according to the incident
procedure. Recover a consistent database from an independently established complete
source, provision fresh restricted database credentials and deliver retained keys.
Run the two checks above before starting traffic. Exercise native SSO and OAuth plus
known same-key command replays in the isolated deployment; preserve UUIDs and original
keys. Confirm downstream trust in restored issuer/JWKS state before operator release.
`/readyz` only checks database reachability and cannot authorise reopening.

A missing or changed listed fact requires keeping traffic closed. Never replay a
missing receipt against an older snapshot to manufacture recovery evidence, copy a
receipt without its transaction's state and audit, use a new idempotency key, or
create replacement UUIDs. A matching file proves only its listed facts. The file is
not a complete external acknowledgement ledger; no check here establishes that
unlisted post-snapshot revocations or secret rotations were recovered. If completeness
cannot be established from the recovery source, operator release remains unresolved.
The CLI never changes traffic routing; the rehearsal's closed listener is test scaffolding.

## Retention and external decisions

Product deletion remains terminal `deletedAt` soft deletion with immediate credential
clearing and durable UUID/identifier reservations. Physical domain-data purge jobs and
durations are deferred. The existing bounded command-result expiry job is separate;
its runtime-independent role and invocation are documented in the [ID README](README.md#replay-keys-and-retention).
No production scheduler is installed by this slice.

Before deployment, assign owners and supply:

1. Process/pool topology, database capacity, ingress limits and any explicitly trusted
   proxy boundary. Forwarded IP stays untrusted until that boundary is implemented and tested.
2. Representative traffic mix, burst/concurrency targets and acceptable refusal/latency
   budgets for each flow, including unauthenticated traffic and tenant B OAuth.
3. Secret-store delivery, access control, version inventory, promotion/rollback and
   signing-key emergency rotation/verification overlap.
4. Backup/key retention, a complete post-snapshot recovery source, independent
   acknowledgement evidence, recovery RTO/RPO, and authority to reopen traffic.
5. Monitoring and incident ownership, and deployment scheduling for existing replay
   ciphertext expiry. Domain-data purge policy remains a separate deferred decision.
