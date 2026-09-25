import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { buildView, bundleBrowser } from "@answerable/mcp/build"
import { createTestMcp } from "@answerable/mcp/testing"
import { createE2eMcp } from "./mcp"
import { createRecordStore } from "./records"

test("Apps view creates and deletes through the real MCP client and hides ungranted writes", async () => {
  const html = await buildView({ entry: new URL("./views/records.tsx", import.meta.url).pathname, title: "Test records" })
  const hostBuild = await bundleBrowser(new URL("./testing/host.ts", import.meta.url).pathname)
  const hostJs = hostBuild[0].text
  const records = createRecordStore()
  const tenant = crypto.randomUUID()
  const mcp = await createTestMcp(auth => createE2eMcp({ auth, records, viewHtml: html }))
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/host.js") return new Response(hostJs, { headers: { "Content-Type": "text/javascript" } })
    return new Response('<!doctype html><title>Apps test host</title><iframe title="Records" sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script>', { headers: { "Content-Type": "text/html" } })
  } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true, timeout: 10_000 })
    for (const write of [true, false]) {
      const client = await mcp.connect({ organizationId: tenant, scopes: write ? ["e2e:read", "e2e:write"] : ["e2e:read"] })
      const page = await browser.newPage()
      page.setDefaultTimeout(5_000)
      try {
        const errors: string[] = []
        page.on("pageerror", error => errors.push(error.message))
        await page.exposeFunction("getInitial", async () => ({ html: ((await client.readResource({ uri: "ui://records/index.html" })).contents[0] as { text: string }).text, result: await client.callTool({ name: "records_show", arguments: {} }) }))
        await page.exposeFunction("callTool", (params: Parameters<typeof client.callTool>[0]) => client.callTool(params))
        await page.goto(host.url.href)
        const frame = page.frameLocator("iframe")
        await frame.getByText("No test records yet.").waitFor()
        if (write) {
          await frame.getByLabel("Record title").fill("Browser record")
          await frame.getByRole("button", { name: "Create record" }).click()
          await frame.getByText("Browser record", { exact: true }).waitFor()
          expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toMatchObject({ records: [{ title: "Browser record" }] })
          await frame.getByRole("button", { name: "Delete Browser record" }).click()
          await frame.getByText("No test records yet.").waitFor()
        } else {
          expect(await frame.getByLabel("Record title").count()).toBe(0)
          expect(await frame.getByRole("button", { name: "Create record" }).count()).toBe(0)
        }
        expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ records: [] })
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
