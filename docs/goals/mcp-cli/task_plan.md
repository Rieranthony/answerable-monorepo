# MCP CLI and shipping: plan

**Goal.** One command, `bun mcp new`, that a person or a coding agent runs to make a new MCP. That MCP gets its database and its Answerable ID sign-in without anyone setting them up, and ships to staging, then production, from a tag. It runs in the Toolbox, alone, or both. A second command, `bun mcp add tool`, adds a tool to an existing MCP. The plan must hold at about 200 MCPs. Every behaviour is tested, and documented in plain English.

**Asked on 2026-10-25** by the owner, after the [MCP platform audit](https://claude.ai/artifact/1GnbzkQF8TnUr94rLYYksF):

> "Let's focus for now on US shipping MCPs fairly simply. I like the fact we can have a one command setup. We need to make sure that when we do this, if the MCP ships, automatically we have the new MCP having their database (and auto work on staging then if possible and prod after) we have something that reuses connexion and postgres. Open question: can we make one MCP we own available through the toolbox fairly easily?"

Then:

> "Why not create a CLI for us to spin up a new MCP. Is it part of the toolbox? Just standalone MCP? Standalone MCP available in Toolbox? Name? (check the name entered), description of the MCP. Name of the first tool and description (can skip). Tools should have a unique name / good description (add in the creation template proper comments to help). We can even have a CLI option to spin up a new basic tool inside a MCP. Something I want you to check: how could we make sure our database strategy scales and supports many MCP (at some point maybe like 200???). This CLI must be super easy to use / understand by LLMs, they will be the ones most likely using it, so we should have the CLAUDE.md and AGENTS.md have the simple instructions. I want you then to DOCUMENT in our documentation, in plain, simple English: how to spin up a new MCP, how to add a tool, how we deploy new MCP (explain staging / prod). Be clear about the fact we automatically get a database linked to the MCP + that we get auth setup with ID. Plan with files and report here. This should be perfect, no corner cut, this will impact a lot of our code / users. Everything should be tested and the DEVELOPER EXPERIENCE SHOULD BE IMMACULATE. 10/10 or nothing."

**Status:** approved by the owner on 2026-10-25 (D1 to D4 and D17 to D19 as recommended; D5 to D16 stand). The briefs are written. Nothing is coded. Building starts after typed configuration's B1 and B2 land (D3). The planning files are:
- this file;
- [`findings.md`](findings.md): every fact and how it was established;
- [`design.md`](design.md): the behaviour the briefs build;
- [`decisions.md`](decisions.md);
- [`progress.md`](progress.md): the session log and probe numbers.

## Phases

| # | Phase | Status |
| --- | --- | --- |
| 1 | Audit and first probes: scaffold timing, Toolbox mount, image, path routing | complete |
| 2 | Deploy automation facts: every hard-coded service list, and how each would read a declared list | complete |
| 3 | Database strategy at 200 MCPs: probes on a throwaway Postgres | complete |
| 4 | CLI and DX research: commands, terminal detection, templates, local sign-in, docs components | complete |
| 5 | Design and decisions | complete; approved by the owner on 2026-10-25 |
| 6 | Briefs, tests named first, model per brief | complete: `briefs/` |
| 7 | Build M1 to M9 | after typed configuration's B1 and B2 (D3) |
| 8 | Ship: `staging/<name>`, then `production/<name>` | the owner's tags |

## Briefs

Every brief is written in full in [`briefs/`](briefs/README.md). An independent review on 2026-10-25 found 30 problems: 7 that would have failed a brief, 16 to fix and 7 minor. All are fixed in the briefs; `progress.md` lists them. [`briefs/README.md`](briefs/README.md) holds what they share:
- who does what;
- what to read first;
- the rules that bind;
- the gates;
- the cleanup pass, verbatim;
- the report contract.

The coordinator dispatches each brief to its model in its own worktree (`.claude/worktrees/mcp-cli-m<N>`), reviews the diff against [`design.md`](design.md), runs the gates and lands the brief on `main`.

The SDK work and the CLI were one brief in the first outline. They are two here (M2, M3), because each changes a contract that the next one builds on.

| # | Brief | Model | Depends on | Exit evidence |
| --- | --- | --- | --- | --- |
| [M1](briefs/m1.md) | Database model in `@answerable/mcp-postgres`: provisioning (shared and own), migrations under the owner role, grants, `mcpDatabase` with organisation isolation, the serving login's assertion, the test helper, the role-switching scan | Opus 5.5 | typed configuration B1 and B2 | Isolation between MCPs and organisations; no role or organisation left on a released connection, even after a failed reset; overhead per borrow measured |
| [M2](briefs/m2.md) | SDK: `description`, `database` and `example`; the context (`person`, `organisation`, `client`, typed `db`); `createIdProfiles`; the call scope; both `createTestMcp`s; every caller moved | Opus 5.5 | M1 | Every MCP suite and the acceptance green; the type test |
| [M3](briefs/m3.md) | `bun mcp`: `new`, `add tool`, `list`, `check`, `db`, `help`; the templates with their guidance comments; `mcp.json` and `retired.json`; the generator; `mcps/example` rebuilt with the CLI | Opus 5.5 | M2 | The end-to-end CLI test in a temporary worktree; every refusal tested; step timings |
| [M4](briefs/m4.md) | Runtime: `@answerable/mcp-platform` (evidence, profiles and poller, health, db per MCP); the Toolbox mounting from the generated list with batched ingest; `mcps/standalone`; the admin MCP on the shared wiring; e2e on Postgres as `both`; the acceptance with two new journeys | Opus 5.5 | M3 | Acceptance green; e2e agreeing across two processes; ingest and latency measured |
| [M5](briefs/m5.md) | Shipping: one `mcps` image; the chart from `mcps.json`; bootstrap, one migration Job; the standalone Deployment and path Ingress on `mcp.<zone>`; the `mcp` hostname in Terraform; `run-job` at the deployed revision; the kind stack; the chart at 200 | Opus 5.5 | M4 | `infra:check` and `infra:test` green; release size at 200; migration time |
| [M6](briefs/m6.md) | Registration: the register Job's own machine client (D13), proven against ID first; register from the list on every deploy, comparing and patching, never narrowing; the standalone server's client | Opus 5.5 | M5 | The kind stack registering a new MCP after the root lock, and a sign-in to it |
| [M7](briefs/m7.md) | Local loop: `bun mcp setup` and `bun mcp dev`; journeys for a CLI-made MCP in each mode through real ID | Sonnet 5.5 | M6 | Journeys green; `bun mcp dev` to ready, measured; one by-hand Claude Code run, or the steps for the owner |
| [M8](briefs/m8.md) | Documentation in plain English: index, create, add a tool, database, sign-in, deploy, the CLI reference from the code; `AGENTS.md`; agents prompts; redirects; a fresh agent working only from the docs | Sonnet 5.5 | M7 | `bun --filter web test` green; the fresh agent's two runs reported |
| [M9](briefs/m9.md) | The pass over the whole goal; `knip`; the 200-MCP benchmark; every gate; the end-to-end proof from a clean worktree; the evidence report | Opus 5.5 | M8 | All gates green; the benchmark against the probes in the evidence report |

The order is M1 to M9, one at a time. `mcp:test:e2e` and `infra:test` (M2, M4, M5, M6, M7, M9) never run beside another acceptance or kind stack on this machine.

## Landing

- **M1, M2, M3, M7 and M8:** each lands on `main` on its own, because none changes what a tag ships.
- **M4, M5 and M6 change the deployment together.** After M4, the Toolbox needs `TOOLBOX_MCPS_DATABASE_URL`. After M5, the standalone server needs its client and its Secrets. So they are built one after the other on an integration branch, `claude/mcp-cli`, and land on `main` together once M6's kind stack passes. Until then, `main` stays shippable for the civo-deploy work, and no tag is pushed from the branch.
- **M9** lands last.

## Risks to test first

1. **`mcpDatabase` under failure.** A connection whose reset fails must be destroyed, never returned with a role or an organisation. M1's first test.
2. **Migrating as the owner role.** The role has no `CREATE` on the database, and Postgres refuses even `CREATE SCHEMA IF NOT EXISTS` to it (F10, probed). M1 applies the journal itself and the CLI strips drizzle-kit's schema line. M1 proves both against Postgres first.
3. **drizzle-kit's row-level-security output** in a `pgSchema`: `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` on the qualified table. M1.
4. **Helm's 1 MiB release Secret at 200 MCPs.** M5 measures it.
5. **Path routing through Traefik and Cloudflare on `mcp.<zone>`,** the well-known path included. The kind stack in M5, staging at the first ship.
6. **A machine principal creating resources and clients in ID after the root lock.** Not yet verified (F5). M6's first test.
7. **`run-job` checking out `main` ahead of the deployed commit** (F6). M5 fixes it.
8. **Civo's `max_connections`,** still unmeasured (B7a). The first staging ship records it.

## Errors encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
| Probe script inserted into `body_hash`; the column is `hash` | 1 | Read the table with `\d`, fixed the column |
| `timeout` is not on macOS | 1 | Ran without it |
| Routing probe answered 404 everywhere: zsh does not split `$u` in `set -- $u`, so every request went to `/` | 2 | Ran the loop under `bash -c` |
| Routing probe answered 403 `Invalid Host: 127.0.0.1` | 1 | Correct behaviour: the SDK's Host check wants the resource URL's host; requested `localhost` |
