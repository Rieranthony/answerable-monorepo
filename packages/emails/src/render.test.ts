import { describe, expect, test } from "bun:test"
import { holeNames, type Email } from "./holes"
import { emails, link, mailbox, removed } from "./fixtures"
import { renderEmail } from "./render"

// The invisible-padded preheader: the text before its inner div.
const preheader = (html: string) =>
  html.match(/<div style="display:none[^>]*>([^<]*)<div>/)![1]!

describe("what each email says", () => {
  test("the sign-in email", () => {
    const { subject, tag, text } = renderEmail(link)
    expect(subject).toBe("Sign in to Acme Surveyors")
    expect(tag).toBe("sign-in")
    expect(text).toMatchInlineSnapshot(`
      "Sign in to Acme Surveyors

      Use the link below to sign in.

      Sign in https://id.example.com/magic-link?token=abc123&callbackURL=%2Fhome

      On another browser or device, enter this code on the page where you started:

      04817352

      The link and the code expire in 10 minutes.

      If you did not ask to sign in, you can ignore this email: nobody can sign in without it."
    `)
  })

  test("the access-removed email", () => {
    const { subject, tag, text } = renderEmail(removed)
    expect(subject).toBe("Your access to Acme Surveyors was removed")
    expect(tag).toBe("access-removed")
    expect(text).toMatchInlineSnapshot(`
      "Your access was removed

      Someone asked to sign in to Acme Surveyors with this address. Your access has been removed, so no sign-in link was sent.

      If you think this is a mistake, ask your administrator."
    `)
  })

  test("the mailbox-code email", () => {
    const { subject, tag, text } = renderEmail(mailbox)
    expect(subject).toBe("Your code to connect your company sign-in")
    expect(tag).toBe("mailbox-code")
    expect(text).toMatchInlineSnapshot(`
      "Connect your company sign-in

      You signed in to Acme Surveyors with your company account for the first time here. To connect it to your existing account, enter this code on the page where you started.

      04817352

      The code expires in 10 minutes.

      If this was not you, tell your administrator: someone may be using your company sign-in."
    `)
  })

  test("the expiry reads in minutes", () => {
    const says = (expiresInMinutes: number) =>
      renderEmail({ ...link, expiresInMinutes }).text
    expect(says(1)).toContain("expire in 1 minute.")
    expect(says(10)).toContain("expire in 10 minutes.")
    expect(says(90)).toContain("expire in 90 minutes.")
    expect(renderEmail({ ...mailbox, expiresInMinutes: 1 }).text).toContain(
      "expires in 1 minute.",
    )
  })

  test("the plain-text part carries the whole link and the whole code", () => {
    const url =
      "https://id.example.com/m?next=%22%3E%3Cscript%3E&x='1'&y=a+b#frag"
    const { text } = renderEmail({ ...link, url })
    expect(text).toContain(` ${url}\n`)
    expect(text).toContain("\n04817352\n")
    expect(renderEmail(mailbox).text).toContain("\n04817352\n")
  })

  test("the HTML part has one button, the plain link and the code", () => {
    const { html } = renderEmail(link)
    const href =
      "https://id.example.com/magic-link?token=abc123&amp;callbackURL=%2Fhome"
    expect(html.split(`href="${href}"`)).toHaveLength(3) // the button and the plain link
    expect(html).toContain(`>${href}</a>`)
    expect(html.match(/04817352/g)).toHaveLength(1)
    expect(html).toContain("The link and the code expire in 10 minutes.")
    expect(html).toContain("nobody can sign in without it")
  })

  test("the access-removed email has no link, no code and no button", () => {
    const { html, text } = renderEmail(removed)
    expect(html).not.toMatch(/<a[\s>]/i)
    expect(html).not.toMatch(/href=|mso-padding-alt|<button/i)
    expect(html).not.toMatch(/\d{8}/)
    expect(`${html}\n${text}`.replace(/<!DOCTYPE[^>]*>/i, "")).not.toMatch(
      /https?:\/\//i,
    )
    expect(text).not.toMatch(/\d{4,}/)
  })

  test("the mailbox-code email has a code and no link", () => {
    const { html, text } = renderEmail(mailbox)
    expect(html).not.toMatch(/<a[\s>]/i)
    expect(html).not.toMatch(/href=/i)
    expect(`${html}\n${text}`.replace(/<!DOCTYPE[^>]*>/i, "")).not.toMatch(
      /https?:\/\//i,
    )
  })

  test("no email carries the brand name or a brand device", () => {
    for (const email of emails) {
      const { subject, html, text } = renderEmail(email)
      expect(`${subject}\n${html}\n${text}`).not.toMatch(/answerable/i)
    }
  })
})

describe("the preheader", () => {
  test("holds no link and no code", () => {
    for (const email of emails) {
      const line = preheader(renderEmail(email).html)
      expect(line.length).toBeGreaterThan(10)
      expect(line).not.toMatch(/https?:|\/\/|\d{4,}/)
      expect(line).not.toContain("04817352")
    }
  })
})

describe("the HTML part", () => {
  test("loads nothing and names no address but the sign-in link", () => {
    for (const email of emails) {
      const { html } = renderEmail(email)
      expect(html).not.toMatch(
        /<(img|link|script|iframe|video|audio|source|object|embed)\b/i,
      )
      expect(html).not.toMatch(/\bsrc=|@import|@font-face|url\(/i)
      const withoutDoctype = html.replace(/<!DOCTYPE[^>]*>/i, "")
      const addresses = [
        ...new Set(withoutDoctype.match(/https?:\/\/[^"'<\s]+/g)),
      ]
      expect(addresses).toEqual(
        email.template === "magic-link"
          ? [
              "https://id.example.com/magic-link?token=abc123&amp;callbackURL=%2Fhome",
            ]
          : [],
      )
    }
  })

  test("is laid out in tables and survives Outlook desktop", () => {
    const { html } = renderEmail(link)
    expect(html).toContain('role="presentation"')
    expect(html).toContain("<!--[if mso]>")
    expect(html).toContain("mso-padding-alt")
    expect(html).not.toMatch(/display:\s*(flex|grid)/)
  })

  test("is light only, in English, with a title", () => {
    const { html } = renderEmail(link)
    expect(html).toContain('<meta name="color-scheme" content="light"/>')
    expect(html).toContain(
      '<meta name="supported-color-schemes" content="light"/>',
    )
    expect(html).toContain('lang="en"')
    expect(html).toContain("<title>Sign in to Acme Surveyors</title>")
  })

  test("stays far below Gmail's clipping size", () => {
    for (const email of emails) {
      expect(Buffer.byteLength(renderEmail(email).html)).toBeLessThan(16 * 1024)
    }
  })
})

describe("a value is text, never markup, a pattern or a header", () => {
  test("a firm name is escaped in the HTML part and kept as typed in the subject and the text", () => {
    const firmName = `<script>alert("x")</script> & Sons <img src=x onerror=y>`
    for (const email of [
      { ...link, firmName },
      { ...removed, firmName },
      { ...mailbox, firmName },
    ]) {
      const { subject, html, text } = renderEmail(email)
      expect(html).not.toContain("<script")
      expect(html).not.toContain("<img")
      expect(html).toContain(
        "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Sons &lt;img src=x onerror=y&gt;",
      )
      expect(text).toContain(firmName)
      if (email.template !== "mailbox-code") expect(subject).toContain(firmName)
    }
  })

  test("an address is escaped in the attribute and the text keeps it whole", () => {
    const url = "https://id.example.com/magic?next=%22%3E%3Cscript%3E&x='1'"
    const { html, text } = renderEmail({ ...link, url })
    expect(html).not.toContain("<script")
    expect(html).toContain("&#x27;1&#x27;")
    expect(text).toContain(url)
  })

  test("a value that looks like a placeholder, or like a replacement pattern, stays literal", () => {
    const firmName = "{{url}} {{code}} $& $1 $` $'"
    const { subject, html, text } = renderEmail({ ...link, firmName })
    expect(subject).toBe(`Sign in to ${firmName}`)
    expect(html).toContain("{{url}} {{code}} $&amp; $1 $` $&#x27;")
    expect(text.split("\n")[0]).toBe(`Sign in to ${firmName}`)
    // Filled once: the real address is not substituted into the name. It appears three times: the button, the link, its text.
    expect(html.match(/token=abc123/g)).toHaveLength(3)
  })

  test("no line break, tab or control character reaches a subject", () => {
    const names: Record<string, string> = {
      "Acme\r\nBcc: x@example.com": "Acme Bcc: x@example.com",
      "Acme\n\nBcc": "Acme Bcc",
      "A\u0085B": "A B",
      "A\u2028B": "A B",
      "A\tB": "A B",
      "A\u0000B": "A B",
      "  A   B  ": "A B",
    }
    for (const [firmName, expected] of Object.entries(names)) {
      expect(renderEmail({ ...removed, firmName }).subject).toBe(
        `Your access to ${expected} was removed`,
      )
      expect(renderEmail({ ...link, firmName }).subject).toBe(
        `Sign in to ${expected}`,
      )
    }
  })
})

describe("a value that cannot be used is refused", () => {
  test("a firm name with nothing in it", () => {
    for (const firmName of ["", " ", "\r\n", " \t "]) {
      for (const email of [
        { ...link, firmName },
        { ...removed, firmName },
        { ...mailbox, firmName },
      ]) {
        expect(() => renderEmail(email)).toThrow(TypeError)
      }
    }
  })

  test("an address that is not http or https, or holds a space or a control character", () => {
    const refused = [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://id.example.com/x",
      "file:///etc/passwd",
      "not a url",
      "",
      "//id.example.com/x",
      "https://id.example.com/a b",
      "https://id.example.com/a\nb",
      "https://id.example.com/a\u0000b",
      " https://id.example.com/",
    ]
    for (const url of refused) {
      expect(() => renderEmail({ ...link, url }), JSON.stringify(url)).toThrow(
        "http or https URL",
      )
    }
    expect(
      renderEmail({ ...link, url: "http://localhost:47300/m" }).html,
    ).toContain("http://localhost:47300/m")
  })

  test("a code that is not exactly eight digits", () => {
    for (const code of [
      "",
      "1234567",
      "123456789",
      "1234567a",
      "1234 5678",
      "12345678\n",
      " 12345678",
      "１２３４５６７８",
      "1.234567",
    ]) {
      expect(
        () => renderEmail({ ...link, code }),
        JSON.stringify(code),
      ).toThrow("exactly 8 digits")
      expect(() => renderEmail({ ...mailbox, code })).toThrow(
        "exactly 8 digits",
      )
    }
    expect(renderEmail({ ...link, code: "00000000" }).text).toContain(
      "\n00000000\n",
    )
  })

  test("an expiry that is not a positive whole number of minutes", () => {
    for (const expiresInMinutes of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      2 ** 53,
      "10" as unknown as number,
    ]) {
      expect(
        () => renderEmail({ ...link, expiresInMinutes }),
        String(expiresInMinutes),
      ).toThrow("positive whole number")
      expect(() => renderEmail({ ...mailbox, expiresInMinutes })).toThrow(
        "positive whole number",
      )
    }
  })

  test("a template that does not exist", () => {
    expect(() =>
      renderEmail({ template: "constructor" } as unknown as Email),
    ).toThrow("Unknown email template")
  })

  test("the error never repeats the link or the code", () => {
    const secret =
      "https://id.example.com/magic-link?token=SECRETTOKEN and more"
    for (const email of [
      { ...link, url: secret },
      { ...link, code: "SECRETCODE" },
      { ...mailbox, code: "SECRETCODE" },
    ]) {
      try {
        renderEmail(email)
        throw new Error("not refused")
      } catch (error) {
        expect(String((error as Error).message)).not.toMatch(/SECRET|token=/)
      }
    }
  })
})

test("every template fills every hole it names", () => {
  for (const email of emails) {
    const { subject, html, text } = renderEmail(email)
    for (const part of [subject, html, text]) expect(part).not.toContain("{{")
    expect(Object.keys(holeNames)).toContain(email.template)
  }
})
