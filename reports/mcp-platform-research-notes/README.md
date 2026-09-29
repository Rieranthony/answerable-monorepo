# Research notes

Raw notes behind [`../mcp-platform-research-2026-09-28.md`](../mcp-platform-research-2026-09-28.md), one file per research pass, produced on 28 September 2026 by the sub agents and the Codex browsing pass. Each fact inside is marked verified (with its URL, commit or file and line) or inferred. They are kept as evidence for the implementation steps; the report is the summary and the design documents are the decisions. One correction applies throughout: the installed MCP SDK 2.1.0 does implement the 2026-07-28 protocol (verified by grep of the server bundle and by this repository's acceptance), contrary to one note's summary.

| File | Pass |
| --- | --- |
| `answerable-id-authorisation-model.md` | Answerable ID schema, policy, tokens, admin API, access views, audit |
| `mcp-packages-and-sdk-inventory.md` | `packages/auth`, the MCP package on main and on pull request 11, `mcps/e2e`, the installed SDK inventory |
| `consumers-and-hosts-in-repo.md` | The tutor MCP, OmniChat, external tools, the docs conventions |
| `executor.md` | UsefulSoftwareCo/executor at a0b0d915 |
| `toolhive.md` | stacklok/toolhive at 61aaf42 |
| `mcp-specification-and-hosts.md` | MCP revisions, SDK, host matrix, Anthropic API features |
| `palantir-and-authorisation.md` | Palantir, enterprise admin controls, identity for agents, engines, standards |
| `sandboxes-and-code-mode.md` | Code mode designs and the Bun sandbox probes with measured numbers |
| `gateways-and-librechat.md` | LibreChat at c8c5478 and the gateway landscape |
| `prepared-mutations-approvals-and-query-surfaces.md` | Two-phase prior art, approval binding, GraphQL evidence, OpenAPI projection, error taxonomies |
| `observability-evidence-and-durable-execution.md` | OpenTelemetry, evidence schemas, durable execution options, limits, versioning |
| `codex-chrome-browsing-pass.md` | Official pages read in Chrome: Palantir, Anthropic, OpenAI, ToolHive, Microsoft, Executor |
