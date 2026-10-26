# Pull request 13 audit: progress

## 2026-10-26

- The owner asked for an audit of the pull request once M9 has landed, with the plan in files and the report before any code changes.
- Wrote `task_plan.md` and `findings.md`, and measured the pull request before M9 (`findings.md`, Baseline).
- The owner confirmed the scope: PR #13 and what it reshapes, not the whole repository.
- M9 is running in the worktree. The audits start once it has been reviewed and committed.
- **M9 committed and pushed** as 7ffd16b4. The coordinator's gates were all green, and the acceptance, run alone, gave 69 pass in 150 s. The post-M9 baseline and M9's open items are in `findings.md`.
- **The six audits (A to F) started** on 7ffd16b4, each an Opus agent, read-only, working from `auditor-brief.md`. Their reports go to the session scratchpad, under `pr13-audit/<letter>/report.md`.
- **All six audits reported** (A 12, B 11, C 17, D 19, E 13, F 18 findings). With M9's six open items and the overlaps merged, that is 83 distinct findings. Every finding is recorded in `findings.md` with how it was checked.
- **Reproduced by this session:**
  - the role switch across MCPs (B2);
  - the empty-value rule (A2).
- **Measured by this session:** the test gate with 50 and with 100 generated MCPs (F18). It passes at 50 and fails at 100 with `too many clients`. All 150 MCPs were dropped afterwards.
- **The report,** `report.html`, is published as https://claude.ai/artifact/WadRa6EXTco4AxzsFPPt8y. It holds 11 defects to fix, 7 decisions for the owner, the recommended cleanups and the proposals recommended against.
- **The owner decided:**
  - D-1: one process;
  - D-2: keep the `own` mode, against the recommendation;
  - D-3: grants;
  - everything else as recommended.

  Recorded in `decisions.md`.
- **The six audit reports** are copied into `audits/`. The briefs R1 to R6 are written in `briefs/`. R1 starts.

- **R1, the defects,** by Opus. All eleven are fixed, each with a test that failed first.
  - **A4:** `ID_HOST`, loopback unless the image sets `0.0.0.0`.
  - **C3:** readiness fails only on the server's own database. MCP databases are reported within 250 ms.
  - **F18:**
    - `mcp:test` runs through Turborepo with `--concurrency=4`, its cache off, `--continue` and `--env-mode=loose`.
    - Measured: 200 generated MCPs pass, 2,225 tests in 46.6 to 52.0 s, at no more than 15 connections. Cap 16 times out from CPU load. CI's runner has 4 vCPUs.
  - **F1:** the local path's prerequisites.
  - **F2:** an unserved MCP's dependency is dropped (proven by deleting 100 MCPs).
  - **F3:** one rule for organisation filtering.
  - **C5:** in the Toolbox only. Done in the SDK, it would make the admin MCP read ID for an outsider's refused call, which its test forbids.
  - **D11, A8, F11:** the lockfile also had `packages/acceptance` stale.
  - **E12, E13, F13, M9's status lines.**
  - **Also fixed,** outside the audit: the CLI end-to-end test failed about 1 run in 16 on the sort order of its roles.
  - **The agent's gates:**
    - `mcp:test`: 1,025 pass;
    - ID: 1,493, at 100%;
    - the acceptance: 69;
    - kind: 123;
    - web: 120;
    - knip clean.
- **The coordinator's review of R1:** the diff matches the brief. The gates:
  - frozen install unchanged;
  - typecheck and lint forced: 21 of 21;
  - build: 2 of 2;
  - `mcp:test` on the new runner: 14 of 14 tasks in 29 s;
  - web: 120;
  - knip clean;
  - `infra:check` passed.
- **R2, one process (D-1),** by Opus.
  - **The Toolbox now serves every standalone or `both` MCP** at `<TOOLBOX_STANDALONE_ORIGIN>/<name>/mcp`:
    - one `createMcpServer` per such MCP, with its own scope check and its own `createCalls`;
    - routing by the first path segment, falling back to the hub;
    - tested in `alone.test.ts` (8 tests), including tokens refused across paths and the hub.
  - **Deleted:**
    - `mcps/standalone` (−1,971 lines; 179 moved into the Toolbox);
    - its database, its logins and `answerable_mcps_standalone`;
    - `standalone-hub`, `standalone-migrate`, `mcps-migrate` (merged into `toolbox-migrate`), its Deployment and network policy, and init `007`.
  - **The `mcp` host's Ingress** now points at the Toolbox's Service.
  - **`standalone_enable`** loses `hostClientIds`, which only a test passed. A missing `claude-code-<name>` now answers `NOT_FOUND`.
  - **Local standalone URLs move from 47510 to 47400.** Deployed URLs are unchanged.
  - **Re-measured:**
    - the release at 200 MCPs: 59,528 bytes, 5.7%;
    - the connection ceilings: 230 / 320 → 170 / 240.
  - **Size:** 193 files, +1,278 / −3,366.
  - **The agent's gates:**
    - `mcp:test`: 1,019 pass;
    - the acceptance: 69;
    - web: 120;
    - knip clean;
    - `infra:check` passed.

    `infra:test` stopped at install: Docker Desktop's disk was full (1.4 GB free of 58.4 GB).
- **The coordinator, on R2:**
  - **Reviewed** the routing, the merged migration Job and the `mcp` Ingress.
  - **Removed** the 12 untagged Answerable images this goal's kind runs had left, by ID, with no prune. That freed about 0.4 GB, since they share layers. The rest of Docker's disk is other projects' containers and volumes, plus the shared build cache, which are the owner's to clear.
  - **Dropped** the standalone databases and logins that init `007` had made on the development Postgres.
  - **Gates:**
    - frozen install unchanged;
    - typecheck and lint forced: 20 of 20;
    - build: 2 of 2;
    - `mcp:test`: 13 of 13 tasks in 44 s;
    - web: 120;
    - knip clean;
    - `infra:check` passed.
  - **The kind stack** runs in CI on the push, on a clean runner.
- **CI on R2 (c9834a88):** passed.
  - `containers`, the kind stack: 4 min 2 s.
  - `validate`: 9 min 51 s. It covers typecheck, lint, build, web, `mcp:test`, the acceptance and ID.
  - `infra-check`: passed.

  So the kind stack proves D-1 on a clean runner.
- **R3, grants instead of per-MCP roles (D-3),** by Opus.
  - **Provisioning:** each MCP gets a schema owned by the migrator, and `USAGE` for the Toolbox's login. It makes no role. The role lock stays, because concurrent grants on one database fail with "tuple concurrently updated" (measured).
  - **Migration:** drizzle's own migrator runs as the migrator login, with the journal in the MCP's schema. After each migration, the serving login gets DML on the MCP's tables and every other privilege is revoked.
  - **Deleted:**
    - the hand-written loop and the scanner (B3);
    - `role-switching.ts` and `check`'s scan;
    - the role prefixes and `TOOLBOX_MCPS_ROLE_PREFIX`;
    - the reset on release (B6).
  - **The serving-login check** refuses:
    - any attribute beyond `LOGIN`;
    - any membership;
    - anything owned;
    - `CREATE` on a schema;
    - `CREATE` or `TEMPORARY` on the database;
    - a missing `USAGE`.

    `assertOwnLogin` is merged into it.
  - **Row-level security** is proved again: a serving login that owns nothing sees only its organisation's rows, and none with the setting reset.
  - **The 200-MCP benchmark,** against M9:

    | What | R3 | M9 |
    |---|---|---|
    | Roles made | 0 | 400 |
    | Provisioning | 102 to 121 ms | 0.70 to 0.73 s |
    | First migration | 2.41 to 2.62 s | 1.96 to 2.16 s |
    | Migration with nothing pending | 1.12 to 1.24 s | 1.16 to 1.36 s |
    | One query | 0.40 to 0.43 ms | 0.47 to 0.51 ms |
    | Burst of 1,000 | 139 to 243 ms | 192 to 198 ms |
  - **Size:** 81 files, +534 / −806.
  - **The agent's gates:**
    - `mcp:test`: 1,007 pass;
    - the acceptance: 69;
    - charts: 92;
    - web: 120;
    - knip clean.

    `infra:test` was not run (Docker's disk); CI runs it.
  - **For the owner:**
    - **The development Postgres** still holds the old model: schemas `e2e` and `example` owned by `mcp_*_owner`, and eight old roles. The serving-login check refuses to start the Toolbox there until they go. The permission check refused the agent's drop as irreversible, so it is left to the owner.
    - **The deleted scan** also flagged `answerable.organisation_id` in an MCP's `src`. Nothing replaces that lint.
- **The coordinator, on R3:**
  - **Reviewed** provisioning, the grant step and the serving-login check.
  - **Gates:**
    - frozen install unchanged;
    - typecheck and lint forced: 20 of 20;
    - build: 2 of 2;
    - `mcp:test`: 13 of 13 tasks in 33 s;
    - web: 120;
    - knip clean;
    - `infra:check` passed.
  - **The kind stack** runs in CI on the push.
- **The owner's follow-ups,** done by the coordinator (`decisions.md`, Follow-ups):
  - the development Postgres cleaned and migrated under the new model, with the Toolbox's login passing its check;
  - the organisation guard added to R5's brief;
  - Docker's build cache cleared, 11 GB.
- **CI on R3 (b4081e52):** passed. `containers` (the kind stack), `validate` and `infra-check` all succeeded, so the grants model holds in the kind stack.
- **R4, configuration, database, SDK and shipping cleanups,** by Opus.
  - **Done:**
    - **Configuration:**
      - A1: one `local` value;
      - A2: an empty or blank variable is unset, while `NODE_ENV=""` is still refused. Production behaviour changes are listed in the agent's report, such as an empty `PORT` becoming the default instead of being refused;
      - A3: `default.env` deleted, with the hand-written groups;
      - A5 and C17: `parseEnvironment` moved to `mcp-platform`;
      - A6: three ops variables are constants;
      - A7: the chart's `runtimeRole` values deleted;
      - A9: own MCPs' migration variables inventoried;
      - A10 and E8: one `declaredMcps` schema;
      - A11, A12.
    - **Database:**
      - B4: `ensureLocalMcpDatabases` deleted, with one command documented for older volumes;
      - B5: the `grants.ts` hook deleted;
      - B8: test-migrate scripts split out of the production scripts;
      - B11: the bootstrap test asserts what `provisionMcps` is handed.
    - **SDK:**
      - C7: `createIdProfiles` moved to `mcp-platform`, so `id-admin` depends on zod alone;
      - C8: `context.client` deleted;
      - C12 and F10: one fake of ID's admin API, `createFakeId`, which gained break glass, the root lock, per-caller idempotency and injected failures.
    - **Shipping:**
      - E4: the staff-token path deleted; the remedy for a locked root is break glass;
      - E5: `run-job bootstrap` deleted;
      - E9: the `mcps` image copies `packages/`, +0.18%;
      - E10: the `enabled` switches deleted.
  - **Not done:**
    - **F17's call to `checkProviderId`.** `names.ts` is on the ops image's runtime path, and the ops image doesn't carry the SDK. The duplicate rule stays, held equal by its test.
    - **C9, stopped before any code.** It touches pre-PR code:
      - the Toolbox's `/enable`, which `bun mcp dev`, three acceptance set-ups, the admin MCP's tests and 13 docs pages use;
      - register, which cannot narrow staging's existing `toolbox-hub` capability without narrowing code or a one-off admin call.
  - **Size:** 141 files, +916 / −1,893, without the plan files.
  - **The agent's gates:**
    - `mcp:test`: 1,004 pass;
    - ID: 1,493, at 100%;
    - the acceptance: 69;
    - kind: 123, now that Docker's disk is free;
    - web: 120;
    - knip clean.
- **The coordinator:** removed by ID the three untagged Answerable images the earlier kind runs left, about 711 MB.
- **The coordinator's gates on R4:**
  - frozen install unchanged;
  - typecheck and lint forced: 20 of 20;
  - build: 2 of 2;
  - `mcp:test`: 13 of 13 tasks in 30 s;
  - web: 120;
  - knip clean;
  - `infra:check` passed.
- **R4 committed** as d1c46569 and pushed. **R5 started.**
- **C9 moves to its own PR.** It is proposed as a follow-up session, "Take platform:write off the Toolbox (audit C9)", to start from `main` once PR #13 has merged. The reasons are in R4's entry: it rewrites code from before the PR, and register needs a way to narrow staging's existing `toolbox-hub` capability.
- **CI on R4 (d1c46569):** passed, the kind stack included.
- **R5, the CLI, tests and docs,** by Opus.
  - **The CLI:**
    - D3: `--json` deleted;
    - D6: no default status tool; `withTool` shared by `new` and `add tool`; `mcps/example` loses `example.status`, and the context is shown through `src/docs/caller.ts`;
    - D14: guidance written once;
    - D2: a documented way to drop an unwanted table;
    - D7: `--no-check` deleted;
    - D8: provision after the migration;
    - D9 and E7: `grants` deleted;
    - D10: every MCP migrated in one process;
    - D13: the generated README deleted;
    - D16: `mcp.json` is `{ serve, database }`;
    - D17: the docs name only `bun mcp check`;
    - D18: `parseArgs`. A repeated flag now takes its last value, `--` ends the flags, and a value starting with `-` is refused;
    - D19: a reason beside each reserved name;
    - the organisation guard: a `guard` step in `bun mcp check`, error row `organisation-setting`.
  - **Tests:**
    - F4 and F15: refusals asserted once, with typed codes;
    - F5: the snapshot (473 lines) replaced by "`mcps/example` is what `bun mcp` writes";
    - F8: `mcps.journeys` deleted, and the real-ID organisation-name test moved into `mcp-cli.journeys`;
    - F9: the CLI's end-to-end test is now the acceptance's `scaffold.journeys`;
    - F14: the three web tests deleted.
  - **Docs:**
    - F6: `mcp/run-locally.mdx` is new, and `local-testing.mdx` falls from 7,275 to 2,906 words;
    - F7: the by-hand recipes deleted;
    - D-2: what `own` isolates;
    - D-5: e2e and example in docs/12;
    - D-7: nine CHANGELOGs deleted;
    - the register row `Q-TOOLBOX-CALL-REGISTRATION`;
    - F12: `AGENTS.md` falls from 3,074 to 2,891 words.
  - **`mcp:test` concurrency re-measured.** It stays at 4: cap 8 was not consistently faster at 200 MCPs (33–41 s against 38–41 s), and CI has 4 CPUs.
  - **Size:** about +1,233 / −3,327.
  - **The agent's gates:**
    - `mcp:test`: 944 pass in 10.4 s (30 s at R4);
    - web: 117;
    - the acceptance: 65;
    - the scaffold journey: 19.5 s;
    - kind: 123;
    - the release at 200 MCPs: 50,672 bytes, 4.8%.
  - **The new by-hand sign-in steps,** replacing the CLI goal's status-tool steps:
    - `bun mcp setup`;
    - `bun mcp dev example` and the printed `claude mcp add` for the Toolbox;
    - Authenticate;
    - `example_notes_list`, then `example_notes_add`, whose preview names your organisation;
    - for a standalone MCP, `bun mcp dev e2e` and `claude mcp add … http://localhost:47400/e2e/mcp --client-id claude-code-e2e`, then `records_list`.
- **The coordinator, on R5:**
  - Corrected `deploy.mdx:91`: a locked root now ships with break glass, not a staff token in the cluster.
  - Left for R6: the CLI no longer prints its error codes, though the docs' error table lists them.
- **The coordinator's gates on R5:**
  - frozen install unchanged;
  - typecheck and lint forced: 20 of 20;
  - build: 2 of 2;
  - `mcp:test`: 13 of 13 tasks in 11 s;
  - web: 117;
  - knip clean;
  - `infra:check` passed.
- **R5 committed** as 33ed630d and pushed.
- **R6:** the proof agent (gates, the end-to-end proof in kind, the numbers) and the newcomer agent started on 33ed630d.
- **R6's newcomer read** (Sonnet), docs only, in a copy:
  - **Every runnable command worked as documented:**
    - `new` with a tool, in 4.2 s;
    - `add tool` for a mutation;
    - `db generate` and `migrate`;
    - `check`, at 100%;
    - six refusals, each matching its row.
  - **It stopped, as expected, at the local sign-in.** ID was not running, and the refusals said why.
  - **It found 14 docs problems and 2 CLI points.** The worst:
    - local sign-in needs directory credentials no page explains;
    - the root secret's development value is in no doc;
    - the first-run steps use the deployed origin;
    - shipping's status contradicts itself between `index.mdx` and `deploy.mdx`;
    - what to commit is said three ways;
    - nothing says what to do when changing a shipped tool. Verified by the coordinator: the Toolbox's ingest refuses a changed contract under the same version (`mcps/toolbox/src/catalogue.ts:42`), so a missed bump fails the staging deploy, and nothing catches it before;
    - `bun mcp dev`'s refusal names itself as the fix.
  - **All of it goes into brief R6b,** run after the proof agent, since both would use the shared test databases.
  - **For the owner:** a check in `bun mcp check` comparing a tool's contract with `main`'s manifest would catch the version case before shipping. It is an addition, not a fix, so it is put to the owner.
- **R6's proofs** (Opus), on 33ed630d. Each heavy run ran alone.
  - **ID:** 1,493 pass, 100% lines and functions, 303 s.
  - **The acceptance:** 65 pass, 166 s; nothing left behind.
  - **The end-to-end proof from a clean copy, without a terminal:**
    - `prooftb` (`toolbox`), `proofsa` (`standalone`) and `proofbo` (`both`, `own`), each with `items.list` and `items.add`, then `check`;
    - 12 commands, all exit 0, each in 2.7 to 4.1 s; 62 files, +2,560 lines, nothing edited by hand.
  - **The kind stack from the copy: 130 pass** (123 and 7 proofs), 209 s. Each proof held:
    - the bootstrap provisioned both shared schemas, and `proofbo`'s database and two logins;
    - `toolbox-migrate` migrated all three, as the migrator or `proofbo`'s owner, with row-level security on;
    - the serving logins hold DML only;
    - `/health` lists all five MCPs;
    - `/proofsa/mcp` and `/proofbo/mcp` answer their metadata, and `/prooftb/mcp` answers 404;
    - register made each standalone MCP's resource and client;
    - a person signed in at each path after `standalone_enable`, in 0.5 s, and called `items_list`;
    - the same person signed in through the Toolbox after `toolbox_enable` and `access_grant`, and saw only `prooftb_*` and `proofbo_*`;
    - `proofbo_items_add` was committed and then listed, so a write reached `proofbo`'s own database.
  - **Afterwards:** every MCP was forgotten, with no traces. The copy and the cluster are gone. Docker was restored to its earlier `:local` images, and the three images built from the copy were removed by ID.
  - **The numbers at 200 MCPs,** against M9:

    | What | R6 | M9 |
    |---|---|---|
    | Roles made | 0 | 400 |
    | Provisioning | 108 to 122 ms | 0.70 to 0.73 s |
    | First migration | 2.08 to 2.14 s | 1.96 to 2.16 s |
    | Migration with nothing pending | 1.03 to 1.29 s | 1.16 to 1.36 s |
    | One query through `mcpDatabase` | 0.38 ms | 0.47 to 0.51 ms |
    | Burst of 1,000 queries | 126 to 137 ms | 192 to 198 ms |
    | 1,000 tool calls at once | 5.05 to 5.14 s | 5.18 to 5.94 s |
    | One call, median | 10.3 to 10.6 ms | 10.7 to 12.3 ms |
    | Helm release | 50,672 bytes, 4.8% | 61,680 bytes, 5.9% |
    | `mcp:test` with 200 MCPs | 2,144 pass in 39.3 s, peak 7 connections | broke before 100 MCPs |
  - **Noted:**
    - tool names at a standalone path are unprefixed (`items_list`), as the template says;
    - one own MCP already takes the connection budget past PostgreSQL's default 100, which belongs with the owner's Civo `max_connections` item.
- **R6b, the newcomer's findings,** by Opus. All 16 items are done:
  - two routes to a local sign-in, the host lane checked by running it;
  - the root secret's development value;
  - `$ID` in the first-run steps;
  - one local-start recipe;
  - `run-locally` in the reading order;
  - shipping's status;
  - one rule for what to commit;
  - "Change a tool after it ships". A field description counts as a contract change too, and the deploy shows only Helm's failure; the Toolbox pod's log has the reason;
  - the migration workflow;
  - one way to regenerate the manifest;
  - the skipped tests;
  - a Toolbox `bun mcp dev` output;
  - `high` risk marked Not yet;
  - tag names and the hand-off;
  - `bun mcp dev`'s fix line, now `bun mcp setup`, test first;
  - `Next:` after `new --tool`.

  Size: 22 files, +225 / −75. The agent's gates passed, the acceptance (65) included.

### Every finding the owner approved, accounted for

| Audit | Done | Not done, and why |
|---|---|---|
| A, configuration (12) | A1–A8, A10–A12 (R1, R4); A9's inventory half (R4) | A9's deletion: D-2 keeps `own` |
| B, database (11) | B2, B3, B6, B9 (R3); B4, B5, B8, B11 (R4); B7 (R2) | B1: D-2. B10: a keep, with Civo's `max_connections` the owner's item |
| C, SDK and servers (17) | C2, C11 (R2); C3, C5 (R1, C5 in the Toolbox only); C7, C8, C12, C17 (R4); C13 (accepted, D-5, documented in R5) | C1: D-1 chose C2. C4: D-4. C6: kept, since standalone MCPs remain. C9: moved to a follow-up (R4). C10: D-2. C14, C15, C16: recommended against |
| D, CLI (19) | D1 (docs in R1 and R6b, sign-in by hand is the owner's); D2, D3, D6–D10, D13, D14, D16–D19 (R5); D11 (R1) | D4: kept, the owner's ask. D5: the table kept, F4 and F15 taken. D12: D-2. D15: recommended against |
| E, shipping (13) | E1, E6, E11 (R2); E4, E5 (bootstrap only), E8, E9, E10 (R4); E7 (R5); E12, E13 (R1, R2); E3 (accepted, D-5) | E2: moot after R2. E5's `chartAt` rewrite: recommended against |
| F, tests and docs (18) | F1, F2, F3, F11's lockfile, F13, F18 (R1); F4–F9, F12, F14, F15 (R5); F10 (R4); F11's CHANGELOGs (D-7, R5) | F16: moot after R2 and R3. F17's call to `checkProviderId`: it would break the ops image |
| M9's open items (6) | 2 = D11; 3 = A10; 4 (R1); 1, a register row (R5) | 5 = F16, moot. 6: raise the sign-in budget when a proof needs it |
- **The coordinator, on R6b:**
  - **Reviewed** the fix line's logic.
  - **Gates:**
    - frozen install unchanged;
    - typecheck and lint forced: 20 of 20;
    - build: 2 of 2;
    - `mcp:test`: 13 of 13 tasks in 12 s;
    - web: 117;
    - knip clean;
    - `infra:check` passed.
  - **Written:** the dated evidence section in `reports/mcp-foundation-evidence.md`, and the table above.
- **The audit's diff** outside the planning files: 323 files, +4,183 and −9,176, net 4,993 lines fewer. In code: +3,339 and −5,037.
