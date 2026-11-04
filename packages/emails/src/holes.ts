// What an email takes and the values its holes get. It imports nothing, so the generator can run when the generated file
// is missing or broken (a merge conflict in it, say), and the React side shares these types with the runtime.

/** An email to render: the template's name and what it needs. A new template adds a member here and a row to `holeNames`. */
export type Email =
  | {
      template: "magic-link"
      /** The firm the person signs in to. Plain text: the HTML part escapes it. */
      firmName: string
      /** The one-time sign-in address, http or https. */
      url: string
      /** The eight digits for another browser or device. */
      code: string
      /** How long the link and the code work, in whole minutes, from the moment the email is sent. */
      expiresInMinutes: number
    }
  | {
      template: "mailbox-code"
      /** The firm the person signed in to. Plain text: the HTML part escapes it. */
      firmName: string
      /** The eight digits for the page where the person started. */
      code: string
      /** How long the code works, in whole minutes, from the moment the email is sent. */
      expiresInMinutes: number
    }

/** The name of a template: the `template` of an `Email`. */
export type TemplateName = Email["template"]

/** The holes of each template: the `{{name}}` words in its generated subject, HTML and text, each filled with a string. */
export const holeNames = {
  "magic-link": ["firmName", "url", "code", "expiry"],
  "mailbox-code": ["firmName", "code", "expiry"],
} as const satisfies Record<TemplateName, readonly string[]>

/** What a template component takes: one string for each of its holes. */
export type Holes<T extends TemplateName> = Record<
  (typeof holeNames)[T][number],
  string
>

// An error names no value: it ends up in a log.
const fail = (message: string): never => {
  throw new TypeError(message)
}

// A line break in a firm name would end a Subject header early and start a new one.
const firmNameOf = (value: string) =>
  value.replace(/[\p{Cc}\s]+/gu, " ").trim() ||
  fail("The firm name must not be empty")

// The caller makes the expiry itself, as it does the address and the code.
const expiryOf = (minutes: number) =>
  minutes === 1 ? "1 minute" : `${minutes} minutes`

/**
 * The values an email's holes take: a firm name on one line and never empty, which comes from a person, and an expiry as
 * words ("30 minutes", "1 minute").
 * @throws `TypeError` for a firm name with nothing in it, or a template that does not exist.
 */
export function holesOf(email: Email): Record<string, string> {
  switch (email.template) {
    case "magic-link":
      return {
        firmName: firmNameOf(email.firmName),
        url: email.url,
        code: email.code,
        expiry: expiryOf(email.expiresInMinutes),
      }
    case "mailbox-code":
      return {
        firmName: firmNameOf(email.firmName),
        code: email.code,
        expiry: expiryOf(email.expiresInMinutes),
      }
    default:
      return fail("Unknown email template")
  }
}
