import { manifest } from "@answerable/mcp"
import { createE2eProvider } from "../src/mcp"
import { createRecordStore } from "../src/records"

// The view's HTML is not part of the manifest.
const provider = createE2eProvider({ records: createRecordStore(), viewHtml: "<!doctype html>" })
await Bun.write(new URL("../manifest.json", import.meta.url), `${JSON.stringify(manifest(provider), null, 2)}\n`)
console.log("Wrote mcps/e2e/manifest.json")
