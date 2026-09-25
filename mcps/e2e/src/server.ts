import { createE2eMcp } from "./mcp"
import { readMcpEnvironment } from "@answerable/mcp"
import { createRecordStore } from "./records"

const config = readMcpEnvironment(process.env)
const view = Bun.file(new URL("../dist/records.html", import.meta.url))
if (!await view.exists()) throw new Error("Missing records view. Run bun run --filter @answerable/mcp-e2e build first.")
const records = createRecordStore()
const app = createE2eMcp({ auth: config.auth, records, viewHtml: await view.text() })
const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch: app.fetch })
console.log(`E2E MCP serving ${config.auth.resource}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await server.stop()
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
