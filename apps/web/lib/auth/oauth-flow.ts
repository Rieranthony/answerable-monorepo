import { authClient } from "./client"

export type OAuthFlow = {
  client: { clientId: string; name: string | null; uri: string | null }
  resource: { identifier: string; name: string } | null
  scopes: string[]
  memberships: {
    memberId: string
    organizationId: string
    name: string
    slug: string
    authenticated: boolean
  }[]
  selectedMemberId: string | null
  status: "selection" | "consent"
}

export async function loadOAuthFlow() {
  const response = await authClient.$fetch<OAuthFlow>("/oauth2/flow", {
    method: "POST",
    body: { oauth_query: window.location.search.slice(1) },
  })
  if (response.error || !response.data)
    throw new Error(
      "This request has expired or is unavailable. Start again from the application.",
    )
  return response.data
}

export async function continueOAuthFlow(memberId: string) {
  const response = await authClient.$fetch<{ url: string }>(
    "/oauth2/continue",
    {
      method: "POST",
      body: {
        oauth_query: window.location.search.slice(1),
        postLogin: true,
        memberId,
      },
    },
  )
  if (response.error || !response.data?.url)
    throw new Error(
      "Access is unavailable for this organisation. Sign in again or ask its administrator to check your access.",
    )
  window.location.assign(response.data.url)
}

export async function decideOAuthConsent(accept: boolean) {
  const response = await authClient.$fetch<{ url: string }>("/oauth2/consent", {
    method: "POST",
    body: { oauth_query: window.location.search.slice(1), accept },
  })
  if (response.error || !response.data?.url)
    throw new Error(
      "Your choice could not be recorded. Try again, or start a new request from the application.",
    )
  window.location.assign(response.data.url)
}
