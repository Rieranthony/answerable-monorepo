import { SQL } from "bun"
import { createIdAdmin } from "@answerable/id-admin"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import { readToolboxEnvironment } from "./environment"
import { startGrantsPoller } from "./poller"
import { createTracer } from "./spans"
import { createToolbox } from "./toolbox"

const { databaseUrl, auth, port, id: idConfig, otlpEndpoint } = readToolboxEnvironment(process.env)
const view = Bun.file(new URL("../dist/records.html", import.meta.resolve("@answerable/mcp-e2e/mcp")))
if (!await view.exists()) throw new Error("Missing the e2e records view. Run bun run --filter @answerable/mcp-e2e build first.")
const db = new SQL(databaseUrl)
const telemetry = createTracer(otlpEndpoint)
const id = createIdAdmin(idConfig)
//#region providers
const toolbox = await createToolbox({ providers: [createE2eProvider({ records: createRecordStore(), viewHtml: await view.text() })], auth, db, id, spans: telemetry.tracer })
//#endregion
const poller = startGrantsPoller({ id, grants: toolbox.grants })
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: toolbox.fetch })
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
