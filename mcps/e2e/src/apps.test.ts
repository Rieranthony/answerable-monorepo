import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { buildView, bundleBrowser } from "@answerable/mcp/build"
import { createTestMcp } from "@answerable/mcp/testing"
import { createE2eProvider } from "./mcp"
import { createRecordStore } from "./records"

test("the Apps view lists the caller's records through the real MCP client and host bridge", async () => {
  const html = await buildView({ entry: new URL("./views/records.tsx", import.meta.url).pathname, title: "Test records" })
  const hostBuild = await bundleBrowser(new URL("./testing/host.ts", import.meta.url).pathname)
  const hostJs = hostBuild[0].text
  const records = createRecordStore()
  const organizationId = crypto.randomUUID()
  const principal = { userId: crypto.randomUUID(), organizationId, membershipId: crypto.randomUUID(), grantId: crypto.randomUUID(), clientId: "test", scopes: [], expiresAt: 1 }
  for (const title of ["First record", "Second record"]) records.create(principal, title)
  const mcp = await createTestMcp(createE2eProvider({ records, viewHtml: html }))
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/host.js") return new Response(hostJs, { headers: { "Content-Type": "text/javascript" } })
    return new Response('<!doctype html><title>Apps test host</title><iframe title="Records" sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script>', { headers: { "Content-Type": "text/html" } })
  } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true, timeout: 10_000 })
    for (const [tenant, expected] of [[organizationId, ["First record", "Second record"]], [crypto.randomUUID(), []]] as const) {
      const client = await mcp.connect({ organizationId: tenant, scopes: ["e2e:read"] })
      const page = await browser.newPage()
      page.setDefaultTimeout(5_000)
      try {
        const errors: string[] = []
        page.on("pageerror", error => errors.push(error.message))
        await page.exposeFunction("getInitial", async () => ({ html: ((await client.readResource({ uri: "ui://records/index.html" })).contents[0] as { text: string }).text, result: await client.callTool({ name: "records_show", arguments: {} }) }))
        await page.goto(host.url.href)
        const frame = page.frameLocator("iframe")
        if (expected.length) {
          await frame.getByRole("listitem").first().waitFor()
          expect(await frame.getByRole("listitem").allInnerTexts()).toEqual([...expected])
        } else await frame.getByText("No test records yet.").waitFor()
        expect(await frame.getByRole("button").count()).toBe(0)
        expect(await frame.getByRole("textbox").count()).toBe(0)
        expect(errors).toEqual([])
      } finally {
        await page.close()
        await client.close()
      }
    }
  } finally {
    await browser?.close()
    host.stop(true)
    await mcp.close()
  }
}, 30_000)
