// What the tests render: one of each email.
import type { Email } from "./holes"

export const link = {
  template: "magic-link",
  firmName: "Acme Surveyors",
  url: "https://id.example.com/magic-link?token=abc123&callbackURL=%2Fhome",
  code: "04817352",
  expiresInMinutes: 30,
} as const satisfies Email

export const mailbox = {
  template: "mailbox-code",
  firmName: "Acme Surveyors",
  code: "04817352",
  expiresInMinutes: 30,
} as const satisfies Email

export const emails: readonly Email[] = [link, mailbox]
