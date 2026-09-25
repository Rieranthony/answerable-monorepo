import { decodeJwt, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type JWK } from "jose"

export type TestIssuer = {
  issuer: string
  sign(options: {
    resource: string
    scopes?: readonly string[]
    organizationId?: string
    userId?: string
    expiresIn?: string | number
    claims?: Record<string, unknown>
    header?: Record<string, unknown>
  }): Promise<string>
  rotate(): Promise<void>
  outage(unavailable: boolean): void
  jwksRequests(): number
  stop(): void
}

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
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname
      if (path === "/jwks") requests++
      if (unavailable) return new Response("Unavailable", { status: 503 })
      if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") {
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks` })
      }
      if (request.method === "GET" && path === "/jwks") return Response.json({ keys })
      return new Response("Not found", { status: 404 })
    },
  })
  const issuer = server.url.origin
  return {
    issuer,
    async sign(options) {
      const token = new UnsecuredJWT({
        iss: issuer, aud: options.resource, sub: options.userId ?? crypto.randomUUID(),
        subject_type: "user", organization_id: options.organizationId ?? crypto.randomUUID(),
        membership_id: crypto.randomUUID(), grant_id: crypto.randomUUID(),
        client_id: "test-client", scope: (options.scopes ?? []).join(" "),
      }).setIssuedAt().setExpirationTime(options.expiresIn ?? "5m")
      const payload = { ...decodeJwt(token.encode()), ...options.claims }
      for (const name of Object.keys(payload)) if (payload[name] === undefined) delete payload[name]
      return new SignJWT(payload).setProtectedHeader({ alg, kid, typ: "at+jwt", ...options.header }).sign(signingKey)
    },
    rotate,
    outage(value) { unavailable = value },
    jwksRequests: () => requests,
    stop() { server.stop(true) },
  }
}
