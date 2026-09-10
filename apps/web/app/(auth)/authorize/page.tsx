import { createMetadata } from "@/lib/metadata"
import { OAuthRequest } from "@/components/auth/oauth-request"

export const metadata = createMetadata({
  pathname: "/authorize",
  title: "Choose an organisation",
  description: "Choose the organisation for this application.",
})

export default function AuthorizePage() {
  return <OAuthRequest />
}
