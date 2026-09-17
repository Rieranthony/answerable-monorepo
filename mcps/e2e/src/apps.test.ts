import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { buildView, bundleBrowser } from "@answerable/mcp-base/build"
import { connectTestClient } from "@answerable/mcp-base/testing"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import { createE2eMcp } from "./mcp"
import { recordsOutput } from "./contracts"
import { createRecordStore } from "./services/records"

test("Apps view creates and deletes through the real MCP client, and cannot bypass denied scopes", async () => {
  const html = await buildView({ entry: new URL("./views/records.tsx", import.meta.url).pathname, title: "Test records" })
  const hostBuild = await bundleBrowser(new URL("./testing/host.ts", import.meta.url).pathname)
  const hostJs = hostBuild[0].text
  const key = await generateKeyPair("EdDSA")
  const jwk = { ...(await exportJWK(key.publicKey)), kid: "test", alg: "EdDSA" }
  const jwks = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [jwk] }) })
  const records = createRecordStore(":memory:")
  const resourceInstanceId = crypto.randomUUID()
  const tenant = crypto.randomUUID()
  const issuer = "https://id.test"
  const resource = "https://fixture.test/mcp"
  const auth = { issuer, resource, resourceInstanceId, jwksUrl: new URL("/jwks", jwks.url).href, allowLocalHttp: true }
  const app = createE2eMcp({ auth, records, viewHtml: html, allowedHosts: ["127.0.0.1"] })
  let loseNextCreateResult = false
  const mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const loseResult = loseNextCreateResult && request.method === "POST" && (await request.clone().text()).includes('"records_create"')
    const response = await app.fetch(request)
    if (loseResult) {
      loseNextCreateResult = false
      return new Response("Simulated loss of the committed write response", { status: 502 })
    }
    return response
  } })
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/host.js") return new Response(hostJs, { headers: { "Content-Type": "text/javascript" } })
    return new Response('<!doctype html><title>Apps test host</title><iframe title="Records" sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script>', { headers: { "Content-Type": "text/html" } })
  } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true, timeout: 10_000 })
    for (const write of [true, false]) {
      const token = await new SignJWT({
        sub: crypto.randomUUID(), subject_type: "user", organization_id: tenant, membership_id: crypto.randomUUID(), grant_id: crypto.randomUUID(),
        client_instance: crypto.randomUUID(), resource_instance: resourceInstanceId, client_id: "test", azp: "test",
        scope: write ? "e2e:read e2e:write" : "e2e:read", authorization_version: 1, organization_authorization_version: 1, upstream_auth_time: null,
      }).setProtectedHeader({ alg: "EdDSA", kid: "test", typ: "at+jwt" }).setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime("5m").sign(key.privateKey)
      const client = await connectTestClient({ url: new URL("/mcp", mcp.url), accessToken: token })
      const page = await browser.newPage()
      page.setDefaultTimeout(5_000)
      try {
        const errors: string[] = []
        page.on("pageerror", error => errors.push(error.message))
        await page.exposeFunction("getInitial", async () => ({ html: ((await client.readResource({ uri: "ui://records/index.html" })).contents[0] as { text: string }).text, result: await client.callTool({ name: "records_show", arguments: {} }) }))
        await page.exposeFunction("callTool", (params: Parameters<typeof client.callTool>[0]) => client.callTool(params))
        await page.goto(host.url.href)
        const frame = page.frameLocator("iframe")
        await frame.getByLabel("Record title").fill(write ? "Browser record" : "Forbidden record")
        loseNextCreateResult = write
        await frame.getByRole("button", { name: "Create record" }).click()
        if (write) {
          await frame.getByRole("alert").waitFor()
          expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toMatchObject({ records: [{ title: "Browser record" }] })
          await frame.getByRole("button", { name: "Create record" }).click()
          await frame.getByText("Browser record", { exact: true }).waitFor()
          expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toMatchObject({ records: [{ title: "Browser record" }] })
          expect(recordsOutput.parse((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).records).toHaveLength(1)
          await frame.getByRole("button", { name: "Delete Browser record" }).click()
          await frame.getByText("No test records yet.").waitFor()
          const readOnlyApp = createE2eMcp({ auth, records, viewHtml: html, allowedHosts: ["127.0.0.1"], readOnly: true })
          const readOnlyServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: readOnlyApp.fetch })
          let readOnlyClient: Awaited<ReturnType<typeof connectTestClient>> | undefined
          try {
            readOnlyClient = await connectTestClient({ url: new URL("/mcp", readOnlyServer.url), accessToken: token })
            expect((await readOnlyClient.listTools()).tools.map(tool => tool.name)).not.toContain("records_create")
            expect((await readOnlyClient.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ records: [] })
            await expect(readOnlyClient.callTool({ name: "records_create", arguments: { title: "Omitted", operationKey: crypto.randomUUID() } })).rejects.toThrow("not found")
          } finally {
            await readOnlyClient?.close()
            readOnlyServer.stop(true)
          }
        } else {
          await frame.getByRole("alert").filter({ hasText: "insufficient_scope" }).waitFor()
          expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ records: [] })
        }
        expect(errors).toEqual([])
      } finally {
        await page.close()
        await client.close()
      }
    }
  } finally {
    await browser?.close()
    host.stop(true)
    mcp.stop(true)
    jwks.stop(true)
    records.close()
  }
}, 30_000)
