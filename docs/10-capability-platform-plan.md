# Capability platform plan

> **TL;DR**
> - **Decides:** the first goal (MCP base, the e2e MCP, the Toolbox MCP with basic tools), the bar it must meet for developer experience, documentation, tests and simplicity, the briefs that deliver it and which model runs each, and the order of everything after it.
> - **Rule:** order, not time. A new tool is five fields and one test. Nothing lands without documentation and automated tests.
> - **Not here:** the design ([`08-capability-platform.md`](08-capability-platform.md)), the rules ([`09-mcp-design-standard.md`](09-mcp-design-standard.md)), the evidence ([research](../reports/mcp-platform-research-2026-09-28.md)).

The goal below has been delivered, with the prompt in [`goals/toolbox-goal.md`](goals/toolbox-goal.md). Its register rows moved into [`02-plan.md`](02-plan.md#open-register) and its "Do not re-propose" lines joined that list. "After the goal" stays here.

## The goal

Three things exist at the end, and they are the same kit an outside developer would use, even though only the monorepo uses them for now.

| Deliverable | Where | What "done" means |
| --- | --- | --- |
| **MCP base** | `packages/mcp` (`@answerable/mcp`, the package formerly `mcp-base`) with `packages/auth` | `defineTool`, `defineMutation`, `defineProvider`, `createMcpServer`, the manifest export, the conformance kit and the in-process test client; every export documented; 100% coverage. |
| **e2e MCP** | `mcps/e2e` | Kept as the reference server and the real-ID acceptance. Rebuilt on the new definitions: the same five tools, one of them a proper mutation with a versioned target, plus the prompt, resource and view. |
| **Toolbox MCP** | `mcps/toolbox` | One MCP endpoint on Answerable ID with the basic tools: the direct projection of a person's granted tools, `toolbox_whoami`, `toolbox_search`, `toolbox_describe`, `toolbox_execute`, `toolbox_prepare`, `toolbox_commit`, `toolbox_commit_confirmed`; the e2e provider mounted as its first provider; grants read live from ID; the catalogue; evidence rows and spans. |

**In the goal.** The agent and controlled policy classes end to end; the human class answers `APPROVAL_REQUIRED` with no page yet. Direct and meta projections. Postgres full-text search. The platform-tier admin API of the hub for the catalogue and the one-call "enable the Toolbox for an organisation" operation. The acceptance kit extracted to `packages/acceptance`. A scaffolding command. The documentation site pages listed below. The evidence report updated with measured numbers.

**Out of the goal**, each already ordered in "After the goal": approval pages, operations and the worker, run_code, the OpenAPI adapter and the admin MCP, tenant self-service in ID, CIMD and DCR, hosted deployment, remote providers.

## The bar

**Developer experience.** A read tool is five fields:

```ts
import { defineTool } from "@answerable/mcp"
import { z } from "zod"

export const rfisList = defineTool({
  name: "rfis.list",
  description: "List the RFIs of a project, newest first. Use projects.search first to find the project id.",
  input: z.object({ projectId: z.string(), limit: z.number().int().max(100).default(20), cursor: z.string().optional() }),
  output: z.object({ items: z.array(rfi), next_cursor: z.string().nullable(), has_more: z.boolean() }),
  async execute({ projectId, limit, cursor }, { principal, upstream }) { /* ... */ },
})
```

Everything else has a default: `kind` is `read` unless the definition has `prepare` and `commit`, `version` is the provider's, `risk` is `normal`, `cost_units` is 1, annotations and `_meta` are derived, the tool name on the wire is derived from `name`. A mutation adds `prepare` and `commit` and nothing else. A provider is `defineProvider({ id, version, tools })`. A server is `createMcpServer({ provider, auth })`. A test is `createTestMcp` plus `assertProviderConformance`. The scaffold makes a new server with one tool, one test, a manifest snapshot and its environment file in one command: `bun run mcp:new <name>`. One command checks a package: `bun run mcp:check` (typecheck, lint, tests with coverage, conformance, manifest drift).

The rule for every API decision in the goal: if a field, option or step can be derived or defaulted, it is. Names are the ones authors already know: `defineTool`, not `defineCapability`. Error messages name the definition and say what to change.

**SDK from day one.** Every export carries documentation comments that the reference page is generated from; the `exports` map is the whole public surface; nothing imports a package's internals; types are exported; packages are versioned `0.x` with a changelog; each package has a README that runs; examples live in `mcps/e2e` and are tested. A public npm release is not in the goal, and nothing in the goal would have to change for it.

**Documentation.** Every behaviour that lands has its page on the docs site before the brief is done, following [`AGENTS.md`](../AGENTS.md): a copy-pasteable command or definition first, tables, a Limits section, an Errors table, "Not yet." for what is not built, `title` and `description` on every page, cross-links both ways.

| Page (`apps/web/content/docs/mcp/`) | Content |
| --- | --- |
| `index.mdx` | What the kit is, status, the packages table, how a request is authorised |
| `authoring.mdx` | The five-field tool, the mutation, the provider, the server, descriptions, pagination, errors |
| `testing.mdx` | `createTestMcp`, the conformance kit, the manifest snapshot, `mcp:check`, the acceptance |
| `toolbox.mdx` | What the Toolbox is, what a person sees, direct and meta projections, prepare and commit, the policy classes, whoami |
| `toolbox-admin.mdx` | Enabling an organisation, the catalogue, grant strings in ID entitlements, host clients |
| `standard.mdx` | The rules of [`09-mcp-design-standard.md`](09-mcp-design-standard.md) in docs form, with what enforces each |
| `reference.mdx` | Generated API reference for `@answerable/mcp` and `@answerable/auth` |
| `errors.mdx` | Every error code, its meaning, its retry policy |
| `claude-code.mdx`, `local-testing.mdx` | Updated for the Toolbox |

`docs/07-mcp-platform-draft.md` becomes the record of the foundation decisions and points here; `README.md` and `AGENTS.md` gain the new workspaces, commands and gates.

**Tests.** Every change starts with a failing test. `packages/mcp`, `packages/auth`, `packages/acceptance` and `mcps/toolbox` gate 100% line and function coverage. Every provider runs the conformance kit. The acceptance journeys below run against real Answerable ID through `packages/acceptance` and are part of `bun run mcp:test:e2e`. The host lane (a LibreChat container, Claude Code by hand) is recorded in the evidence report and is not a gate. Measured numbers, never estimates, in docs and the evidence report.

**Quality.** Small files with one job, plain data over classes, closures over containers, no configuration that a default would cover, no abstraction with one caller, no feature outside the goal, no comment that repeats the code. Delete before simplifying, simplify before optimising, optimise before automating. Every brief ends with a first-principles cleanup pass by the agent that built it (the prompt is in [`goals/toolbox-goal.md`](goals/toolbox-goal.md)), and the whole tree gets the same pass after B5 and after B8. A reviewer reads the diff against the design and the standard; anything the standard does not require and the goal does not need comes out.

## Briefs

The goal is delivered as briefs, one bounded job each. Fable 5.1 coordinates: writes each brief from this plan and the design, reviews the diff, runs the gates, lands on `main`. Opus 5.5 takes the complicated briefs; Sonnet 5.5 the ordinary ones. Every brief names its tests first, the documentation page it must leave complete, and what it must not touch.

| # | Brief | Model | Depends on |
| --- | --- | --- | --- |
| B0 | Land pull request 11 rebased on `main`; gates green; evidence report entry. | Sonnet 5.5 | |
| B1 | SDK tool model: `defineTool` with defaults, identity and version, derived annotations and `_meta`, host-safe names, the error envelope with `retry.policy`, the pagination contract, `defineProvider`, `manifest()` with the drift test, `createMcpServer({ provider, auth })`. `mcps/e2e` moved to it. | Opus 5.5 | B0 |
| B2 | Conformance kit read checks and `assertProviderConformance`; `mcp:check`; TSDoc on every export; `reference.mdx` generation; `authoring.mdx` and `testing.mdx` rewritten. | Sonnet 5.5 | B1 |
| B3 | Prepared mutations in the SDK: `defineMutation`, the intent store interface with in-memory and Postgres implementations, intents, commit tokens, policy classes from `risk`, state machine, staleness, idempotent replay, receipts, the two commit tools, conformance mutate checks; the e2e mutation with a versioned target; `errors.mdx`. | Opus 5.5 | B1 |
| B4 | `packages/acceptance`: the ID fixture, the OAuth client and the browser sign-in extracted from `mcps/e2e`; journeys J4 and J5 added to the acceptance. | Sonnet 5.5 | B3 |
| B5 | Toolbox core: `mcps/toolbox` with the endpoint, the grants reader against ID's member access view with the cache and the audit-log poller, the catalogue tables, the direct projection, `toolbox_whoami`, evidence rows with the hash chain, spans, `/health`, the e2e provider mounted; journeys J1, J2, J3, J10. | Opus 5.5 | B1, B4 |
| B6 | Toolbox mutations and meta projection: `toolbox_prepare`, `toolbox_commit`, `toolbox_commit_confirmed`, `toolbox_search` on Postgres full text, `toolbox_describe`, `toolbox_execute`, `list_changed` on grant change, host client settings; journeys J6 and J7. | Opus 5.5 | B3, B5 |
| B7 | Toolbox administration: the platform-tier admin API for the catalogue and host clients, the enable-organisation operation performing the ID calls, `toolbox-admin.mdx`, `toolbox.mdx`. | Sonnet 5.5 | B5 |
| B8 | Scaffold and polish: `mcp:new`, README per package, `README.md` and `AGENTS.md` updates, `standard.mdx`, `index.mdx`, `claude-code.mdx` and `local-testing.mdx` for the Toolbox, `docs/07` pointer; a sweep for anything undocumented or untested. | Sonnet 5.5 | B2, B6, B7 |
| B9 | Host lane: Claude Code against the Toolbox by hand with a partial entitlement (J9); the LibreChat container with a public client (J8); the evidence report. | Sonnet 5.5 | B8 |

B1 and B3 can run in parallel with B4's extraction; B5 waits for both. Each brief ends with the evidence report updated: commands, counts, measured numbers, what testing found.

## Acceptance journeys

Each journey runs against real Answerable ID through `packages/acceptance` unless marked otherwise.

| Journey | Proves |
| --- | --- |
| J1 direct list | A fully entitled member sees exactly the catalogue's tools in deterministic order with honest annotations and `_meta`; `toolbox_whoami` returns the person, organisation and grants; a call succeeds; evidence and a span exist. |
| J2 partial and denied | A member with a domain grant sees only that domain; a member with no Toolbox grant sees nothing and a call is the unknown-tool error; a disabled organisation stops at refresh. |
| J3 grant change without re-authorisation | An entitlement row changes in ID; within 60 s the same token lists the new tool and `list_changed` was published. |
| J4 agent-class mutation | Prepare returns a semantic preview and a token; commit returns a receipt; a repeat returns the same receipt as replay; a changed target answers `INTENT_STALE`; an expired intent answers `INTENT_EXPIRED`. |
| J5 controlled class | `toolbox_commit` answers `APPROVAL_REQUIRED`; `toolbox_commit_confirmed` with the matching summary commits; a wrong summary refuses. |
| J6 human class | The class answers `APPROVAL_REQUIRED` and records the intent as awaiting approval; the page is Not yet. |
| J7 meta projection | A member with more than 40 grants gets the meta tools; search finds a capability by a word from its description; describe returns its schema; execute runs it; prepare and commit work through the meta tools. |
| J8 OmniChat (host lane) | A LibreChat container with `oauth.client_id` set signs a person in through ID, sends `resource`, lists tools with the text mirror, calls a read and a mutation, and refreshes. |
| J9 Claude Code (host lane) | A partial entitlement by hand; the confirmed commit prompts even under an allow rule. |
| J10 evidence | The chain verifies; an update or delete is rejected by the trigger; a payload erasure keeps the chain valid. |

## After the goal

In order, each with the exit evidence the design names.

1. Approval pages for the human class (the hub as an OIDC client of ID, `toolbox/approve`, `four_eyes`) and the operations table with the pg-boss worker.
2. Tenant-tier writes for groups, group members and entitlements in ID; the OpenAPI adapter with ID's admin API as its first source, producing the admin MCP as a generated provider.
3. Hosts: CIMD and policy-gated DCR in ID with the Better Auth upgrade as its own commit; hosted deployment; Claude.ai on a public URL.
4. Programmatic composition: `toolbox_run` on QuickJS in a pool of secret-free Bun subprocesses (capped WebAssembly memory, host-side deadline, call budget, parent-side kill), typed handles, intents returned as a set.
5. Remote providers and upstream identity: RFC 8693 token exchange in ID, the credential vault and per-person connect flows, the upstream-MCP adapter.
6. Public SDK release and third-party providers.
7. Query surface, only when its trigger in the design fires.

## Backlog

Usage telemetry in Answerable ID and a usage store joined on the ID subject (tool usage from the Toolbox evidence, model and token usage exported from OmniChat cells), a separate pass · Events and subscriptions · batch intents · embedding search · GraphQL adapter · ID-JAG acceptance at ID · DPoP at the hub · machine principals with sponsors · Answerable Control extraction · ToolHive for third-party stdio servers · Restate spike when the workflow trigger fires · ChatGPT and Copilot Studio certification.
