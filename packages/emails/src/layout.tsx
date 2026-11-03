/** @jsxImportSource react */
// The pragma, not only this package's tsconfig: a consumer whose own tsconfig says another JSX runtime (Answerable ID
// says hono/jsx) type-checks and runs these files with its settings, not ours.
import { Body } from "@react-email/body"
import { Container } from "@react-email/container"
import { Head } from "@react-email/head"
import { Html } from "@react-email/html"
import { Preview } from "@react-email/preview"
import { Text } from "@react-email/text"
import type { CSSProperties, ReactNode } from "react"
import { colour, fontFamily, weight } from "./theme"

/** What the shared layout needs from a template. */
export type LayoutProps = {
  /** The `<title>`; screen readers announce it and some clients show it. */
  title: string
  /** The preheader: the grey line after the subject in an inbox list. Never a link or a code. */
  preview: string
  children: ReactNode
}

/**
 * Every template's frame: a white page, one 480px column of tables (Outlook desktop lays out with Word, not a browser:
 * it ignores `max-width`, so there the column fills the pane), system fonts and no external resource. Light only: the
 * `color-scheme` meta tells Apple Mail not to invert it.
 */
export function Layout({ title, preview, children }: LayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <title>{title}</title>
      </Head>
      <Preview>{preview}</Preview>
      <Body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: colour.background,
          color: colour.foreground,
          fontFamily,
        }}
      >
        <Container style={{ maxWidth: "480px", margin: "0 auto" }}>
          <Block style={{ padding: "32px 24px" }}>{children}</Block>
        </Container>
      </Body>
    </Html>
  )
}

/**
 * A block with its own fill, padding or rule. Outlook desktop ignores padding and borders on `<p>` and `<div>` and honours
 * them on `<td>`, so a block is a one-cell table.
 */
function Block({
  style,
  children,
}: {
  style: CSSProperties
  children: ReactNode
}) {
  return (
    <table
      role="presentation"
      width="100%"
      border={0}
      cellPadding={0}
      cellSpacing={0}
    >
      <tbody>
        <tr>
          <td style={style}>{children}</td>
        </tr>
      </tbody>
    </table>
  )
}

// Long-hand margins on the heading: Outlook desktop mis-reads the shorthand on some block elements, and the `Text`
// component expands its own the same way.
const heading = {
  margin: 0,
  marginBottom: "12px",
  fontFamily,
  fontSize: "24px",
  fontWeight: weight.label,
  lineHeight: "1.25",
  letterSpacing: "-0.3px",
  color: colour.foreground,
} as const

const paragraph = {
  margin: "0 0 16px",
  fontSize: "14px",
  lineHeight: "1.5",
  color: colour.foreground,
} as const

const small = {
  margin: 0,
  fontSize: "14px",
  lineHeight: "1.5",
  color: colour.mutedForeground,
} as const

/** The one `<h1>` of an email. */
export function Heading({ children }: { children: ReactNode }) {
  return <h1 style={heading}>{children}</h1>
}

/** A paragraph of body text. */
export function Paragraph({ children }: { children: ReactNode }) {
  return <Text style={paragraph}>{children}</Text>
}

/** Space between two tables: Outlook desktop ignores margins on them, so a fixed-height `div` stands in. */
function Spacer({ height }: { height: number }) {
  return (
    <div
      style={{
        height: `${height}px`,
        lineHeight: `${height}px`,
        fontSize: "1px",
      }}
      data-skip-in-text="true"
    >
      &nbsp;
    </div>
  )
}

/** The sentence that closes an email, under a thin rule, in secondary text. */
export function Closing({ children }: { children: ReactNode }) {
  return (
    <>
      <Spacer height={16} />
      <Block
        style={{
          paddingTop: "16px",
          borderTop: `1px solid ${colour.separator}`,
        }}
      >
        <Text style={small}>{children}</Text>
      </Block>
    </>
  )
}

/** A line of secondary text that only helps a reader with a screen: the plain-text part leaves it out. */
export function Aside({ children }: { children: ReactNode }) {
  return (
    <Text style={{ ...small, marginBottom: "12px" }} data-skip-in-text="true">
      {children}
    </Text>
  )
}

/**
 * A grey box for what a person copies: the plain link, or the code. `skipInText` leaves a box the plain-text part
 * already carries elsewhere (the link, which the button's line holds) out of it.
 */
export function Box({
  children,
  skipInText = false,
}: {
  children: ReactNode
  skipInText?: boolean
}) {
  return (
    <div data-skip-in-text={skipInText ? "true" : undefined}>
      <Block style={{ padding: "12px 16px", backgroundColor: colour.surface }}>
        {children}
      </Block>
      <Spacer height={16} />
    </div>
  )
}

/** The text inside a `Box` that holds a link: small, broken anywhere so a long address cannot widen the box. */
export const linkText = {
  ...small,
  color: colour.foreground,
  fontSize: "13px",
  wordBreak: "break-all",
} as const

/** The text inside a `Box` that holds a code: larger and spaced out so eight digits are easy to read and to copy. */
export const codeText = {
  margin: 0,
  fontSize: "24px",
  fontWeight: weight.label,
  lineHeight: "1.25",
  letterSpacing: "2px",
  fontVariantNumeric: "tabular-nums",
  color: colour.foreground,
} as const
