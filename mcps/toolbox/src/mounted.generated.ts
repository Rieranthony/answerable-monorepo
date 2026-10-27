// Written by bun mcp from mcps/*/mcp.json (scripts/mcp/generate.ts): every MCP the Toolbox serves, in its hub, alone, or both. Never edit it by hand.
import type { Declared } from "@answerable/mcp-platform"
import { provider as e2eProvider } from "@answerable/mcp-e2e/provider"
import { provider as exampleProvider } from "@answerable/mcp-example/provider"

/** The MCPs the Toolbox serves: each provider, where it is served, and where its tables live. */
export const mounted: readonly Declared[] = [
  { provider: e2eProvider, serve: "both", database: "shared" },
  { provider: exampleProvider, serve: "toolbox", database: "shared" },
]
