import { createIdAdmin, createIdProfiles } from "@answerable/id-admin"
import { createMcpServer, readMcpEnvironment } from "@answerable/mcp"
import { provider } from "./provider"

const { auth, port, id } = readMcpEnvironment(process.env)
// Every handler is told who is calling, which only ID knows: without a machine client the server does not start.
if (!id) {
  console.error("The example MCP cannot start: set MCP_ID_CLIENT_ID and MCP_ID_CLIENT_SECRET, a machine client in ID with platform:read, to read who is calling")
  process.exit(1)
}
const server = createMcpServer({ provider, auth, profiles: createIdProfiles(createIdAdmin(id)) })
Bun.serve({ hostname: "127.0.0.1", port, fetch: server.fetch })
console.log(`example MCP serving ${auth.resource}`)
