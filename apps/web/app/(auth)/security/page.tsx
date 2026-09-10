import { SecurityForm } from "@/components/auth/security-form"
import { createMetadata } from "@/lib/metadata"

export const metadata = createMetadata({
  pathname: "/security",
  title: "Account security",
  description:
    "Verify your sign-in or connect another work account to Answerable.",
})

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const query = await searchParams
  return (
    <SecurityForm
      error={typeof query.error === "string" ? query.error : null}
    />
  )
}
