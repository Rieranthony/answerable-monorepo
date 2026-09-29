import { assertProviderConformance } from "@answerable/mcp/testing"
import { createToolboxProvider } from "./meta"
import { e2e } from "./test/hub"

// The Toolbox's own tools against a hub that grants the e2e records list and create, and runs nothing.
const provider = e2e()
const tool = (name: string) => provider.tools.find(item => item.name === name)!
const caller = { grants: ["e2e/records"], capabilities: [{ tool: tool("records.list"), policy_class: null }, { tool: tool("records.create"), policy_class: "agent" as const }] }

assertProviderConformance(createToolboxProvider({
  providers: [provider],
  caller: async () => caller,
  search: async () => ["e2e/records.list"],
  run: async ran => ({ ran: ran.identity }),
  refused: () => {},
}), {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: {
    "toolbox.whoami": {},
    "toolbox.search": { query: "records" },
    "toolbox.describe": { identities: ["e2e/records.list"] },
    "toolbox.execute": { identity: "e2e/records.list" },
    "toolbox.prepare": { identity: "e2e/records.create", arguments: { title: "Conformance" } },
  },
})
