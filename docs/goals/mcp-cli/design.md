# MCP CLI and shipping: design

The behaviour every brief builds. Facts are in [`findings.md`](findings.md); the choices, with their alternatives, are in [`decisions.md`](decisions.md). Nothing here is built yet.

## What a developer does

```sh
bun mcp new acme --description "Notes for construction projects: list, read and add notes on a project." --serve toolbox
bun mcp add tool acme notes.add --mutation --description "Prepare a new note on a project; commit it to save it. Use notes.list first to avoid duplicates."
bun mcp check acme
bun mcp dev acme
git commit … && git push origin main
git tag staging/acme-notes && git push origin staging/acme-notes        # staging
git tag production/acme-notes && git push origin production/acme-notes  # production, same commit
```

That's the whole path. After the staging tag, `acme` has its own database schema, migrated. It is signed in through Answerable ID and mounted in the Toolbox. Staff then enable it for an organisation (`toolbox_enable` in the admin MCP) and grant it to people (`access_grant`). Those two steps are deliberate business choices, not part of shipping.

## The command: `bun mcp`

A root script, `"mcp": "bun scripts/mcp/cli.ts"`, so `bun mcp <command>` runs from the repository root. Each MCP's `package.json` gets the same script, so it also runs from inside `mcps/<name>`. There, the MCP argument may be left out. The probe confirmed that Bun passes the arguments through unchanged, and that `bun mcp` from inside a workspace without the script fails with "Script not found".

| Command | What it does |
| --- | --- |
| `bun mcp new [name]` | Makes an MCP: asks, or reads flags; writes the files; creates its local schema; writes its first migration and manifest; runs the check |
| `bun mcp add tool <mcp> <domain.operation>` | Adds a read tool, or with `--mutation` a change, with its test and its conformance example |
| `bun mcp list` | Every MCP: where it runs, its database mode, its tools, its local, staging and production URLs. `--json` for scripts |
| `bun mcp check <mcp>` | Typecheck, lint, tests with the conformance kit and the coverage gate, and the manifest. When the manifest is stale it says so, rewrites it, and asks you to commit it |
| `bun mcp dev <mcp>` | Runs it locally against the development Postgres and the local ID, in the Toolbox or the standalone server, and prints the `claude mcp add` command |
| `bun mcp db <mcp> generate` | Writes the migration for a change to `src/db/schema.ts` (drizzle-kit, with the schema line made safe, see Database) |
| `bun mcp help [command]` | Usage with one example per command. Every command takes `--help` |

### Rules that make it work for people and for coding agents

- **Interactive only in a terminal.** With a TTY, missing answers are asked with prompts (`@clack/prompts`, the latest release when built). Without one, as in a coding agent's shell (the probe found `isTTY` false there), the CLI never waits for input. A missing answer exits with code 2 and prints the exact command to run again, with the missing flag filled in as a placeholder.
- **One meaning per flag, no aliases.** The same names are used in prompts, flags, files and docs: `--description`, `--serve toolbox|standalone|both`, `--tool`, `--tool-description`, `--mutation`.
- **Every error says what to do.**

  > MCP name "Acme" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme

  > acme is taken by mcps/acme; choose another name

  > toolbox is reserved

  > A tool's description is 22 characters; write 40 to 1,000 saying what it does, when to use it and its limits

  The rules are the SDK's own, exported from `@answerable/mcp` (today they are module constants in `tool.ts` and `provider.ts`), so the CLI and the SDK can never disagree.
- **Nothing half-written.** Every check runs before the first file is written. A failure after that (for example, Postgres is down when the schema is created) leaves the files, says which step failed, and gives the command that finishes it (`bun mcp db acme migrate` creates a missing schema).
- **Stable, short output.** One line per step, then `Next:` with the two or three commands that come next. `--json` prints the same facts as one object.
- **Idempotent where it can be.** Running `add tool` again with the same name refuses, naming the file. `dev` and `check` can run any number of times.
- **Exit codes:**
  - 0: done;
  - 1: a step failed after files were written, and the output names the command that finishes the job;
  - 2: refused before anything was written.
- **`--json`:** success is `{ "ok": true, "steps": […], "next": […] }`; a refusal or failure is `{ "ok": false, "error": { "code", "message", "fix" } }`.
- **`list`:** sorted by name.
- **Arguments:** in `add tool [mcp] <domain.operation>`, the positional with a dot is the tool and the other is the MCP.
- **`--description`** always describes what the command creates: the MCP in `new`, the tool in `add tool`. The first tool's description in `new` is `--tool-description`.

### `bun mcp new`: the questions

In this order, each with its rule and the default an Enter takes:

1. **Name.**
   - The rule: a lowercase letter, then up to 11 lowercase letters or digits.
   - Refused when it is:
     - taken by any `mcps/*/mcp.json`;
     - reserved: `toolbox`, `admin`, `id`, `mcp`, `mcps`, `standalone`, `api`, `www`, `test`, `ops`, `public`, `drizzle`. `e2e` and `example` aren't reserved; they are taken by their directories;
     - retired, listed in `mcps/retired.json`.
   - It is the provider id, so it prefixes every tool (`acme_notes_list` in the Toolbox) and names its database schema.
2. **Description.**
   - The rule: 40 to 1,000 characters.
   - It says what the MCP is for, in a sentence or two.
   - It becomes the provider's new `description` field, shown in the manifest, the Toolbox catalogue, `bun mcp list` and the README.
3. **Where it runs.**
   - `toolbox` (default and recommended): clients reach it through the one Toolbox URL.
   - `standalone`: its own URL, `https://mcp.<zone>/<name>/mcp`.
   - `both`.
   - Without a terminal, `--serve` is required, so the choice is always deliberate.
4. **First tool name**, `<domain>.<operation>`; Enter skips.
   - Skipping writes `<name>.status`, a tool that reports the caller's organisation, as today.
   - The prompt shows what makes a good name: what the caller can do (`notes.list`, `projects.search`), never the vendor or the transport.
5. **First tool description** (40 to 1,000 characters), with a good and a bad example shown.
6. **Read or change** (`--mutation`): a read answers a question; a change is prepared, then committed.

The database mode isn't asked, because the default is the right one almost every time. The summary line says `Database: schema acme in answerable_mcps (shared). Pass --database own for a database of its own.`

After the questions, it does the following and prints one line for each:
- writes `mcps/<name>`;
- regenerates the Toolbox's and the standalone server's dependencies before the install, so the lockfile stays current;
- runs `bun install`;
- creates the schema in `answerable_mcps` and `answerable_mcps_test` on the development Postgres;
- writes the first migration;
- runs the tests once with the manifest rewrite;
- regenerates the generated lists again, now that the manifest holds the new MCP's scopes and grant strings;
- runs `bun mcp check <name>`.

`--no-check` skips the last step.

## What `bun mcp new` writes

```text
mcps/acme/
  mcp.json                 the declaration: name, serve (toolbox | standalone | both), database (shared | own). The CLI writes it; people may edit serve and database
  package.json             @answerable/mcp-acme, exports ./provider, scripts incl. "mcp"
  README.md                what it is, the commands, where it runs, links to the docs
  manifest.json            the contract, from the first test run
  src/mcp.ts               written by the CLI, never edited: defineTool and defineMutation bound to this MCP's schema (see What every tool receives)
  src/provider.ts          defineProvider({ id, description, version, database, tools }): plain data, as today
  src/tools/notes-list.ts  one file per tool, a plain export, with the guidance comments below
  src/tools/notes-list.test.ts
  src/provider.test.ts     the conformance kit over every tool, examples read from the tool files
  src/db/schema.ts         pgSchema("acme") and the MCP's tables (a commented starter table)
  drizzle/                 its migrations, written by bun mcp db acme generate
  tsconfig.json, eslint.config.mjs, bunfig.toml   from templates in scripts/mcp, not copied from mcps/e2e at run time
```

- **No `server.ts` and no port per MCP.** The Toolbox (47400 locally) and the standalone server (47510 locally, the port the scaffold used) serve MCPs, and `bun mcp dev` runs them locally. One fewer file to get wrong, and production and local run the same code path.
- **One file per tool.** `add tool` is then a new file plus two marked insertions: the import and the array entry in `src/provider.ts`, between `// bun mcp: tools` markers. The diff stays readable, and an agent can do the same by hand.
- **A tool carries its own example input** (a new optional `example` field on `defineTool` and `defineMutation`). The conformance kit reads it, so no separate examples map can fall out of step. `toolbox_describe` can show it, as docs/08 already says it does.

## What every tool receives

A tool is a plain export. It reaches its database and the caller through the context, with no factory and no closure:

```ts
// src/mcp.ts: written by bun mcp new; regenerated, never edited
import { mcp } from "@answerable/mcp"
import * as schema from "./db/schema"

/** This MCP's definitions: every handler's context.db is typed by src/db/schema.ts. */
export const { defineTool, defineMutation } = mcp({ schema })
```

```ts
// src/tools/notes-list.ts
import { desc } from "drizzle-orm"
import { z } from "zod"
import { notes } from "../db/schema"
import { defineTool } from "../mcp"

export const notesList = defineTool({
  name: "notes.list",
  description: "List the notes of the caller's organisation, newest first, 20 per page. Use notes.add to write one.",
  input: z.object({ limit: z.number().int().min(1).max(100).default(20), cursor: z.string().optional() }),
  output: z.object({ items: z.array(note), next_cursor: z.string().nullable(), has_more: z.boolean() }),
  async execute({ limit }, { db, person, organisation }) {
    const rows = await db.select().from(notes).orderBy(desc(notes.created_at)).limit(limit + 1)
    // Row-level security (D19) already limits rows to organisation.id; person.name and organisation.name are there to address the caller.
    return page(rows, limit)
  },
})
```

| Field | What it is | Where it comes from |
| --- | --- | --- |
| `person` | `{ id, name, email, membershipId, groups: [{ id, slug, name }] }` | The token gives the ids (verified offline). ID's admin API gives name, email and groups, read by the Toolbox or the standalone server, cached 60 s per member, dropped by the audit-log poller on a change (D18) |
| `organisation` | `{ id, name, slug }` | The token gives the id; ID's admin API gives name and slug, cached the same way |
| `client` | `{ id }`: the AI app the person uses | The token |
| `db` | This MCP's drizzle database, typed by `src/db/schema.ts`, with `db.query.<table>` for relational reads | Made once per process for each MCP; each query borrows a connection from the shared pool (mode `shared`) or the MCP's own pool (mode `own`) |
| `executionId`, `signal` | The call's id, and the cancel signal | As today |
| `principal` | The verified token, for anything the fields above don't cover | As today |

How the pieces fit:
- **The schema travels with the provider.** `defineProvider` takes the MCP's `database: { schema, migrations }`, and the serving process builds `drizzle({ client, schema })` once from it. That process is the Toolbox, the standalone server, `bun mcp dev`, or `createTestMcp` in tests.
- **The tests need no setup.** An MCP's tests import `createTestMcp` from `@answerable/mcp-postgres/testing`. It wraps the SDK's, because `@answerable/mcp-postgres` already depends on `@answerable/mcp` and the reverse would be a cycle. It migrates the MCP's test schema in `answerable_mcps_test`, then serves through the same role and organisation path as production, with a test person and organisation that `connect({ person, organisation })` can override.
- **The exception to "closures, no container".** The database is the one dependency the platform supplies. Upstream clients and secrets remain closures until `upstream` exists (docs/08).

### The guidance comments in a tool file

```ts
// One tool = one thing the caller can do. Hosts call this tool acme_notes_list in the Toolbox, notes_list alone.
//
// name: <domain>.<operation>, from the caller's side: notes.list, projects.search, rfis.create.
//   Never the vendor or the transport (sharepoint_query), never a mode switch (manage_notes).
//   Unique in this MCP; the CLI and defineProvider refuse a second one.
//
// description: the model reads only this to choose the tool. Say what it does, when to use it,
//   its limits (page size, what it cannot see) and what the ids mean. 40 to 1,000 characters.
//   Good: "List the notes of a project, newest first, 20 per page. Use projects.search first to find the project id."
//   Bad: "Gets notes."
//
// input and output: Zod objects. Describe every field (.describe("…")): hosts show it to the model.
//   A list takes limit and cursor and returns items, next_cursor and has_more (the conformance kit checks it).
//
// execute: gets the checked input and the caller. Read only principal.organizationId's data:
//   every query filters on it. Throw ToolError for a failure the caller can fix.
```

A mutation file carries the same comments for `prepare` (it computes the preview and changes nothing) and `commit` (it applies exactly what was prepared), plus `risk`.

## Where an MCP runs

| `serve` | Reached at | Who sees it | Rows in ID per MCP |
| --- | --- | --- | --- |
| `toolbox` | The Toolbox's URL; tools `acme_*` | People whose organisation enabled `acme` and who hold a grant string covering the tool | None: its grant strings join the Toolbox resource's `allowedScopes` when an organisation is enabled |
| `standalone` | `https://mcp.<zone>/acme/mcp` | People whose token carries `acme:read` or `acme:write` | A resource, a Claude Code client and a link, made by the register Job |
| `both` | Both | Both rules, each on its own path | As `standalone` |

### The Toolbox

- **A generated list.** `mcps/toolbox/src/mounted.generated.ts` imports the provider of every `toolbox` or `both` MCP. A drift test fails when it disagrees with the declarations. The Toolbox's `package.json` dependencies are generated alongside it.
- **Database and context.** For each mounted provider, the Toolbox builds its `db` once at boot:
  - **`shared` mode:** `mcpDatabase` over the one pool to `answerable_mcps`, taking that MCP's role, schema and the caller's organisation on every borrow;
  - **`own` mode:** its own pool.

  On each call it supplies `person` and `organisation` from the cached ID read beside the grants (see What every tool receives).
- **e2e becomes a normal MCP.** It is mounted the same way, with its records in Postgres, so staging no longer splits test data across replicas.

### The standalone server

- **One shared process.** `mcps/standalone` is one Deployment serving every `standalone` or `both` MCP by path on one host. Each MCP has its own `createMcpServer`, with its own resource URL and audience, so a token for `acme` is refused by `beta`.
- **What it owns:**
  - intents and evidence in its own database, `answerable_standalone`, in the same model as the Toolbox's;
  - `/health`, which checks both databases;
  - the authority and evidence wiring the Toolbox and the admin MCP each build today, lifted into one shared package (audit finding 12).
- **Proved locally** with two scaffolded MCPs in one process:
  - each answered `401` at `/<name>/mcp` and gave its own metadata at `/.well-known/oauth-protected-resource/<name>/mcp`;
  - an unknown name got `404`;
  - `/health` answered at the root;
  - the SDK's Host check stayed on.
- **The admin MCP stays apart.** It keeps its own Deployment and database because it holds `platform:write`. Only its image changes.

## Database

**Two modes, with the same code (D1).**
- **`shared`, the default:** a schema in the shared database `answerable_mcps`. It costs nothing per MCP in connections or Secrets.
- **`own`:** a database `answerable_mcp_<name>`, with its own owner and runtime logins and two Secrets. Every serving process opens one pool to it.
- **Moving between them:** the tables are `pgSchema("<name>")` tables either way, so a move is a dump and restore of the schema.
- **Who picks `own`:** an MCP that needs hard isolation, its own size or maintenance window, or a client's request.

The Toolbox, the admin MCP and ID keep the databases they have. The rest of this section describes the shared mode; the `own` mode is the same with one database and two logins per MCP.

**Organisation isolation by default (D19).**
- **On borrow:** besides the role and the search path, a borrowed connection gets the caller's organisation (`set_config('answerable.organisation_id', $1, false)`).
- **On release:** the reset clears it.
- **In the schema:** tables the CLI writes have `organisation_id` and a drizzle `pgPolicy` with `enableRLS()` limiting every row to that setting. drizzle-orm 0.45.4 has both (read, not yet probed).
- **Shared tables:** a table shared across organisations is an explicit, commented exception.

| Postgres object | What it is | Per MCP? |
| --- | --- | --- |
| schema `acme` | The MCP's tables and its migration journal (`acme.__drizzle_migrations`) | yes |
| role `mcp_acme_owner` | `NOLOGIN`. Owns schema `acme`; the migrations run as it | yes |
| role `mcp_acme` | `NOLOGIN`. `USAGE` on `acme` and the table privileges its grants name; nothing elsewhere | yes |
| login `answerable_mcps_migrator` | Member of every owner role (`INHERIT FALSE, SET TRUE`); the migration Job takes each owner role in turn | no |
| login `answerable_mcps_toolbox` | Member of the runtime role of every `toolbox` or `both` MCP; no privilege of its own | no |
| login `answerable_mcps_standalone` | The same, for every `standalone` or `both` MCP | no |

**Three logins and three Secrets, whatever the number of MCPs.** The bootstrap Job creates everything from the declared list and can run again safely. Locally, at N = 200, it took 2.1 s for the schemas and roles.

**Borrowing a connection.**
- `mcpDatabase(pool, { name: "acme", … })` returns a drizzle database whose borrowed connections run `set role mcp_acme; set search_path to acme`.
- When the connection is released, it runs `reset role; reset search_path`. If the reset fails, the connection is destroyed rather than returned.
- Probe, with the hub login, 200 schemas and one pool of 4:
  - queries and transactions ran as the MCP's role;
  - a thrown transaction rolled back;
  - a cross-schema read was refused;
  - every pooled connection was the hub login again afterwards.
- At N = 200, 1,000 queries took 302 ms on 10 connections. The same burst against a database per MCP had 105 of 200 refused.
- The overhead is measured in M1 at the borrow level. The transaction-level variant cost 1.41 ms against 0.50 ms per query.

**Trust.** A mounted provider runs in the hub's process and can issue `set role` itself. The hub login is a member of every runtime role it serves, so provider code is trusted first-party code, as it already must be (audit finding 7). Two guards:
- a lint rule and a test refuse `set role`, `reset role` and `set session authorization` in `mcps/*/src`;
- the serving logins hold no privilege of their own, and `assertServingLogin` checks it before a server listens: memberships only in `mcp_*` runtime roles, `INHERIT FALSE`.

**Migrations.**
- **The tables.** An MCP's tables are `pgSchema("<name>")` tables in `src/db/schema.ts`. drizzle-kit then qualifies every name and every foreign key (probe).
- **No migration creates a schema.** Provisioning creates schema `<name>` and its owner role, which has no `CREATE` on the database. Postgres checks that right before it checks whether the schema exists, so even `CREATE SCHEMA IF NOT EXISTS` run as the owner role is refused (probe, Postgres 17: `permission denied for database`). So:
  - `bun mcp db <name> generate` removes drizzle-kit's `CREATE SCHEMA "<name>";` line from the files it has just written. An applied migration is never edited, as the repository's rule says.
  - `migrateMcp` applies the journal itself, in drizzle's journal format, in `<name>.__drizzle_migrations`, which the owner role may create. Drizzle's own migrator always runs `CREATE SCHEMA IF NOT EXISTS` on its journal schema, so it can't be used here.
- **What a migration file may contain.** `migrateMcp` refuses, naming the file and line:
  - any statement that creates a schema, grants or revokes;
  - `ALTER DEFAULT PRIVILEGES`;
  - a name qualified with another schema, `public` included.

  It refuses a changed applied file, as `migrate()` does today. The grants are the migration Job's job, not the MCP's.
- **One migration Job, `mcps-migrate`,** migrates every MCP in turn, each `shared` MCP as its owner role through the migrator login, then applies its grants.
  - Probe: the first migration of 200 schemas took 7.1 s, and a pass with nothing pending is cheaper still.
  - One MCP's failure fails the release, as today's per-database Jobs do.
  - The Toolbox, the admin MCP and the standalone server keep a migration Job each for their own databases, each mounting only its own owner login.
- **MCPs follow expand, then contract,** like every database here.

**Grants.**
- **The default:** the runtime role gets `select, insert, update, delete` on every table of the MCP's schema, and `usage` on its sequences.
- **The rest:** everything else on the schema's objects is revoked from `PUBLIC`.
- **Narrowing:** an MCP may narrow the default by exporting `grants` from `src/db/grants.ts`. `bun mcp db <name> migrate` reads it locally, and the migration Job reads it on every deploy.

**Tests.**
- Every MCP's tests run against its own schema in `answerable_mcps_test` on the development Postgres, through `mcpDatabase` and a fresh serving login, which is exactly the production path.
- Suites can run at the same time, because each resets only its own schema.
- The cost: an MCP's tests need the development Postgres, as the Toolbox's do, so Codex's sandbox can't run them.

**Connections.**
- The Toolbox opens one pool to its own database and one to `answerable_mcps`. The standalone server does the same. Neither grows with the number of MCPs.
- At the autoscalers' ceilings, the new pools add 10 connections per replica of each. docs/12's budget gains two lines.
- `max_connections` on Civo is still to be measured (B7a). When it is, it becomes the number every pool size is checked against.

## Shipping

**The declared list.**
- A generator reads `mcps/*/mcp.json` and the manifests and writes `charts/answerable/mcps.json`.
- The chart reads it with `.Files.Get`, so `helm template` and `infra:check` keep working. It is named so that `infra:check` doesn't take it for an environment overlay.
- A drift test fails when it is stale.

**What the chart renders from the list:**
- the bootstrap's MCP list, as `OPS_MCPS`;
- the ops Role's Secret names;
- one `mcps-migrate` hook at weight -9;
- the Toolbox's `TOOLBOX_MCPS_DATABASE_URL`;
- the standalone server's Deployment, rendered only when at least one MCP is `standalone` or `both`;
- the standalone server's Ingress on `mcp.<zone>`, with two Prefix paths per MCP;
- one network policy for the standalone server;
- the smoke checks.

**One image, `mcps`.**
- It holds the Toolbox, the admin MCP, the standalone server and every MCP, and replaces the `toolbox` and `admin-mcp` images.
- The matrix, the promote loop with its count, and the pipeline's image list read one committed list.
- GHCR visibility is flipped once, for the new package.
- Probe: 265 MB, and every server started from it.

**Terraform.** The `mcp` hostname is added once to both tfvars and to the edge check. No Terraform change follows for any later MCP.

**Registration in ID.** The register Job mints the standalone server's `platform:read` machine client, `standalone-hub`, as it mints `toolbox-hub` today, so the standalone server starts. Then it gets its own machine client: decision D13 of the v0 code audit, built here.
- **Minting.** The client is made with root at the first run, before `make-admin` locks root, and its secret goes into a Kubernetes Secret.
- **Every deploy.** After that, the Job runs on every deploy with that client.
- **What it registers.** For each `standalone` or `both` MCP: the resource `https://mcp.<zone>/<name>/mcp` with the manifest's scopes and `offline_access`, a host client `claude-code-<name>`, and the link.
- **Changes.** It reads each row, compares, and patches with `If-Match`. It never narrows the Toolbox resource, which enable calls widen.
- **The client's power.** The client holds `platform:read platform:write`, as the Toolbox's client already does; ID has no narrower scope. Not yet: a `platform:register` scope in ID.

**Access per organisation.** For a standalone MCP, staff give an organisation access with the admin MCP's `standalone_enable`. It creates the pair capabilities and the login entitlement that sign-in needs, as `toolbox_enable` does for the Toolbox. People then get the MCP's scopes with `access_grant`, for the organisation, a group or a person; `everyone: true` on `standalone_enable` grants the whole organisation in the same step.

**The order of a deploy** (`staging/<name>`, then `production/<name>` on the same commit):
1. Ops RBAC.
2. Bootstrap: the database, the logins, each MCP's schema and roles.
3. `id-migrate`, then `mcps-migrate`.
4. The Deployments roll: the Toolbox with the new provider mounted, and the standalone server with the new path.
5. `--wait`.
6. Register.
7. Smoke: each standalone MCP's metadata, and the Toolbox's `/health`, which names its mounted providers.

Production promotion already refuses a commit that staging hasn't built and signed (`promote-production.yml`, "Verify the staging build"). So staging always comes first, and production runs the identical images.

**Retiring an MCP.**
- Its name goes into `mcps/retired.json` and can never be used again.
- Its schema, roles and ID rows stay until a later contract step removes them.
- Not yet: `bun mcp retire`.

## Local loop

`bun mcp dev acme`:
1. migrates the MCP's local schema;
2. starts the Toolbox (`toolbox`), the standalone server (`standalone`) or both, with hot reload, mounting the MCP, then waits for their `/health`;
3. for a standalone MCP, makes sure its resource and a `claude-code-acme` client exist in the local ID, and gives the developer's organisation access, as `standalone_enable` does;
4. for a Toolbox MCP, enables it for the developer's organisation in the local Toolbox and grants that organisation its grant string. These are local-only conveniences: in staging and production they stay staff decisions;
5. prints the `claude mcp add …` command.

Registering in the local ID uses a local machine client that `bun mcp setup` creates once. It uses the local root secret while root is unlocked. Once root is locked, `bun mcp setup` asks for a staff token one time and says where to get it.

## Documentation, in plain English

Every page follows `AGENTS.md`: a command first, code included from tested files, an Errors table, "Not yet." for anything unbuilt, and a `.md` form.

| Page | What it says |
| --- | --- |
| `mcp/index.mdx` | What an MCP is; the three places it runs; what you get without doing anything: a database, sign-in with Answerable ID, staging and production from tags |
| `mcp/create.mdx` (replaces `quickstart.mdx`, with a redirect) | `bun mcp new`, in a terminal and with flags; every question; what it writes; trying it with `bun mcp dev` |
| `mcp/add-a-tool.mdx` | `bun mcp add tool`; naming; writing a description the model can use; read or change; testing it |
| `mcp/database.mdx` | Your schema is made for you; `src/db/schema.ts`; `bun mcp db <mcp> generate`; migrations ship by themselves; tests use a test schema; limits |
| `mcp/sign-in.mdx` | What Answerable ID does for you in each mode, what staff do per organisation (enable, grant), how a person connects Claude Code |
| `mcp/deploy.mdx` | Staging, then production, with tags; what happens, in order; how to check it worked; rolling back; what is not automatic |
| `mcp/cli.mdx` | Every command, flag and error of `bun mcp`, rendered from the CLI's own definitions by a `<CliReference />` component with a Markdown form, so the page can't drift |
| Updated | `toolbox/add-tools.mdx` (now `--serve toolbox`); `agents.mdx` (one prompt each to create, add a tool, deploy); `local-testing.mdx`; `claude-code.mdx`; `tools.mdx`; `mutations.mdx`; `servers.mdx`; `testing.mdx`; `standard.mdx`; README; docs/08, docs/10, docs/12; the runbook |

**`AGENTS.md`** gains a short "Make an MCP" section at the top of "MCP kit and Toolbox". `CLAUDE.md` already loads `AGENTS.md`, so it needs no change. The section:

```text
New MCP:  bun mcp new <name> --description "…" --serve toolbox|standalone|both [--tool <domain.operation> --tool-description "…"]
New tool: bun mcp add tool <name> <domain.operation> --description "…" [--mutation]
Check:    bun mcp check <name>        Run locally: bun mcp dev <name>        Ship: tag staging/<name>, then production/<name>
Never hand-edit *.generated.* or charts/answerable/mcps.json: bun mcp writes them.
```

## Tests

| Area | What proves it |
| --- | --- |
| CLI | Each command with injected input and output, with and without a terminal; every refusal message (each is an Errors row in the docs); `--json`; no file written when a check fails. Templates are snapshot-tested for a fixed name and date, and the docs render the same files |
| CLI end to end | In a temporary worktree: `bun mcp new` without a terminal, then `bun mcp check` passes; `add tool` for a read and for a mutation, then `check` passes; a second `new` with the same name refuses |
| SDK | `description` on providers, `example` on tools, the exported rules, the manifest's new fields |
| `@answerable/mcp-postgres` | Bootstrap of MCP schemas and roles, idempotent; migration under the owner role with the journal in the schema; grants; `mcpDatabase`: isolation, rollback, no role or organisation left on a released connection (including after a failed query and a failed reset), concurrency; `assertServingLogin` |
| Generators | Drift tests for `charts/answerable/mcps.json`, the Toolbox's mounted list and the standalone server's list |
| Toolbox | A database-backed provider mounted through `mcpDatabase`; `both` mode |
| Standalone server | Routing by path, one audience per MCP, Host checks, evidence, health, unknown paths |
| Ops and pipeline | Bootstrap with the list; one migration Job for MCP schemas beside the hubs' own; register from the list with the new machine client, compare and patch, never narrowing; images list; smoke from the list |
| Admin MCP | `standalone_enable` gives an organisation access to a standalone MCP |
| Chart | Renders with 0, 1, 3 and 200 MCPs, including the size of the rendered release at 200 (Helm's 1 MiB release Secret) |
| Kind stack | One `toolbox` MCP and one `standalone` MCP end to end: schema created, migrated, mounted, path-routed, registered, smoke passing |
| Acceptance | A CLI-made MCP signs a person in through real ID in each mode (new journeys) |
| Scale | A recorded benchmark, not a gate: 200 synthetic MCPs through bootstrap, migration, Toolbox ingest (probe: 1.6 s first boot, 1.8 s unchanged; batched per provider in M4), and a burst over every MCP. Numbers go in the evidence report |
