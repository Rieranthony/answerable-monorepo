import { assertProviderConformance } from "@answerable/mcp/testing"
import { createE2eProvider } from "./mcp"
import { createRecordStore } from "./records"

const records = createRecordStore()

assertProviderConformance(createE2eProvider({ records, viewHtml: "<!doctype html><title>Records</title>" }), {
  manifest: new URL("../manifest.json", import.meta.url),
  // A delete needs a record to delete: an input no definition can hold.
  examples: { "records.delete": principal => ({ id: records.create(principal, "Doomed").id }) },
  moveTarget: (target, principal) => records.touch(principal, target.resource_id),
})
