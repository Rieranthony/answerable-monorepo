import { assertProviderConformance } from "@answerable/mcp-postgres/testing"
import { provider } from "./provider"

// One test per check of the Answerable MCP standard, for every tool, each called with its example; and manifest.json, the contract.
assertProviderConformance(provider, { manifest: new URL("../manifest.json", import.meta.url) })
