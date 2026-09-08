import { createMetadata } from "@/lib/metadata"

import { LoginForm } from "@/components/auth/login-form"
import { decideLoginRoute, pendingOAuthQuery } from "@/lib/auth/login-routing"

export const metadata = createMetadata({
  pathname: "/login",
  title: "Sign in",
  description: "Sign in to Answerable with your organisation’s account.",
})

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const query = await searchParams
  const params = new URLSearchParams()

  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(name, item)
    } else if (value !== undefined) {
      params.set(name, value)
    }
  }

  return (
    <LoginForm
      route={decideLoginRoute(params)}
      oauthQuery={pendingOAuthQuery(params)}
    />
  )
}
