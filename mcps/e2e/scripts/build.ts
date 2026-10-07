import { buildView } from "@answerable/mcp/build"

const html = await buildView({
  entry: Bun.fileURLToPath(new URL("../src/views/records.tsx", import.meta.url)),
  title: "Answerable test records",
})
await Bun.write(new URL("../dist/records.html", import.meta.url), html)
console.log("Built records MCP Apps view")
