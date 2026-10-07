// The admin lane: real Answerable ID, the admin MCP and the Toolbox, kept up for an owner to onboard an organisation with Claude Code by hand.
// Not a test and not part of `mcp:test:e2e`. Run it from the repository root: `bun packages/acceptance/scripts/admin-lane.ts`.
import { decodeJwt } from "jose"
import { z } from "zod"
import { adminResource, startAdminStack } from "../src/admin-mcp"
import { cleanup, onCleanup } from "../src/cleanup"
import { launchBrowser, linkClient, serve, serveCallback, setSsoProvider, signIn, startId, step } from "../src/index"
import { toolboxResource, type HostClient } from "../src/toolbox"

// A failure must not leave ID, its database and the servers running behind it.
async function fail(error: unknown) {
  console.error(error)
  await cleanup()
  process.exit(1)
}
process.on("unhandledRejection", fail)
process.on("uncaughtException", fail)

// Claude Code's two clients: the callback ports of `claude mcp add --callback-port`.
const adminHost = { clientId: "claude-code-admin", redirectUri: "http://localhost:47700/callback" }
const toolboxHost = { clientId: "claude-code-toolbox", redirectUri: "http://localhost:47701/callback" }

// Many company sign-ins for the owner (each Verify sign-in and each new authorisation after it may take one) and for the new organisation's person.
const id = await startId({ tenants: [], platform: { signIns: 12 }, spares: [{ slug: "newco", signIns: 6 }] })
const { admin, manifest } = id
const platform = manifest.platform!
const spare = manifest.spares[0]!
const stack = await startAdminStack(id, { adminHost, toolboxHost })
// The first enable for any organisation links the Toolbox's host client to the Toolbox in ID. Linked in advance, ID refuses a person whose organisation is not
// enabled yet at its organisation chooser ("Access is unavailable for this organisation"), as it does once the Toolbox serves other organisations, not with `invalid_target`.
await linkClient(admin, toolboxHost.clientId, toolboxResource)

// One line per request, so the log shows what Claude Code sent and what each server answered.
function logged(name: string, handler: (request: Request) => Response | Promise<Response>) {
  return async (request: Request) => {
    const rpc = request.method === "POST" ? (await request.clone().json().catch(() => undefined)) as { method?: string; params?: { name?: string } } | undefined : undefined
    const response = await handler(request)
    console.log(`[${name}] ${request.method} ${new URL(request.url).pathname} ${[rpc?.method, rpc?.params?.name].filter(Boolean).join(" ")} -> ${response.status}`)
    return response
  }
}
const mcp = stack.adminMcp()
serve(47_606, logged("admin", mcp.fetch))
serve(47_604, logged("toolbox", stack.toolbox.fetch))
const browser = await launchBrowser()

/** Sign a person in as Claude Code does, with the kit's browser, listening on the host client's callback port only while it runs: Claude Code listens there itself. */
async function signInAs(host: HostClient, resource: string, scope: string, person: { slug: string; email: string }) {
  const listener = serveCallback(host.redirectUri)
  try {
    return await signIn(browser, { idOrigin: manifest.idOrigin, resource, clientId: host.clientId, callback: host.redirectUri, scopes: [scope] }, { ...person, scopes: [scope] })
  } finally {
    listener.stop(true)
  }
}

// ID knows a staff member only after their first sign-in, so the lane signs the staff member in once, headlessly, and makes them an owner. The owner signs in again in Claude Code.
step("Signing the staff member in once and making them an owner of the admin MCP")
const staff = await signInAs(adminHost, adminResource, "admin", { slug: "answerable", email: platform.email })
const member = z.uuid().parse(decodeJwt(staff.state.tokens!.access_token).membership_id)
await admin("PUT", `/organizations/${platform.organizationId}/groups/${stack.groups.owner}/members/${member}`, {})

// A directory with its own credentials needs a client secret, which no admin tool takes. When an organisation holds the spare directory's domain, the lane sets its SSO provider, as the journeys do.
const connected = new Map<string, Promise<unknown>>()
let busy = false
async function connectSpare() {
  if (busy) return
  busy = true
  try {
    const { items } = z.object({ items: z.array(z.object({ id: z.uuid(), slug: z.string() })) }).parse(await admin("GET", "/organizations?limit=100"))
    for (const { id: organizationId, slug } of items) {
      if (organizationId === platform.organizationId || connected.has(organizationId)) continue
      const { items: domains } = z.object({ items: z.array(z.object({ domain: z.string() })) }).parse(await admin("GET", `/organizations/${organizationId}/domains?limit=100`))
      if (!domains.some(({ domain }) => domain === spare.domain)) continue
      const setting = setSsoProvider(admin, organizationId, spare)
      connected.set(organizationId, setting)
      // Another try on the next tick if ID refuses.
      await setting.catch(error => (connected.delete(organizationId), Promise.reject(error)))
      console.log(`[lane] ${slug} holds ${spare.domain}: set its SSO provider to the spare directory, because a directory with its own credentials needs a secret no tool takes`)
    }
  } finally {
    busy = false
  }
}
const watcher = setInterval(() => void connectSpare().catch(error => console.error("[lane] setting an SSO provider failed", error)), 1_000)
onCleanup(() => clearInterval(watcher))

console.log(`
Admin lane is up. ID ${manifest.idOrigin}, the admin MCP ${adminResource}, the Toolbox ${toolboxResource}. Ctrl-C stops it and removes everything.
At ID's email step type the address given below; the company sign-in that follows accepts it.

1. Staff, an owner of the admin MCP: ${platform.email}
   claude mcp add --transport http answerable-admin ${adminResource} --client-id ${adminHost.clientId} --callback-port 47700
   then run /mcp in Claude Code, choose answerable-admin and Authenticate, and type the email above. Ask Claude to call admin_whoami: you are an owner, with 27 tools.

2. Onboard a new organisation: ask Claude to create the organisation ${spare.slug}, named Newco, and route the domain ${spare.domain} to it, enable the Toolbox for it from
   ${toolboxHost.clientId} with e2e, and grant everyone in it e2e/records on ${toolboxResource}. A directory with its own credentials needs a secret that no tool takes,
   so this lane sets the SSO provider itself once the organisation holds ${spare.domain}, and says so here.

3. The new organisation's person, in the Toolbox: ${spare.email}
   claude mcp add --transport http answerable-toolbox ${toolboxResource} --client-id ${toolboxHost.clientId} --callback-port 47701
   then /mcp, choose answerable-toolbox and Authenticate. Before step 2 ID stops this person with "Access is unavailable for this organisation". After it, the Toolbox lists seven tools:
   toolbox_whoami, the four e2e_records tools and the two commit tools; toolbox_whoami shows the grant e2e/records.

When the previous sign-in at your company directory is older than 30 minutes, the critical tools (organisations_disable, organisations_enable, staff_grant, staff_revoke) ask you to sign in again:
open ${manifest.idOrigin}/security in the browser you signed in with and choose Verify sign-in, then clear the server's authentication in Claude Code and authenticate again.

claude mcp remove answerable-admin; claude mcp remove answerable-toolbox   when you are done.
`)
await new Promise(() => {})
