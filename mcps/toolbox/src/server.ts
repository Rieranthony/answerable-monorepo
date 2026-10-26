import { createIdAdmin } from "@answerable/id-admin"
import { createTracer, mcpDatabases, startAuditPoller } from "@answerable/mcp-platform"
import { assertRuntimeRole, connect } from "@answerable/mcp-postgres"
import { readToolboxEnvironment } from "./environment"
import { mounted } from "./mounted.generated"
import { createToolbox } from "./toolbox"

const { databaseUrl, mcps: databases, auth, origin, hostname, port, id: idConfig, otlpEndpoint } = readToolboxEnvironment(process.env)
const db = connect(databaseUrl)
const mcps = mcpDatabases(mounted, databases)
// Serve as the restricted logins only, both checked before the boot's ingest writes anything: the owner could drop the evidence triggers, and a
// serving login that owns the MCPs' tables would not be bound by their row-level security.
await Promise.all([assertRuntimeRole(db), mcps.assert()]).catch(async (error: Error) => {
  await Promise.all([db.$client.end(), mcps.close()])
  console.error(`The Toolbox cannot start: ${error.message}`)
  process.exit(1)
})
const telemetry = createTracer("answerable-toolbox", otlpEndpoint)
const id = createIdAdmin(idConfig)
const toolbox = await createToolbox({ mount: mcps.mount, pools: mcps.pools, auth, origin, db, id, spans: telemetry.tracer })
const poller = startAuditPoller({ id, caches: [toolbox.grants, toolbox.profiles] })
const server = Bun.serve({ hostname, port, fetch: toolbox.fetch })
const alone = mounted.filter(({ serve }) => serve !== "toolbox").map(({ provider }) => `${origin}/${provider.id}/mcp`)
console.log(`Toolbox serving ${[auth.resource, ...alone].join(", ")}`)
let closing = false
// Stop serving, then exit: under bun --hot, as the dev script runs it, the process would otherwise stay alive with its port closed.
async function close() {
  if (closing) return
  closing = true
  poller.stop()
  await server.stop()
  await telemetry.shutdown()
  await Promise.all([db.$client.end(), mcps.close()])
  process.exit(0)
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
