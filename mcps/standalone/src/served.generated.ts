// Written by bun mcp from mcps/*/mcp.json (scripts/mcp/generate.ts): every MCP the standalone server serves, serve standalone or both. Never edit it by hand.
import type { Declared } from "@answerable/mcp-platform"
import { provider as e2eProvider } from "@answerable/mcp-e2e/provider"

/** The MCPs the standalone server serves: each provider, and where its tables live. */
export const served: readonly Declared[] = [
  { provider: e2eProvider, database: "shared" },
]
