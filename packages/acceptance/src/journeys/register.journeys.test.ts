// Real Answerable ID: what the ops register Job does with its own machine client, ops-register, after root is locked (infra/ops/src/register.ts).
// Minted with the root secret as the Job's first run mints it, the client creates and patches a resource, a public client and their link, the rows
// each standalone MCP needs, once a person holds platform:write and ID refuses the root secret.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { z } from "zod"
import { launchBrowser, registerMachine, startId, step, type Id } from "../index"

const resource = "https://mcp.example.test/acme/mcp"
const hostClient = "claude-code-acme"
const callback = "http://localhost:47700/callback"

let id: Id
let token: string

/** ID's admin API with the ops-register client's token, answering the status, the ETag and the body. */
async function asClient(method: string, path: string, { body, ifMatch, key = crypto.randomUUID() }: { body?: unknown; ifMatch?: string; key?: string } = {}) {
  const response = await fetch(`${id.manifest.idOrigin}/api/admin/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === "GET" ? {} : { "Idempotency-Key": key }),
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, etag: response.headers.get("ETag"), body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
}

beforeAll(async () => {
  id = await startId({ tenants: [], platform: { signIns: 1 } })
})
afterAll(() => id?.stop())

test("ops-register, minted with root, creates and patches a resource, a client and a link after the root lock", async () => {
  const { admin, manifest } = id
  const platform = manifest.platform!.organizationId

  step("Minting ops-register with the root secret: platform:read and platform:write on ID's admin resource")
  const machine = await registerMachine(admin, platform, "ops-register", { [manifest.adminResource]: ["platform:read", "platform:write"] })

  step("Locking root: a staff member signs in once and joins platform-admins")
  const browser = await launchBrowser()
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${manifest.idOrigin}/login`)
  await page.getByLabel(/email/i).fill(manifest.platform!.email)
  await page.getByRole("button", { name: /continue/i }).click()
  await page.getByRole("heading", { name: "Signed in" }).waitFor({ timeout: 30_000 })
  const members = z.object({ items: z.array(z.object({ id: z.uuid(), email: z.string() })) }).parse(await admin("GET", `/organizations/${platform}/members?email=${encodeURIComponent(manifest.platform!.email)}`))
  const groups = z.object({ items: z.array(z.object({ id: z.uuid(), slug: z.string() })) }).parse(await admin("GET", `/organizations/${platform}/groups?q=platform-admins`))
  const admins = groups.items.find(group => group.slug === "platform-admins")!
  await admin("PUT", `/organizations/${platform}/groups/${admins.id}/members/${members.items[0]!.id}`, {}, { "If-None-Match": "*" })
  const refused = await fetch(`${manifest.idOrigin}/api/admin/v1/organizations?limit=1`, { headers: { Authorization: `Bearer ${manifest.rootSecret}` } })
  expect(refused.status).toBe(403)
  expect(((await refused.json()) as { code: string }).code).toBe("root_locked")

  step("ops-register's token: client credentials for ID's admin resource")
  const issued = await fetch(`${manifest.idOrigin}/auth/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${machine.clientId}:${machine.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", resource: manifest.adminResource, scope: "platform:read platform:write" }),
  })
  expect(issued.status).toBe(200)
  token = z.object({ access_token: z.string() }).parse(await issued.json()).access_token

  step("Creating the resource, the public client and their link")
  const at = `/resources/${encodeURIComponent(resource)}`
  expect((await asClient("GET", at)).status).toBe(404)
  const created = await asClient("POST", "/resources", { key: "acme-resource-v1", body: { classification: "platform_shared", organizationId: null, identifier: resource, name: "acme", allowedScopes: ["acme:read", "offline_access"], accessTokenTtl: 900 } })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const client = await asClient("POST", "/clients", { key: "claude-code-acme-v1", body: { clientId: hostClient, name: "Claude Code (acme)", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], redirectUris: [callback], scopes: ["openid", "offline_access", "acme:read"] } })
  expect(client.status, JSON.stringify(client.body)).toBe(201)
  const link = `/clients/${hostClient}${at}`
  expect((await asClient("PUT", link, { key: "claude-code-acme-link-v1" })).status).toBe(201)
  expect((await asClient("PUT", link, { key: "claude-code-acme-link-again" })).status).toBe(200)
  // A second creation of either is a conflict, which is how register learns that a row it did not read exists.
  expect((await asClient("POST", "/resources", { body: { identifier: resource, name: "acme", allowedScopes: ["acme:read"] } })).body.code).toBe("conflict")

  step("Patching both with If-Match: the resource's scopes, the client's scopes and redirect URIs")
  const held = await asClient("GET", at)
  // Linking a client is a change of the resource too: its revision moved on from 1.
  const revision = z.number().parse(held.body.revision)
  expect(held.body).toMatchObject({ allowedScopes: ["acme:read", "offline_access"], clients: [hostClient] })
  const widen = { ifMatch: held.etag!, key: `acme-resource-v1-r${revision}`, body: { allowedScopes: ["acme:read", "acme:write", "offline_access"] } }
  const widened = await asClient("PATCH", at, widen)
  expect(widened.status, JSON.stringify(widened.body)).toBe(200)
  expect(widened.body).toMatchObject({ allowedScopes: ["acme:read", "acme:write", "offline_access"], revision: revision + 1 })
  // The same key and input again replays; the ETag read before the change is stale for a new command.
  expect((await asClient("PATCH", at, widen)).status).toBe(200)
  const stale = await asClient("PATCH", at, { ifMatch: held.etag!, key: "acme-resource-v1-stale", body: { accessTokenTtl: 600 } })
  expect(stale.status).toBe(412)
  const heldClient = await asClient("GET", `/clients/${hostClient}`)
  // ID keeps scope lists sorted.
  expect(heldClient.body).toMatchObject({ scopes: ["acme:read", "offline_access", "openid"], redirectUris: [callback], resources: [resource] })
  const patched = await asClient("PATCH", `/clients/${hostClient}`, { ifMatch: heldClient.etag!, key: `claude-code-acme-v1-r${heldClient.body.revision}`, body: { scopes: ["openid", "offline_access", "acme:read", "acme:write"], redirectUris: [callback, "http://localhost:47701/callback"] } })
  expect(patched.status, JSON.stringify(patched.body)).toBe(200)
  expect(patched.body).toMatchObject({ scopes: ["acme:read", "acme:write", "offline_access", "openid"], redirectUris: [callback, "http://localhost:47701/callback"] })

  step("ID's audit log names ops-register, a client, for its token and every change")
  const audit = z.object({ items: z.array(z.object({ action: z.string(), actorType: z.string(), actorId: z.string() })) }).parse((await asClient("GET", "/audit-events?actorId=ops-register&limit=50")).body)
  expect(audit.items.map(item => item.action).toSorted()).toEqual(["client.created", "client.resource_linked", "client.updated", "oauth.token.issued", "resource.created", "resource.updated"])
  expect(new Set(audit.items.map(item => `${item.actorType} ${item.actorId}`))).toEqual(new Set(["client ops-register"]))
})
