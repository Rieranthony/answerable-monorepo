// Real Answerable ID, a real browser and the official MCP OAuth client against the e2e MCP.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createMcpServer, createMemoryIntentStore } from "@answerable/mcp"
import { testPrincipal } from "@answerable/mcp/testing"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import type { Client } from "@modelcontextprotocol/client"
import { decodeJwt } from "jose"
import { z } from "zod"
import {
  connect,
  grantOrganisation,
  launchBrowser,
  linkClient,
  refusal,
  registerClient,
  registerResource,
  serve,
  signIn,
  startId,
  step,
  tool,
  type Id,
  type OAuthSession,
} from "../index"

const resource = "http://127.0.0.1:47602/mcp"
const otherResource = "http://127.0.0.1:47605/mcp"
const callback = "http://127.0.0.1:47603/callback"
const clientId = "mcp-e2e-browser"
const scopes = ["e2e:identity", "e2e:read", "e2e:write"]
const tenants = [
  { slug: "mcp-alpha", scopes },
  { slug: "mcp-beta", scopes },
  { slug: "mcp-gamma", scopes: ["e2e:identity", "e2e:read"] },
]
const writers = tenants.filter(tenant => tenant.scopes.includes("e2e:write"))
const readTools = ["identity_get", "records_list", "records_show"]
const allTools = [...readTools, "records_create", "records_delete", "e2e_commit", "e2e_commit_confirmed"]
const protocols = ["2025", "2026-07-28"] as const

const intentSchema = z.object({
  intent_id: z.uuid(),
  commit_token: z.string(),
  commit_tool: z.string(),
  policy_class: z.string(),
  expires_at: z.iso.datetime(),
  preview: z.object({ summary: z.string(), changes: z.array(z.unknown()) }),
})
const recordSchema = z.object({ id: z.uuid(), organizationId: z.uuid(), title: z.string(), version: z.number() })
const receiptSchema = z.object({ receipt_id: z.uuid(), intent_id: z.uuid(), status: z.string(), idempotent_replay: z.boolean(), results: z.record(z.string(), z.unknown()) })
const identitySchema = z.object({ userId: z.string(), organizationId: z.string(), scopes: z.array(z.string()) })
const commitArgs = (intent: z.infer<typeof intentSchema>) => ({ intent_id: intent.intent_id, commit_token: intent.commit_token })

let id: Id
let browser: Awaited<ReturnType<typeof launchBrowser>>
const records = createRecordStore()
// The journey controls the intent clock; token lifetimes stay on real time.
let clockOffset = 0
const intents = createMemoryIntentStore({ now: () => Date.now() + clockOffset })
const sessions = new Map<string, { organizationId: string; scopes: string[]; oauth: OAuthSession }>()
const kept = new Map<string, { record: z.infer<typeof recordSchema>; intent: z.infer<typeof intentSchema>; receipt: z.infer<typeof receiptSchema> }>()
const drafts = new Map<string, z.infer<typeof recordSchema>>()

function session(slug: string) {
  const found = sessions.get(slug)
  if (!found) throw new Error(`${slug} never signed in; the first test shows why`)
  return found
}
const clientFor = (slug: string, protocol: (typeof protocols)[number] = "2026-07-28") => connect(resource, session(slug).oauth.provider, protocol)
const prepare = async (client: Client, name: string, args: Record<string, unknown>) => intentSchema.parse(await tool(client, name, args))
const listed = async (client: Client) => z.object({ items: z.array(recordSchema) }).parse(await tool(client, "records_list")).items

beforeAll(async () => {
  id = await startId({ tenants: tenants.map(({ slug }) => ({ slug, signIns: 1 })) })
  const { admin, manifest } = id
  await registerResource(admin, { identifier: resource, scopes, accessTokenTtl: 60 })
  await registerClient(admin, { clientId, redirectUri: callback, scopes })
  await linkClient(admin, clientId, resource)
  for (const tenant of tenants) {
    const { organizationId } = manifest.tenants.find(({ slug }) => slug === tenant.slug)!
    await grantOrganisation(admin, organizationId, { clientId, resource, scopes, entitledScopes: tenant.scopes })
  }
  const provider = createE2eProvider({ records, viewHtml: "<!doctype html><title>Records</title>" })
  serve(47_602, createMcpServer({ provider, auth: { issuer: manifest.idOrigin, resource }, intents }).fetch)
  serve(47_605, createMcpServer({ provider, auth: { issuer: manifest.idOrigin, resource: otherResource } }).fetch)
  serve(Number(new URL(callback).port), () => new Response("Signed in. You can close this page."))
  browser = await launchBrowser()
})
afterAll(() => id?.stop())

test("each organisation signs in through ID with the SDK's OAuth client and a real browser", async () => {
  for (const tenant of tenants) {
    step(`${tenant.slug}: signing in through ID with the MCP SDK's OAuth client`)
    const { organizationId, email } = id.manifest.tenants.find(({ slug }) => slug === tenant.slug)!
    const oauth = await signIn(browser, { idOrigin: id.manifest.idOrigin, resource, clientId, callback, scopes }, { slug: tenant.slug, email, scopes: tenant.scopes })
    expect(oauth.state.tokens?.access_token).toBeString()
    expect(oauth.state.tokens?.refresh_token).toBeString()
    sessions.set(tenant.slug, { organizationId, scopes: tenant.scopes, oauth })
  }
})

test("each access token is bound to the MCP, lives 60 seconds and carries exactly the entitled scopes", () => {
  for (const { slug } of tenants) {
    const { oauth, scopes: entitled } = session(slug)
    const tokens = oauth.state.tokens!
    const expected = [...entitled, "offline_access"].sort()
    const claims = decodeJwt(tokens.access_token)
    expect(tokens.scope?.split(" ").sort()).toEqual(expected)
    expect(String(claims.scope).split(" ").sort()).toEqual(expected)
    expect(claims.aud).toBe(resource)
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60)
  }
})

test("a 2025 and a 2026-07-28 client see the entitled tools, the prompt and the resource, and identity_get names the selected organisation", async () => {
  for (const { slug } of tenants) {
    const { oauth, organizationId, scopes: entitled } = session(slug)
    const claims = decodeJwt(oauth.state.tokens!.access_token)
    for (const protocol of protocols) {
      step(`${slug}: MCP calls with a ${protocol} client`)
      const client = await clientFor(slug, protocol)
      expect((await client.listTools()).tools.map(item => item.name)).toEqual(entitled.includes("e2e:write") ? allTools : readTools)
      const identity = identitySchema.parse(await tool(client, "identity_get"))
      expect(identity).toMatchObject({ userId: claims.sub, organizationId })
      expect(identity.scopes.toSorted()).toEqual([...entitled, "offline_access"].sort())
      expect(JSON.stringify((await client.readResource({ uri: "fixture://guide" })).contents)).toContain("organisation")
      expect(JSON.stringify((await client.getPrompt({ name: "fixture_walkthrough", arguments: {} })).messages)).toContain("records_list")
    }
  }
})

describe("J4 agent-class mutation", () => {
  test("prepare returns a preview and a commit token; commit returns a receipt whose results is the record", async () => {
    for (const { slug } of writers) {
      step(`${slug}: create through records_create and e2e_commit`)
      const client = await clientFor(slug)
      const created = []
      for (const title of [`${slug} record`, `${slug} draft`]) {
        const intent = await prepare(client, "records_create", { title })
        expect(intent).toMatchObject({ commit_tool: "e2e_commit", policy_class: "agent", preview: { summary: `Create record “${title}”` } })
        expect(intent.commit_token).toStartWith("act_")
        expect(intent.preview.changes).toHaveLength(1)
        const receipt = receiptSchema.parse(await tool(client, "e2e_commit", commitArgs(intent)))
        expect(receipt).toMatchObject({ intent_id: intent.intent_id, status: "committed", idempotent_replay: false })
        const record = recordSchema.parse(receipt.results)
        expect(record).toMatchObject({ title, organizationId: session(slug).organizationId, version: 1 })
        created.push({ record, intent, receipt })
      }
      kept.set(slug, created[0]!)
      drafts.set(slug, created[1]!.record)
    }
  })

  test("a repeat of the commit returns the same receipt as a replay and creates nothing", async () => {
    const client = await clientFor("mcp-alpha")
    const { intent, receipt, record } = kept.get("mcp-alpha")!
    step("mcp-alpha: repeating the commit with the same token")
    const replay = receiptSchema.parse(await tool(client, "e2e_commit", commitArgs(intent)))
    expect(replay.receipt_id).toBe(receipt.receipt_id)
    expect(replay).toEqual({ ...receipt, idempotent_replay: true })
    expect((await listed(client)).filter(({ title }) => title === record.title)).toHaveLength(1)
  })

  test("a record changed after prepare makes the delete stale, with the expected and current versions", async () => {
    const client = await clientFor("mcp-alpha")
    const { record } = kept.get("mcp-alpha")!
    const intent = await prepare(client, "records_delete", { id: record.id })
    step("mcp-alpha: changing the record after prepare, as another writer would")
    records.touch(testPrincipal({ organizationId: session("mcp-alpha").organizationId }), record.id)
    const error = await refusal(client, "e2e_commit_confirmed", { ...commitArgs(intent), preview_summary: intent.preview.summary })
    expect(error.code).toBe("INTENT_STALE")
    expect(error.details).toEqual({ targets: [{ resource_id: record.id, expected: "1", current: "2" }] })
  })

  test("an intent past its expiry answers INTENT_EXPIRED", async () => {
    const client = await clientFor("mcp-alpha")
    const intent = await prepare(client, "records_create", { title: "Too late" })
    step("mcp-alpha: moving the intent clock past the expiry")
    clockOffset += Date.parse(intent.expires_at) - intents.now() + 1
    expect((await refusal(client, "e2e_commit", commitArgs(intent))).code).toBe("INTENT_EXPIRED")
  })
})

describe("J5 controlled class", () => {
  test("a delete names the confirmed commit tool, and e2e_commit answers APPROVAL_REQUIRED", async () => {
    for (const { slug } of writers) {
      step(`${slug}: delete through records_delete needs e2e_commit_confirmed`)
      const client = await clientFor(slug)
      const intent = await prepare(client, "records_delete", { id: drafts.get(slug)!.id })
      expect(intent).toMatchObject({ commit_tool: "e2e_commit_confirmed", policy_class: "controlled", preview: { summary: `Delete record “${slug} draft”` } })
      const error = await refusal(client, "e2e_commit", commitArgs(intent))
      expect(error).toMatchObject({ code: "APPROVAL_REQUIRED", details: { approval: { class: "controlled", commit_tool: "e2e_commit_confirmed" } } })
    }
  })

  test("a summary that differs by one character is refused; the exact summary commits and the record is gone", async () => {
    for (const { slug } of writers) {
      const client = await clientFor(slug)
      const draft = drafts.get(slug)!
      const intent = await prepare(client, "records_delete", { id: draft.id })
      step(`${slug}: confirming with a summary that differs by one character`)
      const wrong = await refusal(client, "e2e_commit_confirmed", { ...commitArgs(intent), preview_summary: intent.preview.summary.slice(0, -1) })
      expect(wrong.code).toBe("APPROVAL_REQUIRED")
      expect(wrong.message).toContain("differs")
      const receipt = receiptSchema.parse(await tool(client, "e2e_commit_confirmed", { ...commitArgs(intent), preview_summary: intent.preview.summary }))
      expect(receipt.results).toEqual({ deleted: true, id: draft.id })
      expect((await listed(client)).map(({ id }) => id)).not.toContain(draft.id)
    }
  })
})

test("each organisation lists only its own records, and preparing to delete another's answers NOT_FOUND", async () => {
  for (const { slug } of writers) {
    step(`${slug}: lists only its own records and cannot prepare deleting another's`)
    const client = await clientFor(slug)
    expect((await listed(client)).map(({ id }) => id)).toEqual([kept.get(slug)!.record.id])
    for (const [other, { record }] of kept) {
      if (other !== slug) expect((await refusal(client, "records_delete", { id: record.id })).code).toBe("NOT_FOUND")
    }
  }
})

test("a read-only organisation lists no records, and every write is an unknown tool to it", async () => {
  step("mcp-gamma: read-only access sees no other organisation's records and no writes")
  const client = await clientFor("mcp-gamma")
  expect(await tool(client, "records_list")).toEqual({ items: [], next_cursor: null, has_more: false })
  for (const name of ["records_create", "records_delete", "e2e_commit", "e2e_commit_confirmed"]) {
    await expect(client.callTool({ name, arguments: {} })).rejects.toThrow(`Tool ${name} not found`)
  }
})

test("a second MCP at another URL refuses the token with 401", async () => {
  for (const { slug } of tenants) {
    step(`${slug}: the token is refused by another MCP`)
    const call = (url: string) =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${session(slug).oauth.state.tokens!.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    // The MCP it was issued for accepts it, so the refusal is about the audience and not the expiry.
    expect((await call(resource)).status).toBe(200)
    const elsewhere = await call(otherResource)
    expect(elsewhere.status).toBe(401)
    expect(elsewhere.headers.get("www-authenticate")).toMatch(/resource_metadata=/)
  }
})

test("the SDK refreshes an expired access token by itself, ID rotates the refresh token and the scopes stay", async () => {
  for (const { slug } of tenants) {
    step(`${slug}: the SDK refreshes an expired access token`)
    const { oauth, organizationId, scopes: entitled } = session(slug)
    const tokens = oauth.state.tokens!
    oauth.state.tokens = { ...tokens, access_token: "expired" }
    const client = await clientFor(slug, "2025")
    expect((await tool(client, "identity_get")).organizationId).toBe(organizationId)
    const refreshed = oauth.state.tokens!
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)
    const expected = [...entitled, "offline_access"].sort()
    expect(refreshed.scope?.split(" ").sort()).toEqual(expected)
    expect(String(decodeJwt(refreshed.access_token).scope).split(" ").sort()).toEqual(expected)
  }
})

test("disabling an organisation stops refresh with invalid_grant, while the access token already issued works until it expires", async () => {
  for (const { slug } of tenants) {
    step(`${slug}: disabling the organisation stops refresh`)
    const { oauth, organizationId } = session(slug)
    await id.admin("POST", `/organizations/${organizationId}/disable`)
    const endpoint = oauth.state.discovery?.authorizationServerMetadata?.token_endpoint
    expect(endpoint).toBeString()
    const refused = await fetch(endpoint!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: String(oauth.state.tokens?.refresh_token), resource }),
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: "invalid_grant" })
    const client = await clientFor(slug, "2025")
    expect((await tool(client, "identity_get")).organizationId).toBe(organizationId)
  }
})
