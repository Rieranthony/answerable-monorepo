/** @jsxImportSource react */
import { Closing, Heading, Layout, Paragraph } from "./layout"

/** What the access-removed email says. */
export type AccessRemovedProps = {
  /** The firm the person asked to sign in to. Plain text: the template escapes it. */
  firmName: string
}

/**
 * Sent instead of a sign-in link when someone asked to sign in with an address whose access was removed. It carries no
 * link, no code and no button, and does not say who removed the access.
 */
export function AccessRemovedEmail({ firmName }: AccessRemovedProps) {
  return (
    <Layout
      title={`Your access to ${firmName} was removed`}
      preview="No sign-in link was sent."
    >
      <Heading>Your access was removed</Heading>
      <Paragraph>
        {`Someone asked to sign in to ${firmName} with this address. Your access has been removed, so no sign-in link was sent.`}
      </Paragraph>
      <Closing>If you think this is a mistake, ask your administrator.</Closing>
    </Layout>
  )
}
