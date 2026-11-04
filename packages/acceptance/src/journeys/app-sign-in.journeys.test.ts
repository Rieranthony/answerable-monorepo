// Real application OIDC through ID's pages and LibreChat's audited client-library version.
// This does not run LibreChat, OpenCloud or their own session/account code.
import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Page } from "@playwright/test"
import * as oidc from "openid-client"
import { z } from "zod"
import { launchBrowser, serveCallback, startId, step, type Id } from "../index"

const callback = "http://127.0.0.1:47603/callback"
const clientId = "application-oidc-acceptance"
const scopes = ["openid", "profile", "email", "offline_access"]

let id: Id
let browser: Awaited<ReturnType<typeof launchBrowser>>
let clientSecret: string

beforeAll(async () => {
  id = await startId({ tenants: [{ slug: "application-oidc", signIns: 1 }] })
  const registered = z.object({ clientSecret: z.string() }).parse(
    await id.admin("POST", "/clients", {
      clientId,
      name: "Application OIDC acceptance",
      organizationId: id.manifest.tenants[0]!.organizationId,
      tokenEndpointAuthMethod: "client_secret_post",
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [callback],
      scopes,
    }),
  )
  clientSecret = registered.clientSecret
  serveCallback(callback)
  browser = await launchBrowser()
})
afterAll(() => id?.stop())

async function configuration(secret: string) {
  const tokenRequests: {
    grantType: string | null
    usesPost: boolean
    hasVerifier: boolean
    status: number
  }[] = []
  const config = await oidc.discovery(
    new URL(id.manifest.idOrigin),
    clientId,
    { client_secret: secret },
    undefined,
    {
      // Only the disposable loopback fixture uses HTTP. Keep state, nonce,
      // signature, issuer, audience and subject checks enabled.
      execute: [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks],
      [oidc.customFetch]: async (url, options) => {
        const requestOptions = {
          ...options,
          body:
            options.body instanceof Uint8Array
              ? new Uint8Array(options.body)
              : options.body,
        }
        const response = await fetch(url, requestOptions)
        if (new URL(url).pathname === "/auth/oauth2/token") {
          const body = await new Request(url, requestOptions).formData()
          tokenRequests.push({
            grantType: body.get("grant_type")?.toString() ?? null,
            usesPost:
              !new Headers(options.headers).has("authorization") &&
              body.get("client_id") === clientId &&
              body.get("client_secret") === secret,
            hasVerifier: body.has("code_verifier"),
            status: response.status,
          })
        }
        return response
      },
    },
  )
  return { config, tokenRequests }
}

async function authorization(config: oidc.Configuration) {
  const verifier = oidc.randomPKCECodeVerifier()
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callback,
    scope: scopes.join(" "),
    prompt: "consent",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  })
  expect(url.searchParams.get("client_id")).toBe(clientId)
  expect(url.searchParams.get("response_type")).toBe("code")
  expect(url.searchParams.has("resource")).toBe(false)
  return {
    url,
    checks: {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    },
  }
}

async function chooseOrganisation(page: Page, url: URL) {
  await page.goto(url.href)
  const email = page.getByLabel(/email/i)
  const chooser = page.getByRole("heading", { name: "Choose an organisation" })
  await email.or(chooser).waitFor()
  if (await email.isVisible()) {
    await email.fill(id.manifest.tenants[0]!.email)
    await page.getByRole("button", { name: /continue/i }).click()
    // The organisation has magic links on as well, so ID asks which way.
    const directory = page.getByRole("button", { name: /^Continue with / })
    await chooser.or(directory).waitFor()
    if (await directory.isVisible()) await directory.click()
    await chooser.waitFor()
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click()
}

async function approve(page: Page, config: oidc.Configuration) {
  const request = await authorization(config)
  await chooseOrganisation(page, request.url)
  await page.getByRole("heading", { name: "Access it will receive" }).waitFor()
  for (const name of [
    "Confirm who you are",
    "Read your name",
    "Read your email address",
    "Stay connected after you leave",
  ])
    expect(await page.locator("section ul").innerText()).toContain(name)
  await page.getByRole("button", { name: "Accept", exact: true }).click()
  await page.waitForURL(`${callback}?**`)
  const returned = new URL(page.url())
  expect(returned.searchParams.get("iss")).toBe(id.manifest.idOrigin)
  return { returned, checks: request.checks }
}

test("a browser reads both discovery documents cross-origin without credentials", async () => {
  step(
    "Application origin: reading ID's two public discovery documents in Chromium",
  )
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(callback)
    const discovered = await page.evaluate(
      async ({ idOrigin }) => {
        const documents = []
        for (const path of [
          "/.well-known/openid-configuration",
          "/.well-known/oauth-authorization-server",
        ]) {
          const response = await fetch(`${idOrigin}${path}`, {
            credentials: "omit",
          })
          documents.push({
            status: response.status,
            type: response.type,
            metadata: await response.json(),
          })
        }
        return documents
      },
      { idOrigin: id.manifest.idOrigin },
    )
    expect(discovered).toHaveLength(2)
    for (const document of discovered) {
      expect(document.status).toBe(200)
      expect(document.type).toBe("cors")
      expect(document.metadata).toMatchObject({
        issuer: id.manifest.idOrigin,
        token_endpoint: `${id.manifest.idOrigin}/auth/oauth2/token`,
        userinfo_endpoint: `${id.manifest.idOrigin}/auth/oauth2/userinfo`,
        jwks_uri: `${id.manifest.idOrigin}/auth/jwks`,
      })
      expect(document.metadata.token_endpoint_auth_methods_supported).toContain(
        "client_secret_post",
      )
      expect(document.metadata.code_challenge_methods_supported).toEqual([
        "S256",
      ])
    }
    expect(discovered[0]!.metadata).toEqual(discovered[1]!.metadata)
  } finally {
    await context.close()
  }
})

test("a confidential application needs permission, signs in with POST and S256, and loses its grants on secret rotation", async () => {
  const tenant = id.manifest.tenants[0]!
  const { config, tokenRequests } = await configuration(clientSecret)
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  try {
    step(
      "Application sign-in: registration alone does not permit a customer login",
    )
    await chooseOrganisation(page, (await authorization(config)).url)
    expect(await page.getByRole("alert").innerText()).toContain(
      "Access is unavailable for this organisation",
    )
    expect(tokenRequests).toEqual([])

    step(
      "Application sign-in: granting login and renewal, then completing selection and consent",
    )
    for (const grantKind of ["authorization_code", "refresh_token"])
      await id.admin(
        "POST",
        `/organizations/${tenant.organizationId}/capabilities`,
        { clientId, resource: null, grantKind, scopes },
      )
    await id.admin(
      "POST",
      `/organizations/${tenant.organizationId}/entitlements`,
      { clientId, scopes },
    )
    const approved = await approve(page, config)
    const issued = await oidc.authorizationCodeGrant(
      config,
      approved.returned,
      approved.checks,
    )
    const claims = issued.claims()!
    expect(claims).toMatchObject({
      iss: id.manifest.idOrigin,
      aud: clientId,
      nonce: approved.checks.expectedNonce,
    })
    expect(claims.sub).toBeString()
    expect(issued.scope?.split(" ").toSorted()).toEqual(scopes.toSorted())
    expect(issued.access_token.split(".")).toHaveLength(1)
    expect(issued.refresh_token).toBeString()
    expect(tokenRequests).toEqual([
      {
        grantType: "authorization_code",
        usesPost: true,
        hasVerifier: true,
        status: 200,
      },
    ])
    const profile = await oidc.fetchUserInfo(
      config,
      issued.access_token,
      claims.sub,
    )
    expect(profile).toMatchObject({
      sub: claims.sub,
      email: tenant.email,
      email_verified: true,
      name: "MCP tester",
      organization_id: tenant.organizationId,
    })

    step(
      "Application sign-in: refresh changes the credential and preserves the identity",
    )
    const renewed = await oidc.refreshTokenGrant(config, issued.refresh_token!)
    expect(renewed.refresh_token).toBeString()
    expect(renewed.refresh_token === issued.refresh_token).toBe(false)
    expect(renewed.claims()).toMatchObject({
      iss: id.manifest.idOrigin,
      aud: clientId,
      sub: claims.sub,
    })
    expect(renewed.scope?.split(" ").toSorted()).toEqual(scopes.toSorted())
    expect(
      await oidc.fetchUserInfo(config, renewed.access_token, claims.sub),
    ).toMatchObject({ sub: claims.sub, email: tenant.email })
    expect(tokenRequests[1]).toEqual({
      grantType: "refresh_token",
      usesPost: true,
      hasVerifier: false,
      status: 200,
    })

    step(
      "Application sign-in: rotation refuses the old secret and the old grant even with the replacement secret",
    )
    const rotated = z
      .object({ clientSecret: z.string() })
      .parse(await id.admin("POST", `/clients/${clientId}/rotate-secret`))
    expect(rotated.clientSecret === clientSecret).toBe(false)
    await expect(
      oidc.refreshTokenGrant(config, renewed.refresh_token!),
    ).rejects.toMatchObject({ error: "invalid_client" })
    const replacement = await configuration(rotated.clientSecret)
    await expect(
      oidc.refreshTokenGrant(replacement.config, renewed.refresh_token!),
    ).rejects.toMatchObject({ error: "invalid_grant" })
    await expect(
      oidc.fetchUserInfo(replacement.config, renewed.access_token, claims.sub),
    ).rejects.toMatchObject({ status: 401 })
    const nextApproval = await approve(page, replacement.config)
    const next = await oidc.authorizationCodeGrant(
      replacement.config,
      nextApproval.returned,
      nextApproval.checks,
    )
    expect(next.claims()).toMatchObject({ sub: claims.sub, aud: clientId })
    expect(
      await oidc.fetchUserInfo(
        replacement.config,
        next.access_token,
        claims.sub,
      ),
    ).toMatchObject({ sub: claims.sub, email: tenant.email })
  } catch (error) {
    console.error(
      "[acceptance] application ID page:",
      new URL(page.url()).pathname,
      await page.locator("body").innerText(),
    )
    throw error
  } finally {
    await context.close()
  }
})
