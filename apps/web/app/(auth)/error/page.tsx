import { createMetadata } from "@/lib/metadata"
import Link from "next/link"

import { describeError } from "@/lib/auth/error-copy"

export const metadata = createMetadata({
  pathname: "/error",
  title: "Can't sign in",
  description: "Get help signing in to your Answerable account.",
})

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function SignInErrorPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const query = await searchParams
  const code = first(query.error) ?? null
  const details = first(query.error_description)
  const description = describeError(code)

  return (
    <section aria-labelledby="error-heading">
      {/* SSO redirects to the bare errorCallbackURL, so the signed OAuth query
          is unavailable here. Keep the recovery link deliberately plain. */}
      <h1 id="error-heading" className="text-xl/6 font-bold">
        {description.title}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm/6">{description.body}</p>
      {details && (
        <p className="bg-muted mt-4 px-2 py-2 text-sm/6 break-words whitespace-pre-wrap">
          {details}
        </p>
      )}
      <Link
        href="/login"
        className="mt-8 inline-block text-sm/6 underline underline-offset-4"
      >
        Try another email
      </Link>
    </section>
  )
}
