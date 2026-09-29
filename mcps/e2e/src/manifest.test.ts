import { expect, test } from "bun:test"
import { manifest } from "@answerable/mcp"
import { createE2eProvider } from "./mcp"
import { createRecordStore } from "./records"

test("manifest.json matches the provider", async () => {
  const provider = createE2eProvider({ records: createRecordStore(), viewHtml: "<!doctype html>" })
  const committed = await Bun.file(new URL("../manifest.json", import.meta.url)).json()
  expect(committed, "mcps/e2e/manifest.json is out of date; run bun run --filter @answerable/mcp-e2e manifest").toEqual(manifest(provider))
})
