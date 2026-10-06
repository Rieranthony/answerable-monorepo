# Audit D: the Toolbox, @answerable/mcp-postgres and the admin MCP schemas

## Summary

Audited the Toolbox's catalogue tables, `@answerable/mcp-postgres`'s evidence and intent tables, its migrator, the admin MCP's use of them and the `mcp:new` scaffold, on main 93cf95f, against a private Postgres 16 (`audit-pg-d`, 47436).

- **The core is sound.** The hash layout agrees in all three places (28 fields), `verify` caught 30 of 30 single-field changes, every hot-path query is a primary-key or `(organisation_id, seq)` lookup (0.009 to 0.036 ms mean), and the receipt `CHECK` holds.
- **Delete:** 4 evidence columns and 8 of 16 `kind` values that nothing writes. Also `intents.approval` (a pure function of `policy_class` that nothing reads), `capabilities.status`, four write-only `providers` columns, the GIN index the planner never uses (0 scans), and the migrator's legacy-layout test.
- **Intents grow forever,** but the SDK's own memory store sweeps them after a 1-day replay window. A mutation costs 6,963 B on disk (intent 3,531, evidence 2,712, payload 721): 2.54 GB a year at 1,000 mutations a day. Because `intents.preview` keeps the same JSON as the erasable payload (15 of 15 rows), `erase()` erases nothing in practice.
- **Two correctness gaps.** First, the intent can be expired by two different calls, so an `intent.expired` row can be lost (reproduced: 0 rows). Second, `verify` does not read payloads: a changed payload body still passes.
- **The per-organisation lock caps one organisation at 373 to 407 events/s** with 20 writers, against 1,263 to 1,566 events/s across 20 organisations. The chance that two of 75 organisations share a `hashtext` lock key is 6.5 × 10⁻⁷; a collision only serialises the two. Keep.
- **Migrations:** reset to one file per directory, namespaced records, apply the directories in the order given, and add a checksum. As built, an edited applied file is skipped silently, and a server file that sorts before the package's breaks a fresh database (both reproduced).

## Method

- Read the four migrations, `packages/mcp-postgres/src/*`, `mcps/toolbox/src/{catalogue,search,grants,poller,admin,admin-enable,toolbox,db/migrate}.ts`, `mcps/admin/src/admin.ts`, `server.ts`, `scripts/migrate.ts`, `scripts/mcp-templates.ts` and the SDK's `packages/mcp/src/{intents,commit,prepare,server}.ts`. Also read the four docs named in the brief, docs/02's register and "Do not re-propose", and the installed Drizzle 0.45.2 migrator.
- Ran the three suites once each against fresh test databases, after a `pg_stat_statements` reset (container started with `track=all`). Ports 47400 and 47520 were free, so the entry-point tests ran.
- Probes are in `/private/tmp/claude-501/-Users-anthonyriera-code-answerable/a810977b-1778-4c0c-818b-541405b0d1b6/scratchpad/probes/d/`. 01–07 and 21 read the suite databases. 08–20 used a scratch database, `audit_d_probe`, in my container, migrated like the Toolbox's (`lib.ts`, `reset.ts`); I have since dropped it, so recreate it to rerun them.
- **Caveat on timings:** four audit containers shared the host, with load averages from 23 to 260 (`uptime`, recorded in the outputs). The final rerun of 09 failed when the Docker VM disk filled (`No space left on device`, 87.7 MB free of 58.4 GB). I dropped my scratch database and shrank my container's WAL from 448 MB to 64 MB (`max_wal_size` set to 64 MB, in my container only). Treat absolute times as upper bounds and ratios as the finding.

## Findings

| # | Object | What it does today | Evidence | Verdict | Why |
|---|---|---|---|---|---|
| 1 | `providers.version`, `manifest`, `registered_at`, `status` | `ingest` writes them at every start. No production code reads them, and `status` is never set to `retired` | `catalogue.ts:28-30`. A grep finds `from providers` only in `*.test.ts`, and `retired` only in the `CHECK`. Manifests average 2,209 B stored, 24 kB as text at most (37 test providers) | **simplify** to `providers (id text primary key)` | The in-process manifest is the source of truth (`admin.ts:46-52`, `meta.ts:32`). The table's only job is to anchor the two foreign keys. Delete the `registered_at` test with it |
| 2 | `capabilities.status` | Default `active`; nothing writes or reads it | Grep: no writer, no reader. 137 of 137 rows are `active` | **delete** | A claim about a retirement flow that does not exist |
| 3 | `capabilities` (the other columns) | `kind`, `risk`, `input` and `output` feed the version guard; `title`, `description` and `input` feed `search`; `provider_id` gives the known set | `catalogue.ts:31,35,41`; `search.ts:13` | **keep** | Each column has a reader |
| 4 | `capabilities_search` (GIN) | Indexes `search` | 0 index scans after the suite (21). At 137 rows the planner seq-scans with or without it: 3.3 ms cold, 0.33 ms warm (20) | **delete** (low priority) | Bounded by providers × capabilities. Add it back once capabilities number in the thousands. Keep the generated `search` column |
| 5 | Index on `capabilities.provider_id` | Missing | Only `ingest` queries it (109 calls, 0.036 ms). A 137-row seq scan takes 0.07 ms (14) | **keep, no index** | Small by construction |
| 6 | `organisation_catalogue` | Read on every request through the primary-key prefix; `ingest` updates it by `provider_id and enabled` | 89 calls at 0.033 ms; 39 calls at 0.012 ms (05). At 75 organisations × 5 providers both seq-scan, in 0.07 and 0.044 ms (14). `updated_at` is written and never read | **keep, no `provider_id` index** | Small by construction (organisations × providers). `updated_at` is the only trace of a catalogue change, because admin API writes record no evidence |
| 7 | `host_clients` | Projection settings per host client; primary-key read on every request | 57 calls at 0.028 ms (05) | **keep** | The `CHECK` allows a `direct_limit` above 128 while the API caps it at 128 (`catalogue.ts:73`). Optional: `check (direct_limit between 1 and 128)` |
| 8 | `evidence_events.on_behalf_of`, `operation_id`, `target_type`, `target_id` | Chained; never written | Grep across `packages/*`, `mcps/*`: nothing outside `evidence.ts` sets them (only the layout test names them) | **delete** | They stand for Not-yet features (machine principals, operations). One `target_*` pair per event cannot hold an intent's array of targets. Future facts can go in `data`, which is chained and 4 KiB, with no format change, or into a `schema_version` 2 layout |
| 9 | `evidence_events`, the written columns | `receipt_id` (`intent-evidence.ts:36-37`, `toolbox.ts:124`), `execution_id` and `request_id` (`toolbox.ts:108`, `admin.ts:52`), `trace_id` and `span_id` (Toolbox), `upstream` (admin), `reason`, `error_code`, `payload_ref` and `payload_hash` | Grep (see 05 for every insert column list) | **keep** | Each has a writer |
| 10 | `evidence_events.kind` `CHECK` (16 values) | 8 are written: `capability.completed`, `capability.denied`, `intent.prepared`, `intent.approval_requested`, `intent.committed`, `intent.stale`, `intent.expired`, `receipt.issued` | Grep finds 0 production writers for `capability.requested`, `intent.approved`, `intent.denied`, `operation.started`, `operation.finished`, `run.started`, `run.finished` and `limit.refused` | **simplify** to the 8 that are written | `kind` is hashed as text, so adding a kind later is a `CHECK` change, not a chain-format change |
| 11 | `evidence_events.actor_type` | Always `user` | The type allows only the literal `"user"` (`evidence.ts:13`) | **keep** | Machine principals are Not yet, and a new value is not a format change |
| 12 | `evidence_events.id` and its primary key | Random UUIDv7, chained | The key had 0 scans in the Toolbox and admin suites (21). It costs 45 B a row, 8% of the 568 B a row costs (19). Nothing reads events by id outside the tests | **simplify** (optional) | `(organisation_id, seq)` already identifies an event: make it the primary key and drop `id` and its index |
| 13 | Chain trigger and hash layout | The trigger takes a per-organisation advisory lock, assigns `seq` and `prev_hash`, and computes `row_hash`; another trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` | The comment, the trigger and `evidence.ts` `chained` agree, 28 fields each. With every field set to a distinct value, a change to any one of the 28 fields, `prev_hash` or `row_hash` is caught (30 of 30, probe 08) | **keep** | Correct as built |
| 14 | `evidence_payloads` integrity | `verify` never reads payloads, and payloads have no update guard | A body changed with its hash kept: `verify` answers `{ ok: true }` (08) | **add**: `verify` compares `sha256(body::text)` with `hash` and with the event's `payload_hash` for unerased bodies, and a trigger refuses any update other than an erase | Today the body is protected by nothing. Both changes are a few lines |
| 15 | `evidence_payloads` against `intents.preview` | The payload is the intent's preview | 15 of 15 bodies equal `intents.preview` (07) | **design question** (see the questions) | `erase()` leaves the same JSON in `intents`, which is never deleted |
| 16 | Per-organisation advisory lock `hashtext(organisation_id)` | Serialises one organisation's writers | One organisation, 20 writers: 373 and 407 rows/s, p95 97 and 81 ms. Twenty organisations: 1,566 and 1,263 rows/s (09). `hashtext` is a 32-bit `int4`: 118 colliding pairs observed among 10⁶ UUIDs against 116.4 expected; the chance of a shared key is 6.5 × 10⁻⁷ for 75 organisations and 6.5 × 10⁻⁵ for 750 (16) | **keep** | A shared key only serialises two chains; each chain is still read by `organisation_id`. The admin MCP has a single chain (the platform's), at staff volume |
| 17 | Indexes on evidence by `intent_id` or `execution_id` | Missing | No code reads evidence by either. The documented erase snippet (`apps/web/content/docs/toolbox/index.mdx:230`) seq-scans: 40 ms at 200,000 rows, and 100 ms by `execution_id` (14) | **keep, no index** | Add `(intent_id) where intent_id is not null` with the first erase workflow, or filter the snippet by `organisation_id` |
| 18 | `evidence_payloads.organisation_id`, `created_at` | Written, never read | 2.4 ms seq scan at 40,000 rows (14) | **keep, no index** | Erasure or retention by organisation will need them |
| 19 | `intents.approval` | Written as `{required, status}` from `policy_class` | `prepare.ts:37` derives it; nothing reads `intent.approval` (grep `packages/mcp`, `mcps`). 47 B a row (11) | **delete** (the column and `Intent.approval`) | Redundant. Approvals are Not yet, and their record will be its own table (docs/08 `approvals`) |
| 20 | `intents` retention | The Postgres store never deletes. The memory store removes terminal intents, and committed ones 1 day after commit | SDK `intents.ts:58-70` against `mcp-postgres/src/intents.ts` (no `delete`). 1,952 B per live row, 3,531 B per mutation on disk (11) | **add** a sweep that deletes what the memory store's `removable` deletes, at most once a minute on insert | Both stores implement one contract, so they should behave alike. `input` and `receipt.results` stay forever although evidence never records inputs or results. The sweep seq-scans: 19.5 ms at 40,000 rows (14), and with the sweep the table holds about a day's intents. No index needed |
| 21 | Expiry, which runs twice | `withEvidence` calls `store.expire`, then `store.get` and `store.transition` expire again | 5 expire `UPDATE`s per mutation where 2 to 3 would do (11; admin suite: 44 against 16 compare-and-sets, 05). With `expires_at` between the two clock reads, the intent ends `expired` with 0 `intent.expired` rows (12) | **simplify**: one expire per call. The store reports what it expired and the wrapper records it | Duplicate logic that loses evidence. The window is small but real |
| 22 | `intents` constraints | The schema refuses unknown statuses and a receipt that does not match `committed` | It accepts `expires_at < created_at`, any `commit_token_hash`, `targets` that are not an array, a status moving backwards, and an `input` rewritten after prepare (13). The SDK guarantees `expiresInMs >= 1` (`mutation.ts:141`) | **add** `check (expires_at > created_at)` and `check (commit_token_hash ~ '^[0-9a-f]{64}$')`. Not an immutability trigger | Two cheap constraints. The compare-and-set in one store is the only writer of status |
| 23 | `commit_token_hash` comparison | Done in the SDK, not in SQL | `commit.ts:103` (`hashToken(…) !== intent.commit_token_hash`). Single use comes from the compare-and-set `prepared → committing` (`commit.ts:119`) | **keep** | Comparing digests leaks nothing useful |
| 24 | JSON as text (`::text::jsonb`), `jsonb` type | Stores and returns the JSON | Bound straight to `::jsonb`, Bun 1.3.1 refuses numbers and booleans and turns JSON `null` into SQL `NULL`; through text all six JSON kinds survive (18). `jsonb` reorders keys | **keep** | `plan` is `unknown`, so the text route is required. Nothing hashes intent JSON today; an approval digest (Not yet) must canonicalise its input itself |
| 25 | Index on `intents (organisation_id, status, expires_at)` | Missing | Nothing reads it. An approvals list would seq-scan in 5.3 ms at 40,000 rows (14) | **keep, no index** | Add it with the approvals page, if the sweep has not already kept the table small |
| 26 | Migration numbering: one sequence across two directories, sorted globally by name, recorded by name | Files 0001 and 0003 (Toolbox) and 0002 and 0004 (package) | The admin MCP records `0002, 0004` with gaps (17a). A server file that refers to the package's tables and sorts first fails on a fresh database: `relation "intents" does not exist` (17c). No file refers to the other directory's objects today (17d) | **simplify** (reset below) | Order should follow dependency, which is the directory order, not the alphabet |
| 27 | Refusal of duplicate names (`migrate.ts:21`) | Refuses two files with one name across directories | Code | **delete** once records are namespaced | It is needed only because names are global |
| 28 | The legacy-layout test and the "never rename" rule | Prove that a database migrated from one directory is not migrated again | `mcps/toolbox/src/db/migrate.test.ts:56-73`; `packages/mcp-postgres/README.md:24`; CHANGELOGs | **delete** | No database was ever deployed |
| 29 | `schema_migrations (name, applied_at)` | Records the name only | An applied file edited afterwards is skipped silently and the schema stays old (17b). ID's Drizzle migrator stores a hash but never compares it (`drizzle-orm@0.45.2/pg-core/dialect.js:56-69` compares `created_at` only) | **add** `checksum text not null` (SHA-256 of the file) and refuse on a mismatch | About 4 lines. It catches exactly the edit a reset invites |
| 30 | Migrator mechanics | Advisory lock, a transaction per file, `.simple()` for multi-statement files, and the table created under the lock | `migrate.ts:26-39`; CHANGELOG records the catalogue collision that motivated the lock | **keep** | Correct as built |
| 31 | `mcp:new` scaffold | Writes no database code; the server uses the memory intent store | `scripts/mcp-templates.ts:22-26`; `server.ts:156` | **keep** | Only the Toolbox and the admin MCP need Postgres |
| 32 | Admin MCP storage | Uses only the package's `intents` and evidence tables, plus `select 1` for `/health` | `admin.ts:35-42,65`; `scripts/migrate.ts:14` migrates `[migrations]` alone. `answerable_admin` serves `admin:dev` and `answerable_admin_test` the suite's reset. `infra/postgres/init/004-create-mcp-databases.sql` creates both, plus `answerable_mcp_postgres_test` | **keep** separate databases | Sharing the Toolbox's database under a schema saves one init line but couples backups, credentials and retention for staff evidence and customer evidence. `mcp:test` also runs the suites concurrently on separate databases |

### Proposed migration reset

| Directory | Files after the reset | Recorded as |
|---|---|---|
| `packages/mcp-postgres/migrations/` | `0001_evidence.sql`, `0002_intents.sql`, with findings 8, 10, 12 (if chosen), 14, 19 and 22 applied (or one `0001_initial.sql`) | `mcp-postgres/0001_evidence.sql` |
| `mcps/toolbox/migrations/` | `0001_initial.sql` (catalogue and `host_clients`, with findings 1, 2 and 4 applied) | `toolbox/0001_initial.sql` |

- **Migrator change:** `migrate(db, [{ name: "mcp-postgres", url }, { name: "toolbox", url }])`. It applies the directories in the order given (the package first) and the files of each directory by name, and records `namespace/file` with its checksum.
- **What it removes:** the global sort, the duplicate refusal and the gaps. The next file in a directory is simply that directory's next number.
- **References to update:** `mcps/toolbox/README.md:37`, `packages/mcp-postgres/README.md:22-24`, `evidence.ts:40`, `migrate.ts:4`, `mcps/toolbox/src/db/migrate.ts:6`, both `migrate.test.ts`, `apps/web/content/docs/toolbox/index.mdx:214` and the header of `0002_evidence.sql`, which still says "The Toolbox's evidence".

## Measured numbers

**01–04. Suites** (`04-suites-stat.sh`)

| Suite | Result |
|---|---|
| `@answerable/mcp-postgres` | 24 pass, 0 fail, 688 ms |
| Toolbox | 79 pass, 0 fail, 3.35 s |
| Admin MCP | 120 pass, 6 skipped (conformance checks that do not apply), 0 fail, 5.87 s |

**05. Statement shapes** (`pg_stat_statements` after one run of each suite; selected rows, all in `05-statements.out`)

| Statement | Calls | Mean ms | Index |
|---|---|---|---|
| Trigger: last row of an organisation | 1,051 / 85 / 47 | 0.009 / 0.024 / 0.027 | `(organisation_id, seq)` backward |
| Capability version guard, by `(identity, version)` | 458 | 0.029 | Primary key |
| Capabilities by `provider_id` | 109 | 0.036 | Seq scan, 137 rows |
| Catalogue by organisation (every request) | 89 | 0.033 | Primary-key prefix |
| Host client by id (every request) | 57 | 0.028 | Primary key |
| Expire `UPDATE` / compare-and-set `UPDATE` (admin) | 44 / 16 | 0.025 / 0.112 | Primary key |
| Search | 14 | 0.102 | Seq scan |
| `evidence_events` insert (all shapes) | 2 to 33 each | 0.79 to 5.5 | Primary key and unique index |

**08. Hash layout**

| What | Result |
|---|---|
| Fields in the comment, the trigger and `evidence.ts` | 28 / 28 / 28, the same order |
| Single-field changes caught | 30 of 30 |
| Payload body changed, hash kept | `verify` → `{ ok: true }` |

**09, 10, 14, 15. Chain cost** (two measurements per row, sources in brackets)

| What | Measurement 1 | Measurement 2 |
|---|---|---|
| 10,000 sequential `record()` | 3.76 ms/row, 266/s (`09…out`) | 6.52 ms/row, 153/s (`09…rerun.out`) |
| The same rows without the trigger, a transaction each | 2.92 ms/row (`09…out`) | 3.56 ms/row (`09…rerun.out`) |
| `verify()` over 10,000 rows | 120, 80, 71 ms (`09…out`) | 150, 131, 158 ms (`09…rerun.out`) |
| One-row insert, server side (`pg_stat_statements`), chained against plain | 1.03 against 0.83 ms (`10…out`) | 1.07 against 0.10 ms (`10…rerun.out`) |
| 160,000 rows in one statement, server side, chained | 0.144 ms/row (14, seeding) | 0.377 ms/row (15) |
| The same without the trigger | 0.045 ms/row (15) | 0.083 ms/row (15) |
| 20 writers, 1 organisation, 5,000 rows | 373/s, p50 47 ms, p95 97 ms (`09…out`, pass 1) | 407/s, p50 41 ms, p95 81 ms (`09…out`, pass 2) |
| 20 writers, 20 organisations, 5,000 rows | 1,566/s, p50 10 ms, p95 28 ms (pass 1) | 1,263/s, p50 12 ms, p95 34 ms (pass 2) |

For scale, 373 events/s for one organisation means a 1,000-member organisation reaches the cap only if every member calls once every 2.7 s.

**11, 19. Growth** (1,000 agent-class mutations through `withEvidence(createPostgresIntentStore)` with the Toolbox suite's `e2e/records.delete` JSON; 100,000 read-shaped events)

| Table | Rows per mutation | Bytes per mutation (heap, indexes, TOAST) | At 1,000 mutations a day |
|---|---|---|---|
| `intents` | 1 (1,952 B live row; `receipt` 864, `preview` 480, `targets` 174, `approval` 47) | 3,531 (includes update churn) | 3.5 MB a day; a day's worth with a sweep |
| `evidence_events` | 5 (2 `capability.completed`, `intent.prepared`, `intent.committed`, `receipt.issued`) | 2,712 | 2.7 MB a day |
| `evidence_payloads` | 1 | 721 | 0.7 MB a day |
| All three | | 6,963 | 6.96 MB a day, 2.54 GB a year without a sweep |
| A read call | 1 event | 568 (heap 455, `(organisation_id, seq)` index 68, `id` key 45) | 0.57 MB per 1,000 reads |

Statements per mutation: 5 expire `UPDATE`s, 2 `SELECT`s of the intent, 2 compare-and-set `UPDATE`s, 1 intent `INSERT`, 5 event `INSERT`s and 1 payload `INSERT`.

**12, 13. Intents**

| What | Result |
|---|---|
| An intent that expires between the two clock reads | Ends `expired` with 0 `intent.expired` events |
| What the schema refuses | Unknown status; `committed` without a receipt; a receipt on a prepared intent |
| What the schema accepts | `expires_at < created_at`; a human-class intent `prepared` without approval; an agent-class intent `awaiting_approval`; `approval` as `"yes"`; a malformed token hash; `targets` as an object; `committed → prepared`; `input` rewritten |

**14. Query plans at 200,000 events, 40,000 intents, 137 capabilities and 375 catalogue rows**

| Query | Plan | Time |
|---|---|---|
| Trigger's last-row lookup | Index scan backward | 0.027 ms |
| One `verify` page of 1,000 rows | Index scan | 0.50 ms |
| Evidence by `intent_id` (the docs' erase snippet) | Parallel seq scan | 40 ms |
| Evidence by `execution_id` | Parallel seq scan | 100 ms |
| Payloads by organisation | Seq scan | 2.4 ms |
| Capabilities by provider | Seq scan | 0.07 ms |
| Catalogue by provider and `enabled` | Seq scan | 0.044 ms |
| Catalogue by organisation | Seq scan | 0.07 ms |
| Sweep count | Seq scan | 19.5 ms |
| Approvals list | Seq scan | 5.3 ms |

**16, 17, 18, 20, 21. The rest**

| What | Result |
|---|---|
| `hashtext` | `int4`; 118 colliding pairs observed in 10⁶ UUIDs, 116.4 expected. Chance of a shared key: 6.46 × 10⁻⁷ for 75 organisations, 6.54 × 10⁻⁵ for 750, 0.0065 for 7,500 |
| Migrator | Gaps (`0002, 0004`); an edited applied file applies nothing; a server file that sorts first fails; no cross-directory references |
| JSON binding | Direct binding fails for numbers and booleans and turns JSON `null` into SQL `NULL`; the text route survives all six kinds |
| Search plan | Seq scan with and without the GIN index |
| Index usage after the suites | `capabilities_search` 0 scans; `evidence_events_pkey` 0 scans in the Toolbox and admin suites |
| Provider manifests | 2,209 B stored on average |

## Questions for the owner

| Question | Recommended answer |
|---|---|
| Should the Postgres intent store delete what the memory store deletes (terminal intents, and committed ones after the 1-day replay)? | **Yes.** It bounds `intents` to about a day, stops keeping `input` and `results` forever, and makes `erase()` of the preview payload real. Evidence retention stays with `Q-EVIDENCE-RETENTION`; feed it the numbers above |
| Should the 4 unwritten evidence columns and 8 unwritten kinds be cut now, or kept as slots? | **Cut now.** Nothing has shipped; new facts fit in the chained `data`, and kinds are a `CHECK` change |
| `providers`: reduce it to `id`, or delete it with its two foreign keys? | **Reduce it to `id`.** It keeps the foreign keys for one column. The admin API already refuses unmounted providers in process |
| Migration scheme: namespaced records in directory order with a checksum (a small code change), or file-name prefixes with no code change? | **Namespaced records with a checksum.** Prefixes order by alphabet, which breaks for a server whose name sorts before `mcp-postgres` |
| Drop `evidence_events.id` and key events by `(organisation_id, seq)`? | **Optional: yes.** It saves 8% of every event and nothing reads it. Keep `id` only if events need one global handle |

## Did not get to

- Behaviour of the trigger under `REPEATABLE READ` or `SERIALIZABLE` callers (not verified; `record()` uses the default `READ COMMITTED`).
- Timings on dedicated hardware: every number here comes from Docker on macOS under shared load, and the last rerun stopped when the VM disk filled. Another process on the host had filled it; I did not touch other containers or Docker's caches.
- Atomicity of an intent write and its evidence: they are separate transactions in `withEvidence`. Not assessed.
- The acceptance journeys (`bun run mcp:test:e2e`): not run.
- Drift between docs/08's intent table (`input_fingerprint`, `idempotency_key`, and the statuses `approved`, `denied`, `cancelled`) and what is built. Noted, not audited.
