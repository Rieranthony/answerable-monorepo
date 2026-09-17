import { afterEach, expect, test } from "bun:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { createIdVerifier, AuthenticationError } from "./index"

const issuer = "https://id.example.test"
const resource = "https://fixture.example.test/mcp"
const resourceInstanceId = crypto.randomUUID()
const now = Math.floor(Date.now() / 1000)
const identity = {
  sub: crypto.randomUUID(),
  subject_type: "user",
  organization_id: crypto.randomUUID(),
  membership_id: crypto.randomUUID(),
  grant_id: crypto.randomUUID(),
  client_instance: crypto.randomUUID(),
  resource_instance: resourceInstanceId,
  client_id: "fixture-client",
  azp: "fixture-client",
  organization_authorization_version: 1,
  authorization_version: 1,
  upstream_auth_time: now,
  scope: "e2e:read e2e:write",
}

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

async function fixture() {
  const key = await generateKeyPair("EdDSA")
  let keys = [{ ...(await exportJWK(key.publicKey)), kid: "first", alg: "EdDSA" }]
  let requests = 0
  let unavailable = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return unavailable
        ? new Response("Unavailable", { status: 503 })
        : Response.json({ keys })
    },
  })
  servers.push(server)
  const config = {
    issuer,
    resource,
    resourceInstanceId,
    jwksUrl: new URL("/jwks", server.url).href,
    allowLocalHttp: true,
    cooldownDuration: 0,
  }
  const verify = createIdVerifier(config)
  async function token(
    changes: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
  ) {
    return new SignJWT({
      ...identity,
      iss: issuer,
      aud: resource,
      iat: now,
      exp: now + 300,
      ...changes,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: "first", ...header })
      .sign(key.privateKey)
  }
  return {
    verify,
    token,
    config,
    requests: () => requests,
    outage: () => { unavailable = true },
    async rotate() {
      const next = await generateKeyPair("EdDSA")
      keys = [...keys, { ...(await exportJWK(next.publicKey)), kid: "next", alg: "EdDSA" }]
      return new SignJWT({ ...identity, iss: issuer, aud: resource, iat: now, exp: now + 300 })
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: "next" })
        .sign(next.privateKey)
    },
  }
}

test("verifies ID user claims against network JWKS and returns immutable safe context", async () => {
  const f = await fixture()
  const principal = await f.verify(await f.token({ aud: [resource, "https://id.example.test/userinfo"] }))
  expect(principal).toMatchObject({
    type: "user",
    userId: identity.sub,
    organizationId: identity.organization_id,
    membershipId: identity.membership_id,
    resourceInstanceId,
    scopes: ["e2e:read", "e2e:write"],
  })
  expect(Object.isFrozen(principal)).toBe(true)
  expect(Object.isFrozen(principal.scopes)).toBe(true)
  expect(principal).not.toHaveProperty("token")
  await Promise.all([f.verify(await f.token()), f.verify(await f.token())])
  expect(f.requests()).toBe(1)
})

test.each([
  ["wrong issuer", { iss: "https://attacker.test" }],
  ["wrong audience", { aud: "https://other.test/mcp" }],
  ["expired", { exp: now - 1 }],
  ["not yet valid", { nbf: now + 300 }],
  ["future issuance", { iat: now + 300 }],
  ["missing expiry", { exp: undefined }],
  ["wrong resource instance", { resource_instance: crypto.randomUUID() }],
  ["machine", { subject_type: "client" }],
  ["missing membership", { membership_id: undefined }],
  ["bad user id", { sub: "alice@example.test" }],
  ["client mismatch", { azp: "another-client" }],
  ["invalid version", { authorization_version: 0 }],
  ["invalid scopes", { scope: ["e2e:read"] }],
  ["proof-bound token without proof", { cnf: { jkt: "key" } }],
])("rejects %s", async (_label, changes) => {
  const f = await fixture()
  await expect(f.verify(await f.token(changes))).rejects.toBeInstanceOf(AuthenticationError)
})

test("rejects ID tokens, forged signatures and opaque credentials", async () => {
  const f = await fixture()
  await expect(f.verify(await f.token({}, { typ: "JWT" }))).rejects.toBeInstanceOf(AuthenticationError)
  const other = await generateKeyPair("EdDSA")
  const forged = await new SignJWT({ ...identity, iss: issuer, aud: resource, exp: now + 300, iat: now })
    .setProtectedHeader({ typ: "at+jwt", alg: "EdDSA", kid: "first" })
    .sign(other.privateKey)
  await expect(f.verify(forged)).rejects.toBeInstanceOf(AuthenticationError)
  await expect(f.verify("opaque")).rejects.toBeInstanceOf(AuthenticationError)
})

test("refreshes JWKS for a rotated key and continues using cached keys during an outage", async () => {
  const f = await fixture()
  const original = await f.token()
  await f.verify(original)
  await f.verify(await f.rotate())
  expect(f.requests()).toBe(2)
  f.outage()
  await f.verify(original)
  expect(f.requests()).toBe(2)
  await expect(createIdVerifier(f.config)(original)).rejects.toBeInstanceOf(AuthenticationError)
})

test("rejects insecure issuer/JWKS configuration unless explicitly local", () => {
  const config = { issuer, resource, resourceInstanceId, jwksUrl: "http://evil.test/jwks" }
  expect(() => createIdVerifier(config)).toThrow()
  expect(() => createIdVerifier({ ...config, allowLocalHttp: true })).toThrow()
  expect(() => createIdVerifier({ ...config, jwksUrl: "https://user:secret@id.test/jwks" })).toThrow()
})

test("enforces a configured maximum token lifetime and validates cache bounds", async () => {
  const f = await fixture()
  await expect(f.verify(await f.token({ exp: now + 901 }))).rejects.toBeInstanceOf(AuthenticationError)
  const short = createIdVerifier({ ...f.config, maxTokenLifetimeSeconds: 60 })
  await expect(short(await f.token())).rejects.toBeInstanceOf(AuthenticationError)
  for (const overrides of [{ maxTokenLifetimeSeconds: 0 }, { cacheMaxAge: -1 }, { timeoutDuration: 0 }, { cooldownDuration: -1 }]) {
    expect(() => createIdVerifier({ ...f.config, ...overrides })).toThrow()
  }
})

test("an outage rejects unknown keys and expired caches without accepting unverifiable tokens", async () => {
  const f = await fixture()
  await f.verify(await f.token())
  const unknownKeyToken = await f.rotate()
  const uncached = createIdVerifier({ ...f.config, cacheMaxAge: 0 })
  await uncached(await f.token())
  f.outage()
  await expect(f.verify(unknownKeyToken)).rejects.toBeInstanceOf(AuthenticationError)
  expect((await f.verify(await f.token())).userId).toBe(identity.sub)
  await expect(uncached(await f.token())).rejects.toBeInstanceOf(AuthenticationError)
})
