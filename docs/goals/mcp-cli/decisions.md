# MCP CLI and shipping: decisions

**Approved by the owner on 2026-10-25:** "Approve D1 to D4 and D17 to D19 as recommended. Write the briefs in full and commit the planning files on main." The engineering defaults D5 to D16 stand as proposed. Each decision lists the chosen option first, then the alternatives and why they lose. "Owner" marks the decisions that were the owner's call. The F-numbers refer to [`findings.md`](findings.md).

## Owner decisions (approved)

**D1. The database: two modes, `shared` by default and `own` when chosen.** Owner. Revised on 2026-10-25 at the owner's request: "leave the door open to create MCPs with their own DB… something modulable with good default".
- **`shared` (the default):** a schema in the shared `answerable_mcps` database, as described below.
- **`own`:**
  - **What it is:** a database of its own, `answerable_mcp_<name>`, with its own owner and runtime logins and their two Secrets.
  - **How to choose it:** `--database own` when the MCP is made, or `"database": "own"` in `mcp.json`.
  - **How it is served:** every process that serves it opens one pool to it.
- **The code is the same in both modes.** The tables are `pgSchema("<name>")` tables in both, so an MCP moves between modes by dumping and restoring its schema, with no code change. `bun mcp list` shows each MCP's mode. `bun mcp check` warns when the `own` databases' pools would pass the connection budget in docs/12. Not yet: a `bun mcp move` command.

The shared mode in detail:
- **How it works:** each MCP gets two `NOLOGIN` roles, an owner and a runtime role. The whole MCP database has three logins: the migrator, the Toolbox and the standalone server. The Toolbox and the standalone server each use one pool, and take the MCP's role whenever they borrow a connection.
- **Why:** connections and Secrets don't grow with the number of MCPs. At 200 MCPs, 1,000 queries ran on 10 connections. Disk is 30 MiB rather than 1.5 GiB, and creating everything takes 2.1 s rather than 25.7 s. Isolation held: a cross-schema read was refused (F4).
- **Alternative: a database per MCP.** It is the model the Toolbox and the admin MCP use today, with no change to `@answerable/mcp-postgres`. It fails at scale: a Toolbox process needs one pool per mounted MCP, and a burst over 200 MCPs had 105 refused at `max_connections` 100 (F4). It would also need 400 logins and 400 Secrets, or a PgBouncer in front.
- **The cost:**
  - `@answerable/mcp-postgres` learns schemas: the migrator's journal, runtime grants and the hub assertion (F4);
  - each MCP's tables are `pgSchema` tables;
  - mounted provider code is trusted not to switch role itself, guarded by a lint rule and a test.
- **Reversed in part on 2026-10-26** by D-3 of the pull request 13 audit ([decisions](../pr13-audit/decisions.md)): the per-MCP owner and runtime roles are gone. The migrator login owns every MCP's schema and tables and migrates them with drizzle's migrator, the journal in the MCP's schema; the serving login is granted `USAGE` on each schema it serves and read and write on its tables, and a borrow sets the search path and the organisation only. The role prefixes, the role scans and the migration scanner went with them. The schema per MCP, the one shared database, one pool per serving process, row-level security by organisation and the `own` mode stay. The cost: one MCP's code or migration can reach another's tables; organisation isolation does not depend on the roles.

**D2. Standalone MCPs run in one shared standalone server, at `https://mcp.<zone>/<name>/mcp`.** Owner.
- **Why:** one Deployment and one hostname, whatever the number of MCPs. The SDK already serves path resources, and ID accepts them (F3). One process serving two MCPs by path was proved locally.
- **Alternative: a Deployment per MCP.** About 50 GiB of memory requests at 200 MCPs (F6), and an image or entry in every list per MCP.
- **Alternative: a subdomain per MCP.** A DNS record and a reissued origin certificate for each new MCP (F1, F3).
- **The cost:** standalone MCPs share one process, as Toolbox providers already do. An MCP that needs its own process is Not yet (trigger: an MCP with a dependency or load the others must not share).
- **Reversed in part on 2026-10-26** by D-1 of the pull request 13 audit ([decisions](../pr13-audit/decisions.md)): the Toolbox's process serves every standalone MCP at `https://mcp.<zone>/<name>/mcp`, beside its hub, so there is no separate standalone server, database, serving login, machine client or migration Job. The `mcp.<zone>` hostname, each MCP's resource and `claude-code-<name>` client, and `standalone_enable` stay.

**D3. The order: typed configuration's B1 and B2 first, then this goal.** Owner.
- **Why:** typed configuration was approved on 2026-10-21 and isn't started. It moves `readMcpEnvironment` and every service's variables onto `@answerable/config`, with generated inventories (F8). This goal adds variables to the Toolbox and the standalone server, so building it first would mean writing them twice.
- **Alternative:** this goal first, then typed configuration rewrites what this goal added.

**D4. Which models do the work.**
- **Recommended:**
  - Opus 5.5 takes M1 to M6 and M9: the database model, the SDK context, the CLI, the runtime, the deployment, the registration and the cleanup.
  - Sonnet 5.5 takes M7 and M8: the local loop and acceptance journeys, then the documentation pass.
  - The SDK and the CLI were one brief in the outline the owner approved; they are M2 and M3 in the written briefs.
  - This session coordinates: it writes the briefs, reviews each diff, runs the gates and lands on `main`.
- **Alternative:** the Toolbox goal's routing, with Fable coordinating. Owner.

**D17. Every tool receives a ready context: who is calling, their organisation, and the MCP's typed database.** Owner, asked for on 2026-10-25: "who is connected, their data coming from the ID platform so we can address who they are; a DB connexion that is shared and coming typed from the context if possible (to avoid recreating it every time)".
- **`execute(input, context)` receives:**
  - `person`: id, name, email, membership id, and groups with their id, slug and name;
  - `organisation`: id, name, slug;
  - `client`: the AI app's client id;
  - `db`: this MCP's drizzle database, typed by `src/db/schema.ts`;
  - `executionId`, `signal`, and `principal` (the verified token) for anything else.
- **`db` is made once per process for each MCP and shared by every call.** A call borrows a connection only while a query runs.
- **Typing without wiring.** `bun mcp new` writes `src/mcp.ts`, which binds `defineTool` and `defineMutation` to the MCP's schema. Tools import from there and get a typed `context.db` with no factory and no closure.
- **This changes one foundation decision of docs/07.** "Dependencies come from closures, so there is no container" now has one exception: the platform supplies the database. Every other dependency stays a closure.
- **Alternative: closures, `createProvider({ db })`.** That was the first draft. Every tool file would become a factory, and the type would be wired by hand in each MCP.

**D18. Where `person` and `organisation` come from: ID's admin API, read by the platform and cached.** Owner.
- **The facts:**
  - The access token carries only ids: `sub`, `organization_id`, `membership_id`, `grant_id`, client and scopes (`apps/id/src/auth/user-token-boundary.ts:58-71`).
  - ID's admin API has the rest: a member's `name`, `email`, `status` and `groups` (`groupId`, `slug`, `name`), and an organisation's `name` and `slug`, all readable with `platform:read`.
- **How it works:**
  - The Toolbox, and the standalone server through a `platform:read` machine client the register Job mints, read both.
  - The read runs alongside the Toolbox's existing grants read and is cached per member and per organisation for 60 seconds.
  - The Toolbox's audit-log poller already watches `member.`, `group_member.`, `organization.` and `user.` events and drops the cache when one arrives.
  - When ID doesn't answer, the last profile read is served for up to an hour. With none, the call answers `UPSTREAM_UNAVAILABLE`, as a Toolbox call already does when grants can't be read.
- **Tests:** `createTestMcp` gives a test person and organisation, which a test can set.
- **Alternative: name, email and the organisation's name and slug as claims in the access token.**
  - **For it:** it works offline, with no extra read and no credential for the standalone server.
  - **Against it:**
    - it changes ID's token contract;
    - it copies personal data into every bearer token that passes through a host;
    - the data stays as old as the token, up to 900 s;
    - groups can't go there, by the rule that roles stay out of tokens.

**D19. Organisation isolation enforced by Postgres, by default.** Owner, proposed here.
- **How it works:**
  - When a connection is borrowed, the platform also sets the caller's organisation (`set_config('answerable.organisation_id', …)`). A release resets it with the role.
  - Every table the CLI writes has an `organisation_id` column and a drizzle row-level-security policy restricting rows to that setting.
  - A tool then can't read or write another organisation's rows even if its query forgets the filter.
- **The cost:**
  - a table shared across organisations needs an explicit, reviewed exception (`src/db/schema.ts` comments it);
  - the policy and the setting become part of M1's tests;
  - one more statement per borrow.
- **Alternative:** each query filters on `organisation.id`, by convention and review, as today.

## Engineering defaults (standing)

**D5. One command, `bun mcp`, with `new`, `add tool`, `list`, `check`, `dev`, `db` and `help`.**
- It replaces `bun run mcp:new`, and its references move with it. The gate scripts (`mcp:check`, `mcp:test`, `mcp:test:e2e`) stay, because CI runs them.
- It is interactive in a terminal, takes flags otherwise, and never waits for input without a terminal.
- **Alternatives:**
  - a separate `answerable` binary: an install step for no gain inside the monorepo;
  - keeping `mcp:new` beside it: two ways to do one thing.

**D6. Three places to run, chosen when the MCP is made: `toolbox` (the default in prompts), `standalone`, `both`.** The value was `alone` in the first draft. It is `standalone`, the owner's word, matching the standalone server.
- Without a terminal, `--serve` is required, so a coding agent always makes the choice deliberately.
- `serve` can be changed later in `mcp.json`.

**D7. Every MCP is declared in `mcps/<name>/mcp.json`.** The chart's list, the Toolbox's mounted list and the standalone server's list are generated from the declarations, with drift tests, and are never edited by hand.
- **Alternative:** the declaration inside `defineProvider`. That mixes how a provider is shipped into what it offers, and the chart generator would have to import TypeScript.

**D8. One image, `mcps`, for the Toolbox, the admin MCP, the standalone server and every MCP.**
- **Why:** the probe built it at 265 MB and every server started from it (F2). It removes the Dockerfile COPY that breaks a Toolbox mount, the per-image matrix entry and the GHCR flip.
- **What doesn't change:** today's revision label already gives a new digest on every commit, so restarts are the same as now.
- **Alternative:** an image per server.

**D9. Register automation with its own machine client (the v0 code audit's D13, built now).**
- It runs on every deploy, compares and patches with `If-Match`, and never narrows the Toolbox resource.
- The client holds `platform:read platform:write`, as the Toolbox's does. Not yet: a narrower `platform:register` scope in ID (F5).

**D10. Staging, then production, with tags, and no per-environment switch per MCP.**
- Production promotion already refuses a commit staging hasn't built and signed, so the order is enforced (F6).
- A switch that holds one MCP of a commit back from production is Not yet (trigger: the first MCP that must stay out of production while its commit ships).

**D11. MCP tests run against the MCP's own schema in `answerable_mcps_test`,** through the same role path as production.
- **The cost:** the development Postgres is needed, as for the Toolbox's tests, so Codex's sandbox can't run them.
- **Alternative:** in-memory stores in tests. They prove nothing about the database the MCP runs on.

**D12. One file per tool, with guidance comments.**
- A tool carries its own `example` input, which the conformance kit reads.
- `add tool` writes the file, its test and the two marked lines in `src/provider.ts`.

**D13. Names.**
- The MCP name rule is the provider id rule.
- Reserved names: `toolbox`, `admin`, `id`, `mcp`, `mcps`, `standalone`, `api`, `www`, `test`, `ops`, `public`, `drizzle`, `platform` and `postgres` (the last two would collide with `@answerable/mcp-platform` and `@answerable/mcp-postgres`). `e2e` and `example` aren't reserved; their directories take them.
- Retired names are listed in `mcps/retired.json` and refused for ever.
- The tool name rule is the SDK's, unique within the MCP.
- `bun mcp retire`: Not yet.

**D14. e2e moves onto the new shape.** Its records go in Postgres, it is served `both`, and it is the proof that a database-backed MCP ships through the Toolbox and the standalone server. This also ends staging's per-replica test data (audit finding 4).

**D15. The admin MCP keeps its own Deployment and database.** It holds `platform:write` on ID, which no shared process should carry. Only its image changes, to `mcps`.

**D16. `bun mcp dev` works against the local ID,** through a local machine client that `bun mcp setup` creates once.
- **Alternative:** a disposable ID per run from the acceptance kit. That needs Docker and Chromium, collides with an acceptance run on its fixed ports and Compose name, and forgets every sign-in on restart (F7).
