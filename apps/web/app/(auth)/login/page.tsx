import type { Metadata } from "next"

import { LoginForm } from "@/components/auth/login-form"
import { decideLoginRoute, pendingOAuthQuery } from "@/lib/auth/login-routing"

export const metadata: Metadata = { title: "Sign in · Answerable" }

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
