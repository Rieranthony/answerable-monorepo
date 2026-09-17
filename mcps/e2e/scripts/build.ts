import { buildView } from "@answerable/mcp-base/build"

const html = await buildView({
  entry: new URL("../src/views/records.tsx", import.meta.url).pathname,
  title: "Answerable test records",
})
await Bun.write(new URL("../dist/records.html", import.meta.url), html)
console.log("Built records MCP Apps view")
