import { createMetadata } from "@/lib/metadata"
import { ConsentForm } from "@/components/auth/consent-form"

export const metadata = createMetadata({
  pathname: "/consent",
  title: "Allow access",
  description: "Review and approve access to your Answerable account.",
})

export default function ConsentPage() {
  return <ConsentForm />
}
