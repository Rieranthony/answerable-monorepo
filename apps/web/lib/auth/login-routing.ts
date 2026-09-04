export type LoginRoute =
  { mode: "auto"; organizationSlug: string } | { mode: "form"; email?: string }

const ORGANIZATION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function decideLoginRoute(params: URLSearchParams): LoginRoute {
  const organizationSlug = params.get("organization")
  const loginHint = params.get("login_hint")

  if (
    organizationSlug !== null &&
    ORGANIZATION_SLUG.test(organizationSlug) &&
    !params.has("login_hint")
  ) {
    return { mode: "auto", organizationSlug }
  }

  if (loginHint !== null && EMAIL_ADDRESS.test(loginHint)) {
    return { mode: "form", email: loginHint }
  }

  return { mode: "form" }
}

export function pendingOAuthQuery(params: URLSearchParams): string | null {
  if (!params.has("client_id") || !params.has("sig")) return null
  return params.toString()
}
