// The runtime: fills the strings scripts/generate.ts wrote from the React templates. It imports no React, so a service that
// sends mail bundles a few kilobytes of strings, not a renderer (src/react.tsx is the React side, for the generator, the
// preview and the tests).
import { templates } from "./generated/templates.generated"
import { holesOf, holeNames, type Email } from "./holes"

/** What a mail sender takes: the subject, the two parts and the tag the sender files the message under. */
export type RenderedEmail = {
  /** One line: no line break can reach a header. */
  subject: string
  html: string
  /** The same words as the HTML part, with every link written out. */
  text: string
  /** The sender's category for the message (Postmark's `Tag`). Never a link, a code or an address. */
  tag: string
}

// The same five characters React escapes, in the same spelling, so the two renderers agree byte for byte
// (equivalence.test.ts compares them on hostile input).
const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
}
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => entities[character]!)

const unescaped = (value: string) => value

// One pass over a template: a value that itself reads "{{url}}" is never scanned again, and the function replacer means
// "$&" and "$1" in a value are literal. Only this template's own hole names match.
const patterns = Object.fromEntries(
  Object.entries(holeNames).map(([name, holes]) => [
    name,
    new RegExp(`\\{\\{(${holes.join("|")})\\}\\}`, "g"),
  ]),
)

function fill(
  source: string,
  template: string,
  holes: Record<string, string>,
  escape: (value: string) => string,
) {
  return source.replace(patterns[template]!, (_, name: string) =>
    escape(holes[name]!),
  )
}

/**
 * Renders an email for sending: the subject, the HTML part, the plain-text part and the tag. The HTML part escapes every
 * value; the subject and the text part, which are not markup, carry them as given.
 * @throws `TypeError` when a value is refused (see `holesOf`) or the template is unknown.
 */
export function renderEmail(email: Email): RenderedEmail {
  const holes = holesOf(email)
  const { template } = email
  const source = templates[template]
  return {
    subject: fill(source.subject, template, holes, unescaped),
    html: fill(source.html, template, holes, escapeHtml),
    text: fill(source.text, template, holes, unescaped),
    tag: source.tag,
  }
}
