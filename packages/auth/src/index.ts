import { createRemoteJWKSet, customFetch, jwtVerify } from "jose"
import { z } from "zod"

/** The issuer and resource a verifier trusts, the kind of token it accepts and the HTTP client it uses for discovery. */
export type IdVerifierConfig<Kind extends "user" | "client" = "user"> = {
  /** Trusted Answerable ID issuer, for example https://id.answerable.org. */
  issuer: string
  /** This service's canonical resource URL as registered in ID; the token audience must contain it. */
  resource: string
  /** HTTP client for discovery and key requests. Default: the global fetch. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /** The kind of token to accept: `user`, a person's, which gives a `UserPrincipal`, or `client`, a machine client's `client_credentials` token, which gives a `MachinePrincipal`. Default: `user`. */
  subjectType?: Kind
}

/** The caller a verified access token names. Constrain every query by `organizationId`. */
export type UserPrincipal = Readonly<{
  /** The person's global Answerable ID user id, the token's `sub`: the only id to join on. */
  userId: string
  /** The organisation the person signed in to and chose for this token. */
  organizationId: string
  /** The person's membership in `organizationId`. */
  membershipId: string
  /** The authorisation this token was issued under; a refreshed token keeps it. */
  grantId: string
  /** The OAuth client that asked for the token. */
  clientId: string
  /** The scopes ID issued: the entitled subset of the ones requested. */
  scopes: readonly string[]
  /** Expiry, in seconds since the epoch. */
  expiresAt: number
  /** The organisation's authorisation version when the token was issued; ID advances it when it disables the organisation. */
  organizationAuthorizationVersion: number
}>

/** The machine client a verified `client_credentials` token names. Constrain every query by `organizationId`. */
export type MachinePrincipal = Readonly<{
  /** The OAuth client that asked for the token, which is also the token's subject. */
  clientId: string
  /** The organisation that owns the client. */
  organizationId: string
  /** The scopes ID issued: the client's allowed subset of the ones requested. */
  scopes: readonly string[]
  /** Expiry, in seconds since the epoch. */
  expiresAt: number
  /** The client's authorisation version when the token was issued; ID advances it when the client's authority changes. */
  authorizationVersion: number
  /** The owning organisation's authorisation version when the token was issued; ID advances it when it disables the organisation. */
  organizationAuthorizationVersion: number
}>

/** Thrown for every rejected token, always with the same message so that it reveals nothing; answer it with a `401` challenge. */
export class AuthenticationError extends Error {
  constructor() {
    super("A valid Answerable ID access token is required")
    this.name = "AuthenticationError"
  }
}

const version = z.number().int().positive()
const shared = z.object({
  organization_id: z.uuid(),
  organization_authorization_version: version,
  client_id: z.string().min(1),
  azp: z.string().optional(),
  scope: z.string(),
  exp: z.number().int().positive(),
  cnf: z.never().optional(),
})
const claimsOf = {
  user: shared.extend({ subject_type: z.literal("user"), sub: z.uuid(), membership_id: z.uuid(), grant_id: z.uuid() }),
  // A machine client is its own subject.
  client: shared.extend({ subject_type: z.literal("client"), sub: z.string().min(1), authorization_version: version }).refine(claims => claims.sub === claims.client_id),
}

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

/**
 * Create a function that verifies an Answerable ID access token against the issuer's published keys, offline, and returns its caller.
 * The keys are read from the issuer's metadata on first use; every failure throws `AuthenticationError`.
 * It accepts a person's token, or with `subjectType: "client"` a machine client's instead.
 *
 * @example
 * ```ts
 * import { createIdVerifier } from "@answerable/auth"
 *
 * const verify = createIdVerifier({ issuer: "https://id.answerable.org", resource: "https://example.answerable.org/mcp" })
 * const principal = await verify(accessToken)
 * ```
 */
export function createIdVerifier<Kind extends "user" | "client" = "user">(config: IdVerifierConfig<Kind>): (token: string) => Promise<Kind extends "client" ? MachinePrincipal : UserPrincipal> {
  const { issuer, resource } = config
  const claimsSchema = claimsOf[config.subjectType ?? "user"]
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
      const common = {
        organizationId: claims.organization_id,
        clientId: claims.client_id,
        scopes: Object.freeze([...new Set(claims.scope.split(" ").filter(Boolean))]),
        expiresAt: claims.exp,
        organizationAuthorizationVersion: claims.organization_authorization_version,
      }
      return Object.freeze(claims.subject_type === "user"
        ? { userId: claims.sub, membershipId: claims.membership_id, grantId: claims.grant_id, ...common }
        : { authorizationVersion: claims.authorization_version, ...common }) as Kind extends "client" ? MachinePrincipal : UserPrincipal
    } catch {
      throw new AuthenticationError()
    }
  }
}
