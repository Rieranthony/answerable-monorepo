import { createE2eMcp } from "./mcp"
import { readConfig } from "./config"
import { createRecordStore } from "./services/records"

const config = readConfig(process.env)
const view = Bun.file(new URL("../dist/records.html", import.meta.url))
if (!await view.exists()) throw new Error("Missing records view. Run bun run --filter @answerable/mcp-e2e build first.")
const records = createRecordStore(config.recordsPath)
const app = createE2eMcp({ auth: config.auth, records, viewHtml: await view.text() })
const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch: app.fetch })
console.log(`E2E MCP listening on ${server.url}mcp; resource ${config.auth.resource}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await server.stop()
  records.close()
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
