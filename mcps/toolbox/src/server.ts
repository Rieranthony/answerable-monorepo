import { createIdAdmin } from "@answerable/id-admin"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import { viewHtml } from "@answerable/mcp-e2e/view"
import { assertRuntimeRole, connect } from "@answerable/mcp-postgres"
import { readToolboxEnvironment } from "./environment"
import { startGrantsPoller } from "./poller"
import { createTracer } from "./spans"
import { createToolbox } from "./toolbox"

const { databaseUrl, auth, hostname, port, id: idConfig, otlpEndpoint } = readToolboxEnvironment(process.env)
const db = connect(databaseUrl)
// Serve as the restricted runtime login only: the owner could drop the evidence triggers. Checked before the boot's ingest writes anything.
await assertRuntimeRole(db).catch(async (error: Error) => {
  await db.close()
  console.error(`The Toolbox cannot start: ${error.message}`)
  process.exit(1)
})
const telemetry = createTracer(otlpEndpoint)
const id = createIdAdmin(idConfig)
//#region providers
const toolbox = await createToolbox({ providers: [createE2eProvider({ records: createRecordStore(), viewHtml })], auth, db, id, spans: telemetry.tracer })
//#endregion
const poller = startGrantsPoller({ id, grants: toolbox.grants })
const server = Bun.serve({ hostname, port, fetch: toolbox.fetch })
console.log(`Toolbox serving ${auth.resource}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  poller.stop()
  await server.stop()
  await telemetry.shutdown()
  await db.close()
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
