import { assertProviderConformance } from "@answerable/mcp/testing"
import { createE2eProvider } from "./mcp"
import { createRecordStore } from "./records"

const records = createRecordStore()

assertProviderConformance(createE2eProvider({ records, viewHtml: "<!doctype html><title>Records</title>" }), {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: {
    "identity.get": {},
    "records.list": { limit: 5 },
    "records.show": {},
    "records.create": { title: "Example" },
    "records.delete": principal => ({ id: records.create(principal, "Doomed").id }),
  },
  moveTarget: (target, principal) => records.touch(principal, target.resource_id),
})
