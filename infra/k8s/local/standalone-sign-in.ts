// The kind stack's proof that an organisation reaches a standalone MCP, which the Toolbox serves at its path on the mcp host, once staff enable it,
// in a process of its own for the reason sign-in.ts gives: `bun infra/k8s/local/standalone-sign-in.ts`, with its input as JSON on standard input and its result as JSON on the last line of
// standard output. stack.test.ts runs it after the root lock, once a deploy has registered the MCP.
import { connect, intentSchema, serveCallback, signIn, signInRefused, tool } from "@answerable/acceptance"
import { chromium } from "@playwright/test"
import { hosts, origin, startBrowserEdge } from "./stack"

/** What stack.test.ts hands over: the MCP, made by bun mcp with notes.add as example is, and its scopes; the staff member and the client organisation's person; and the stack's certificates. */
export type StandaloneSignInInput = {
  mcp: string
  scopes: string[]
  staff: { email: string }
  tenant: { slug: string; email: string; organizationId: string }
  stackCa: string
  originPullCert: { cert: string; key: string }
  edgeCert: { cert: string; key: string }
}

const input = JSON.parse(await Bun.stdin.text()) as StandaloneSignInInput

const idOrigin = origin(hosts.id)
const adminResource = `${origin(hosts.adminMcp)}/mcp`
const mcpResource = `${origin(hosts.mcp)}/${input.mcp}/mcp`
// Claude Code's callback, as register gave every host client (OPS_CLAUDE_CALLBACK_PORT's 47700).
const callback = "http://localhost:47700/callback"
const tls = { ca: input.stackCa, ...input.originPullCert }

// The MCP SDK and the kit call fetch themselves: the stack's origins take the origin-pull certificate, as through Cloudflare.
const original = globalThis.fetch
const stackOrigins = new Set(Object.values(hosts).map(origin))
globalThis.fetch = Object.assign((request: string | URL | Request, init?: RequestInit) => {
  const url = new URL(request instanceof Request ? request.url : String(request))
  return stackOrigins.has(url.origin) ? original(request, { ...init, tls }) : original(request, init)
}, original)

const edge = startBrowserEdge({ stackCa: input.stackCa, originPullCert: input.originPullCert, serverCert: input.edgeCert })
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${edge.hostResolverRules}`] })
const listener = serveCallback(callback)
try {
  // Staff, an owner since the first run, enable the MCP for the client organisation through the admin MCP, as a host does: prepare, show the
  // summary, commit with it. Their browser keeps ID's session for the refusal below.
  const staffBrowser = await browser.newContext({ ignoreHTTPSErrors: true })
  const staff = await signIn(staffBrowser, { idOrigin, resource: adminResource, clientId: "claude-code-admin", callback, scopes: ["admin"] }, { slug: "answerable", email: input.staff.email, scopes: ["admin"] })
  const admin = await connect(adminResource, staff.provider, "2025")
  const intent = intentSchema.parse(await tool(admin, "standalone_enable", { organizationId: input.tenant.organizationId, mcp: input.mcp, everyone: true }))
  const receipt = await tool(admin, "admin_commit_confirmed", { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary })
  await admin.close()

  // The client organisation's person signs in to the MCP through Claude Code's client, as Claude Code does, and prepares a note: the preview names
  // their organisation as ID holds it, which the Toolbox read for the call.
  const started = performance.now()
  const person = await signIn(await browser.newContext({ ignoreHTTPSErrors: true }), { idOrigin, resource: mcpResource, clientId: `claude-code-${input.mcp}`, callback, scopes: input.scopes },
    { slug: input.tenant.slug, email: input.tenant.email, scopes: input.scopes })
  const signedIn = Math.round((performance.now() - started) / 100) / 10
  const client = await connect(mcpResource, person.provider, "2025")
  const prepared = intentSchema.parse(await tool(client, "notes_add", { title: "From Claude Code" }))
  await client.close()
  const claims = JSON.parse(Buffer.from(person.state.tokens!.access_token.split(".")[1]!, "base64url").toString()) as { aud: string; organization_id: string; client_id: string; scope: string }

  // A person of another organisation, the staff member's, which nobody enabled: ID refuses at the organisation chooser.
  const refused = await signInRefused(staffBrowser, { idOrigin, resource: mcpResource, clientId: `claude-code-${input.mcp}`, callback, scopes: input.scopes }, { slug: "answerable", email: input.staff.email, scopes: [] })
  console.log(JSON.stringify({
    preview: intent.preview, receipt, signedIn, prepared: prepared.preview.summary, refused,
    claims: { aud: claims.aud, organization_id: claims.organization_id, client_id: claims.client_id, scope: claims.scope },
  }))
} finally {
  globalThis.fetch = original
  listener.stop(true)
  await browser.close()
  edge.stop()
}
process.exit(0)
