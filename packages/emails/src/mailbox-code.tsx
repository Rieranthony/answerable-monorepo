/** @jsxImportSource react */
import { Text } from "@react-email/text"
import { Box, Closing, Heading, Layout, Paragraph, codeText } from "./layout"

/** What the mailbox-code email says. */
export type MailboxCodeProps = {
  /** The firm the person signed in to. Plain text: the template escapes it. */
  firmName: string
  /** The eight digits to enter on the page where the person started. */
  code: string
  /** How long the code works, as the email says it: "10 minutes". */
  expiry: string
}

/**
 * Sent to prove a mailbox when a person first signs in to a firm with their company account and already has an account
 * here: the code connects the two. It carries a code and no link.
 */
export function MailboxCodeEmail({ firmName, code, expiry }: MailboxCodeProps) {
  return (
    <Layout
      title="Your code to connect your company sign-in"
      preview={`Connect your company sign-in for ${firmName}. The code expires in ${expiry}.`}
    >
      <Heading>Connect your company sign-in</Heading>
      <Paragraph>
        {`You signed in to ${firmName} with your company account for the first time here. To connect it to your existing account, enter this code on the page where you started.`}
      </Paragraph>
      <Box>
        <Text style={codeText}>{code}</Text>
      </Box>
      <Paragraph>{`The code expires in ${expiry}.`}</Paragraph>
      <Closing>
        If this was not you, tell your administrator: someone may be using your
        company sign-in.
      </Closing>
    </Layout>
  )
}
