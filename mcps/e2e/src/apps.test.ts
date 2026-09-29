import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { buildView, bundleBrowser } from "@answerable/mcp/build"
import { createTestMcp } from "@answerable/mcp/testing"
import { createE2eProvider } from "./mcp"
import { createRecordStore } from "./records"

test("the Apps view creates through prepare and e2e_commit, deletes after showing the summary, and hides writes from readers", async () => {
  const html = await buildView({ entry: new URL("./views/records.tsx", import.meta.url).pathname, title: "Test records" })
  const hostBuild = await bundleBrowser(new URL("./testing/host.ts", import.meta.url).pathname)
  const hostJs = hostBuild[0].text
  const records = createRecordStore()
  const organizationId = crypto.randomUUID()
  const mcp = await createTestMcp(createE2eProvider({ records, viewHtml: html }))
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/host.js") return new Response(hostJs, { headers: { "Content-Type": "text/javascript" } })
    return new Response('<!doctype html><title>Apps test host</title><iframe title="Records" sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script>', { headers: { "Content-Type": "text/html" } })
  } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true, timeout: 10_000 })
    for (const write of [true, false]) {
      const client = await mcp.connect({ organizationId, scopes: write ? ["e2e:read", "e2e:write"] : ["e2e:read"] })
      const calls: string[] = []
      const page = await browser.newPage()
      page.setDefaultTimeout(5_000)
      try {
        const errors: string[] = []
        page.on("pageerror", error => errors.push(error.message))
        await page.exposeFunction("getInitial", async () => ({ html: ((await client.readResource({ uri: "ui://records/index.html" })).contents[0] as { text: string }).text, result: await client.callTool({ name: "records_show", arguments: {} }) }))
        await page.exposeFunction("callTool", (params: Parameters<typeof client.callTool>[0]) => {
          calls.push(params.name)
          return client.callTool(params)
        })
        await page.goto(host.url.href)
        const frame = page.frameLocator("iframe")
        if (write) {
          await frame.getByText("No test records yet.").waitFor()
          await frame.getByLabel("Record title").fill("Browser record")
          await frame.getByRole("button", { name: "Create record" }).click()
          await frame.getByText("Browser record", { exact: true }).waitFor()
          expect(calls).toEqual(["records_create", "e2e_commit", "records_list"])
          expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toMatchObject({ items: [{ title: "Browser record", version: 1 }] })
          await frame.getByRole("button", { name: "Delete Browser record" }).click()
          await frame.getByText("Delete record “Browser record”").waitFor()
          expect(calls.slice(3)).toEqual(["records_delete"])
          expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toMatchObject({ items: [{ title: "Browser record" }] })
          await frame.getByRole("button", { name: "Cancel" }).click()
          await frame.getByRole("button", { name: "Delete Browser record" }).click()
          await frame.getByRole("button", { name: "Confirm" }).click()
          await frame.getByText("No test records yet.").waitFor()
          expect(calls.slice(4)).toEqual(["records_delete", "e2e_commit_confirmed", "records_list"])
        } else {
          await frame.getByText("No test records yet.").waitFor()
          expect(await frame.getByLabel("Record title").count()).toBe(0)
          expect(await frame.getByRole("button").count()).toBe(0)
        }
        expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ items: [], next_cursor: null, has_more: false })
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
