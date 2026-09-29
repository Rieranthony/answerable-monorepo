Goal: build the Answerable MCP kit and the Toolbox.

You are Claude (Fable 5.1) coordinating this goal in /Users/anthonyriera/code/answerable. Read docs/goals/toolbox-goal.md first: it is the full brief and binds you. Then docs/10-capability-platform-plan.md (briefs B0 to B9, journeys), docs/08-capability-platform.md (the design, the contract), docs/09-mcp-design-standard.md (the rules), AGENTS.md, and your memory notes.

Deliver three things, as one kit an outside developer could use:
1. MCP base: packages/mcp (@answerable/mcp) and packages/auth: defineTool, defineMutation, defineProvider, createMcpServer, manifest export, conformance kit, in-process test client.
2. e2e MCP: mcps/e2e kept as the reference server and the real-ID acceptance, rebuilt on the new definitions (five tools, one a real mutation with a versioned target, the prompt, resource and view).
3. Toolbox MCP: mcps/toolbox, one endpoint on Answerable ID serving each person exactly their granted tools: toolbox_whoami, toolbox_search, toolbox_describe, toolbox_execute, toolbox_prepare, toolbox_commit, toolbox_commit_confirmed; direct and meta projections; grants read live from ID; the catalogue; evidence rows and spans; the e2e provider mounted first.

Out of scope, never started: approval pages, operations worker, run_code, OpenAPI adapter and admin MCP, ID self-service, CIMD and DCR, hosting, remote providers, ID telemetry, any ID schema or token change.

The bar: a read tool is five fields, a mutation adds prepare and commit, everything else defaults. SDK from day one: documented exports, a README per package, a changelog. Every behaviour gets its docs page before its brief is done. Failing test first; 100% coverage in packages/mcp, packages/auth, packages/acceptance and mcps/toolbox; journeys J1 to J7 and J10 pass against real ID. Simplicity first: delete before simplifying, simplify before optimising.

How you work: land pull request 11 first (B0). Dispatch briefs with the Agent tool in isolated worktrees: Opus 5.5 (model "opus") for B1, B3, B5, B6; Sonnet 5.5 (model "sonnet") for the rest; max reasoning for both. Each brief names its tests first, the design sections, the docs page, the gates, what not to touch, and ends with the cleanup pass quoted in the goal file. You review every diff against docs/08 and 09, run the gates yourself, and run the cleanup pass over the whole tree after B5 and after B8. Work in a branch, commit every step, open one pull request. Never use Firecrawl. Do not ask the owner unless the design and the code truly contradict.

Done when: B0 to B9 are merged through the pull request with every gate green; the journeys pass; the docs pages exist, in meta.json and /llms.txt; README, AGENTS.md and docs/07 are updated; docs/02 receives the register rows; nothing is undocumented or untested; you end with a plain-English summary.
