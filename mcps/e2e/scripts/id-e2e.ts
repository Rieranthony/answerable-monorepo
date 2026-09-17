import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type BrowserContext, type Page } from "@playwright/test"
import { buildView, bundleBrowser } from "@answerable/mcp-base/build"
import { z } from "zod"
import { decodeJwt } from "jose"
import { connectTestClient } from "@answerable/mcp-base/testing"
import { createE2eMcp } from "../src/mcp"
import { createRecordStore } from "../src/services/records"

const root = new URL("../../../", import.meta.url).pathname
// Owning this loopback port serialises runners before any Docker mutation.
const guard = Bun.serve({ hostname: "127.0.0.1", port: 47604, fetch: () => new Response("MCP acceptance is running", { status: 409 }) })
const directory = await mkdtemp(join(tmpdir(), "answerable-id-mcp-"))
const manifestPath = join(directory, "manifest.json")
const compose = ["docker", "compose", "-p", "answerable-mcp-e2e", "-f", join(root, "mcps/e2e/compose.yaml")]
const processes: ReturnType<typeof Bun.spawn>[] = []
const commands = new Set<ReturnType<typeof Bun.spawn>>()
const servers: Array<ReturnType<typeof Bun.serve>> = []
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let records: ReturnType<typeof createRecordStore> | undefined
let cleaning: Promise<void> | undefined

function ensureRunning() {
  if (cleaning) throw new Error("Test run interrupted")
}
async function command(cmd: string[], duringCleanup = false) {
  if (!duringCleanup) ensureRunning()
  const child = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" })
  commands.add(child)
  try {
    if (await child.exited !== 0) throw new Error(`Command failed: ${cmd.slice(0, 3).join(" ")}`)
  } finally { commands.delete(child) }
}
async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    ensureRunning()
    if (await check().catch(() => false)) return
    const stopped = processes.find(process => process.exitCode !== null)
    if (stopped) throw new Error(`${label}: child process stopped (${stopped.exitCode})`)
    await Bun.sleep(200)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    const failed: string[] = []
    async function attempt(label: string, close: () => unknown | Promise<unknown>) {
      try { await close() } catch { failed.push(label) }
    }
    await attempt("browser", () => browser?.close())
    for (const server of servers.reverse()) await attempt("HTTP server", () => server.stop(true))
    await attempt("record store", () => records?.close())
    for (const child of [...commands, ...processes.reverse()]) {
      await attempt("child process", async () => {
        if (child.exitCode === null) child.kill("SIGTERM")
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL") }, 5_000)
        try { await child.exited } finally { clearTimeout(timer) }
      })
    }
    await attempt("fixture container", () => command([...compose, "down", "--volumes"], true))
    await attempt("temporary files", () => rm(directory, { recursive: true, force: true }))
    guard.stop(true)
    if (failed.length) throw new Error(`Cleanup failed: ${failed.join(", ")}`)
  })()
  return cleaning
}
process.once("SIGINT", () => { void cleanup().finally(() => process.exit(130)) })
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(143)) })

try {
  console.log("[e2e] Starting isolated PostgreSQL")
  await command([...compose, "up", "-d", "--wait"])
  ensureRunning()
  const id = Bun.spawn([process.execPath, "apps/id/scripts/mcp-e2e-fixture.ts", manifestPath, "--isolated-mcp-fixture"], { cwd: root, stdout: "inherit", stderr: "inherit" })
  processes.push(id)
  await waitFor(() => Bun.file(manifestPath).exists(), "ID fixture")
  const manifest = await Bun.file(manifestPath).json() as {
    idOrigin: string; webOrigin: string; mcpOrigin: string; callback: string; clientId: string;
    resource: string; resourceInstanceId: string; scopes: string[];
    tenants: Array<{ email: string; organizationId: string; slug: string }>;
  }
  ensureRunning()
  console.log("[e2e] Starting real web login pages")
  const web = Bun.spawn([process.execPath, "node_modules/next/dist/bin/next", "dev", "--port", "47601", "--hostname", "127.0.0.1"], {
    cwd: join(root, "apps/web"), stdout: "ignore", stderr: "inherit",
    env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_ID_URL: manifest.idOrigin, NEXT_DIST_DIR: ".next-mcp-e2e" },
  })
  processes.push(web)
  await waitFor(async () => (await fetch(`${manifest.webOrigin}/login`)).ok, "web login")
  const html = await buildView({ entry: join(root, "mcps/e2e/src/views/records.tsx"), title: "ID acceptance records" })
  ensureRunning()
  records = createRecordStore(join(directory, "records.sqlite"))
  const app = createE2eMcp({ auth: {
    issuer: manifest.idOrigin, jwksUrl: `${manifest.idOrigin}/auth/jwks`, resource: manifest.resource,
    resourceInstanceId: manifest.resourceInstanceId, allowLocalHttp: true,
  }, records, viewHtml: html })
  servers.push(Bun.serve({ hostname: "127.0.0.1", port: 47602, fetch: app.fetch }))
  const challengeResponse = await fetch(manifest.resource, { method: "POST" })
  assert.equal(challengeResponse.status, 401)
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challengeResponse.headers.get("www-authenticate") ?? "")?.[1]
  assert.ok(metadataUrl, "MCP challenge advertises protected-resource metadata")
  assert.equal(new URL(metadataUrl).origin, manifest.mcpOrigin)
  const metadata = z.object({ resource: z.string(), authorization_servers: z.array(z.string()).length(1) }).parse(await (await fetch(metadataUrl)).json())
  assert.equal(metadata.resource, manifest.resource)
  assert.equal(metadata.authorization_servers[0], manifest.idOrigin)
  const oauth = z.object({ issuer: z.string(), authorization_endpoint: z.url(), token_endpoint: z.url() }).parse(await (await fetch(new URL("/.well-known/oauth-authorization-server", metadata.authorization_servers[0]))).json())
  assert.equal(oauth.issuer, manifest.idOrigin)
  assert.equal(new URL(oauth.authorization_endpoint).origin, manifest.idOrigin)
  assert.equal(new URL(oauth.token_endpoint).origin, manifest.idOrigin)
  const otherApp = createE2eMcp({ auth: {
    issuer: manifest.idOrigin, jwksUrl: `${manifest.idOrigin}/auth/jwks`, resource: `${manifest.mcpOrigin}/other-mcp`,
    resourceInstanceId: crypto.randomUUID(), allowLocalHttp: true,
  }, records, viewHtml: html })
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: otherApp.fetch })
  servers.push(other)
  const hostJs = (await bundleBrowser(join(root, "mcps/e2e/src/testing/host.ts")))[0].text
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/host.js") return new Response(hostJs, { headers: { "Content-Type": "text/javascript" } })
    return new Response('<!doctype html><title>Real ID Apps acceptance</title><iframe title="Records" sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script>', { headers: { "Content-Type": "text/html" } })
  } })
  servers.push(host)
  const callback = Bun.serve({ hostname: "127.0.0.1", port: 47603, fetch: () => new Response("Authorisation received. You can close this page.") })
  servers.push(callback)
  browser = await chromium.launch({ headless: true })
  const results: string[] = []
  const expiryChecks: Array<{ accessToken: string; expiresAt: number }> = []
  for (const tenant of manifest.tenants) {
    console.log(`[e2e] Authenticating ${tenant.slug} through ID and web pages`)
    const context: BrowserContext = await browser.newContext()
    const page: Page = await context.newPage()
    page.setDefaultTimeout(30_000)
    let upstreamNavigations = 0
    page.on("request", request => {
      const url = new URL(request.url())
      if (request.isNavigationRequest() && url.pathname === "/authorize" && ![manifest.idOrigin, manifest.webOrigin].includes(url.origin)) upstreamNavigations++
    })
    const verifier = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url")
    const state = crypto.randomUUID()
    const authorize = new URL(oauth.authorization_endpoint)
    authorize.search = new URLSearchParams({ client_id: manifest.clientId, redirect_uri: manifest.callback,
      response_type: "code", scope: [...manifest.scopes, "offline_access"].join(" "), resource: manifest.resource,
      code_challenge: challenge, code_challenge_method: "S256", state }).toString()
    await page.goto(authorize.href)
    await page.getByLabel(/email/i).fill(tenant.email)
    await page.getByRole("button", { name: /continue/i }).click()
    try {
      await page.getByRole("heading", { name: "Choose an organisation" }).waitFor()
      await page.getByRole("button", { name: "Continue", exact: true }).click()
      await page.getByRole("button", { name: "Accept", exact: true }).click()
    } catch (error) {
      console.error("[e2e] Consent page:", new URL(page.url()).pathname, await page.locator("body").innerText())
      throw error
    }
    await page.waitForURL(`${manifest.callback}?**`)
    assert.equal(upstreamNavigations, 1, "SSO must navigate to the corporate provider exactly once")
    const returned: URL = new URL(page.url())
    assert.equal(returned.searchParams.get("state"), state)
    assert.ok(returned.searchParams.get("code"), "ID must return an authorisation code")
    const response = await fetch(oauth.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
      grant_type: "authorization_code", client_id: manifest.clientId, code: returned.searchParams.get("code")!,
      redirect_uri: manifest.callback, code_verifier: verifier, resource: manifest.resource,
    }) })
    assert.equal(response.status, 200, "ID must exchange the real browser code")
    const token = await response.json() as { access_token: string; refresh_token?: string }
    assert.ok(token.access_token)
    const denied = await fetch(new URL("/other-mcp", other.url), { method: "POST", headers: {
      Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })
    assert.equal(denied.status, 401, "An ID-issued token for this MCP must fail at another resource")
    const client = await connectTestClient({ url: new URL(manifest.resource), accessToken: token.access_token })
    try {
      const walkthrough = await client.getPrompt({ name: "fixture_walkthrough", arguments: {} })
      assert.ok(JSON.stringify(walkthrough.messages).includes("records_create"))
      const guide = await client.readResource({ uri: "fixture://guide" })
      assert.ok(z.object({ text: z.string() }).parse(guide.contents[0]).text.includes("operation key"))
      const identity = await client.callTool({ name: "identity_get", arguments: {} })
      assert.equal(z.object({ organizationId: z.uuid() }).parse(identity.structuredContent).organizationId, tenant.organizationId)
      const list = await client.callTool({ name: "records_list", arguments: {} })
      assert.deepEqual(list.structuredContent, { records: [] }, "Each tenant starts with an isolated list")
      const created = await client.callTool({ name: "records_create", arguments: { title: tenant.slug, operationKey: crypto.randomUUID() } })
      assert.equal(created.isError, undefined)
      results.push(z.object({ id: z.uuid() }).parse(created.structuredContent).id)
      await page.exposeFunction("getInitial", async () => ({
        html: z.object({ text: z.string() }).parse((await client.readResource({ uri: "ui://records/index.html" })).contents[0]).text,
        result: await client.callTool({ name: "records_show", arguments: {} }),
      }))
      await page.exposeFunction("callTool", (params: Parameters<typeof client.callTool>[0]) => client.callTool(params))
      await page.goto(host.url.href)
      const frame = page.frameLocator("iframe")
      const title = `${tenant.slug} browser record`
      await frame.getByLabel("Record title").fill(title)
      await frame.getByRole("button", { name: "Create record" }).click()
      await frame.getByText(title, { exact: true }).waitFor()
      const rows = z.object({ records: z.array(z.object({ title: z.string() })) }).parse((await client.callTool({ name: "records_list", arguments: {} })).structuredContent)
      assert.ok(rows.records.some(record => record.title === title), "UI action must persist through the authenticated MCP")
      await frame.getByRole("button", { name: `Delete ${title}` }).click()
      await frame.getByText(title, { exact: true }).waitFor({ state: "detached" })
      if (results.length > 1) {
        const forbidden = await client.callTool({ name: "records_get", arguments: { recordId: results[0] } })
        assert.equal(forbidden.isError, true, "Other tenant's record must be inaccessible")
      }
      assert.ok(token.refresh_token, "ID must issue a refresh token for offline_access")
      const refreshBody = (refreshToken: string) => new URLSearchParams({ grant_type: "refresh_token", client_id: manifest.clientId, refresh_token: refreshToken, resource: manifest.resource })
      const refreshedResponse = await fetch(oauth.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshBody(token.refresh_token) })
      assert.equal(refreshedResponse.status, 200, "An active grant can refresh")
      const refreshed = z.object({ access_token: z.string(), refresh_token: z.string() }).parse(await refreshedResponse.json())
      const refreshedClient = await connectTestClient({ url: new URL(manifest.resource), accessToken: refreshed.access_token })
      try {
        assert.equal(z.object({ organizationId: z.uuid() }).parse((await refreshedClient.callTool({ name: "identity_get", arguments: {} })).structuredContent).organizationId, tenant.organizationId)
        await command([process.execPath, "apps/id/scripts/mcp-e2e-disable.ts", manifestPath, tenant.organizationId])
        const refused = await fetch(oauth.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshBody(refreshed.refresh_token) })
        assert.equal(refused.status, 400, "Disabling the organisation refuses refresh")
        assert.equal(z.object({ error: z.string() }).parse(await refused.json()).error, "invalid_grant")
        assert.notEqual((await refreshedClient.callTool({ name: "identity_get", arguments: {} })).isError, true, "Offline validation accepts the already-issued token until expiry")
        const claims = z.object({ exp: z.number(), iat: z.number() }).parse(decodeJwt(refreshed.access_token))
        assert.ok(claims.exp - claims.iat <= 60, "Fixture access-token lifetime is at most 60 seconds")
        expiryChecks.push({ accessToken: refreshed.access_token, expiresAt: claims.exp })
      } finally {
        await refreshedClient.close()
      }
    } finally {
      await client.close()
      await context.close()
    }
  }
  const remaining = Math.max(0, Math.max(...expiryChecks.map(check => check.expiresAt)) * 1000 - Date.now() + 1000)
  console.log(`[e2e] Waiting ${Math.ceil(remaining / 1000)}s to measure real token expiry after revocation`)
  await Bun.sleep(remaining)
  for (const check of expiryChecks) {
    const expired = await fetch(manifest.resource, { headers: { Authorization: `Bearer ${check.accessToken}` } })
    assert.equal(expired.status, 401, "The revoked organisation's existing token stops working at expiry")
  }
  console.log("[e2e] PASS: real ID browser login, PKCE, resource tokens, MCP identity, writes, Apps UI actions, tenant isolation, refresh, revocation and measured expiry")
} finally {
  await cleanup()
}
