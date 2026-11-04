// Writes each email's HTML and text to disk, to open in a browser or send to a test inbox:
//   bun run --filter @answerable/emails preview [directory]      (default: dist/preview)
// It renders what is sent, the generated strings, so an edit shows after a `generate`. The firm name is hostile on purpose:
// the preview shows that the escaping holds.
import { mkdir } from "node:fs/promises"
import type { Email } from "../src/holes"
import { renderEmail } from "../src/render"

const directory =
  process.argv[2] ?? new URL("../dist/preview", import.meta.url).pathname
await mkdir(directory, { recursive: true })

const firmName = "Acme Surveyors & Partners <script>"
const url =
  "https://id.example.com/magic-link?token=0123456789abcdef0123456789abcdef&callbackURL=%2Fhome"
const emails: Email[] = [
  {
    template: "magic-link",
    firmName,
    url,
    code: "04817352",
    expiresInMinutes: 30,
  },
  {
    template: "mailbox-code",
    firmName,
    code: "04817352",
    expiresInMinutes: 30,
  },
]

for (const email of emails) {
  const { subject, html, text } = renderEmail(email)
  await Bun.write(`${directory}/${email.template}.html`, html)
  await Bun.write(
    `${directory}/${email.template}.txt`,
    `Subject: ${subject}\n\n${text}\n`,
  )
  console.log(
    `${subject}\n  ${directory}/${email.template}.html (${Buffer.byteLength(html)} bytes)`,
  )
}
