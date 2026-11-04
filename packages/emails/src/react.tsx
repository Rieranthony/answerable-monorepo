/** @jsxImportSource react */
// The React side: dev-time only, so it is not in package.json's exports and index.ts never reaches it. The generator
// renders each template here once, with a `{{hole}}` for every value.
import { render, toPlainText } from "@react-email/render"
import { createElement, type ReactElement } from "react"
import { MagicLinkEmail } from "./magic-link"
import { MailboxCodeEmail } from "./mailbox-code"
import { holeNames, type Holes, type TemplateName } from "./holes"
import type { RenderedEmail } from "./render"

type Entry<T extends TemplateName> = {
  /** Postmark's `Tag` for the template: its category, never a link, a code or an address. */
  tag: string
  subject: (holes: Holes<T>) => string
  Component: (holes: Holes<T>) => ReactElement
}

const templates: { [T in TemplateName]: Entry<T> } = {
  "magic-link": {
    tag: "sign-in",
    subject: ({ firmName }) => `Sign in to ${firmName}`,
    Component: MagicLinkEmail,
  },
  "mailbox-code": {
    tag: "mailbox-code",
    subject: () => "Your code to connect your company sign-in",
    Component: MailboxCodeEmail,
  },
}

const templateNames = Object.keys(holeNames) as TemplateName[]

/** Renders a template through React, with `{{hole}}` placeholders for its values. */
async function renderTemplate(
  template: TemplateName,
  holes: Record<string, string>,
): Promise<RenderedEmail> {
  // One cast for the whole table: TypeScript cannot pair a name with its own holes across a union. The generator's output
  // would show a hole a template did not use.
  const { tag, subject, Component } = templates[
    template
  ] as unknown as Entry<TemplateName>
  const values = holes as Holes<TemplateName>
  const html = await render(createElement(Component, values))
  return {
    subject: subject(values),
    html,
    // html-to-text upper-cases an <h1> by default, which would shout a firm's name.
    text: toPlainText(html, {
      selectors: [{ selector: "h1", options: { uppercase: false } }],
    }),
    tag,
  }
}

// Every non-ASCII character as a \u escape: the preheader's padding is invisible characters, and a reader of the
// generated file should see them.
const literal = (value: string) =>
  JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )

/** The text of `src/generated/templates.generated.ts`: every template rendered once, with a `{{hole}}` for each value. */
export async function generateModule(): Promise<string> {
  const rendered: string[] = []
  for (const name of templateNames) {
    const holes = Object.fromEntries(
      holeNames[name].map((hole) => [hole, `{{${hole}}}`]),
    )
    const { subject, tag, html, text } = await renderTemplate(name, holes)
    rendered.push(
      [
        `  ${literal(name)}: {`,
        `    subject: ${literal(subject)},`,
        `    tag: ${literal(tag)},`,
        `    html: ${literal(html)},`,
        `    text: ${literal(text)},`,
        "  },",
      ].join("\n"),
    )
  }
  return [
    "// Written by scripts/generate.ts from the React templates: bun run --filter @answerable/emails generate. Never edit it by hand.",
    "// {{name}} marks a hole that renderEmail fills (src/render.ts).",
    "",
    "/** Each template, rendered once with a `{{hole}}` for every value. */",
    `export const templates: Record<${templateNames.map(literal).join(" | ")}, { subject: string; tag: string; html: string; text: string }> = {`,
    ...rendered,
    "}",
    "",
  ].join("\n")
}
