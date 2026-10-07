import { createMcpServer, readMcpEnvironment } from "@answerable/mcp"
import { createE2eProvider } from "./mcp"
import { createRecordStore } from "./records"
import { viewHtml } from "./view"

const { auth, port } = readMcpEnvironment(process.env)
const mcp = createMcpServer({ provider: createE2eProvider({ records: createRecordStore(), viewHtml }), auth })
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: mcp.fetch })
console.log(`E2E MCP serving ${auth.resource}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await server.stop()
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
