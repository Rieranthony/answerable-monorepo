// The precompiled strings must equal what React renders, so the generator and the escape function are not a second
// opinion about what an email says. Every value is hostile here: markup, a header break, a placeholder, `$&`.
import { describe, expect, test } from "bun:test"
import { hostileNames, hostileUrls } from "./fixtures"
import type { Email } from "./holes"
import { renderThroughReact } from "./react"
import { renderEmail } from "./render"

// The preheader pads itself with invisible characters up to 150, counted on the text it was rendered with: a template
// holding "{{firmName}}" and a person's firm name are different lengths, so the padding differs. Only that is normalised.
const withoutPadding = (html: string) =>
  html.replace(
    /(<div style="display:none[^>]*>[^<]*)<div>[^<]*<\/div>/,
    "$1<div></div>",
  )

async function agree(email: Email) {
  const precompiled = renderEmail(email)
  const react = await renderThroughReact(email)
  expect(precompiled.subject).toBe(react.subject)
  expect(precompiled.tag).toBe(react.tag)
  expect(precompiled.text).toBe(react.text)
  expect(withoutPadding(precompiled.html)).toBe(withoutPadding(react.html))
}

const codes = ["04817352", "00000000"]
const expiries = [1, 10, 90]

describe("renderEmail equals the React path", () => {
  for (const firmName of hostileNames) {
    for (const url of hostileUrls) {
      test(`magic-link: ${JSON.stringify(firmName).slice(0, 36)} ${url.slice(-14)}`, async () => {
        for (const code of codes) {
          for (const expiresInMinutes of expiries) {
            await agree({
              template: "magic-link",
              firmName,
              url,
              code,
              expiresInMinutes,
            })
          }
        }
      })
    }

    test(`access-removed: ${JSON.stringify(firmName).slice(0, 36)}`, async () => {
      await agree({ template: "access-removed", firmName })
    })

    test(`mailbox-code: ${JSON.stringify(firmName).slice(0, 36)}`, async () => {
      for (const code of codes) {
        for (const expiresInMinutes of expiries) {
          await agree({
            template: "mailbox-code",
            firmName,
            code,
            expiresInMinutes,
          })
        }
      }
    })
  }

  test("a long firm name: the same subject and text, and the whole name in the preheader", async () => {
    const firmName = `${"Acme Surveyors and Partners ".repeat(8)}Ltd`
    for (const email of [
      {
        template: "magic-link",
        firmName,
        url: hostileUrls[0]!,
        code: "04817352",
        expiresInMinutes: 10,
      },
      { template: "access-removed", firmName },
      {
        template: "mailbox-code",
        firmName,
        code: "04817352",
        expiresInMinutes: 10,
      },
    ] as const) {
      const precompiled = renderEmail(email)
      const react = await renderThroughReact(email)
      expect(precompiled.subject).toBe(react.subject)
      expect(precompiled.text).toBe(react.text)
      // React's preheader keeps its first 150 characters; the fill keeps the name whole. Everything else is equal.
      expect(precompiled.html).toContain(firmName)
    }
  })
})
