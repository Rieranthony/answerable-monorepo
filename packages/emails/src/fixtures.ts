// What the tests render: one of each email, and the hostile values the equivalence test mixes.
import type { Email } from "./holes"

export const link = {
  template: "magic-link",
  firmName: "Acme Surveyors",
  url: "https://id.example.com/magic-link?token=abc123&callbackURL=%2Fhome",
  code: "04817352",
  expiresInMinutes: 10,
} as const satisfies Email

export const removed = {
  template: "access-removed",
  firmName: "Acme Surveyors",
} as const satisfies Email

export const mailbox = {
  template: "mailbox-code",
  firmName: "Acme Surveyors",
  code: "04817352",
  expiresInMinutes: 10,
} as const satisfies Email

export const emails: readonly Email[] = [link, removed, mailbox]

/** Names that would break markup, a header, a replace or a placeholder if anything let them. */
export const hostileNames = [
  "Acme Surveyors",
  `<script>alert("x")</script> & Sons <img src=x onerror=y>`,
  `O'Neill & "Partners" > Co`,
  "{{url}} {{expiry}} {{firmName}} {{code}}",
  "$& $1 $` $' \\ ${x}",
  "Zoë Müller 設計事務所 😀",
  "Acme\r\nBcc: someone@example.com",
]

/** Addresses with characters that need escaping in an attribute, and one that looks like a placeholder. */
export const hostileUrls = [
  "https://id.example.com/magic-link?token=abc&x=1",
  "https://id.example.com/m?next=%22%3E%3Cscript%3E&x='1'",
  "https://id.example.com/{{firmName}}?q=$&",
]
