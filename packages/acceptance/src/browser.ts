import assert from "node:assert/strict"
import { chromium, type Browser, type Page } from "@playwright/test"
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client"
import { onCleanup } from "./cleanup"
import { oauthProvider } from "./oauth"
import { step } from "./step"

/** Where a person signs in: ID, the MCP's URL as the `resource`, the pre-registered public client, its callback URL and the scopes the MCP advertises. */
type SignInTarget = { idOrigin: string; resource: string; clientId: string; callback: string; scopes: readonly string[] }

/** Who signs in: the organisation's slug as ID's consent page names it, the address its company directory holds, and the scopes the organisation is entitled to. */
type SignInTenant = { slug: string; email: string; scopes: readonly string[] }

/** Launch headless Chromium, closed when the kit stops. Playwright's own signal handlers are off, so the kit's cleanup runs on Ctrl-C. Needs `bun x playwright install chromium`. */
export async function launchBrowser() {
  const browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
  onCleanup(() => browser.close())
  return browser
}

/** Run `steps` on a fresh page of its own browser context, closed afterwards. On failure, prints the page ID showed. */
async function onPage<T>(browser: Browser, steps: (page: Page) => Promise<T>) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  try {
    return await steps(page)
  } catch (error) {
    console.error("[acceptance] ID page:", new URL(page.url()).pathname, await page.locator("body").innerText())
    throw error
  } finally {
    await context.close()
  }
}

/** ID's first pages for one person: email, company sign-in, and the organisation chooser, where it continues with the person's organisation. */
async function chooseOrganisation(page: Page, authorizationUrl: string, email: string) {
  await page.goto(authorizationUrl)
  await page.getByLabel(/email/i).fill(email)
  await page.getByRole("button", { name: /continue/i }).click()
  await page.getByRole("heading", { name: "Choose an organisation" }).waitFor()
  await page.getByRole("button", { name: "Continue", exact: true }).click()
}

/** Complete ID's pages for one person: email, company sign-in, organisation, consent. Returns the callback's query. On failure, prints the page ID showed. */
export function approve(browser: Browser, authorizationUrl: string, target: Pick<SignInTarget, "callback" | "scopes">, tenant: SignInTenant) {
  return onPage(browser, async page => {
    await chooseOrganisation(page, authorizationUrl, tenant.email)
    await page.getByRole("heading", { name: "Access it will receive" }).waitFor()
    const withheld = target.scopes.filter(scope => !tenant.scopes.includes(scope))
    const scopeList = await page.locator("section ul").innerText()
    for (const scope of tenant.scopes) assert.ok(scopeList.includes(scope), `Consent lists ${scope}`)
    assert.ok(scopeList.includes("Stay connected after you leave"))
    if (withheld.length) {
      step(`${tenant.slug}: consent names the unapproved scopes`)
      const notice = await page.getByText(`Not approved for ${tenant.slug}:`).innerText()
      for (const scope of withheld) {
        assert.ok(notice.includes(scope), `Consent names ${scope} as not approved`)
        assert.ok(!scopeList.includes(scope), `Consent does not list ${scope}`)
      }
    } else assert.equal(await page.getByText(/Not approved for/).count(), 0)
    await page.getByRole("button", { name: "Accept", exact: true }).click()
    await page.waitForURL(`${target.callback}?**`)
    return new URL(page.url()).searchParams
  })
}

/** Start a sign-in as a host does: the SDK follows the MCP's 401 to ID and builds the authorisation request, and this checks it. Returns the SDK's session, its transport and the authorisation URL. */
async function challenge(target: SignInTarget) {
  const oauth = oauthProvider(target)
  const transport = new StreamableHTTPClientTransport(new URL(target.resource), { authProvider: oauth.provider })
  await assert.rejects(new Client({ name: "answerable-acceptance", version: "0.1.0" }).connect(transport), UnauthorizedError)
  const authorize = oauth.state.authorizationUrl
  assert.ok(authorize, "The SDK must discover ID from the MCP challenge")
  assert.equal(authorize.origin, target.idOrigin)
  assert.equal(authorize.searchParams.get("client_id"), target.clientId)
  assert.equal(authorize.searchParams.get("resource"), target.resource, "RFC 8707 resource indicator")
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256")
  assert.deepEqual(
    authorize.searchParams.get("scope")?.split(" ").sort(),
    [...target.scopes, "offline_access"].sort(),
    "Scopes come from the protected-resource metadata",
  )
  return { oauth, transport, authorize }
}

/** Sign a person in as a host does: the SDK follows the MCP's 401 to ID and builds the authorisation request, this checks it, a real browser completes ID's pages, and the SDK exchanges the code. Returns the provider, holding the tokens, and its state. */
export async function signIn(browser: Browser, target: SignInTarget, tenant: SignInTenant) {
  const { oauth, transport, authorize } = await challenge(target)
  const callback = await approve(browser, authorize.href, target, tenant)
  assert.equal(callback.get("iss"), target.idOrigin, "RFC 9207 issuer in the authorisation response")
  await transport.finishAuth(callback)
  return oauth
}

/** Sign a person in where ID is expected to refuse, such as one of an organisation not yet entitled to the MCP. Makes the same request as `signIn`, but returns the refusal ID shows at the organisation chooser ("Access is unavailable for this organisation. …") instead of waiting 30 seconds for a consent page. */
export async function signInRefused(browser: Browser, target: SignInTarget, tenant: SignInTenant) {
  const { authorize } = await challenge(target)
  return onPage(browser, async page => {
    await chooseOrganisation(page, authorize.href, tenant.email)
    return page.getByRole("alert").innerText()
  })
}
