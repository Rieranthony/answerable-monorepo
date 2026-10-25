// Written by bun mcp from mcps/*/mcp.json (scripts/mcp/generate.ts): every MCP the Toolbox mounts, serve toolbox or both. Never edit it by hand.
import type { Declared } from "@answerable/mcp-platform"
import { provider as e2eProvider } from "@answerable/mcp-e2e/provider"
import { provider as exampleProvider } from "@answerable/mcp-example/provider"

/** The MCPs the Toolbox mounts: each provider, and where its tables live. */
export const mounted: readonly Declared[] = [
  { provider: e2eProvider, database: "shared" },
  { provider: exampleProvider, database: "shared" },
]
