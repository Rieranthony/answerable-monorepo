import { afterEach, expect, spyOn, test } from "bun:test"
import { AuthenticationError, createIdVerifier } from "./index"
import { createTestIssuer, type TestIssuer } from "./testing"

const resource = "https://mcp.test/mcp"
const issuers: TestIssuer[] = []
afterEach(() => { for (const issuer of issuers.splice(0)) issuer.stop() })
async function fixture(algorithm?: "EdDSA" | "ES256" | "RS256") {
  const issuer = await createTestIssuer({ algorithm })
  issuers.push(issuer)
  return { ...issuer, verify: createIdVerifier({ issuer: issuer.issuer, resource }) }
}

test("valid tokens return only a frozen principal and de-duplicated scopes", async () => {
  const issuer = await fixture()
  const userId = crypto.randomUUID()
  const organizationId = crypto.randomUUID()
  const principal = await issuer.verify(await issuer.sign({ resource, userId, organizationId, scopes: ["read", "write", "read"] }))
  expect(principal).toEqual({ userId, organizationId, membershipId: expect.any(String), grantId: expect.any(String), clientId: "test-client", scopes: ["read", "write"], expiresAt: expect.any(Number) })
  expect(Object.isFrozen(principal)).toBe(true)
  expect(Object.isFrozen(principal.scopes)).toBe(true)
})
for (const algorithm of ["ES256", "RS256"] as const) {
  test(`accepts ${algorithm}`, async () => {
    const issuer = await fixture(algorithm)
    expect((await issuer.verify(await issuer.sign({ resource }))).clientId).toBe("test-client")
  })
}
const invalidClaims: [string, Record<string, unknown>][] = [
  ["issuer", { iss: "https://wrong.test" }], ["audience", { aud: "https://wrong.test/mcp" }],
  ["expired", { exp: 1 }], ["future nbf", { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ["missing exp", { exp: undefined }], ["missing iat", { iat: undefined }],
  ["client subject", { subject_type: "client" }], ["missing membership", { membership_id: undefined }],
  ["non-UUID subject", { sub: "not-a-uuid" }], ["different azp", { azp: "another-client" }],
  ["non-string scope", { scope: ["read"] }], ["proof-bound token", { cnf: { jkt: "key" } }],
]
for (const [name, claims] of invalidClaims) {
  test(`rejects ${name} with a safe authentication error`, async () => {
    const issuer = await fixture()
    await expect(issuer.verify(await issuer.sign({ resource, claims }))).rejects.toThrow(new AuthenticationError())
  })
}
test("rejects the wrong type, an unpublished signature and opaque tokens", async () => {
  const issuer = await fixture()
  const other = await fixture()
  for (const token of [await issuer.sign({ resource, header: { typ: "JWT" } }), await other.sign({ resource, claims: { iss: issuer.issuer } }), "opaque"]) {
    await expect(issuer.verify(token)).rejects.toBeInstanceOf(AuthenticationError)
  }
})
test("does not require resource pins or cap the token lifetime", async () => {
  const issuer = await fixture()
  expect((await issuer.verify(await issuer.sign({ resource, expiresIn: "2h", claims: { azp: "test-client", resource_instance: "ignored" } }))).scopes).toEqual([])
})
test("concurrent verification fetches JWKS once", async () => {
  const issuer = await fixture()
  const token = await issuer.sign({ resource })
  await Promise.all(Array.from({ length: 10 }, () => issuer.verify(token)))
  expect(issuer.jwksRequests()).toBe(1)
})
test("picks up a rotated key after the default JOSE cooldown", async () => {
  const issuer = await fixture()
  await issuer.verify(await issuer.sign({ resource }))
  await issuer.rotate()
  const token = await issuer.sign({ resource })
  const now = Date.now()
  const clock = spyOn(Date, "now").mockReturnValue(now + 31_000)
  try {
    await issuer.verify(token)
    expect(issuer.jwksRequests()).toBe(2)
  } finally { clock.mockRestore() }
})
test("cached keys survive an outage, but unseen keys fail", async () => {
  const issuer = await fixture()
  const known = await issuer.sign({ resource })
  await issuer.verify(known)
  await issuer.rotate()
  const unknown = await issuer.sign({ resource })
  issuer.outage(true)
  await issuer.verify(known)
  const now = Date.now()
  const clock = spyOn(Date, "now").mockReturnValue(now + 31_000)
  try { await expect(issuer.verify(unknown)).rejects.toBeInstanceOf(AuthenticationError) } finally { clock.mockRestore() }
})
test("failed discovery is retried", async () => {
  const issuer = await fixture()
  const token = await issuer.sign({ resource })
  issuer.outage(true)
  await expect(issuer.verify(token)).rejects.toBeInstanceOf(AuthenticationError)
  issuer.outage(false)
  await issuer.verify(token)
})
for (const mismatch of ["issuer", "origin"]) {
  test(`discovery rejects a different ${mismatch}`, async () => {
    const signer = await fixture()
    let keyRequests = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
      if (new URL(request.url).pathname === "/jwks") keyRequests++
      return Response.json({ issuer: mismatch === "issuer" ? signer.issuer : server.url.origin, jwks_uri: mismatch === "origin" ? `${signer.issuer}/jwks` : new URL("/jwks", server.url).href })
    } })
    try {
      const verify = createIdVerifier({ issuer: server.url.origin, resource })
      await expect(verify(await signer.sign({ resource, claims: { iss: server.url.origin } }))).rejects.toBeInstanceOf(AuthenticationError)
      expect(keyRequests).toBe(0)
      expect(signer.jwksRequests()).toBe(0)
    } finally { server.stop(true) }
  })
}
test("discovery inserts the well-known path before an issuer path", async () => {
  const signer = await fixture()
  const paths: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname
    paths.push(path)
    if (path === "/.well-known/oauth-authorization-server/tenant") return Response.json({ issuer: `${server.url.origin}/tenant`, jwks_uri: new URL("/jwks", server.url).href })
    return fetch(`${signer.issuer}/jwks`)
  } })
  try {
    const issuer = `${server.url.origin}/tenant`
    await createIdVerifier({ issuer, resource })(await signer.sign({ resource, claims: { iss: issuer } }))
    expect(paths).toEqual(["/.well-known/oauth-authorization-server/tenant", "/jwks"])
  } finally { server.stop(true) }
})
for (const field of ["issuer", "resource"] as const) {
  for (const [url, rule] of [["http://evil.test", "HTTPS"], ["https://user:password@id.test", "credentials"], ["https://id.test?x=1", "query"], ["https://id.test#x", "fragment"], ["invalid", "valid URL"]]) {
    test(`${field} rejects ${rule}`, () => {
      expect(() => createIdVerifier({ issuer: "https://id.test", resource, [field]: url })).toThrow(rule)
    })
  }
}
test("loopback HTTP needs no opt-in and construction performs no discovery", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    expect(createIdVerifier({ issuer: `http://${host}`, resource: `http://${host}/mcp` })).toBeFunction()
  }
})
