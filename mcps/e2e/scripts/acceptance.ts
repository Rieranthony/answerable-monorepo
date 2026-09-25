// Real Answerable ID, a real browser and the official MCP OAuth client against the e2e MCP.
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser } from "@playwright/test"
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client"
import { decodeJwt } from "jose"
import { z } from "zod"
import { createE2eMcp } from "../src/mcp"
import { createRecordStore } from "../src/records"

const root = new URL("../../../", import.meta.url).pathname
const compose = ["docker", "compose", "-p", "answerable-mcp-e2e", "-f", join(root, "mcps/e2e/compose.yaml")]
const directory = await mkdtemp(join(tmpdir(), "answerable-mcp-acceptance-"))
const manifestPath = join(directory, "manifest.json")
const manifestSchema = z.object({
  idOrigin: z.url(),
  resource: z.url(),
  callback: z.url(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  rootSecret: z.string(),
  tenants: z.array(z.object({ slug: z.string(), email: z.string(), organizationId: z.uuid(), scopes: z.array(z.string()) })),
})
const view = "<!doctype html><title>Records</title>"
const allTools = ["identity_get", "records_create", "records_delete", "records_list", "records_show"]

const closers: Array<() => unknown> = []
let fixture: ReturnType<typeof Bun.spawn> | undefined
let finished: Promise<void> | undefined

function step(message: string) {
  console.log(`[acceptance] ${message}`)
}

async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: root, stdout: "ignore", stderr: "inherit" })
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${command.slice(0, 4).join(" ")}`)
}

function cleanup() {
  finished ??= (async () => {
    for (const close of closers.reverse()) {
      try {
        await close()
      } catch {
        // Keep releasing the remaining resources.
      }
    }
    if (fixture && fixture.exitCode === null) {
      fixture.kill("SIGTERM")
      const kill = setTimeout(() => fixture?.kill("SIGKILL"), 5_000)
      await fixture.exited
      clearTimeout(kill)
    }
    await run([...compose, "down", "--volumes"]).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })()
  return finished
}
process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)))
process.on("SIGTERM", () => void cleanup().finally(() => process.exit(143)))

function serve(port: number, fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch })
  closers.push(() => server.stop(true))
  return server
}

/** An in-memory OAuth client, registered in ID ahead of time, as Claude Code is with --client-id. */
function oauthProvider(manifest: z.infer<typeof manifestSchema>) {
  const state: {
    authorizationUrl?: URL
    verifier?: string
    tokens?: Awaited<ReturnType<OAuthClientProvider["tokens"]>>
    discovery?: OAuthDiscoveryState
  } = {}
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return manifest.callback
    },
    get clientMetadata() {
      return {
        client_name: "MCP acceptance",
        redirect_uris: [manifest.callback],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }
    },
    clientInformation: () => ({ client_id: manifest.clientId }),
    tokens: () => state.tokens,
    saveTokens: tokens => {
      state.tokens = tokens
    },
    redirectToAuthorization: url => {
      state.authorizationUrl = url
    },
    saveCodeVerifier: verifier => {
      state.verifier = verifier
    },
    codeVerifier: () => {
      if (!state.verifier) throw new Error("No PKCE verifier saved")
      return state.verifier
    },
    saveDiscoveryState: discovery => {
      state.discovery = discovery
    },
    discoveryState: () => state.discovery,
  }
  return { provider, state }
}

async function connect(resource: string, provider: OAuthClientProvider, protocol: "2025" | "2026-07-28") {
  const client = new Client(
    { name: "answerable-acceptance", version: "0.1.0" },
    protocol === "2026-07-28" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider }))
  closers.push(() => client.close())
  return client
}

/** Follow the MCP challenge with the SDK, then complete ID's pages in a real browser. */
async function signIn(
  browser: Browser,
  manifest: z.infer<typeof manifestSchema>,
  tenant: z.infer<typeof manifestSchema>["tenants"][number],
) {
  const oauth = oauthProvider(manifest)
  const transport = new StreamableHTTPClientTransport(new URL(manifest.resource), { authProvider: oauth.provider })
  await assert.rejects(new Client({ name: "answerable-acceptance", version: "0.1.0" }).connect(transport), UnauthorizedError)
  const authorize = oauth.state.authorizationUrl
  assert.ok(authorize, "The SDK must discover ID from the MCP challenge")
  assert.equal(authorize.origin, manifest.idOrigin)
  assert.equal(authorize.searchParams.get("client_id"), manifest.clientId)
  assert.equal(authorize.searchParams.get("resource"), manifest.resource, "RFC 8707 resource indicator")
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256")
  assert.deepEqual(
    authorize.searchParams.get("scope")?.split(" ").sort(),
    [...manifest.scopes, "offline_access"].sort(),
    "Scopes come from the protected-resource metadata",
  )
  const context = await browser.newContext()
  closers.push(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  await page.goto(authorize.href)
  await page.getByLabel(/email/i).fill(tenant.email)
  await page.getByRole("button", { name: /continue/i }).click()
  try {
    await page.getByRole("heading", { name: "Choose an organisation" }).waitFor()
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    await page.getByRole("heading", { name: "Access it will receive" }).waitFor()
    const withheld = manifest.scopes.filter(scope => !tenant.scopes.includes(scope))
    const scopeList = await page.locator("section ul").innerText()
    for (const scope of tenant.scopes) assert.ok(scopeList.includes(scope))
    assert.ok(scopeList.includes("Stay connected after you leave"))
    if (withheld.length) {
      step(`${tenant.slug}: consent names the unapproved scopes`)
      const notice = await page.getByText(`Not approved for ${tenant.slug}:`).innerText()
      for (const scope of withheld) {
        assert.ok(notice.includes(scope))
        assert.ok(!scopeList.includes(scope))
      }
    } else assert.equal(await page.getByText(/Not approved for/).count(), 0)
    await page.getByRole("button", { name: "Accept", exact: true }).click()
    await page.waitForURL(`${manifest.callback}?**`)
  } catch (error) {
    console.error("[acceptance] ID page:", new URL(page.url()).pathname, await page.locator("body").innerText())
    throw error
  }
  const callback = new URL(page.url()).searchParams
  assert.equal(callback.get("iss"), manifest.idOrigin, "RFC 9207 issuer in the authorisation response")
  await transport.finishAuth(callback)
  await context.close()
  return oauth
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
  return result.structuredContent as Record<string, unknown>
}

try {
  step("Starting isolated PostgreSQL")
  await run([...compose, "up", "-d", "--wait"])
  fixture = Bun.spawn([process.execPath, "scripts/mcp-e2e-fixture.ts", manifestPath, "--isolated-mcp-fixture"], {
    cwd: join(root, "apps/id"),
    stdout: "inherit",
    stderr: "inherit",
  })
  const deadline = Date.now() + 90_000
  while (!(await Bun.file(manifestPath).exists())) {
    if (fixture.exitCode !== null) throw new Error(`ID fixture stopped (${fixture.exitCode})`)
    if (Date.now() > deadline) throw new Error("Timed out waiting for the ID fixture")
    await Bun.sleep(200)
  }
  const manifest = manifestSchema.parse(await Bun.file(manifestPath).json())
  const records = createRecordStore()
  serve(47_602, createE2eMcp({ auth: { issuer: manifest.idOrigin, resource: manifest.resource }, viewHtml: view, records }).fetch)
  const otherPort = 47_605
  const otherResource = `http://127.0.0.1:${otherPort}/mcp`
  serve(otherPort, createE2eMcp({ auth: { issuer: manifest.idOrigin, resource: otherResource }, viewHtml: view, records }).fetch)
  serve(Number(new URL(manifest.callback).port), () => new Response("Signed in. You can close this page."))
  // Playwright's own signal handlers would exit before this script's cleanup runs.
  const browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
  closers.push(() => browser.close())

  const created = new Map<string, string>()
  for (const tenant of manifest.tenants) {
    step(`${tenant.slug}: signing in through ID with the MCP SDK's OAuth client`)
    const oauth = await signIn(browser, manifest, tenant)
    const tokens = oauth.state.tokens
    assert.ok(tokens?.access_token && tokens.refresh_token, "ID issues an access and a refresh token")
    const expectedScopes = [...tenant.scopes, "offline_access"].sort()
    const partial = !tenant.scopes.includes("e2e:write")
    const claims = decodeJwt(tokens.access_token)
    assert.deepEqual(tokens.scope?.split(" ").sort(), expectedScopes)
    assert.deepEqual(String(claims.scope).split(" ").sort(), expectedScopes)
    assert.equal(claims.aud, manifest.resource, "The access token's audience is this MCP")
    assert.equal(Number(claims.exp) - Number(claims.iat), 60, "The resource's 60-second lifetime is honoured")

    for (const protocol of ["2025", "2026-07-28"] as const) {
      step(`${tenant.slug}: MCP calls with a ${protocol} client`)
      const client = await connect(manifest.resource, oauth.provider, protocol)
      assert.deepEqual((await client.listTools()).tools.map(item => item.name).sort(), partial ? ["identity_get", "records_list", "records_show"] : allTools)
      const identity = await tool(client, "identity_get")
      assert.equal(identity.organizationId, tenant.organizationId, "The token carries the selected organisation")
      assert.equal(identity.userId, claims.sub)
      assert.deepEqual((identity.scopes as string[]).slice().sort(), expectedScopes)
      const guide = await client.readResource({ uri: "fixture://guide" })
      assert.ok(JSON.stringify(guide.contents).includes("organisation"))
      const walkthrough = await client.getPrompt({ name: "fixture_walkthrough", arguments: {} })
      assert.ok(JSON.stringify(walkthrough.messages).includes("records_list"))
    }

    step(`${tenant.slug}: tenant isolation`)
    const client = await connect(manifest.resource, oauth.provider, "2026-07-28")
    if (partial) {
      step(`${tenant.slug}: read-only access excludes other organisations' records and refuses writes`)
      const listed = z.object({ records: z.array(z.object({ id: z.string(), organizationId: z.string() })) }).parse(await tool(client, "records_list"))
      assert.deepEqual(listed.records, [])
      await assert.rejects(tool(client, "records_create", { title: "Unapproved write" }))
    } else {
      const record = await tool(client, "records_create", { title: `${tenant.slug} record` })
      const listed = z.object({ records: z.array(z.object({ id: z.string(), organizationId: z.string() })) }).parse(await tool(client, "records_list"))
      assert.deepEqual(listed.records.map(item => item.id), [record.id], "Each organisation sees only its own records")
      for (const [otherSlug, otherId] of created) {
        const denied = await client.callTool({ name: "records_delete", arguments: { recordId: otherId } })
        assert.equal(denied.isError, true, `${tenant.slug} cannot delete a ${otherSlug} record`)
        assert.ok(JSON.stringify(denied.content).includes("record_not_found"))
      }
      created.set(tenant.slug, String(record.id))
    }

    step(`${tenant.slug}: the token is refused by another MCP`)
    const elsewhere = await fetch(otherResource, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    assert.equal(elsewhere.status, 401)
    assert.match(elsewhere.headers.get("www-authenticate") ?? "", /resource_metadata=/)

    step(`${tenant.slug}: the SDK refreshes an expired access token`)
    const before = tokens.refresh_token
    oauth.state.tokens = { ...tokens, access_token: "expired" }
    const refreshed = await connect(manifest.resource, oauth.provider, "2025")
    assert.equal((await tool(refreshed, "identity_get")).organizationId, tenant.organizationId)
    assert.notEqual(oauth.state.tokens?.refresh_token, before, "ID rotates the refresh token")
    assert.deepEqual(oauth.state.tokens?.scope?.split(" ").sort(), expectedScopes)
    assert.deepEqual(String(decodeJwt(oauth.state.tokens!.access_token).scope).split(" ").sort(), expectedScopes)

    step(`${tenant.slug}: disabling the organisation stops refresh`)
    const disabled = await fetch(`${manifest.idOrigin}/api/admin/v1/organizations/${tenant.organizationId}/disable`, {
      method: "POST",
      headers: { Authorization: `Bearer ${manifest.rootSecret}`, "Idempotency-Key": crypto.randomUUID() },
    })
    assert.equal(disabled.status, 200)
    const discovery = oauth.state.discovery
    assert.ok(discovery?.authorizationServerMetadata?.token_endpoint)
    const refused = await fetch(discovery.authorizationServerMetadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: manifest.clientId,
        refresh_token: String(oauth.state.tokens?.refresh_token),
        resource: manifest.resource,
      }),
    })
    assert.equal(refused.status, 400)
    assert.equal(z.object({ error: z.string() }).parse(await refused.json()).error, "invalid_grant")
    const current = await connect(manifest.resource, oauth.provider, "2025")
    assert.equal(
      (await tool(current, "identity_get")).organizationId,
      tenant.organizationId,
      "An issued access token stays valid until it expires; the MCP verifies offline",
    )
  }
  step("PASS")
} finally {
  await cleanup()
}
