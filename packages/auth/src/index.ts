import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"

export type IdVerifierConfig = {
  issuer: string
  resource: string
  resourceInstanceId: string
  /** Explicit, trusted configuration. Never derived from an incoming token. */
  jwksUrl: string
  /** Development only: permits HTTP for loopback origins, never remote hosts. */
  allowLocalHttp?: boolean
  /** Maximum exp - iat in seconds; default 900, at most ID's 3600-second limit. */
  maxTokenLifetimeSeconds?: number
  cacheMaxAge?: number
  cooldownDuration?: number
  timeoutDuration?: number
}

export type UserPrincipal = Readonly<{
  type: "user"
  userId: string
  organizationId: string
  membershipId: string
  grantId: string
  clientId: string
  clientInstanceId: string
  resourceInstanceId: string
  scopes: readonly string[]
  expiresAt: number
  upstreamAuthTime: number | null
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
  client_instance: z.uuid(),
  resource_instance: z.uuid(),
  client_id: z.string().min(1),
  azp: z.string().min(1).optional(),
  authorization_version: z.number().int().positive(),
  organization_authorization_version: z.number().int().positive(),
  upstream_auth_time: z.number().int().nonnegative().nullable(),
  scope: z.string(),
  exp: z.number().int().positive(),
  iat: z.number().int().nonnegative(),
  // Proof-bound credentials need a separate supported verifier, not bearer acceptance.
  cnf: z.never().optional(),
})

function trustedUrl(value: string, allowLocalHttp: boolean) {
  const url = new URL(value)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    url.username || url.password || url.hash || url.search ||
    (url.protocol !== "https:" && !(allowLocalHttp && local && url.protocol === "http:"))
  ) throw new Error("ID issuer, resource and JWKS must use HTTPS (or explicitly enabled local HTTP)")
  return url
}

/** Validate resource access tokens without creating sessions or querying ID's database. */
export function createIdVerifier(config: IdVerifierConfig) {
  trustedUrl(config.issuer, config.allowLocalHttp === true)
  trustedUrl(config.resource, config.allowLocalHttp === true)
  const jwksUrl = trustedUrl(config.jwksUrl, config.allowLocalHttp === true)
  z.uuid().parse(config.resourceInstanceId)
  const maxLifetime = z.number().int().min(1).max(3600).parse(config.maxTokenLifetimeSeconds ?? 900)
  const cacheMaxAge = z.number().int().nonnegative().parse(config.cacheMaxAge ?? 300_000)
  const cooldownDuration = z.number().int().nonnegative().parse(config.cooldownDuration ?? 30_000)
  const timeoutDuration = z.number().int().positive().parse(config.timeoutDuration ?? 5_000)
  const keys = createRemoteJWKSet(jwksUrl, {
    cacheMaxAge,
    cooldownDuration,
    timeoutDuration,
  })
  return async (token: string): Promise<UserPrincipal> => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["EdDSA"],
        typ: "at+jwt",
        requiredClaims: ["exp", "iat", "sub"],
      })
      const claims = claimsSchema.parse(payload)
      if (
        claims.resource_instance !== config.resourceInstanceId ||
        (claims.azp !== undefined && claims.azp !== claims.client_id) ||
        claims.iat > Math.floor(Date.now() / 1000) ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > maxLifetime
      ) throw new AuthenticationError()
      return Object.freeze({
        type: "user",
        userId: claims.sub,
        organizationId: claims.organization_id,
        membershipId: claims.membership_id,
        grantId: claims.grant_id,
        clientId: claims.client_id,
        clientInstanceId: claims.client_instance,
        resourceInstanceId: claims.resource_instance,
        scopes: Object.freeze([...new Set(claims.scope.split(" ").filter(Boolean))]),
        expiresAt: claims.exp,
        upstreamAuthTime: claims.upstream_auth_time,
      })
    } catch {
      // Neither cryptographic details nor token contents belong in client responses.
      throw new AuthenticationError()
    }
  }
}
