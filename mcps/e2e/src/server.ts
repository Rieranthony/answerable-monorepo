import { createIdAdmin, createIdProfiles } from "@answerable/id-admin"
import { createMcpServer, readMcpEnvironment } from "@answerable/mcp"
import { createE2eProvider } from "./mcp"
import { createRecordStore } from "./records"
import { viewHtml } from "./view"

//#region profiles
const { auth, port, id } = readMcpEnvironment(process.env)
// Every handler is told who is calling, which only ID knows: without a machine client the server does not start.
if (!id) {
  console.error("The e2e MCP cannot start: set MCP_ID_CLIENT_ID and MCP_ID_CLIENT_SECRET, a machine client in ID with platform:read, to read who is calling")
  process.exit(1)
}
const mcp = createMcpServer({ provider: createE2eProvider({ records: createRecordStore(), viewHtml }), auth, profiles: createIdProfiles(createIdAdmin(id)) })
//#endregion
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
