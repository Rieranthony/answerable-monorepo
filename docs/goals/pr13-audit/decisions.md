# Pull request 13 audit: decisions

The owner answered on 2026-10-26, after reading [the report](https://claude.ai/artifact/WadRa6EXTco4AxzsFPPt8y) (`report.html`). The finding ids refer to the six audits in [`audits/`](audits/).

## D-1. Standalone MCPs are served from the Toolbox's process

**The owner chose:** "One process (Recommended)". The choice of `toolbox`, `standalone` or `both` stays.

**What changes:**
- The Toolbox's process serves every standalone MCP at `https://mcp.<zone>/<name>/mcp`, beside its own `/mcp`.
- The standalone server is deleted as a process, with:
  - its database, `answerable_standalone`, and its logins and Secrets;
  - the `answerable_mcps_standalone` login;
  - the `standalone-hub` machine client;
  - the `standalone-migrate` Job;
  - its Deployment and network policy.
- A standalone MCP's intents and evidence go in the Toolbox's database.

**What stays:**
- the `mcp.<zone>` hostname, routed to the Toolbox's Service;
- the second sign-in model: a resource and a `claude-code-<name>` client per standalone MCP;
- `standalone_enable`.

**Findings:** C1, C2, E1, E2, B7, C11, E6, E11, F16. C6, the profile cache's stale window, stays, because standalone MCPs still exist.

**It reverses:** the MCP CLI's D2, which chose a separate shared standalone server.

## D-2. The `own` database mode stays

**The owner chose:** "Keep it", against the recommendation to delete it.

**What changes:** nothing in the mode. Two follow-ups stand:
- the inventory lists each own MCP's migration variable, `MCP_<NAME>_DATABASE_MIGRATION_URL`, as it already lists its runtime variables (A9's alternative);
- `database.mdx` says plainly what `own` isolates and what it does not:
  - it is on the same Postgres instance;
  - its runtime URL is in the serving process's environment.

**Findings not taken:** B1, C10, D12 and A9's deletion.

## D-3. Per-MCP Postgres roles are replaced with grants

**The owner chose:** "Replace with grants (Recommended)".

**What changes:**
- **What stays:** the schema per MCP, the one shared database, one pool per serving process and row-level security.
- **Ownership:** the migrator login owns every MCP schema and runs its migrations.
- **Grants:** each serving login is granted usage on the schemas of the MCPs it serves, and DML on their tables.
- **Deleted:**
  - the per-MCP owner and runtime roles;
  - the role scans in `migrateMcp` and `bun mcp check`, and the migration scanner;
  - the role prefixes and their variables.
- **A borrow** sets the search path and the organisation only.
- **An `own` MCP** keeps its owner and runtime logins, with the same grant step.

**Findings:** B2, B3, B9, F16, B6.

**It reverses:** the role half of the MCP CLI's D1.

## D-4 to D-7 and the rest: as recommended

The owner chose "As recommended (Recommended)":
- **D-4:** keep reading who is calling before every call. Start the read beside the grants read (C5). Move `createIdProfiles` into `@answerable/mcp-platform` (C7).
- **D-5:** accept `e2e` and `example` in every environment, and say so in docs/12.
- **D-6, the CLI:**
  - keep the terminal prompts, `new --tool`, the guidance comments (shortened where they repeat) and the error table;
  - delete `--json` and the default `<name>.status` tool;
  - keep the table `add tool` writes, and document how to drop it before its first migration.
- **D-7:** delete the CHANGELOGs of private workspaces, and stop bumping their versions.
- **Defects:** fix all eleven (report, section 1).
- **Cleanups:** take every cleanup in the report's section 3, except those D-2 keeps.
- **Recommended against:** take none of the proposals in the report's section 4.

## Order of work

The briefs are in [`briefs/`](briefs/):

| Brief | What it does |
|---|---|
| R1 | The defects |
| R2 | D-1 |
| R3 | D-3 |
| R4 | The configuration, database, SDK and shipping cleanups |
| R5 | The CLI, tests and docs cleanups, and D-5 to D-7 |
| R6 | The final pass |

The order is delete, then simplify, then optimise; there is nothing to automate. The coordinator reviews, gates and commits each brief on `claude/typed-config-b1` and pushes it to pull request 13.
