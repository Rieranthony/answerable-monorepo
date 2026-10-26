import { createIdAdmin } from "@answerable/id-admin"
import { startAuditPoller } from "@answerable/mcp-platform"
import { assertRuntimeRole, connect } from "@answerable/mcp-postgres"
import { createAdminMcp } from "./admin"
import { readAdminEnvironment } from "./environment"
import { readPlatform } from "./platform"

const { auth, hostname, port, databaseUrl, id: idConfig, toolboxAdminResource, standaloneOrigin, freshSeconds } = readAdminEnvironment(process.env)
const id = createIdAdmin(idConfig)
const platform = await readPlatform(id).catch((error: Error) => {
  console.error(`The admin MCP cannot start: ${error.message}`)
  process.exit(1)
})
const db = connect(databaseUrl)
// Serve as the restricted runtime login only: the owner could drop the evidence triggers.
await assertRuntimeRole(db).catch(async (error: Error) => {
  await db.$client.end()
  console.error(`The admin MCP cannot start: ${error.message}`)
  process.exit(1)
})
const admin = createAdminMcp({ auth, db, id, platform, freshSeconds, toolbox: toolboxAdminResource ? { resource: toolboxAdminResource } : undefined, standaloneOrigin })
const poller = startAuditPoller({ id, caches: [admin.profiles] })
const server = Bun.serve({ hostname, port, fetch: admin.fetch })
console.log(`Admin MCP serving ${auth.resource} for platform organisation ${platform}`)
let closing = false
// Stop serving, then exit: under bun --hot, as the dev script runs it, the process would otherwise stay alive with its port closed.
async function close() {
  if (closing) return
  closing = true
  poller.stop()
  await server.stop()
  await db.$client.end()
  process.exit(0)
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
