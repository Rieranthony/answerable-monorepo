import { expect, spyOn, test } from "bun:test"
import { AuthenticationError, createIdVerifier, type MachinePrincipal, type UserPrincipal } from "./index"
import { createTestIssuer } from "./testing"

const resource = "https://mcp.test/mcp"
async function fixture(algorithm?: "EdDSA" | "ES256" | "RS256") {
  const issuer = await createTestIssuer({ algorithm })
  return { ...issuer, verify: createIdVerifier({ issuer: issuer.issuer, resource, fetch: issuer.fetch }) }
}

test("valid tokens return only a frozen principal and de-duplicated scopes", async () => {
  const issuer = await fixture()
  const userId = crypto.randomUUID()
  const organizationId = crypto.randomUUID()
  const principal = await issuer.verify(await issuer.sign({ resource, userId, organizationId, scopes: ["read", "write", "read"] }))
  expect(principal).toEqual({
    userId, organizationId, membershipId: expect.any(String), grantId: expect.any(String), clientId: "test-client", scopes: ["read", "write"], expiresAt: expect.any(Number),
    organizationAuthorizationVersion: 1, upstreamAuthTime: expect.any(Number),
  })
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
  ["missing organisation authorisation version", { organization_authorization_version: undefined }],
  ["zero organisation authorisation version", { organization_authorization_version: 0 }],
  ["fractional organisation authorisation version", { organization_authorization_version: 1.5 }],
  ["text upstream authentication time", { upstream_auth_time: "2026-10-01T09:00:00Z" }],
  ["negative upstream authentication time", { upstream_auth_time: -1 }],
  ["fractional upstream authentication time", { upstream_auth_time: 1.5 }],
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
test("the organisation's authorisation version is the token's, which ID advances when it disables the organisation", async () => {
  const issuer = await fixture()
  expect((await issuer.verify(await issuer.sign({ resource, claims: { organization_authorization_version: 7 } }))).organizationAuthorizationVersion).toBe(7)
})
test("the upstream authentication time is the token's, null when the directory reported none or the token has no claim", async () => {
  const issuer = await fixture()
  const time = async (claims: Record<string, unknown>) => (await issuer.verify(await issuer.sign({ resource, claims }))).upstreamAuthTime
  expect(await time({ upstream_auth_time: 1_790_000_000 })).toBe(1_790_000_000)
  expect(await time({ upstream_auth_time: null })).toBeNull()
  expect(await time({ upstream_auth_time: undefined })).toBeNull()
  const now = Math.floor(Date.now() / 1000)
  expect(await time({})).toBeWithin(now - 5, now + 1)
})
// What ID puts in a client_credentials token: the client is the subject, and there is no membership or grant.
const machine = (claims: Record<string, unknown> = {}) => ({
  subject_type: "client", sub: "staff-client", client_id: "staff-client", client_instance: crypto.randomUUID(), authorization_version: 3,
  membership_id: undefined, grant_id: undefined, ...claims,
})
const clientOnly = (issuer: Awaited<ReturnType<typeof fixture>>) => createIdVerifier({ issuer: issuer.issuer, resource, fetch: issuer.fetch, subjectType: "client" })

test("a client token is refused by a user verifier, the default, and a client verifier returns a frozen machine principal", async () => {
  const issuer = await fixture()
  const organizationId = crypto.randomUUID()
  const token = await issuer.sign({ resource, organizationId, scopes: ["toolbox:admin", "toolbox:admin"], claims: machine({ organization_authorization_version: 4 }) })
  await expect(issuer.verify(token)).rejects.toThrow(new AuthenticationError())
  await expect(createIdVerifier({ issuer: issuer.issuer, resource, fetch: issuer.fetch, subjectType: "user" })(token)).rejects.toThrow(new AuthenticationError())
  const principal: MachinePrincipal = await clientOnly(issuer)(token)
  expect(principal).toEqual({
    clientId: "staff-client", organizationId, scopes: ["toolbox:admin"], expiresAt: expect.any(Number), authorizationVersion: 3, organizationAuthorizationVersion: 4,
  })
  expect(Object.isFrozen(principal)).toBe(true)
  expect(Object.isFrozen(principal.scopes)).toBe(true)
})
test("a client verifier refuses a user token", async () => {
  const issuer = await fixture()
  const user: UserPrincipal = await issuer.verify(await issuer.sign({ resource }))
  expect(user.clientId).toBe("test-client")
  await expect(clientOnly(issuer)(await issuer.sign({ resource }))).rejects.toThrow(new AuthenticationError())
})
const invalidMachine: [string, Record<string, unknown>][] = [
  ["a subject that is not the client", { sub: "another-client" }], ["a different azp", { azp: "another-client" }],
  ["a missing client id", { client_id: undefined }], ["a missing client authorisation version", { authorization_version: undefined }],
  ["a zero client authorisation version", { authorization_version: 0 }], ["a missing organisation", { organization_id: undefined }],
  ["a missing organisation authorisation version", { organization_authorization_version: undefined }], ["a proof-bound token", { cnf: { jkt: "key" } }],
]
for (const [name, claims] of invalidMachine) {
  test(`rejects a client token with ${name}`, async () => {
    const issuer = await fixture()
    await expect(clientOnly(issuer)(await issuer.sign({ resource, claims: machine(claims) }))).rejects.toThrow(new AuthenticationError())
  })
}
test("a rejection says only that a valid Answerable ID access token is required, for a person's token or a machine's", () => {
  expect(new AuthenticationError().message).toBe("A valid Answerable ID access token is required")
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
    const issuer = "https://discovery.test"
    const verify = createIdVerifier({ issuer, resource, async fetch(input, init) {
      const request = (input instanceof Request ? new Request(input, init) : new Request(String(input), init))
      if (new URL(request.url).pathname === "/jwks") keyRequests++
      return Response.json({ issuer: mismatch === "issuer" ? signer.issuer : issuer, jwks_uri: mismatch === "origin" ? `${signer.issuer}/jwks` : `${issuer}/jwks` })
    } })
    await expect(verify(await signer.sign({ resource, claims: { iss: issuer } }))).rejects.toBeInstanceOf(AuthenticationError)
    expect(keyRequests).toBe(0)
    expect(signer.jwksRequests()).toBe(0)
  })
}
test("discovery inserts the well-known path before an issuer path", async () => {
  const signer = await fixture()
  const paths: string[] = []
  const issuer = "https://discovery.test/tenant"
  const verify = createIdVerifier({ issuer, resource, async fetch(input, init) {
    const path = new URL((input instanceof Request ? new Request(input, init) : new Request(String(input), init)).url).pathname
    paths.push(path)
    if (path === "/.well-known/oauth-authorization-server/tenant") return Response.json({ issuer, jwks_uri: "https://discovery.test/jwks" })
    return signer.fetch(`${signer.issuer}/jwks`)
  } })
  await verify(await signer.sign({ resource, claims: { iss: issuer } }))
  expect(paths).toEqual(["/.well-known/oauth-authorization-server/tenant", "/jwks"])
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

test("uses the global fetch by default", async () => {
  const issuer = await createTestIssuer()
  const verify = createIdVerifier({ issuer: issuer.issuer, resource })
  const fetch = spyOn(globalThis, "fetch").mockImplementation(issuer.fetch as typeof globalThis.fetch)
  try {
    expect((await verify(await issuer.sign({ resource }))).clientId).toBe("test-client")
  } finally { fetch.mockRestore() }
})
test("test issuer routes are in-process and origin-bound", async () => {
  const issuer = await createTestIssuer({ issuer: "http://localhost:1234" })
  expect(issuer.issuer).toBe("http://localhost:1234")
  for (const [url, method] of [[`${issuer.issuer}/missing`, "GET"], [`${issuer.issuer}/jwks`, "POST"], ["https://other.test/jwks", "GET"]]) {
    expect((await issuer.fetch(url!, { method })).status).toBe(404)
  }
})
