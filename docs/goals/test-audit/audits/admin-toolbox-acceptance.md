# Test audit, area D: the admin MCP, the Toolbox and the acceptance

Audited on 3 October 2026 in worktree `agent-a31616748755b5961` at `491c9e9`, Bun 1.3.1, against Postgres on port 47436. Every number below comes from a run recorded here; "by reading" marks the few claims no run backs. All probe edits were restored (`git status --short` empty at the end).

## Summary

- **Verdict.** The area's security checks mostly fail a test when broken: 33 of 37 source probes did. Of the other 4, two change no behaviour (P1a, P4b) and two are real gaps (P9c, P11b). But `docs/11-admin-mcp.md`'s claim that `admin.test.ts`, `writes.test.ts` and the admin journeys hold all ten invariants is false for four of them: the escalation guard and the freshness rule are tested on some tools only, the audience check is held only in `packages/auth` and `packages/mcp`, "no tool takes a secret" only by the manifest snapshot, and invariant 10 by nothing.
- **Counts.** 407 tests: admin MCP 235 (17 todo), Toolbox 94 (2 todo), acceptance 78. By class: INV 87, CON 77, BEH 91, DUP 103, FILL 22, IMPL 8, todo 19.
- **Finding 1: per-tool guard gaps.** No test catches dropping the platform-organisation guard from `access_grant` (probe P9c). With it dropped, an `admin` prepares `access_grant` of `answerable-owner` to themselves on the platform organisation (a temporary test showed `PREPARED` where the real code answers `PERMISSION_DENIED`). Dropping the freshness check from `staff_revoke` (P11b) also fails nothing. Only 2 of the 11 tools that write to a chosen organisation are tested for the guard, and 3 of the 4 critical tools for freshness.
- **Finding 2: real ID never runs the staff tools.** `staff_grant` and `staff_revoke`, the critical writes on who is staff, never run against real ID: the journeys use root `join`/`leave`, and no lane's `--check` calls them. The fake ID's member access view is static, so no test proves that `staff_grant` makes a role. In all, 7 of the 25 tools are never called against real ID, and 4 more never succeed there.
- **Finding 3: duplication and filler.** 76 of the admin MCP's 161 conformance tests are SDK checks repeated for each of the 15 mutations. 15 of its 17 todos can never apply, because every admin mutation is controlled class. `kit.journeys.test.ts` (3 tests, 6.3 s, one ID boot) repeats the admin journeys. 12 of the kit's 21 unit tests exist for its 100% coverage gate.
- **Measured.**
  - Admin suite: 4.78 and 5.04 s. Toolbox suite: 3.06 and 2.95 s.
  - `bun run mcp:test:e2e`: 78 pass in 89.6 s.
  - Without `Bun.gc(true)`, the acceptance failed: the Toolbox journeys' `beforeAll` timed out after 120 s, 20 tests did not run, and the run took 186.1 s. The workaround is still needed.
- **Lanes.** No test and no CI step runs them. Their `--check` modes repeat the journeys. Run once each: `admin-lane --check` passed in 11 s; `host-lane --check` caught the Toolbox `allow` probe T1 against real ID in 9 s.

## Inventory

Wall times are `bun test <file>` alone, measured twice (load averages 8.1 and 11.5). Journey times come from the timestamped run 2 (the admin, kit and e2e journey files ran before the failure).

| File | Tests | Wall (s) | Layer | What it proves |
| --- | --- | --- | --- | --- |
| `mcps/admin/src/admin.test.ts` | 18 | 0.87, 1.05 | In-process MCP: real `createAdminMcp`, fake ID, test Postgres | Roles, `allow`, evidence, commit path, freshness, escalation guard |
| `mcps/admin/src/writes.test.ts` | 18 | 0.71, 0.89 | In-process MCP: provider without `allow`, fake ID, memory intents | Every mutation's preview, refusals, preconditions and keys |
| `mcps/admin/src/provider.test.ts` | 187 (170 + 17 todo) | 2.71, 3.41 | In-process MCP: conformance kit plus 9 read tests, fake ID | Manifest snapshot, conformance checklist, the reads' query strings and shapes |
| `mcps/admin/src/calls.test.ts` | 2 | 0.09, 0.09 | Unit, stub `IdAdmin` | Write retry with one key; mapping of 412, 5xx and 4xx |
| `mcps/admin/src/server.test.ts` | 2 | 0.32, 0.38 | Spawned process, fake ID over HTTP | Entry point boots, `/health`, SIGTERM, refuses a non-platform client |
| `mcps/admin/src/toolbox.test.ts` | 2 | 0.09, 0.10 | Unit, fake ID, fake Toolbox | `toolbox:admin` token; error mapping of the Toolbox's API |
| `mcps/admin/src/environment.test.ts` | 2 | 0.04, 0.04 | Unit | Configuration parsing and messages |
| `mcps/admin/src/platform.test.ts` | 3 | 0.03, 0.04 | Unit, fake ID | Platform organisation from `/me` `isPlatform` |
| `mcps/admin/src/test/database.test.ts` | 1 | 0.01, 0.02 | Unit, test helper | The test helper refuses other databases |
| `mcps/toolbox/src/toolbox.test.ts` | 15 | 0.86, 1.06 | In-process MCP, fake ID, test Postgres | Grant-based listing and calls, evidence and spans, cache and `list_changed` |
| `mcps/toolbox/src/admin-enable.test.ts` | 11 | 0.63, 0.61 | HTTP route in-process, fake ID | The enable operation's ID writes, idempotence, conflicts |
| `mcps/toolbox/src/admin.test.ts` | 10 | 0.42, 0.44 | HTTP route in-process | Admin API authentication, routes, catalogue, host clients |
| `mcps/toolbox/src/meta.test.ts` | 7 | 0.80, 0.79 | In-process MCP | Meta projection and its five tools |
| `mcps/toolbox/src/catalogue.test.ts` | 7 | 0.25, 0.23 | Query, test Postgres | Ingest, contract-change refusal, catalogue and host-client rows |
| `mcps/toolbox/src/conformance.test.ts` | 13 (11 + 2 todo) | 0.26, 0.24 | In-process MCP | The `toolbox` provider's manifest and read checklist |
| `mcps/toolbox/src/grants.test.ts` | 9 | 0.11, 0.10 | Unit, fake ID | Grant strings from the access view; cache and invalidation |
| `mcps/toolbox/src/poller.test.ts` | 4 | 0.29, 0.29 | Unit, fake ID | Audit-log polling and invalidation |
| `mcps/toolbox/src/spans.test.ts` | 4 | 0.17, 0.18 | Unit, real OTLP over loopback | Span attributes, parent, error status, export |
| `mcps/toolbox/src/projection.test.ts` | 4 | 0.08, 0.08 | Unit | `allowed`, policy class, ordering, projection |
| `mcps/toolbox/src/search.test.ts` | 4 | 0.13, 0.13 | Query, test Postgres | Full-text ranking |
| `mcps/toolbox/src/db/migrate.test.ts` | 3 | 0.29, 0.31 | Schema, test Postgres | Migrations apply once; the split layout matches the old one |
| `mcps/toolbox/src/server.test.ts` | 1 | 0.36, 0.42 | Spawned process | Entry point boots, `/health`, SIGTERM |
| `mcps/toolbox/src/environment.test.ts` | 2 | 0.04, 0.04 | Unit | Configuration parsing |
| `packages/acceptance/src/journeys/admin.journeys.test.ts` | 20 | 50.7 (run 2) | Real ID, Chromium, official MCP OAuth client, Postgres in Docker | A1 to A7 |
| `packages/acceptance/src/journeys/toolbox.journeys.test.ts` | 20 | about 24, derived: 89.6 s total in run 1 minus the other files | Same | J1, J2, J3, J6, J7, J10, administration |
| `packages/acceptance/src/journeys/e2e.journeys.test.ts` | 14 | 7.4 (run 2) | Same | OAuth, token binding, J4, J5, isolation, refresh |
| `packages/acceptance/src/journeys/kit.journeys.test.ts` | 3 | 6.3 (run 2) | Same | Staff sign-in, spare directory, two-audience machine client |
| `packages/acceptance/src/id.test.ts` | 6 | 0.46 | Unit, `Bun.spawn` mocked | `startId` plumbing and failures |
| `packages/acceptance/src/admin.test.ts` | 6 | 0.07 | Unit, loopback server | The kit's root `admin` caller and provisioning bodies |
| `packages/acceptance/src/cleanup.test.ts` | 4 | 0.05 | Unit | Closer order and the Ctrl-C and SIGTERM exits |
| `packages/acceptance/src/mcp.test.ts` | 4 | 0.10 | Unit, stub client | `tool` and `refusal` wrappers |
| `packages/acceptance/src/browser.test.ts` | 1 | 0.29 | Unit, stub page | `approve` prints ID's page on failure |

The kit itself (`src/id.ts`, `admin.ts`, `admin-mcp.ts`, `browser.ts`, `oauth.ts`, `mcp.ts`, `cleanup.ts`) is 600 lines. The ID fixture it drives is `apps/id/scripts/mcp-e2e-fixture.ts`. The lanes are `scripts/host-lane.ts` (146 lines) and `scripts/admin-lane.ts` (152 lines).

## Classification

INV holds a security or correctness invariant, CON a contract, BEH behaviour a person sees. DUP means the fact is already held closer to the consumer; FILL exists for the coverage gate; IMPL is coupled to implementation. "Caught P…" names the probes (next section) that made the test fail.

### `mcps/admin/src/admin.test.ts` (18)

| Test | Class | Note |
| --- | --- | --- |
| a token of another organisation lists no tools … `not_platform` | INV | docs/11 invariant 2; checks that ID is not asked. Caught P4, P13, P21 |
| a platform member without a role lists `admin_whoami` only | INV | Invariants 3 and 4. Caught P13, P21 |
| answerable-team through a group entitlement lists whoami and every read | DUP | Same list as "a team member sees no write …" below, and A1.2 |
| the highest role held counts; another resource, one client only, an unknown string confer nothing | INV | Invariant 4. Caught P1, P2, P3, P7 |
| a role change in ID shows on the next request … one read per request | INV | Invariant 3. Caught P3 |
| a member ID no longer knows has no role | INV | docs/11 Roles step 3. No probe isolated it |
| a token without the admin scope gets no tools | INV | docs/11 step 1. Caught P5, P13, P21 |
| when ID cannot say what a member may use … nothing served from memory | INV | Invariant 3. Caught P3, P6, P6b. Also pins a log line |
| every call leaves one evidence row … `x-request-id` | INV | Invariant 9. Also pins the exact GET paths, including `limit=200` |
| health answers ok only while the database answers | BEH | Operator |
| a team member sees no write and no commit tool; an admin … ; an owner … | INV | Role minimums. Caught P13, P19, P21 |
| a controlled intent commits only through `admin_commit_confirmed` … | INV | Invariant 6. Also pins the full evidence sequence |
| a target moved between prepare and commit answers `INTENT_STALE` | DUP | `writes.test` organisations_update, the conformance `commit_rejects_stale`, and A4.3 |
| the plan's key survives a write whose answer is lost … after a 401 | INV | Invariant 6, one key. Caught P16 |
| demoting the person between prepare and commit refuses the commit | INV | docs/11 step 5. Caught P3. No journey covers it |
| a critical operation needs a directory sign-in within the window … | INV | Invariant 7. Caught P10, P11, P12 |
| every write to the platform organisation is an owner's critical operation | INV | Invariant 7. Caught P8, P9, P11. Covers `groups_addmember` and `sso_set` only; P9c shows the gap |
| an owner taking their own last owner role is warned twice; Toolbox evidence names the Toolbox | BEH | Warnings and the `upstream` field |

### `mcps/admin/src/writes.test.ts` (18)

| Test | Class | Note |
| --- | --- | --- |
| organisations_create previews … one create with the plan's key | BEH | Caught P22 |
| organisations_update … sends the ETag as If-Match; a moved organisation is stale | CON | If-Match. Caught P12 |
| organisations_disable and organisations_enable … never disable the platform organisation | INV | docs/11 step 6 |
| domains_add previews … refuses one already routed | BEH | |
| sso_set … If-None-Match first, If-Match to replace, refuses any other issuer | INV | Invariant 8 (R29) through the issuer refusal |
| groups_create previews … refuses a taken slug | BEH | |
| groups_addmember adds with If-None-Match, changes with If-Match … | CON | Preconditions |
| groups_dropmember removes … refuses one not in the group | BEH | |
| access_grant names who receives what … | BEH | |
| access_revoke disables an entitlement … | BEH | |
| toolbox_enable reads providers and catalogue … safe to repeat | BEH | |
| toolbox_enable without the Toolbox's admin resource configured … | BEH | Operator |
| staff_grant finds the role's group by its entitlement, never by slug | INV | docs/11 Staff. Caught P7 |
| staff_grant prefers the group that confers the least … | BEH | |
| staff_revoke removes the member from every group … each with its own step of the key | CON | Key steps. Caught P7 |
| staff_revoke refuses a role held only through a non-group entitlement … | BEH | |
| access_enable grants a disabled entitlement again … | BEH | |
| an entitlement revoked cannot be granted again … names access_enable | BEH | |

### `mcps/admin/src/provider.test.ts` (9 hand-written, 161 conformance, 17 todo)

| Test | Class | Note |
| --- | --- | --- |
| organisations_list filters by text and status and pages with ID's cursor | CON | The filtering is the fake's; what is the admin MCP's is the forwarded query string |
| organisations_get gives the organisation, its domains and its SSO provider | BEH | |
| organisations_get reads every page of domains | BEH | `all()` paging, which `access_grant` and the staff tools also rely on |
| members_list filters …; members_get gives … access | CON | Output schema against the fake's shape; the filtering is the fake's |
| groups_list and access_list … | CON | Forwarded filters |
| audit_list carries each event's request id and operation id … | CON | Forwarded filters; the events are hand-made |
| sso_test reports ID's connectivity test … | FILL | Pass-through of a result the fake invents; half the test checks the fake's own insecure-issuer branch |
| staff_list gives every member … with their role, whatever their groups are called | BEH | Caught P7 |
| ID failing answers UPSTREAM_UNAVAILABLE … never an empty success | INV | docs/11 Errors |

| Conformance check (count) | Class | Note |
| --- | --- | --- |
| `identity_is_stable`, `name_is_host_safe`, `input_schema_is_closed`, `output_schema_declared`, `list_paginates`, `timeout_bounded`, `manifest_matches_snapshot` (7) | CON | The only holder of "no tool takes a secret" is the snapshot (P23) |
| read `read_has_no_side_effect` (1) | BEH | |
| read `errors_use_envelope` (1) | DUP | The SDK closes inputs |
| `prepare_has_no_side_effect` (15) | INV | Caught P22 |
| `commit_rejects_stale` (12 that run) | INV | Caught P12 |
| `commit_rejects_stale` (3) | FILL | `organisations.create`, `sso.set` and `groups.addmember` print "skipped" and count as passes |
| `preview_is_semantic` (15) | BEH | |
| `targets_have_versions`, `receipt_is_structured` (30) | CON | |
| `commit_requires_token`, `commit_rejects_expired`, `commit_is_idempotent`, `commit_rejects_other_principal`, mutate `errors_use_envelope` (75) | DUP | The SDK behaves the same for every mutation, and `packages/mcp/src/commit.test.ts` holds each; 60 of them took 0.75 s alone |
| `descriptions_operational` (1) | CON | |
| `deprecations_mirrored` (1) | FILL | No tool is deprecated, so it checks nothing |
| `approval_bound_to_digest` (15 todo) | todo | "Not yet: human approvals" |
| `secrets_declared`, `egress_guarded` (2 todo) | todo | "providers declare no secrets and have no upstream client", which is untrue of this provider: it holds `ADMIN_ID_CLIENT_SECRET` and calls ID and the Toolbox |

The conformance part ran 161 tests in 2.83 s, measured twice. That is about 57% of the admin suite.

### `mcps/admin`: the other files

| File, test | Class | Note |
| --- | --- | --- |
| `calls.test`, a write ID does not answer is sent once more with the same key | DUP | `admin.test`'s lost-answer test holds the same through the MCP and the fake's journal |
| `calls.test`, fails twice, stale If-Match, other refusal | CON | The only holder of 412 → `INTENT_STALE` (P15). No journey reaches ID's 412: the SDK's re-prepare refuses first |
| `server.test`, the entry point learns the platform organisation … SIGTERM | BEH | |
| `server.test`, refuses to start for a non-platform client | DUP | `platform.test`, second test (P14 failed both) |
| `toolbox.test`, called with a `toolbox:admin` token | DUP | `writes.test` toolbox_enable checks `scopesAsked` |
| `toolbox.test`, refusal mapping | BEH | |
| `environment.test` × 2 | BEH | |
| `platform.test`, own organisation marked `isPlatform` | INV | Invariant 2 |
| `platform.test`, another organisation refused | INV | Caught P14 |
| `platform.test`, ID refusing or not answering | FILL | Asserts `@answerable/id-admin`'s messages |
| `test/database.test` | FILL | Tests a helper only tests use |

**Admin MCP totals:** INV 47, CON 46, BEH 37, DUP 81, FILL 7, IMPL 0, todo 17. The 57 hand-written tests alone: INV 20, CON 8, BEH 21, DUP 5, FILL 3.

### `mcps/toolbox` (question 4)

| File, test | Class | Note |
| --- | --- | --- |
| toolbox, granted a provider: list, order, annotations, `_meta`, resource, protected-resource metadata | CON | |
| toolbox, providers listed by id | CON | Caught T1 |
| toolbox, `toolbox_whoami` names … | BEH | |
| toolbox, a domain grant …; no grant …; a hidden capability is the unknown-tool error and a denial | INV | docs/08 invariant 3. Caught T1 |
| toolbox, not enabled or disabled stays hidden when granted | INV | Caught T1, T10 |
| toolbox, a token without the `toolbox` scope sees nothing | INV | Caught T8 |
| toolbox, every call one evidence row and one span | INV | docs/08 invariant 8 |
| toolbox, `RESULT_TOO_LARGE` | CON | 102,400 bytes accepted, 102,401 refused |
| toolbox, a mutation through the hub prepares and commits | DUP | `meta.test` prepare, J7.3, and the intents test below |
| toolbox, intents in Postgres, each transition evidence | INV | Invariant 8 |
| toolbox, human class holds an intent | DUP | J6 asserts the same against real ID |
| toolbox, a grant change reaches each listening caller as `tools/list_changed` | BEH | Caught T1. J3 holds it against real ID |
| toolbox, grants cached; an invalidation shows the change | BEH | Caught T1, T4 |
| toolbox, ID cannot say → `UPSTREAM_UNAVAILABLE`, a list fails | INV | Fail closed |
| toolbox, health | BEH | |
| grants, grant-string forms | CON | |
| grants, `allowedScopes` | CON | |
| grants, only the Toolbox's targets count | INV | Caught T2 |
| grants, unknown member has none | BEH | |
| grants, 60-second cache, concurrent reads share one call | BEH | |
| grants, another authorisation version reads again | INV | Caught T3 |
| grants, invalidating reads again, keeps other organisations | BEH | Caught T4 |
| grants, an invalidation calls `changed` once | IMPL | Callback count |
| grants, when ID fails a cached entry answers until 60 s, then `UPSTREAM_UNAVAILABLE` | INV | Caught T4. Also pins log lines |
| poller, first poll records the newest; later polls invalidate | CON | Action prefixes. T5 did not fail it: its fixture still names both organisations through other events |
| poller, pages back through more than 200 events | BEH | Caught T5 |
| poller, a failure is logged and the next poll catches up | BEH | Caught T5 |
| poller, polls every `intervalMs`, one at a time | IMPL | Sleeps 150 and 100 ms and asserts 2 to 6 polls. The only user of the fake's `slow()` |
| admin-enable, one organisation, one host, one provider: calls in order, rows, scopes, catalogue | CON | Also pins the call order |
| admin-enable, a repeat writes nothing | DUP | Toolbox journeys, administration test 2, against real ID |
| admin-enable, the other 9 (two hosts and two providers, failure part way, conflicting rows, paging, member rows, kept overrides, bad body, missing ID rows, ID unreachable) | BEH | Conflicting rows caught T11 |
| toolbox admin, admin resource is origin + `/admin` | CON | |
| toolbox admin, every route needs a machine token for the admin resource with `toolbox:admin` | INV | Caught T6, T7, P18 |
| toolbox admin, unknown route and bad body | BEH | |
| toolbox admin, `GET /providers` | CON | |
| toolbox admin, PUT catalogue stores; PUT catalogue refusals; host clients; evidence verify | BEH (4) | |
| toolbox admin, new capabilities stay disabled until PUT | DUP | `catalogue.test` "capabilities a later version adds stay off" |
| toolbox admin, unexpected failure answers 500 and is logged | FILL | Forces the branch by closing the pool |
| meta, meta lists the four tools and the commit tools | CON | |
| meta, auto projection by `direct_limit` | BEH | |
| meta, search finds by word; prepare and commit | BEH (2) | |
| meta, search never returns what the caller may not use | INV | Caught T10 |
| meta, describe: not usable is `NOT_FOUND` | INV | |
| meta, execute runs a read; refuses mutation, hidden, bad arguments | INV | Caught T9 |
| catalogue, ingest stores manifest and capabilities | CON | Also pins the column list |
| catalogue, ingest again; contract change refuses the boot; later versions stay off | BEH, INV, INV | |
| catalogue, search vector fields | DUP | `search.test` |
| catalogue, catalogue rows read and written | BEH | |
| catalogue, host client defaults | DUP | toolbox admin "host clients are stored …" |
| spans × 3 (attributes with the user id hashed, traceparent, error status) | CON | |
| spans, OTLP export | BEH | |
| projection, `allowed` | INV | Caught T10 |
| projection, policy class; ordered | BEH (2) | |
| projection, `projectionOf` | DUP | `meta.test` auto projection |
| search × 4 | BEH | |
| migrate, apply once; split layout equals the old one | CON (2) | The second guards the one-time B0 move of the files |
| migrate, a fresh schema receives every migration | FILL | Implied by the other two |
| server, environment × 2 | BEH | |
| conformance (11) | CON 8, BEH 1, DUP 1, FILL 1 | As for the admin MCP |

**Toolbox totals:** INV 16, CON 24, BEH 39, DUP 8, FILL 3, IMPL 2, todo 2. Of `toolbox.test`, `grants.test`, `poller.test` and `admin-enable.test`, the INV tests are toolbox 6 and grants 3. The poller and the enable operation have none: they are BEH and CON.

The Toolbox's 2 todos are the same `secrets_declared` and `egress_guarded` placeholders.

### `packages/acceptance` (78; question 3)

| File, test | Class | Note |
| --- | --- | --- |
| admin A1.1 staff sign in; no role → `admin_whoami` alone | INV | Invariants 2 and 3 against real tokens |
| admin A1.2 team group: same token lists reads; one access read per request | INV | Invariant 3. The computed access view, which the fake cannot give |
| admin A1.3 owner adds the critical tools; leaving removes them | INV | |
| admin A2.1 `toolbox_enable` for an existing organisation | BEH | |
| admin A2.2 `organisations_create`: `APPROVAL_REQUIRED`, confirm, audit row joined | INV | Invariants 6 and 9 |
| admin A2.3 `domains_add`; `sso_set` refused; the kit sets SSO | BEH | |
| admin A2.4 `groups_create` | BEH | |
| admin A2.5 refused at the chooser before the enable | DUP | `kit.journeys` second test proves the same ID refusal |
| admin A2.6 enable and grant for the new organisation | BEH | |
| admin A3.1 the new person signs in to the Toolbox and calls | BEH | The only end-to-end onboarding outcome |
| admin A3.2 `access_revoke` removes tools within 60 s; `access_enable` restores | INV | Revocation bound: 8.1 s and 15.1 s in run 1 |
| admin A3.3 `organisations_disable` → refresh `invalid_grant` | DUP | e2e "disabling an organisation stops refresh" and Toolbox J2 |
| admin A4.1 client-organisation member: no tools, `not_platform` | INV | |
| admin A4.2 an admin is not an owner; `groups_addmember` on the owner group → `PERMISSION_DENIED`, nothing written | INV | Invariant 7, one tool |
| admin A4.3 rename between prepare and commit → `INTENT_STALE` with real ETags | INV | |
| admin A5.1 two concurrent commits: one receipt, one organisation, one audit row | INV | |
| admin A6.1 stale → `ADMIN_REAUTHENTICATION_REQUIRED`; authorising again alone changes nothing | INV | Real `sid` and `upstream_auth_time` semantics |
| admin A6.2 Verify sign-in, then a new authorisation commits | BEH | |
| admin A6.3 a refresh keeps the sign-in time | INV | |
| admin A7.1 chain verifies; each write joins one ID audit row | INV | Invariant 9; the fake records no audit rows |
| toolbox sign-in: token carries `toolbox` and `offline_access` only | CON | |
| toolbox J1.1 list, annotations, `_meta`; J7.1 meta list | CON (2) | |
| toolbox J1.2 whoami | BEH | |
| toolbox J1.3 evidence row and span | INV | |
| toolbox J2.1 partial grant; J2.2 gamma: no grant, unknown tool, denial | INV (2) | |
| toolbox J6 human class; J7.2 search, describe, execute; J7.3 prepare and commit | BEH (3) | |
| toolbox J3 grant change reaches the same token and a listener | INV | 10.0 s in run 1 |
| toolbox J2 disable stops refresh | DUP | e2e journeys |
| toolbox J10.1 chain verifies | INV | |
| toolbox J10.2 the trigger refuses update and delete; J10.3 erasure keeps the chain | DUP (2) | `packages/mcp-postgres/src/evidence.test.ts:65-99` |
| toolbox grant-cache statistics | IMPL | Asserts exactly 2 token requests |
| toolbox administration 1: admin API refuses a person's token, lists providers | INV | |
| toolbox administration 2: enable widened the resource and linked clients; a repeat changes nothing | CON | |
| toolbox administration 3: PUT catalogue hides the tool from alpha only | INV | |
| toolbox administration 4: evidence verify route, host clients | DUP | Toolbox `admin.test` |
| e2e sign-in (PKCE, `resource`, `iss`) | CON | |
| e2e token bound to the MCP, 60 s, entitled scopes | INV | |
| e2e 2025 and 2026-07-28 clients | CON | |
| e2e J4.1 prepare and commit | BEH | |
| e2e J4.2 replay, J4.3 stale, J4.4 expired, J5.1 confirmed tool, J5.2 summary off by one | DUP (5) | `packages/mcp/src/commit.test.ts` and the conformance kit hold each. ID plays no part in them |
| e2e isolation; read-only organisation; another MCP refuses the token; disabling stops refresh | INV (4) | The only real-ID audience proof is for the e2e MCP |
| e2e the SDK refreshes and ID rotates | CON | |
| kit × 3 (staff sign-in, spare directory, two audiences) | DUP (3) | A1.1, A2.5 and A3.1, and `startAdminStack`'s two-audience machine client used throughout A2 |
| kit unit `cleanup.test` × 4 | BEH | Ctrl-C leaves nothing behind |
| kit unit `id.test` happy path and plan fields | IMPL (2) | Assert the spawned command arrays |
| kit unit `id.test` four failure modes | FILL (4) | |
| kit unit `admin.test` root call, 204, non-2xx | FILL (3) | Every journey uses `createAdmin` |
| kit unit `admin.test` `registerResource`, `registerMachine`, `setSsoProvider` bodies | IMPL (3) | Mirror the code |
| kit unit `mcp.test` × 4, `browser.test` × 1 | FILL (5) | Error branches the journeys never take (by reading) |

**Acceptance totals:** INV 24, CON 7, BEH 15, DUP 14, FILL 12, IMPL 6.

**What only the journeys prove** (question 3):

- The OAuth flow as hosts run it: discovery from the 401, PKCE S256, RFC 8707 `resource`, RFC 9207 `iss`.
- Scopes narrowed to the entitlement.
- ID's chooser, consent and Security pages, and the `sid` and `upstream_auth_time` rules (A6).
- The member access view computed from real groups and entitlements (A1).
- Real ETags and audit rows carrying `requestId` (A4.3, A7).
- `invalid_grant` after a disable.
- The poller against real audit action names (A3.2, J3).
- The enable operation's rows making a real sign-in work (A2, A3.1).

**What the journeys repeat** of the unit tests:

- Role lists (A1.3 and `admin.test` role minimums).
- Escalation through `groups_addmember` (A4.2 and `admin.test`).
- `INTENT_STALE` (A4.3).
- The `not_platform` refusal (A4.1).
- The human class (J6 and `toolbox.test`).
- The SDK commit rules (e2e J4.2 to J5.2).

**The kit tests** (`admin.test`, `id.test`, `mcp.test`, `browser.test`, `cleanup.test`) test the kit's own plumbing, never the product. Only `cleanup.test` protects something an operator sees: Ctrl-C and SIGTERM remove the container.

### Counts across the area

| Class | Admin MCP | Toolbox | Acceptance | Total |
| --- | --- | --- | --- | --- |
| INV | 47 | 16 | 24 | 87 |
| CON | 46 | 24 | 7 | 77 |
| BEH | 37 | 39 | 15 | 91 |
| DUP | 81 | 8 | 14 | 103 |
| FILL | 7 | 3 | 12 | 22 |
| IMPL | 0 | 2 | 6 | 8 |
| todo | 17 | 2 | 0 | 19 |
| **Tests** | 235 | 94 | 78 | 407 |

## Mutation probes

Each probe made one edit and ran the workspace suite with `bun test` (after `db:test:migrate`). It was then restored with `git checkout -- <file>`.

| # | What was broken | Where | What failed | Verdict |
| --- | --- | --- | --- | --- |
| P1 | Role matcher accepts a `client_resource` target by its `resource` (schema keeps `resource`) | `mcps/admin/src/roles.ts:14,19` | `admin.test` "the highest role held counts …" | Caught, 1 test |
| P1a | Drop only the `kind === "resource"` check | `roles.ts:14` | Nothing | No behaviour change: zod strips `resource`, and a client target's `id` is a client id. The kind check is a second guard |
| P2 | Role from any resource | `roles.ts:14` | Same 1 test | Caught, 1 test |
| P3 | Role cached per membership across requests | `roles.ts:29,43,46` | `admin.test` × 4 (highest role, role change, ID cannot say, demotion) | Caught |
| P4 | No `not_platform` refusal | `roles.ts:55` | `admin.test` "a token of another organisation …" | Caught, 1 test |
| P4b | `role()` asks ID for any organisation | `roles.ts:42` | Nothing | The line is unreachable in production (`allow` refuses first); see dead code |
| P5 | No `missing_scope` refusal | `roles.ts:57` | `admin.test` "without the admin scope" | Caught, 1 test |
| P6 | A failed role read answers "no role" | `roles.ts:37` | `admin.test` "when ID cannot say …" | Caught, 1 test |
| P6b | A failed role read answers the last known role | `roles.ts:30-37` | Same | Caught, 1 test |
| P7 | Lowest role counts (`find` for `findLast`) | `roles.ts:12` | `admin.test` highest role; `writes.test` staff_grant, staff_revoke; `provider.test` staff_list | Caught |
| P8 | Guard without the owner check | `mcps/admin/src/writes.ts:56` | `admin.test` "every write to the platform organisation …" | Caught, 1 test |
| P9 | Guard without freshness | `writes.ts:59` | Same | Caught, 1 test |
| **P9c** | `access_grant` reads its organisation without the guard | `mcps/admin/src/access.ts:144` | **Nothing** | **Gap.** A temporary test (deleted) proved it: as `admin`, `access_grant` of `answerable-owner` to themselves on the platform organisation answered `PREPARED`. On the real code all 8 platform writes tried answer `PERMISSION_DENIED`: `access_grant`, `access_enable`, `access_revoke`, `groups_create`, `groups_dropmember`, `domains_add`, `organisations_update`, `toolbox_enable` |
| P10 | No `upstream_auth_time` counts as fresh | `mcps/admin/src/fresh.ts:15` | `admin.test` freshness | Caught, 1 test |
| P11 | Window in milliseconds (×1000) | `fresh.ts:15` | `admin.test` freshness and platform guard | Caught |
| **P11b** | `staff_revoke` without freshness | `mcps/admin/src/staff.ts:81` | **Nothing** | **Gap.** No journey calls `staff_revoke` |
| P12 | SDK commit does not re-run prepare | `packages/mcp/src/commit.ts:46` | 14 admin tests: 11 conformance `commit_rejects_stale`, `writes.test` update, `admin.test` stale and freshness | Caught. `organisations.update`'s own stale check still passed through ID's 412 |
| P13 | `allow` filters lists only, never calls | `mcps/admin/src/admin.ts:47` | `admin.test` × 4 | Caught |
| P14 | `readPlatform` ignores `isPlatform` | `mcps/admin/src/platform.ts:15` | `platform.test`, `server.test` | Caught (the two are duplicates) |
| P15 | ID's 412 not mapped to `INTENT_STALE` | `mcps/admin/src/calls.ts:72` | `calls.test` second test | Caught by 1 unit test; no journey reaches ID's 412 |
| P16 | Resend after a lost answer with a new key | `calls.ts:66` | `calls.test` first test; `admin.test` lost answer | Caught |
| P18 | No audience check | `packages/auth/src/index.ts:133` | `mcps/admin`: **nothing**. `mcps/toolbox` `admin.test` route auth; `packages/auth` "rejects audience …"; `packages/mcp` `server.test` "… a token for another audience" | Invariant 1 is held by the SDK layer, not by the tests docs/11 names |
| P19 | `staff_grant` minimum `admin` | `staff.ts:34` | `admin.test` role lists | Caught, 1 test |
| P21 | `allow` refusals leave no evidence | `admin.ts:46` | `admin.test` × 4 | Caught |
| P22 | `organisations_create`'s prepare writes to ID | `mcps/admin/src/organisations.ts:28` | 5 tests (`writes.test`, conformance × 3, `admin.test`) | Caught |
| P23 | `sso_set` takes `clientSecret` | `organisations.ts:151` | Conformance `manifest_matches_snapshot` only | Weak: `UPDATE_MANIFEST=1` regenerates the snapshot and the probe passes |
| T1 | Toolbox `allow` ignores grant strings (catalogue only) | `mcps/toolbox/src/toolbox.ts:84` | `toolbox.test` × 5, `meta.test` × 2. Against real ID, `host-lane.ts --check` exited 1 in 9 s: `e2e_identity_get`, not granted, answered 200 | Caught by both layers. Journeys not run with T1 (budget); by reading, J2.2 and A3.2 assert it |
| T2 | Grants from every target | `mcps/toolbox/src/grants.ts:43` | `grants.test` "only the Toolbox's targets" | Caught, 1 test |
| T3 | Cache ignores the authorisation version | `grants.ts:69` | `grants.test` "another authorisation version" | Caught, 1 test |
| T4 | Invalidation marks nothing stale | `grants.ts:83` | `toolbox.test` × 1, `grants.test` × 2 | Caught |
| T5 | Poller ignores `entitlement.*` events | `mcps/toolbox/src/poller.ts:10` | `poller.test` paging and failure tests, not the test about prefixes | Caught incidentally |
| T6 | Admin API skips the `toolbox:admin` check | `mcps/toolbox/src/admin.ts:84` | Toolbox `admin.test` route auth | Caught, 1 test |
| T7 | Admin API verifier without `subjectType: "client"` | `admin.ts:43` | 20 tests | Caught (it refuses every machine token) |
| T8 | Toolbox `allow` ignores the `toolbox` scope | `toolbox.ts:83` | `toolbox.test` "without the toolbox scope" | Caught, 1 test |
| T9 | Meta tools run any mounted capability | `mcps/toolbox/src/meta.ts:36` | `meta.test` execute | Caught, 1 test |
| T10 | Disabled override ignored | `mcps/toolbox/src/projection.ts:9` | `toolbox.test`, `meta.test`, `projection.test` | Caught |
| T11 | Enable counts a disabled row as existing | `mcps/toolbox/src/admin-enable.ts:27` | `admin-enable.test` conflicting rows | Caught, 1 test |
| GC | `Bun.gc(true)` removed from `cleanup` | `packages/acceptance/src/cleanup.ts:25` | Acceptance run 2: the Toolbox journeys' `beforeAll` timed out (120 s, last step "Enabling the Toolbox for each organisation …"). 58 pass, 1 fail, 20 not run, 186.1 s, exit 1. The kit and e2e files after the admin journeys passed; nothing was left behind | Still needed (question 5). It failed one file later than `Q-ACCEPTANCE-GC` describes |

**docs/11 invariants, test by test** (question 1):

| Invariant | Unit test | Journey | Probes |
| --- | --- | --- | --- |
| 1. Audience only; never forwarded | None in `mcps/admin` (P18). Forwarding would fail every test that calls the fake ID, which accepts only tokens it issued | None for the admin MCP (e2e journeys for the e2e MCP) | P18: not held where docs/11 says |
| 2. Platform members only, by system binding | `admin.test` other organisation; `platform.test` | A4.1 | P4, P14 caught |
| 3. Read every request, nothing kept, failure serves nothing | `admin.test` role change, ID cannot say, demotion | A1.2, A1.3 | P3, P6, P6b caught |
| 4. Exactly three strings, resource target only | `admin.test` highest role | A1 (group entitlements only) | P1, P2, P7 caught; P1a no effect |
| 5. Machine client only after the role allowed | `admin.test` other organisation (`id.received` empty) | None explicit | Not probed separately; the SDK runs `allow` before a handler |
| 6. Controlled intent, once, one key, stale refused | `admin.test` commit, lost answer; `writes.test`; `calls.test`; conformance | A2.2, A4.3, A5.1 | P12, P15, P16, P22 caught |
| 7. Critical: owner and fresh at prepare and commit, every write to the platform organisation | `admin.test` freshness (disable, `staff_grant`), platform guard (`groups_addmember`, `sso_set`) | A4.2 (`groups_addmember`), A6 (disable, enable) | P8, P9, P10, P11, P12 caught; **P9c, P11b not** |
| 8. No tool takes a secret | `writes.test` `sso_set` refuses other issuers | A2.3 | P23: snapshot only |
| 9. Evidence for every call, refusal and transition; ID audit joined | `admin.test` × 5 | A7.1 | P21 caught |
| 10. Nothing identity-related leaves `apps/id` | None | None | Not testable as written; a dependency rule could hold it |

## Gaps

**Fake ID compared with real ID** (question 2):

| Behaviour | Fake (`packages/id-admin/src/testing.ts`) | Real ID | Effect on the admin MCP's tests |
| --- | --- | --- | --- |
| Member access view | Static: whatever the test passed to `grant()` | Computed from entitlements, groups and validity; effective members of active organisations and users only (`apps/id/src/db/queries/access.ts:53-166`) | Nothing proves that `staff_grant` or `staff_revoke` changes a role. Tests set the view by hand, and `test/admin.ts` `staff()` uses `via` entitlement ids that exist nowhere |
| Audit rows | None for writes; only `event()` seeds | One row per write, with `requestId` and `operationId` | `audit_list` and the `x-request-id` join are proven only by A7 |
| `503 database_busy` | `outage()` answers plain-text 503 on every route; `failWrite()` gives the problem on writes only | Problem `database_busy` with `Retry-After`, also on reads during a concurrent write (found by the admin lane) | A read during a write answers `UPSTREAM_UNAVAILABLE` without retry; untested |
| 408 and 413 | Not modelled | On every route (OpenAPI) | Untested; they would map to `UPSTREAM_REJECTED` |
| ETags | On organisation, SSO provider, group, group member, entitlement and resource GETs and on PATCH/PUT; none on lists, creates, disable and enable | Same, plus `GET /clients/{id}` and capabilities | Matches what the admin MCP uses |
| 412 | `revision_mismatch` problem | Same code (`apps/id/src/http/admin/revision.ts`) | Matches; only `calls.test` maps it |
| Replay | Journal per method, path and key; receipt `{ operationId, outcome, statusCode, resultReference }` | Per actor, operation name and key digest; same receipt (`apps/id/src/services/operations.ts:95-113`) | Matches for one machine client. A lost answer replayed by real ID is never exercised |
| `sso-provider/test` | Invents a result | Fetches the issuer | `provider.test` `sso_test` checks the fake |
| Tools never called against real ID | | | `members_list`, `members_get`, `sso_test`, `staff_list`, `groups_dropmember`, `staff_grant`, `staff_revoke`. Never succeeding: `groups_addmember`, `organisations_update`, `organisations_enable`, `sso_set`. Checked by grepping the calls in the admin journeys and the lane |

**Invariants and contracts without a test:**

| Gap | Worth a test? | What it would assert |
| --- | --- | --- |
| Escalation guard on every tool that takes an `organizationId` (P9c) | Yes, high | One table in `admin.test`: as `admin`, each of the 11 tools on the platform organisation answers `PERMISSION_DENIED` and nothing is written. About 25 lines; the temporary test above is the template |
| Freshness on every critical tool (P11b) | Yes | A table over the 4 critical tools with a stale sign-in → `ADMIN_REAUTHENTICATION_REQUIRED` |
| `staff_grant` and `staff_revoke` against real ID | Yes | In A1, after root makes the first owner, the owner uses `staff_grant` to give a second member `team` and `staff_revoke` to take it back; that member's `admin_whoami` follows. This replaces root `join`/`leave` for every later role change |
| Admin MCP refuses a token for another audience | Yes, one line | A3: the person's Toolbox token at the admin MCP answers 401 |
| No input field takes a secret | Optional | A conformance check that no input property matches `/secret\|password\|token/i` |
| Invariant 10 | No | Replace with a dependency rule, or drop the claim |
| Evidence for a call refused because the role read failed | Known (`Q-SDK-ALLOW-EVIDENCE`) | When the SDK gains a refusal hook: the refusal leaves a row |

**What an operator running this for thousands of users needs:**

| Gap | Worth it? | What to prove |
| --- | --- | --- |
| Evidence throughput: every call writes a row under `pg_advisory_xact_lock(hashtext(organisation_id))` (`packages/mcp-postgres/migrations/0002_evidence.sql:67`). The admin MCP has one chain, and the Toolbox serialises each organisation's calls | A measurement, not a unit test | Calls per second for one organisation at 50 concurrent callers; correctness under concurrency is already tested (`evidence.test.ts:49`, 20 concurrent) |
| Grant cache sweep: `remember()` scans every cached entry on each miss (`grants.ts:46-53`) | Measure | Miss latency with 10,000 cached members |
| `all()` reads every page: `access_grant` lists every entitlement of a resource in the organisation to find one row (`access.ts:155`) | Low | ID's `memberId`, `groupId` and `clientId` filters would make it one page |
| Poller prefixes against real ID: only `entitlement.*` is proven (A3.2, J3) | Medium | One journey step: a group membership change reaches the Toolbox within one poll |
| `user.*` events are not in the poller's list | Low | A disabled user keeps cached grants up to 60 s; docs/08 invariant 2 ("never from a cached tool list or a prior call") reads stricter than the 60-second cache the docs elsewhere state |
| Clock skew between ID and the admin MCP for freshness | Low | None; worth a sentence in docs/11 |
| ID busy (`503`, `Retry-After`) on reads | Low | The fake's `failWrite` extended to reads; a tool answers `UPSTREAM_UNAVAILABLE` with the delay |

## Dead and test-only code

| Code | Evidence | Note |
| --- | --- | --- |
| `roles.ts:42`, `role()`'s early return for another organisation | P4b failed nothing. Only `writes.test` reaches it, because it serves the provider without `allow` | Unreachable in production; one line of defence |
| `createToolboxAdmin({ fetch })` and `AdminMcpConfig.toolbox.fetch` | `grep`: only `mcps/admin/src/test/admin.ts:117` and `toolbox.test` pass it; `server.ts:14` and `packages/acceptance/src/admin-mcp.ts:96` pass only `resource` | A test seam; acceptable |
| `approve` export of `packages/acceptance/src/browser.ts` | Only `browser.test.ts:3` imports it | Exists for a FILL test |
| Fake ID `slow()` and `latency` | Only `poller.test.ts:65` | Dies with the IMPL timing test |
| `mcps/admin/src/test/database.ts` with its own test, and `mcps/toolbox/src/test/database.ts` | Two copies of `assertDisposable`; the Toolbox's `testDatabase()` does not call it | Test support with a test of its own |
| Kit coverage gate (`packages/acceptance/bunfig.toml`, 100% over `src`) | 12 FILL kit tests exist for it | Test support held to a production gate |
| The lanes (question 5) | Typechecked and linted (`tsconfig.json` includes `scripts`); run by no test, no `turbo` task and no CI step (`.github/workflows/ci.yml` runs only `mcp:test:e2e`); referenced only in docs | People use them for hand demos. `admin-lane --check` passed in 11 s on the same `startAdminStack` the journeys use. `host-lane --check` is the one place the T1 probe met real ID in this audit, but J1 and J2 assert the same |
| `deprecations_mirrored`, and `commit_rejects_stale` for 3 mutations | Count as passes while checking nothing (the kit prints "skipped") | |

## Simplifications

| What | Evidence | Effect |
| --- | --- | --- |
| Conformance: run the provider-independent commit checks once per provider, not once per mutation | 75 of 150 mutate checks in the admin MCP are SDK behaviour; 60 of them took 0.75 s; `packages/mcp/src/commit.test.ts` holds each | −70 tests in the admin MCP; about 0.7 s (in `packages/mcp`, another area's code) |
| Drop the string checks from conformance registration | 17 + 2 todos; 15 can never apply to an all-controlled provider; the other reason is untrue for the admin MCP | −19 todos; the Not yet list lives in docs/09 |
| `mcps/admin/src/provider.test.ts` read tests | 155 lines; 4 of 9 tests assert the fake's filtering | One table of forwarded query strings, plus paging and source failure: about −90 lines |
| Kit unit tests and the kit's 100% gate | 12 FILL and 5 IMPL of 21; 293 lines of tests for 600 lines of kit | Drop the gate; keep `cleanup.test` and `id.test`'s happy path: about −220 lines, 16 tests |
| Shared Toolbox stack | `host-lane.ts:41-90` and `toolbox.journeys.test.ts:107-150` repeat registration, database, `createToolbox` and the poller | A `startToolboxStack` like `startAdminStack`: about −40 lines |
| The A3 wait | 23.2 s of the admin journeys (8.1 s + 15.1 s in run 1) is the 15-second poller. `startGrantsPoller` takes `intervalMs` | A 1-second poller in the journeys saves about 20 s, but no longer measures the production interval. Optimise only if run time matters |
| `test/database.ts` in both servers | Two near-identical files | One helper in `@answerable/mcp-postgres/testing`: −15 lines |

## Recommendations

**Delete.** Time is a measured time for the file or tests removed; line counts are counted.

1. `packages/acceptance/src/journeys/kit.journeys.test.ts` (86 lines, 3 DUP tests, 6.3 s and one ID boot per run).
2. e2e journeys J4.2, J4.3, J4.4, J5.1 and J5.2 (5 DUP tests; the SDK holds them).
3. Toolbox journeys J10.2, J10.3 and "administration 4" (3 DUP).
4. Unit DUPs:
   - `mcps/admin/src/admin.test.ts`: "answerable-team through a group entitlement …" and "a target moved between prepare and commit …".
   - `calls.test.ts` first test.
   - `server.test.ts` second test (one process spawn, about 0.2 s).
   - `toolbox.test.ts` (admin) first test.
   - `mcps/toolbox/src/toolbox.test.ts`: "a mutation through the hub …" and "human class …".
   - `admin-enable.test.ts` "a repeat …"; the Toolbox `admin.test` "new capabilities stay disabled …"; `catalogue.test` search vector and host-client defaults; `projection.test` `projectionOf`.
   - Total: 13 tests.
5. FILL and IMPL tests:
   - `poller.test.ts` "polls every intervalMs …" (250 ms of sleeps), with the fake's `slow()`.
   - `provider.test` `sso_test`; `platform.test` third test; `test/database.test.ts`.
   - Kit `mcp.test.ts`, `browser.test.ts` with the `approve` export, and kit `admin.test.ts`.
   - `id.test.ts` failure modes, once the kit's coverage gate goes.
6. The conformance todos (19) and the per-mutation repeats of the SDK commit checks (70 tests in the admin MCP). This is a change in `packages/mcp/src/conformance.ts`, owned by another area.
7. The lanes' `--check` branches (62 lines). First move the one assertion they add, `anthropic/requiresUserInteraction` on `admin_commit_confirmed` alone, into A1.

**Simplify.**

1. `provider.test.ts` read tests into one table (about −90 lines).
2. One `startToolboxStack` for the host lane and the Toolbox journeys (about −40 lines).
3. One test-database helper.
4. Docs:
   - docs/11 "Security invariants" names `admin.test.ts`, `writes.test.ts` and the admin journeys for all ten invariants; correct it with the table above.
   - `Q-ACCEPTANCE-GC` says the next file after the admin journeys fails; in this run the fourth file (Toolbox) did.

**Add.**

1. A table test in `admin.test.ts`: as `admin`, every tool that takes an `organizationId`, on the platform organisation, answers `PERMISSION_DENIED` and writes nothing. It closes P9c, an owner escalation an admin could reach after a one-line refactor.
2. A table test that each of the 4 critical tools refuses a stale sign-in. It closes P11b.
3. Journey steps that run `staff_grant` and `staff_revoke` against real ID, the only layer whose access view is computed (closes finding 2), and one line that the admin MCP answers 401 to a Toolbox token (invariant 1).
4. Measurements, not tests: evidence throughput for one organisation under concurrency, and grant-cache miss latency at 10,000 members.

**Measured effect of the deletions:** about 40 tests and about 600 lines of test code. The acceptance loses one ID boot and about 7 s of 89.6 s. If the conformance change lands, the admin suite loses about 70 tests and about 0.7 s of its 4.8 to 5.0 s.
