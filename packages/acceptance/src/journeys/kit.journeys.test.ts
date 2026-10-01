// Real Answerable ID, a real browser and the official MCP OAuth client: what the kit gives a journey beyond tenants. Answerable staff sign in (the platform organisation),
// an organisation created through the admin API signs its person in through a spare directory, ID refuses it before it is entitled, and a machine client asks for tokens for two audiences.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createMcpServer } from "@answerable/mcp"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import { decodeJwt } from "jose"
import { z } from "zod"
import { connect, grantOrganisation, launchBrowser, linkClient, registerClient, registerMachine, registerResource, serve, setSsoProvider, signIn, signInRefused, startId, step, tool, type Id } from "../index"

const resource = "http://127.0.0.1:47602/mcp"
const otherAudience = "http://127.0.0.1:47602/other"
const callback = "http://127.0.0.1:47603/callback"
const clientId = "kit-browser"
const scopes = ["e2e:identity", "e2e:read", "e2e:write"]
const refusalText = "Access is unavailable for this organisation. Sign in again or ask its administrator to check your access."

let id: Id
let browser: Awaited<ReturnType<typeof launchBrowser>>
const target = () => ({ idOrigin: id.manifest.idOrigin, resource, clientId, callback, scopes })

beforeAll(async () => {
  // One sign-in for the staff member; two for the spare directory's person, one refused and one let through.
  id = await startId({ tenants: [], platform: { signIns: 1 }, spares: [{ slug: "spare", signIns: 2 }] })
  const { admin, manifest } = id
  await registerResource(admin, { identifier: resource, scopes, accessTokenTtl: 60 })
  await registerClient(admin, { clientId, redirectUri: callback, scopes })
  await linkClient(admin, clientId, resource)
  await grantOrganisation(admin, manifest.platform!.organizationId, { clientId, resource, scopes })
  serve(47_602, createMcpServer({ provider: createE2eProvider({ records: createRecordStore(), viewHtml: "<!doctype html>" }), auth: { issuer: manifest.idOrigin, resource } }).fetch)
  serve(Number(new URL(callback).port), () => new Response("Signed in. You can close this page."))
  browser = await launchBrowser()
})
afterAll(() => id?.stop())

test("Answerable staff sign in to an MCP through the platform organisation's directory", async () => {
  const { platform } = id.manifest
  expect(platform).toEqual({ organizationId: expect.any(String), domain: "answerable.example.test", email: "staff@answerable.example.test" })
  const staff = await signIn(browser, target(), { slug: "answerable", email: platform!.email, scopes })
  expect(decodeJwt(staff.state.tokens!.access_token).organization_id).toBe(platform!.organizationId)
  const identity = await tool(await connect(resource, staff.provider, "2026-07-28"), "identity_get")
  expect(identity.organizationId).toBe(platform!.organizationId)
})

test("an organisation created through the admin API signs its person in through a spare directory, after ID refused it quickly before it was entitled", async () => {
  const { admin, manifest } = id
  const spare = manifest.spares[0]!
  expect(spare).toMatchObject({ slug: "spare", domain: "spare.example.test", email: "tester@spare.example.test", clientId: "spare" })
  const created = z.object({ id: z.uuid() }).parse(await admin("POST", "/organizations", { slug: spare.slug, name: "Spare" }))
  await admin("POST", `/organizations/${created.id}/domains`, { domain: spare.domain })
  await setSsoProvider(admin, created.id, spare)

  step("spare: signing in before any entitlement")
  const started = performance.now()
  expect(await signInRefused(browser, target(), { slug: spare.slug, email: spare.email, scopes })).toBe(refusalText)
  step(`spare: refused after ${Math.round(performance.now() - started)} ms`)

  await grantOrganisation(admin, created.id, { clientId, resource, scopes })
  const person = await signIn(browser, target(), { slug: spare.slug, email: spare.email, scopes })
  expect(decodeJwt(person.state.tokens!.access_token).organization_id).toBe(created.id)
  const identity = await tool(await connect(resource, person.provider, "2026-07-28"), "identity_get")
  expect(identity.organizationId).toBe(created.id)
})

test("a machine client asks ID for a token for each of its two audiences, with that audience's scopes", async () => {
  const { admin, manifest } = id
  await registerResource(admin, { identifier: otherAudience, scopes: ["other:admin"], accessTokenTtl: 60 })
  const machine = await registerMachine(admin, manifest.platform!.organizationId, "kit-machine", {
    [manifest.adminResource]: ["platform:read"],
    [otherAudience]: ["other:admin"],
  })
  const token = (audience: string, scope: string) =>
    fetch(new URL("/auth/oauth2/token", manifest.idOrigin), {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${machine.clientId}:${machine.clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", resource: audience, scope }),
    })
  for (const [audience, scope] of [[manifest.adminResource, "platform:read"], [otherAudience, "other:admin"]] as const) {
    const response = await token(audience, scope)
    expect(response.status, await response.clone().text()).toBe(200)
    const claims = decodeJwt(z.object({ access_token: z.string() }).parse(await response.json()).access_token)
    expect(claims).toMatchObject({ aud: audience, scope, client_id: machine.clientId, organization_id: manifest.platform!.organizationId })
  }
  // The other audience's scope is not approved for the first audience.
  expect((await token(manifest.adminResource, "other:admin")).ok).toBe(false)
})
