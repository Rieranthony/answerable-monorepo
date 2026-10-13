// The staff sign-in of the kind stack, in a process of its own: `bun infra/k8s/local/sign-in.ts`, with its input as JSON on
// standard input and its result as JSON on the last line of standard output. stack.test.ts runs it.
//
// Why a process of its own: Playwright's Chromium, launched and closed inside a Bun process, leaves pipe handles whose later
// finalisation closes file descriptors that the process has since reused. Measured in a Bun process that launched and
// closed Chromium five times and then spawned 800 short children with piped stdin, stdout and stderr: 4 to 5 of them lost
// a pipe (exit 1, nothing written), and none did when Bun.gc(true) ran straight after each close. In the stack test the
// same thing killed a later kubectl (exit 141, SIGPIPE). The acceptance kit's cleanup meets it as Q-ACCEPTANCE-GC. Here
// the browser lives and dies with this process.
import { connect, serveCallback, signIn, tool } from "@answerable/acceptance"
import { chromium } from "@playwright/test"
import { hosts, origin, startBrowserEdge } from "./stack"

/** What stack.test.ts hands over: the person, where to make them an owner, root's secret, and the stack's certificates. */
export type SignInInput = {
  email: string
  platform: string
  ownerGroup: string
  rootAdminSecret: string
  stackCa: string
  originPullCert: { cert: string; key: string }
  edgeCert: { cert: string; key: string }
}

const input = JSON.parse(await Bun.stdin.text()) as SignInInput

const idOrigin = origin(hosts.id)
const adminResource = `${origin(hosts.adminMcp)}/mcp`
const callback = "http://localhost:47700/callback"
const tls = { ca: input.stackCa, ...input.originPullCert }

// The MCP SDK and the kit call fetch themselves: the stack's origins take the origin-pull certificate, as through Cloudflare.
const original = globalThis.fetch
const stackOrigins = new Set(Object.values(hosts).map(origin))
globalThis.fetch = Object.assign((request: string | URL | Request, init?: RequestInit) => {
  const url = new URL(request instanceof Request ? request.url : String(request))
  return stackOrigins.has(url.origin) ? original(request, { ...init, tls }) : original(request, init)
}, original)

// Chromium reaches Traefik through the browser's stand-in for Cloudflare, which presents the origin-pull certificate.
const edge = startBrowserEdge({ stackCa: input.stackCa, originPullCert: input.originPullCert, serverCert: input.edgeCert })
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${edge.hostResolverRules}`] })
const listener = serveCallback(callback)
try {
  const started = performance.now()
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const session = await signIn(context, { idOrigin, resource: adminResource, clientId: "claude-code-admin", callback, scopes: ["admin"] }, { slug: "answerable", email: input.email, scopes: ["admin"] })
  const signedIn = Math.round((performance.now() - started) / 100) / 10
  const client = await connect(adminResource, session.provider, "2025")
  const claims = JSON.parse(Buffer.from(session.state.tokens!.access_token.split(".")[1]!, "base64url").toString()) as { membership_id: string; organization_id: string; client_id: string }
  const before = await tool(client, "admin_whoami")
  // Root makes them the first owner (docs/admin/setup); the admin MCP reads the role on each request.
  const made = await fetch(`${idOrigin}/api/admin/v1/organizations/${input.platform}/groups/${input.ownerGroup}/members/${claims.membership_id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${input.rootAdminSecret}`, "idempotency-key": crypto.randomUUID(), "if-none-match": "*", "content-type": "application/json" },
    body: "{}",
  })
  if (!made.ok) throw new Error(`Making the member an owner answered ${made.status}: ${await made.text()}`)
  const after = await tool(client, "admin_whoami")
  await client.close()
  console.log(JSON.stringify({ signedIn, claims: { organization_id: claims.organization_id, client_id: claims.client_id, membership_id: claims.membership_id }, before, after }))
} finally {
  globalThis.fetch = original
  listener.stop(true)
  await browser.close()
  edge.stop()
}
process.exit(0)
