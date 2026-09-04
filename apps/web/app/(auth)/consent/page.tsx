import type { Metadata } from "next"

import { ConsentForm } from "@/components/auth/consent-form"

export const metadata: Metadata = { title: "Allow access · Answerable" }

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const query = await searchParams
  const clientId = first(query.client_id) ?? "Unknown client"
  const scope = first(query.scope)
  const claims = first(query.claims)
  // Claims remain in the signed browser query for the OAuth client plugin.
  void claims

  return (
    <ConsentForm
      clientId={clientId}
      clientName={first(query.client_name)}
      clientUri={first(query.client_uri)}
      scope={scope}
    />
  )
}
