import { assertProviderConformance } from "@answerable/mcp/testing"
import { createToolboxProvider } from "./whoami"

const caller = { grants: ["e2e/records"], capabilities: [{ identity: "e2e/records.list", kind: "read" as const, policy_class: null }] }

assertProviderConformance(createToolboxProvider(async () => caller), {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: { "toolbox.whoami": {} },
})
