import { expect, test } from "bun:test"
import robots from "../app/robots"
import sitemap from "../app/sitemap"

test("only the homepage is submitted to search engines", () => {
  expect(sitemap()).toEqual([{ url: "https://www.answerable.org/" }])
})

test("crawlers can read noindex directives and fetch social previews", () => {
  expect(robots()).toEqual({
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://www.answerable.org/sitemap.xml",
  })
})
