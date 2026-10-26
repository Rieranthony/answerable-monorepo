// The MCPs the standalone server's tests serve, e2e and example, in a shared MCP database of this suite's own, answerable_standalone_test_mcps,
// under the role prefix mcp_std, made once for the run and dropped after it (src/test/preload.ts).
import { provider as e2e } from "@answerable/mcp-e2e/provider"
import { provider as example } from "@answerable/mcp-example/provider"
import { testSharedMcps } from "@answerable/mcp-platform/testing"

export const prefix = "mcp_std"
/** The providers the suite serves. */
export const providers = [e2e, example]
export const databases = await testSharedMcps({ name: "answerable_standalone_test_mcps", prefix, mcps: providers })
