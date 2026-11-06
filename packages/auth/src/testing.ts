import { decodeJwt, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type JWK } from "jose"

/** A local Answerable ID issuer for tests: it publishes keys and signs tokens, and listens on no port. */
export type TestIssuer = {
  /** The issuer URL to trust: `https://id.test`. */
  issuer: string
  /**
   * Sign an access token for `resource`, with ID's user claims: `upstream_auth_time` is the signing time and `authentication_method` is `directory`, as for a person who has just signed in at their directory.
   * `groups` is the organisation's id followed by `groups`, as ID gives it.
   * `claims` replace the token's claims (an `undefined` value removes one) and `header` its header, to make unusual tokens.
   */
  sign(options: {
    resource: string
    scopes?: readonly string[]
    organizationId?: string
    userId?: string
    /** The ids of the person's groups, after the organisation's id. Default: none. */
    groups?: readonly string[]
    /** Lifetime as a duration string such as `"5m"` or as seconds. Default `"5m"`. */
    expiresIn?: string | number
    claims?: Record<string, unknown>
    header?: Record<string, unknown>
  }): Promise<string>
  /** Publish a new signing key and sign with it from now on; the old key stays published. */
  rotate(): Promise<void>
  /** Make discovery and key requests answer `503` while `unavailable` is true. */
  outage(unavailable: boolean): void
  /** How many times the keys were requested. */
  jwksRequests(): number
  /** Answers the issuer's discovery and key requests: pass it as the verifier's `fetch`. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

/**
 * Create a `TestIssuer` that signs tokens the way Answerable ID does, with a fresh key pair (EdDSA unless `algorithm` says otherwise).
 *
 * @example
 * ```ts
 * import { createIdVerifier } from "@answerable/auth"
 * import { createTestIssuer } from "@answerable/auth/testing"
 *
 * const issuer = await createTestIssuer()
 * const verify = createIdVerifier({ issuer: issuer.issuer, resource: "https://example.test/mcp", fetch: issuer.fetch })
 * const principal = await verify(await issuer.sign({ resource: "https://example.test/mcp", scopes: ["example:read"] }))
 * ```
 */
export async function createTestIssuer(options: { algorithm?: "EdDSA" | "ES256" | "RS256" } = {}): Promise<TestIssuer> {
  const alg = options.algorithm ?? "EdDSA"
  const keys: JWK[] = []
  let signingKey: CryptoKey
  let kid: string
  let unavailable = false
  let requests = 0
  async function rotate() {
    const pair = await generateKeyPair(alg)
    kid = crypto.randomUUID()
    signingKey = pair.privateKey
    keys.push({ ...await exportJWK(pair.publicKey), kid, alg })
  }
  await rotate()
  const issuer = "https://id.test"
  return {
    issuer,
    async fetch(input, init) {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const url = new URL(request.url)
      if (url.origin !== new URL(issuer).origin) return new Response("Not found", { status: 404 })
      const path = url.pathname
      if (path === "/jwks") requests++
      if (unavailable) return new Response("Unavailable", { status: 503 })
      if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") {
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks` })
      }
      if (request.method === "GET" && path === "/jwks") return Response.json({ keys })
      return new Response("Not found", { status: 404 })
    },
    async sign(options) {
      const now = Math.floor(Date.now() / 1000)
      const organizationId = options.organizationId ?? crypto.randomUUID()
      const token = new UnsecuredJWT({
        iss: issuer, aud: options.resource, sub: options.userId ?? crypto.randomUUID(),
        subject_type: "user", organization_id: organizationId, groups: [organizationId, ...(options.groups ?? [])],
        membership_id: crypto.randomUUID(), organization_authorization_version: 1, grant_id: crypto.randomUUID(),
        client_id: "test-client", scope: (options.scopes ?? []).join(" "), upstream_auth_time: now, authentication_method: "directory",
      }).setIssuedAt(now).setExpirationTime(options.expiresIn ?? "5m")
      const payload = { ...decodeJwt(token.encode()), ...options.claims }
      for (const name of Object.keys(payload)) if (payload[name] === undefined) delete payload[name]
      return new SignJWT(payload).setProtectedHeader({ alg, kid, typ: "at+jwt", ...options.header }).sign(signingKey)
    },
    rotate,
    outage(value) { unavailable = value },
    jwksRequests: () => requests,
  }
}
