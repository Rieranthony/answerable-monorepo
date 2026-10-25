// The MCPs the Toolbox mounts, as its tests serve them: in a shared MCP database of this suite's own, answerable_toolbox_test_mcps, under the
// role prefix mcp_tbx, made once for the run and dropped after it (src/test/preload.ts).
import { mcpDatabases } from "@answerable/mcp-platform"
import { testSharedMcps } from "@answerable/mcp-platform/testing"
import { mounted } from "../mounted.generated"

export const prefix = "mcp_tbx"
export const databases = await testSharedMcps({ name: "answerable_toolbox_test_mcps", prefix, mcps: mounted.map(entry => entry.provider) })
export const opened = mcpDatabases(mounted, { shared: databases.url, own: {}, prefix })
/** The mounted e2e provider, with its db. */
export const e2e = opened.mount.find(entry => entry.provider.id === "e2e")!
