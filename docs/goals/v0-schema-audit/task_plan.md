# v0 schema audit (opened 2026-10-19)

**Goal.** The last audit of Answerable ID's storage contract before v0 ships (admin MCP, ID on staging). Challenge what the [schema audit of 6 October](../schema-audit/task_plan.md) kept: what is unnecessary, overly complicated or built on a weak assumption; what can be deleted, then what can be simplified once the dead pieces are gone; what will not scale for enterprise customers with thousands of users; whether tenants are separated and the service is safe. Prefer deleting over simplifying, simplifying over optimising, optimising over automating. A verdict of keep is a fine outcome. Report and decisions before any code; then the changes, covered by tests, with every migration directory reset to zero.

**Owner's words (19 October 2026).** "audit our id platform schema, is anything here unnecessary, overly complicated in our current setup, or based on weak assumptions for our schema? Challenge them. What can be deleted entirely? What can be simplified now that unnecessary pieces are gone? Then make the changes. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating. what won't scale? We will be selling to enterprise customers, this will impact thousands of users. It needs to be safe. Tenant separated. When done, we need this covered by test and also make sure our migration are reset to zero so we start from there. If something is good, let it alone … plan with files, report before coding. You can delegate to opus 5.5."

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Orient: schema modules, invariants migration, docs/02 register and do-not-re-propose, docs/04, the previous audit's decisions and follow-ups, consumers (admin MCP, Toolbox poller, acceptance) | complete |
| 2 | Four Opus 5.5 audits on throwaway Postgres 17 (47433–47436), probes and measured numbers: A deletion model, B tenant separation and RLS, C evidence and growth, D Better Auth fit, revisions and the migration reset | complete (audits in `audits/`) |
| 3 | Consolidate: verdict table, re-run the probes the report leans on, cross-check contradictions | complete (A 09, C 02/12, B 09 re-run by the coordinator; no contradictions between the four) |
| 4 | Report (artifact) with decisions and recommendations for the owner | complete: report v1 https://claude.ai/artifact/JCUq3dkC61ertt6NH8pSNk; D3–D10 taken, D1–D2 not (soft deletion stays) |
| 5 | After approval: implementation briefs (Opus), gates, migrations regenerated from zero, land on main, docs/02, docs/04, memory | complete: D, C, B landed on `claude/v0-schema-audit`, snapshots regenerated (790cbce), docs/02 register (54228fd); ID 1,558/0 at 100%, mcp:test 0 fail, acceptance 57/0, typecheck/lint/build/web/countries green; pushed to main |

## Layout

- Planning files: this directory; consolidated audits in `audits/`.
- Session scratchpad (`/private/tmp/claude-501/-Users-anthonyriera-code-answerable/76dfb76a-2524-4b9b-8129-3b1f640f46e6/scratchpad`): `briefs/`, agents' `audits/<letter>.md`, `probes/<letter>/`, `report.html`.
- Throwaway Postgres: `audit-pg-a..d` on 47433–47436 (`postgres:17-alpine`, `infra/postgres/init`). Remove with `docker rm -f audit-pg-a audit-pg-b audit-pg-c audit-pg-d` when the goal closes. Never `bun run env:up` from a worktree; never touch 47432 (the owner's; down at the start of this goal).
- The owner's checkout: `node_modules` installed 2 October, `bun.lock` 14 October; reinstall with `bun install --force` before any suite run here ([gotcha](../schema-audit/progress.md)).

## What the previous audit settled (not re-opened without new evidence)

D1–D12 of 6 October: generated `0000_initial.sql` + reviewed `0001_invariants.sql` with the catalogue-equivalence test; MCP migrations namespaced and checksummed; no liveness guard on sessions and tokens; live foreign keys with per-table CHECKs for soft deletion; search-path hardening; the protocol sweep; one audit payload per action with `audit_event_users`; typed grant evidence; ~40 dead columns deleted; membership provisioned at sign-in (no `invitations`); `grant_contexts` restrict; upstream tokens kept for `Q-AID-RECHECK`.

## Questions this audit puts to the evidence

1. Soft deletion on 15 tables with live keys: which tables need tombstones at all, what hard deletion plus the audit trail would lose, and what an enterprise erasure request gets today ("not anonymisation").
2. Ten database scope modes and 20 policies: the minimal vocabulary that keeps every protection; a tenant-separation matrix through the admin API; `users.email` unique across tenants (guest and contractor identities); broker tables without RLS.
3. Growth at 10,000 users: audit events per refresh and per machine token, `audit_event_users`, refresh-token rows, grant contexts, admin operations; the Toolbox poller's scan; retention or partitioning; the 20 `*_unchanged` actions.
4. Better Auth fit: columns the pinned 1.7.2 core and plugins read or write on the 18 reachable routes versus columns nothing touches; `revision` + `authorizationVersion` + ETags + the revision triggers; identity-guard triggers versus column privileges; the migration reset procedure for ID, mcp-postgres and the Toolbox.

## Decisions

Put to the owner with the report (recommended option first). **Taken by the owner on 2026-10-19:** everything as recommended except the deletion model. Soft deletion stays on every table so a mistaken deletion can be recovered; an automatic purge of soft-deleted rows after X days comes later, not now. D1 and D2 are therefore not taken; the rest (D3–D10) are.

Noted for the owner: today's soft deletion is terminal (`protect_soft_deletion` refuses clearing `deleted_at`; docs/02 lists terminal `deletedAt` as an accepted decision), so recovery before the purge is a database-owner operation with the trigger disabled. A later goal decides whether deletion becomes reversible inside the purge window; audit A's erasure findings (profile retained, organisation erasure leaves people with live accounts, upstream tokens and sessions) belong to that goal's design.

- **D1 Deletion model (A). Not taken.** Tombstones stay on users, organizations, members, oauth_clients and oauth_resources (`grant_contexts` restrict FKs, reserved client ids and resource identifiers). Hard delete accounts, groups, group_members, entitlements, organization_domains, sso_providers, oauth_client_resources, oauth_consents and organization_capabilities; their `live` becomes `generated always as (true) stored` so the live foreign key still refuses a child under a tombstoned parent and a tombstone over a live child. The two `NULLS NOT DISTINCT` uniques move into Drizzle. Recommended.
- **D2 Erasure (A). Not taken (deferred to the purge goal).** User erasure clears `name`, `image` and `retired_email` (CHECK-enforced) and deletes the person's accounts: erasure forgets, disable is the ban. Organisation erasure erases the people it leaves with no membership. `users_retired_email_check` becomes an implication. Recommended; the ban-or-forget choice is the owner's.
- **D3 Tenant separation fixes (B).** A capability's client must be unowned or the capability's own organisation's (trigger and service); `routing_read` restricted to the tenant under tenant scopes; `findClientForAccess` gets the ownership predicate. Recommended; a vendor-tenant case (B's app signing in A's people) would need an explicit shared marker instead.
- **D4 Scope vocabulary (B).** 10 modes → 7: delete `policy-root` (→ platform-read), `platform-users` (→ platform-write), `grant-admission` (→ policy-user with a session binding). Revoke the unused `jwks` UPDATE/DELETE and `oauth_client_assertions` UPDATE from the runtime role. Recommended.
- **D5 Grant-context trigger (B).** Delete the INSERT branch of `protect_grant_context` (every check is the issuing transaction's, under its locks; its member lock blocks admissions behind a member update); keep the UPDATE branch; the function stops being SECURITY DEFINER. Recommended.
- **D6 Per-refresh audit events (C).** Write `oauth.user.issued` only for the code exchange; delete `oauth.user.replayed`; drop `decision.grant` from user OAuth payloads. Keep per-grant, machine and sign-in events. Recommended (603 GB a year at 10k users otherwise).
- **D7 `*_unchanged` actions (C).** Delete the 25; the journal's `noop` receipt is the record. Recommended.
- **D8 Dead columns and the signing bug (D).** Delete `accounts.password`, `scope`, `access_token`, `id_token`, `access_token_expires_at`; `jwks.expires_at`; `oauth_clients.require_pkce`, `response_types`, `contacts`; `oauth_resources.signing_algorithm` (ES256/RS256 answer 500); the `inert` user status and its default. Recommended.
- **D9 Identity guards (D).** Keep the five identity triggers; column privileges would hold the runtime role only, break one upsert and move eight tests. Recommended: keep (option recorded).
- **D10 Migration reset (D).** After the changes: `db:regenerate` for ID (0000 generated + 0001 reviewed), squash mcp-postgres to one `0001_initial.sql` with the missing-receipt refusal, recreate every existing database (47432 by `env:reset`, test databases by their reset scripts; staging not yet deployed). Recommended.
- **Kept, examined (no decision):** RLS and the read/write split, `protocol` and `grant-client`, revisions, `authorization_version` and ETags, `audit_event_users`, the five audit indexes, `admin_operations`, `grant_contexts`, the protocol sweep, pool settings, `users.email` unique, live keys and the plain `live` column on the five tombstone tables, `system_bindings`, `verifications`, `oauth_client_assertions`, the normalisation CHECKs, `try_uuid`, both drizzle snapshots.

## Errors encountered

| Error | Attempt | Resolution |
|-------|---------|------------|

## Implementation (phase 5)

Three Opus change sets in isolated worktrees, each on its own throwaway Postgres, tests first; landing order D → B → C on `claude/v0-schema-audit`, each rebased and reviewed; then the migration regeneration once, the gates, docs, push to main.

- **D (47436):** the ten columns and the signing bug (D8), `inert` gone, the fake ID and the admin MCP manifest; mcp-postgres squashed to one migration with the missing-receipt refusal (D10 part).
- **B (47434):** the three separation fixes (D3), the vocabulary 10 → 7 and the runtime-role trims (D4), the grant-context trigger's INSERT branch (D5).
- **C (47435):** no audit event per refresh and no `decision.grant` (D6), the 25 `*_unchanged` actions (D7).
- **Landing:** `db:regenerate`, catalogue-equivalence and `test:migrations`, full ID suite, `mcp:test`, acceptance, web tests, typecheck/lint/build; docs/04 (counts, the changed sentences), docs/02 (register rows, do-not-re-propose lines), web docs, the two reports' supersession notes; report v2 with after-numbers; push to main; recreate the databases on 47432; remove `audit-pg-*` and the worktrees.
