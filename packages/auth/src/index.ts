import { createRemoteJWKSet, customFetch, jwtVerify } from "jose"
import { z } from "zod"

export type IdVerifierConfig = {
  /** Trusted Answerable ID issuer, for example https://id.answerable.org. */
  issuer: string
  /** This service's canonical resource URL as registered in ID; the token audience must contain it. */
  resource: string
  /** HTTP client for discovery and key requests. Default: the global fetch. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export type UserPrincipal = Readonly<{
  userId: string
  organizationId: string
  membershipId: string
  grantId: string
  clientId: string
  scopes: readonly string[]
  expiresAt: number
}>

export class AuthenticationError extends Error {
  constructor() {
    super("A valid Answerable ID user access token is required")
    this.name = "AuthenticationError"
  }
}

const claimsSchema = z.object({
  sub: z.uuid(),
  subject_type: z.literal("user"),
  organization_id: z.uuid(),
  membership_id: z.uuid(),
  grant_id: z.uuid(),
  client_id: z.string().min(1),
  azp: z.string().optional(),
  scope: z.string(),
  exp: z.number().int().positive(),
  cnf: z.never().optional(),
})

function trustedUrl(value: string, name: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${name} must be a valid URL`) }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`)
  if (value.includes("?")) throw new Error(`${name} must not contain a query string`)
  if (value.includes("#")) throw new Error(`${name} must not contain a fragment`)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS or loopback HTTP`)
  }
  return url
}

export function createIdVerifier(config: IdVerifierConfig): (token: string) => Promise<UserPrincipal> {
  const { issuer, resource } = config
  const fetcher = config.fetch ?? ((input, init) => fetch(input, init))
  const issuerUrl = trustedUrl(issuer, "issuer")
  trustedUrl(resource, "resource")
  let discovery: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined
  async function discover() {
    const metadataUrl = new URL(issuerUrl)
    metadataUrl.pathname = `/.well-known/oauth-authorization-server${issuerUrl.pathname === "/" ? "" : issuerUrl.pathname}`
    const response = await fetcher(metadataUrl, { signal: AbortSignal.timeout(5000), redirect: "error" })
    if (!response.ok) throw new Error("ID discovery failed")
    const metadata = z.object({ issuer: z.literal(issuer), jwks_uri: z.string() }).parse(await response.json())
    const jwksUrl = trustedUrl(metadata.jwks_uri, "jwks_uri")
    if (jwksUrl.origin !== issuerUrl.origin) throw new Error("jwks_uri must share the issuer origin")
    return createRemoteJWKSet(jwksUrl, { [customFetch]: fetcher })
  }
  return async token => {
    try {
      discovery ??= discover().catch(error => {
        discovery = undefined
        throw error
      })
      const { payload } = await jwtVerify(token, await discovery, {
        issuer, audience: resource, algorithms: ["EdDSA", "ES256", "RS256"],
        typ: "at+jwt", requiredClaims: ["exp", "iat", "sub"],
      })
      const claims = claimsSchema.parse(payload)
      if (claims.azp !== undefined && claims.azp !== claims.client_id) throw new AuthenticationError()
      return Object.freeze({
        userId: claims.sub,
        organizationId: claims.organization_id,
        membershipId: claims.membership_id,
        grantId: claims.grant_id,
        clientId: claims.client_id,
        scopes: Object.freeze([...new Set(claims.scope.split(" ").filter(Boolean))]),
        expiresAt: claims.exp,
      })
    } catch {
      throw new AuthenticationError()
    }
  }
}
