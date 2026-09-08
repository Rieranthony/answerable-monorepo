import { expect, test } from "bun:test"
import { NextRequest } from "next/server"
import { proxy } from "./proxy"

test("explicit Markdown URLs use the config rewrite without renegotiation", () => {
  const request = new NextRequest("https://answerable.org/docs/id/sign-in.md", {
    headers: { Accept: "text/markdown" },
  })
  expect(proxy(request)).toBeUndefined()
})

test("HTML docs URLs negotiate Markdown and preserve query parameters", () => {
  const request = new NextRequest(
    "https://answerable.org/docs/id/sign-in?example=1",
    {
      headers: { Accept: "text/markdown" },
    },
  )
  const response = proxy(request)
  expect(response?.headers.get("x-middleware-rewrite")).toBe(
    "https://answerable.org/llms.mdx/docs/id/sign-in?example=1",
  )
  expect(response?.headers.get("vary")).toBe("Accept")
})

test("browser requests keep the HTML docs page", () => {
  expect(
    proxy(
      new NextRequest("https://answerable.org/docs/id/sign-in", {
        headers: { Accept: "text/html" },
      }),
    ),
  ).toBeUndefined()
})
