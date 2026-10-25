import { createIdAdmin } from "@answerable/id-admin"
import { createTracer, mcpDatabases, startAuditPoller } from "@answerable/mcp-platform"
import { assertRuntimeRole, connect } from "@answerable/mcp-postgres"
import { readStandaloneEnvironment } from "./environment"
import { served } from "./served.generated"
import { createStandalone } from "./standalone"

const { origin, issuer, databaseUrl, mcps: databases, hostname, port, id: idConfig, otlpEndpoint } = readStandaloneEnvironment(process.env)
const db = connect(databaseUrl)
const mcps = mcpDatabases(served, databases)
// Serve as the restricted logins only, checked before listening: the owner could drop the evidence triggers, and a serving login with more than
// the served MCPs' runtime roles could reach another schema.
await Promise.all([assertRuntimeRole(db), mcps.assert()]).catch(async (error: Error) => {
  await Promise.all([db.$client.end(), mcps.close()])
  console.error(`The standalone server cannot start: ${error.message}`)
  process.exit(1)
})
const telemetry = createTracer("answerable-standalone", otlpEndpoint)
const id = createIdAdmin(idConfig)
const standalone = createStandalone({ serve: mcps.mount, pools: mcps.pools, origin, auth: { issuer }, db, id, spans: telemetry.tracer })
const poller = startAuditPoller({ id, caches: [standalone.profiles] })
const server = Bun.serve({ hostname, port, fetch: standalone.fetch })
console.log(`Standalone server serving ${served.map(({ provider }) => `${origin}/${provider.id}/mcp`).join(", ") || "no MCP"}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  poller.stop()
  await server.stop()
  await telemetry.shutdown()
  await Promise.all([db.$client.end(), mcps.close()])
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
