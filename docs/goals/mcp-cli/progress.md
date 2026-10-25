# MCP CLI and shipping: progress

## 2026-10-24: audit

- Published the [MCP platform audit](https://claude.ai/artifact/1GnbzkQF8TnUr94rLYYksF): 15 findings, 4 blockers.
- Scaffold to a green check took about 3 s. A provider mounted in the Toolbox built, but the image failed at start because the Dockerfile copies only e2e.
- `bun run mcp:test` on clean `main`: 645 pass, 0 fail, 12 skip, 11.1 s.

## 2026-10-25: planning

- **Owner's ask.** Shipping MCPs simply, with a database and sign-in set up automatically, staging then production. Then the CLI, its questions, `add tool`, the database at about 200 MCPs, LLM-ready instructions, plain-English docs, "10/10".
- **Probes,** each in a throwaway worktree, deleted afterwards:
  - **Path resource:** the SDK serves `/<name>/mcp` and `/.well-known/oauth-protected-resource/<name>/mcp`, and answers `404` elsewhere.
  - **One image:** builds in 10.2 s at 265 MB; the Toolbox, the admin MCP, e2e and `acme` all start from it.
  - **`bun mcp` arguments:** passed through unchanged, with no terminal attached. Inside a workspace without the script it fails with "Script not found".
  - **Database per MCP at 200:**
    - create: 25.7 s;
    - first migration: 14.2 s; a pass with nothing pending: 3.2 s;
    - disk: 1,511 MiB;
    - a burst over every MCP: 105 of 200 refused, with 95 connections open;
    - a cold connection: 10 ms.
  - **Schema per MCP at 200:**
    - create: 2.1 s;
    - first migration: 7.1 s;
    - disk: 29.9 MiB;
    - 1,000 queries: 302 ms on 10 connections;
    - a role-switched transaction: 1.41 ms per query, against 0.50 ms plain;
    - cross-schema access refused.
  - **`schemaDatabase` prototype with drizzle** (named `mcpDatabase` in the briefs): queries and transactions ran as the MCP's role; a rollback left 0 rows; a cross-schema read was refused; the pool stayed at 4 connections, each back to the hub login after use.
  - **drizzle-kit with `pgSchema`:** names are fully qualified, but the first migration starts `CREATE SCHEMA "acme";`.
  - **One process, two MCPs by path:** each answered `401` with its own metadata; an unknown path got `404`; `/health` answered `200`; the Host check stayed on.
  - **Toolbox ingest with 200 providers × 5 tools:** 1.6 s on the first boot, 1.8 s on an unchanged one, locally.
- **Auditors.** C covered the deployment mechanics for a declared list (F6); D covered ID limits, the rows per MCP, D13 and the kit for local development (F5, F7).
- **Written:** `task_plan.md`, `findings.md`, `design.md`, `decisions.md`, this file. Untracked; nothing committed.
- **Left as found:** the probe container and worktrees were removed, and ports 47433, 47518 and 47519 are free.
- **Discussion with the owner, before approval.** Asked for:
  - a database mode for an MCP's own database, "modulable with good default", now D1 with `shared` and `own`;
  - a rich tool context: who is connected, from ID, and a shared, typed database, now D17 and D18.

  Proposed D19: organisation isolation enforced by Postgres row-level security. Read the token claims and the admin API's member and organisation fields (F9). Design and briefs M1, M2, M3 and M5 updated.

- **Approved by the owner on 2026-10-25:** "Approve D1 to D4 and D17 to D19 as recommended. Write the briefs in full and commit the planning files on main."
- **The briefs.** Written in `briefs/`: a shared `README.md` (who does what, rules, gates, the cleanup pass, the report contract), then M1 to M9. The outline's SDK-and-CLI brief became two: M2, the SDK context, and M3, the CLI. Numbers after M2 moved up by one.
- **The independent review of the briefs (2026-10-25)** found 30 problems: 7 blockers, 16 fixes, 7 notes. Three blockers were checked on Postgres 17 first (F10). All are fixed:
  - **Blockers:**
    - migrating as the owner role (Postgres refuses `CREATE SCHEMA IF NOT EXISTS` without `CREATE` on the database, so M1 applies the journal itself);
    - the conformance kit had no database (both testing entry points take `db`);
    - the examples map is kept as an override for dynamic inputs;
    - `example` and `e2e` are no longer reserved;
    - M5 mints `standalone-hub` so the standalone server can start;
    - organisations had no way into a standalone MCP (`standalone_enable` in M6);
    - M3's end-to-end test now copies the working tree and uses a random name, with clean-up.
  - **Fixes:**
    - meta tools and commits use the target provider's `db`;
    - the migration script moves to `mcps/standalone`, and the hub databases keep their Jobs;
    - the database owner and grants are named;
    - the `CREATEROLE` grant step;
    - the advisory lock;
    - no `alter role` in own mode;
    - migration contents restricted: no schema creation, no grants, no foreign qualifiers;
    - the applied-file check kept;
    - a `pg.Client` for migrations;
    - the test organisation getter;
    - a typed definition and turbo settings for the test URLs;
    - `invalidate(organisationIds, userIds)`;
    - group validity computed;
    - stale numbers and names aligned;
    - every docs include of `mcps/example` kept;
    - `turbo.json` inputs;
    - a coverage gate for `scripts`;
    - the generator before `bun install`;
    - `bun mcp dev`'s order and its organisation;
    - the journeys' tool names and the audience check;
    - the budget warning and `grants.ts` given owners;
    - e2e's contracts kept identical;
    - M4 to M6 on an integration branch so `main` stays shippable.
  - **Notes:**
    - `list` prints deployed URLs from M5;
    - `mcps.json` has an object root;
    - chart tests use a copy of the chart;
    - `ops.claudeCallbackPort`;
    - exit codes, the JSON error shape, argument parsing and the `--description` rule are fixed;
    - `readMcpEnvironment` is removed when dead;
    - the fresh-agent wording and the demo clean-up;
    - the ops image's imports.
- **`alone` is renamed to `standalone`** (the owner's word) for `--serve`.
- **The reviewer's second pass:** 27 of the 30 fixed; 1 wrong, 3 partial, 5 new. All fixed:
  - `invalidate` everywhere for profiles;
  - M1's tests match its own-mode text;
  - the admin's `CREATE` on `answerable_mcps` through the migrator's membership;
  - turbo variables global, not per workspace;
  - the design's remedy command;
  - `standalone_enable` modelled on the Toolbox's enable (capabilities and the login entitlement; resource scopes through `access_grant` or `everyone: true`);
  - M6's risk number;
  - the generator runs twice (before the install, and after the manifest);
  - the design's local loop matches M7;
  - explicit hook weights;
  - `standalone-hub`'s Secret, deploy and start plumbing;
  - the README's branch lines;
  - `@answerable/id-admin`'s new dependency on `@answerable/mcp` named.
