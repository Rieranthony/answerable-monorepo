import { expect, spyOn, test } from "bun:test"
import type { Browser } from "@playwright/test"
import { approve } from "./browser"

test("when a page fails, approve prints what ID showed, closes the browser context and rethrows", async () => {
  const closed: string[] = []
  const page = {
    setDefaultTimeout() {},
    goto: async () => {
      throw new Error("navigation failed")
    },
    url: () => "http://127.0.0.1:47600/oauth2/error?code=access_denied",
    locator: () => ({ innerText: async () => "Access denied" }),
  }
  const browser = { newContext: async () => ({ newPage: async () => page, close: async () => void closed.push("context") }) } as unknown as Browser
  const error = spyOn(console, "error").mockImplementation(() => {})
  await expect(approve(browser, "http://127.0.0.1:47600/authorize", { callback: "http://127.0.0.1:47603/callback", scopes: [] }, { slug: "acme", email: "a@b.test", scopes: [] })).rejects.toThrow("navigation failed")
  expect(error).toHaveBeenCalledWith("[acceptance] ID page:", "/oauth2/error", "Access denied")
  expect(closed).toEqual(["context"])
  error.mockRestore()
})
