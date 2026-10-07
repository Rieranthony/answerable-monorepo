// The host lane: real Answerable ID and the Toolbox, kept up for two real hosts, LibreChat in a container and Claude Code.
// Not a test and not part of `mcp:test:e2e`. Run it from the repository root: `bun packages/acceptance/scripts/host-lane.ts`.
import { z } from "zod"
import { cleanup, onCleanup } from "../src/cleanup"
import { serve, startId, step } from "../src/index"
import { startToolboxStack, toolboxResource as resource } from "../src/toolbox"

// A failure must not leave ID, its database and the Toolbox running behind it.
async function fail(error: unknown) {
  console.error(error)
  await cleanup()
  process.exit(1)
}
process.on("unhandledRejection", fail)
process.on("uncaughtException", fail)

// LibreChat's callback for the server named `toolbox` in librechat.yaml, and Claude Code's for `--callback-port 47700`.
const librechat = { clientId: "librechat-lane", redirectUri: "http://localhost:3080/api/mcp/toolbox/oauth/callback" }
const claudeCode = { clientId: "claude-code-lane", redirectUri: "http://localhost:47700/callback" }
const hosts = [librechat, claudeCode]
const compose = Bun.fileURLToPath(new URL("../host-lane/compose.yaml", import.meta.url))

// One company sign-in each for LibreChat and Claude Code, and spares for more tries. A refresh needs none.
const id = await startId({ tenants: [{ slug: "host-lane", signIns: 12 }] })
const { admin, manifest } = id
const tenant = manifest.tenants[0]!
const { toolbox, adminApi } = await startToolboxStack(id, { hosts, database: "answerable_toolbox_hostlane" })
// One line per request, so the log shows what each host sent and what the Toolbox answered.
serve(47_604, async request => {
  const rpc = request.method === "POST" ? await request.clone().json().catch(() => undefined) as { method?: string; params?: { name?: string } } | undefined : undefined
  const response = await toolbox.fetch(request)
  const said = [rpc?.method, rpc?.params?.name].filter(Boolean).join(" ")
  console.log(`[toolbox] ${request.method} ${new URL(request.url).pathname} ${said} -> ${response.status} protocol=${request.headers.get("mcp-protocol-version") ?? "-"} agent=${request.headers.get("user-agent") ?? "-"}`)
  return response
})

step("Enabling the organisation for both host clients, and entitling it to e2e/records only")
const enabled = await adminApi("POST", `/organisations/${tenant.organizationId}/enable`, { hostClientIds: hosts.map(host => host.clientId), providers: ["e2e"] })
if (enabled.status !== 200) throw new Error(`Enabling the organisation answered ${enabled.status}: ${JSON.stringify(enabled.body)}`)
step(`Enabled: ${z.object({ created: z.array(z.string()) }).parse(enabled.body).created.length} rows made in ID and the catalogue`)
await admin("POST", `/organizations/${tenant.organizationId}/entitlements`, { resource, scopes: ["e2e/records"] })

// ID's OAuth events as they happen: an authorisation, a code exchange, a refresh.
const seen = new Set<string>()
const decision = z.object({ client: z.object({ clientId: z.string() }).optional(), resource: z.object({ identifier: z.string() }).nullish() })
const auditEvents = z.object({ items: z.array(z.object({ id: z.string(), action: z.string(), data: z.object({ grantType: z.string().optional(), scopes: z.array(z.string()).optional(), decision: decision.optional() }).nullable() })) })
async function audit() {
  const { items } = auditEvents.parse(await admin("GET", "/audit-events?limit=50"))
  for (const event of items.toReversed().filter(item => item.action.startsWith("oauth.user.") && !seen.has(item.id))) {
    seen.add(event.id)
    const { client, resource: audience } = event.data?.decision ?? {}
    console.log(`[id] ${event.action} client=${client?.clientId} resource=${audience?.identifier} grant=${event.data?.grantType ?? "-"} scopes=${JSON.stringify(event.data?.scopes ?? null)}`)
  }
}
await audit()
const watcher = setInterval(() => void audit().catch(error => console.error("[id] reading the audit log failed", error)), 3000)
onCleanup(() => clearInterval(watcher))

console.log(`
Host lane is up. ID ${manifest.idOrigin}, the Toolbox ${resource}. Ctrl-C stops it and removes everything.
At ID's email step type ${tenant.email}; every company sign-in is accepted. The organisation is entitled to e2e/records only.

LibreChat (the client is librechat-lane, the server is named toolbox):
  docker compose -p answerable-host-lane -f ${compose} up -d
  open http://localhost:3080, register an account, then MCP Settings, Connect on toolbox and Continue with OAuth
  docker compose -p answerable-host-lane -f ${compose} down --volumes

Claude Code (the client is claude-code-lane):
  claude mcp add --transport http toolbox-lane ${resource} --client-id claude-code-lane --callback-port 47700
  then run /mcp in Claude Code, choose toolbox-lane and Authenticate
  claude mcp remove toolbox-lane
`)
await new Promise(() => {})
