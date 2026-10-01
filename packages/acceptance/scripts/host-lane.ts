// The host lane: real Answerable ID and the Toolbox, kept up for two real hosts, LibreChat in a container and Claude Code.
// Not a test and not part of `mcp:test:e2e`. Run it from the repository root: `bun packages/acceptance/scripts/host-lane.ts`; `--check` signs in once as Claude Code's client and exits.
import assert from "node:assert/strict"
import { SQL } from "bun"
import { createIdAdmin } from "@answerable/id-admin"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import { toolboxAdminResource } from "@answerable/mcp-toolbox/admin"
import { migrate } from "@answerable/mcp-toolbox/migrate"
import { startGrantsPoller } from "@answerable/mcp-toolbox/poller"
import { createMemoryTracer } from "@answerable/mcp-toolbox/spans"
import { createToolbox } from "@answerable/mcp-toolbox/toolbox"
import { decodeJwt } from "jose"
import { z } from "zod"
import { cleanup, onCleanup } from "../src/cleanup"
import { connect, launchBrowser, linkClient, registerClient, registerResource, serve, signIn, startId, step, type Admin } from "../src/index"

const resource = "http://127.0.0.1:47604/mcp"
const toolboxAdmin = toolboxAdminResource(resource)
const database = "answerable_toolbox_hostlane"
// LibreChat's callback for the server named `toolbox` in librechat.yaml, and Claude Code's for `--callback-port 47700`.
const librechat = { clientId: "librechat-lane", redirectUri: "http://localhost:3080/api/mcp/toolbox/oauth/callback" }
const claudeCode = { clientId: "claude-code-lane", redirectUri: "http://localhost:47700/callback" }
const hosts = [librechat, claudeCode]
const compose = new URL("../host-lane/compose.yaml", import.meta.url).pathname

// A machine client of the platform organisation: its secret, once, with the capability to ask for `scopes` for `audience`.
async function registerMachine(admin: Admin, organizationId: string, clientId: string, scopes: string[], audience: string) {
  const created = z.object({ clientSecret: z.string() }).parse(await admin("POST", "/clients", {
    clientId, name: clientId, organizationId, tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], clientCredentialsScopes: scopes,
  }))
  await linkClient(admin, clientId, audience)
  await admin("POST", `/organizations/${organizationId}/capabilities`, { clientId, resource: audience, grantKind: "client_credentials", scopes })
  return created.clientSecret
}

// One company sign-in each for LibreChat, Claude Code and the check, and spares for a second try. A refresh needs none.
const id = await startId({ tenants: [{ slug: "host-lane", signIns: 12 }] })
const { admin, manifest } = id
const tenant = manifest.tenants[0]!

step("Registering the Toolbox resource (60-second tokens), its admin resource and the two host clients")
await registerResource(admin, { identifier: resource, scopes: ["toolbox"], accessTokenTtl: 60 })
await registerResource(admin, { identifier: toolboxAdmin, scopes: ["toolbox:admin"], accessTokenTtl: 300 })
for (const { clientId, redirectUri } of hosts) await registerClient(admin, { clientId, redirectUri, scopes: ["toolbox"] })
const organisations = z.object({ items: z.array(z.object({ id: z.uuid(), slug: z.string() })) }).parse(await admin("GET", "/organizations?q=answerable"))
const platform = organisations.items.find(organisation => organisation.slug === "answerable")!
const hubSecret = await registerMachine(admin, platform.id, "toolbox-hub", ["platform:read", "platform:write"], manifest.adminResource)
const staffSecret = await registerMachine(admin, platform.id, "toolbox-staff", ["toolbox:admin"], toolboxAdmin)
// ID makes its signing key when it signs its first token; two first tokens at once make two keys. One token comes first, as in the Toolbox journey.
async function staffToken() {
  const response = await fetch(new URL("/auth/oauth2/token", manifest.idOrigin), {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`toolbox-staff:${staffSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", resource: toolboxAdmin, scope: "toolbox:admin" }),
  })
  if (!response.ok) throw new Error(`ID refused the staff client a token (${response.status}): ${await response.text()}`)
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token
}
await staffToken()

step(`Creating and migrating ${database}`)
const server = new SQL({ url: "postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test", max: 1 })
await server.unsafe(`create database ${database}`)
await server.close()
const db = new SQL({ url: `postgres://answerable:answerable@127.0.0.1:47532/${database}`, max: 4 })
onCleanup(() => db.close())
await migrate(db)
const machine = createIdAdmin({ issuer: manifest.idOrigin, adminResource: manifest.adminResource, clientId: "toolbox-hub", clientSecret: hubSecret })
const provider = createE2eProvider({ records: createRecordStore(), viewHtml: "<!doctype html><title>Records</title>" })
const toolbox = await createToolbox({ providers: [provider], auth: { issuer: manifest.idOrigin, resource }, db, id: machine, spans: createMemoryTracer().tracer })
const poller = startGrantsPoller({ id: machine, grants: toolbox.grants })
onCleanup(() => poller.stop())
// One line per request, so the log shows what each host sent and what the Toolbox answered.
serve(47_604, async request => {
  const rpc = request.method === "POST" ? await request.clone().json().catch(() => undefined) as { method?: string; params?: { name?: string } } | undefined : undefined
  const response = await toolbox.fetch(request)
  const said = [rpc?.method, rpc?.params?.name].filter(Boolean).join(" ")
  console.log(`[toolbox] ${request.method} ${new URL(request.url).pathname} ${said} -> ${response.status} protocol=${request.headers.get("mcp-protocol-version") ?? "-"} agent=${request.headers.get("user-agent") ?? "-"}`)
  return response
})

step("Enabling the organisation for both host clients, and entitling it to e2e/records only")
const enabled = await fetch(`${new URL(resource).origin}/admin/v1/organisations/${tenant.organizationId}/enable`, {
  method: "POST",
  headers: { Authorization: `Bearer ${await staffToken()}`, "Content-Type": "application/json" },
  body: JSON.stringify({ hostClientIds: hosts.map(host => host.clientId), providers: ["e2e"] }),
})
if (!enabled.ok) throw new Error(`Enabling the organisation answered ${enabled.status}: ${await enabled.text()}`)
step(`Enabled: ${z.object({ created: z.array(z.string()) }).parse(await enabled.json()).created.length} rows made in ID and the catalogue`)
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

const email = tenant.email
if (process.argv.includes("--check")) {
  // Claude Code's client, signed in by the kit's browser: what a person with a partial entitlement sees.
  const callback = new URL(claudeCode.redirectUri)
  const listener = serve(Number(callback.port), () => new Response("Signed in"))
  const oauth = await signIn(await launchBrowser(), { idOrigin: manifest.idOrigin, resource, clientId: claudeCode.clientId, callback: callback.href, scopes: ["toolbox"] }, { slug: tenant.slug, email, scopes: ["toolbox"] })
  listener.stop(true)
  const claims = decodeJwt(oauth.state.tokens!.access_token)
  console.log("token", JSON.stringify({ iss: claims.iss, aud: claims.aud, client_id: claims.client_id, scope: claims.scope, expires_in: Number(claims.exp) - Number(claims.iat) }))
  const client = await connect(resource, oauth.provider, "2026-07-28")
  const { tools } = await client.listTools()
  console.log("tools", JSON.stringify(tools.map(({ name, annotations, _meta }) => ({ name, annotations, _meta })), null, 2))
  console.log("whoami", JSON.stringify((await client.callTool({ name: "toolbox_whoami", arguments: {} })).structuredContent))
  await assert.rejects(client.callTool({ name: "e2e_identity_get", arguments: {} }), /Tool e2e_identity_get not found/)
  console.log("e2e_identity_get: Tool e2e_identity_get not found")
  const interactive = tools.filter(item => item._meta?.["anthropic/requiresUserInteraction"] === true).map(item => item.name)
  assert.deepEqual(interactive, ["toolbox_commit_confirmed"])
  assert.deepEqual(tools.map(item => item.name), ["toolbox_whoami", "e2e_records_create", "e2e_records_delete", "e2e_records_list", "e2e_records_show", "toolbox_commit", "toolbox_commit_confirmed"])
  await audit()
  step("Check passed: seven tools, no e2e_identity_get, requiresUserInteraction on toolbox_commit_confirmed only")
  await cleanup()
  process.exit(0)
}

console.log(`
Host lane is up. ID ${manifest.idOrigin}, the Toolbox ${resource}. Ctrl-C stops it and removes everything.
At ID's email step type ${email}; every company sign-in is accepted. The organisation is entitled to e2e/records only.

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
