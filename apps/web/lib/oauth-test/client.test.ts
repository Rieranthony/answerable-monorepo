import { describe, expect, test } from "bun:test"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import { OAuthTestClient } from "./client"

const config = {
  issuer: "http://localhost:47300",
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://localhost:47100/api/oauth-test/callback",
}
async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256")
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }
  let nonce = ""
  let fault = ""
  let now = Date.now()
  let exchanges = 0
  const refreshes: string[] = []
  const revoked: string[] = []
  const transport = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input)
    if (url.endsWith("openid-configuration"))
      return Response.json({
        issuer: config.issuer,
        authorization_endpoint: config.issuer + "/auth/oauth2/authorize",
        token_endpoint: config.issuer + "/auth/oauth2/token",
        jwks_uri: config.issuer + "/auth/jwks",
        revocation_endpoint: config.issuer + "/auth/oauth2/revoke",
      })
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] })
    const body = new URLSearchParams(String(init?.body))
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Basic " + btoa("test-client:test-secret"),
    )
    if (url.endsWith("/revoke")) {
      revoked.push(body.get("token")!)
      return new Response(null)
    }
    if (body.get("grant_type") === "refresh_token") {
      refreshes.push(body.get("refresh_token")!)
      if (fault === "refresh")
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      return Response.json({
        access_token: "access-next",
        refresh_token: "refresh-next",
        token_type: "Bearer",
        expires_in: 60,
      })
    }
    exchanges++
    expect(body.get("code_verifier")!.length).toBeGreaterThanOrEqual(43)
    const id = await new SignJWT({
      nonce: fault === "nonce" ? "wrong" : nonce,
      name: "Anthony",
      email: "anthony@example.com",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("user-1")
      .setIssuer(fault === "issuer" ? "https://wrong.example" : config.issuer)
      .setAudience(fault === "audience" ? "other-client" : config.clientId)
      .setIssuedAt()
      .setExpirationTime(fault === "expiry" ? "-1h" : "1h")
      .sign(privateKey)
    return Response.json({
      access_token: "access-first",
      refresh_token: "refresh-first",
      token_type: "Bearer",
      expires_in: 60,
      scope: "openid profile email offline_access",
      id_token: fault === "signature" ? id.slice(0, -20) + "A".repeat(20) : id,
    })
  }
  const client = new OAuthTestClient(config, transport, () => now)
  async function start() {
    const result = await client.start()
    const url = new URL(result.url)
    nonce = url.searchParams.get("nonce")!
    return {
      ...result,
      query: new URLSearchParams({
        state: url.searchParams.get("state")!,
        code: "code",
      }),
    }
  }
  return {
    client,
    start,
    fault: (v: string) => {
      fault = v
    },
    advance: (ms: number) => {
      now += ms
    },
    exchanges: () => exchanges,
    refreshes,
    revoked,
  }
}
describe("independent OAuth consumer", () => {
  test("uses PKCE and verifies identity, rotates refresh tokens, revokes and signs out locally", async () => {
    const f = await fixture()
    const s = await f.start()
    expect(new URL(s.url).searchParams.get("code_challenge_method")).toBe(
      "S256",
    )
    const session = await f.client.callback(s.browserId, s.query)
    expect(f.client.view(session).identity?.sub).toBe("user-1")
    expect(JSON.stringify(f.client.view(session))).not.toContain("access-first")
    await f.client.refresh(session)
    await f.client.refresh(session)
    expect(f.refreshes).toEqual(["refresh-first", "refresh-next"])
    await f.client.revoke(session)
    expect(f.revoked).toContain("refresh-next")
    expect(f.client.view(session).canRefresh).toBe(false)
    f.client.logout(session)
    expect(f.client.view(session).identity).toBeNull()
  })
  test("binds callback state to browser and consumes it only once", async () => {
    const f = await fixture()
    const s = await f.start()
    await expect(f.client.callback("other", s.query)).rejects.toThrow()
    await expect(
      f.client.callback(
        s.browserId,
        new URLSearchParams({ code: "x", state: "wrong" }),
      ),
    ).rejects.toThrow()
    await f.client.callback(s.browserId, s.query)
    await expect(f.client.callback(s.browserId, s.query)).rejects.toThrow()
    expect(f.exchanges()).toBe(1)
  })
  test("rejects denied, expired and missing-state flows without exchanging a code", async () => {
    const f = await fixture()
    const s = await f.start()
    await expect(
      f.client.callback(s.browserId, new URLSearchParams()),
    ).rejects.toThrow()
    s.query.set("error", "access_denied")
    await expect(f.client.callback(s.browserId, s.query)).rejects.toThrow(
      "Access was denied",
    )
    const t = await f.start()
    f.advance(11 * 60_000)
    await expect(f.client.callback(t.browserId, t.query)).rejects.toThrow()
    expect(f.exchanges()).toBe(0)
  })
  for (const fault of ["nonce", "issuer", "audience", "expiry", "signature"])
    test(`rejects invalid ID token ${fault}`, async () => {
      const f = await fixture()
      const s = await f.start()
      f.fault(fault)
      await expect(f.client.callback(s.browserId, s.query)).rejects.toThrow()
    })
  test("expires sessions and clears credentials after refresh failure", async () => {
    const f = await fixture()
    const s = await f.start()
    const id = await f.client.callback(s.browserId, s.query)
    f.fault("refresh")
    await expect(f.client.refresh(id)).rejects.toThrow()
    expect(f.client.view(id).canRefresh).toBe(false)
    f.advance(61 * 60_000)
    expect(f.client.view(id).identity).toBeNull()
  })
})

test("limits pending transactions and frees expired entries", async () => {
  let now = Date.now()
  const metadata = {
    issuer: config.issuer,
    authorization_endpoint: config.issuer + "/authorize",
    token_endpoint: config.issuer + "/token",
    jwks_uri: config.issuer + "/jwks",
    revocation_endpoint: config.issuer + "/revoke",
  }
  const client = new OAuthTestClient(
    config,
    async () => Response.json(metadata),
    () => now,
  )
  const attempts = await Promise.allSettled(
    Array.from({ length: 1001 }, () => client.start()),
  )
  expect(
    attempts.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1000)
  await expect(client.start()).rejects.toThrow("Too many")
  now += 11 * 60_000
  expect((await client.start()).browserId).toBeTruthy()
})

test("never sends client credentials to a discovery endpoint on another origin", async () => {
  let calls = 0
  const client = new OAuthTestClient(config, async () => {
    calls++
    return Response.json({
      issuer: config.issuer,
      authorization_endpoint: config.issuer + "/authorize",
      token_endpoint: "https://other.example/token",
      jwks_uri: config.issuer + "/jwks",
      revocation_endpoint: config.issuer + "/revoke",
    })
  })
  await expect(client.start()).rejects.toThrow("Unexpected ID endpoint")
  expect(calls).toBe(1)
})
