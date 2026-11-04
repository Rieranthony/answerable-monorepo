/** @jsxImportSource react */
import { Button } from "@react-email/button"
import { Link } from "@react-email/link"
import { Section } from "@react-email/section"
import { Text } from "@react-email/text"
import {
  Aside,
  Box,
  Closing,
  Heading,
  Layout,
  Paragraph,
  codeText,
  linkText,
} from "./layout"
import { colour, fontFamily, weight } from "./theme"

/** What the sign-in email says. The generator fills each with a `{{name}}` hole; `renderEmail` fills it for a person. */
export type MagicLinkProps = {
  /** The firm the person signs in to. Plain text: the template escapes it. */
  firmName: string
  /** The one-time sign-in address (http or https). */
  url: string
  /** The eight digits to enter on the page where sign-in started, from another browser or device. */
  code: string
  /** How long the link and the code work, as the email says it: "30 minutes". */
  expiry: string
}

/**
 * The sign-in email: the firm, one button, the plain link to copy, and the code for another browser or device. The
 * `Aside` and the plain link's box are left out of the plain-text part, which has no button; its link comes from the
 * button's line.
 */
export function MagicLinkEmail({
  firmName,
  url,
  code,
  expiry,
}: MagicLinkProps) {
  return (
    <Layout
      title={`Sign in to ${firmName}`}
      preview={`Your sign-in link for ${firmName}. It expires in ${expiry}.`}
    >
      <Heading>{`Sign in to ${firmName}`}</Heading>
      <Paragraph>Use the link below to sign in.</Paragraph>
      <Section style={{ margin: "16px 0" }}>
        <Button
          href={url}
          style={{
            backgroundColor: colour.foreground,
            color: colour.onDark,
            fontFamily,
            fontSize: "14px",
            fontWeight: weight.label,
            lineHeight: "1",
            textDecoration: "none",
            padding: "12px 20px",
            borderRadius: 0,
          }}
        >
          Sign in
        </Button>
      </Section>
      <Aside>
        If the button does not work, copy this link into your browser:
      </Aside>
      <Box skipInText>
        <Text style={linkText}>
          <Link
            href={url}
            style={{ color: colour.foreground, textDecoration: "underline" }}
          >
            {url}
          </Link>
        </Text>
      </Box>
      <Paragraph>
        On another browser or device, enter this code on the page where you
        started:
      </Paragraph>
      <Box>
        <Text style={codeText}>{code}</Text>
      </Box>
      <Paragraph>{`The link and the code expire in ${expiry}.`}</Paragraph>
      <Paragraph>
        Never read this code to anyone. Answerable and your IT team will never
        ask for it.
      </Paragraph>
      <Closing>
        If you did not ask to sign in, you can ignore this email: nobody can
        sign in without it.
      </Closing>
    </Layout>
  )
}
