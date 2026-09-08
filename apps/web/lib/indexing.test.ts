import { expect, test } from "bun:test"
import robots from "../app/robots"
import sitemap from "../app/sitemap"

test("only the homepage is submitted to search engines", () => {
  expect(sitemap()).toEqual([{ url: "https://answerable.org/" }])
})

test("crawlers can read noindex directives and fetch social previews", () => {
  expect(robots()).toEqual({
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://answerable.org/sitemap.xml",
  })
})
