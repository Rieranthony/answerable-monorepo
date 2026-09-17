import { expect, test } from "bun:test"
import { buildView } from "./build"

test("build errors fail with an actionable message", async () => {
  await expect(buildView({ entry: "/nonexistent/answerable-view.tsx", title: "Example" })).rejects.toThrow()
})
test("browser entry bundles into standalone HTML with no external scripts", async () => {
  const html = await buildView({ entry: new URL("./testing-view.fixture.ts", import.meta.url).pathname, title: "Test <view>" })
  expect(html).toContain("Test &lt;view&gt;")
  expect(html).toContain("fixture-rendered")
  expect(html).not.toContain("<script src=")
})
