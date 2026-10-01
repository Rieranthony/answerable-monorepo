import assert from "node:assert/strict"
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test"
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

/** Where a person's pages open: a browser, which gives each sign-in a context of its own, or one of its contexts, which keeps ID's session cookie from one sign-in to the next. */
type Where = Browser | BrowserContext

/** Run `steps` on a fresh page of its own browser context, or of the given context, and close what it opened afterwards. On failure, prints the page ID showed. */
async function onPage<T>(where: Where, steps: (page: Page) => Promise<T>) {
  const context = "newContext" in where ? await where.newContext() : where
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  try {
    return await steps(page)
  } catch (error) {
    console.error("[acceptance] ID page:", new URL(page.url()).pathname, await page.locator("body").innerText())
    throw error
  } finally {
    await (context === where ? page : context).close()
  }
}

/** ID's first pages for one person: email and company sign-in, unless the browser context already holds the person's ID session, and the organisation chooser, where it continues with the person's organisation. */
async function chooseOrganisation(page: Page, authorizationUrl: string, email: string) {
  await page.goto(authorizationUrl)
  const field = page.getByLabel(/email/i)
  const chooser = page.getByRole("heading", { name: "Choose an organisation" })
  await field.or(chooser).waitFor()
  if (await field.isVisible()) {
    await field.fill(email)
    await page.getByRole("button", { name: /continue/i }).click()
    await chooser.waitFor()
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click()
}

/** Complete ID's pages for one person: email, company sign-in, organisation, consent. Returns the callback's query. On failure, prints the page ID showed. */
export function approve(browser: Where, authorizationUrl: string, target: Pick<SignInTarget, "callback" | "scopes">, tenant: SignInTenant) {
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

/** Sign a person in as a host does: the SDK follows the MCP's 401 to ID and builds the authorisation request, this checks it, a real browser completes ID's pages, and the SDK exchanges the code. Returns the provider, holding the tokens, and its state. Given a context of the browser instead of the browser, it keeps ID's session for the next sign-in through that context, which then skips the email step. */
export async function signIn(browser: Where, target: SignInTarget, tenant: SignInTenant) {
  const { oauth, transport, authorize } = await challenge(target)
  const callback = await approve(browser, authorize.href, target, tenant)
  assert.equal(callback.get("iss"), target.idOrigin, "RFC 9207 issuer in the authorisation response")
  await transport.finishAuth(callback)
  return oauth
}

/** Sign a person in where ID is expected to refuse, such as one of an organisation not yet entitled to the MCP. Makes the same request as `signIn`, but returns the refusal ID shows at the organisation chooser ("Access is unavailable for this organisation. …") instead of waiting 30 seconds for a consent page. */
export async function signInRefused(browser: Where, target: SignInTarget, tenant: SignInTenant) {
  const { authorize } = await challenge(target)
  return onPage(browser, async page => {
    await chooseOrganisation(page, authorize.href, tenant.email)
    return page.getByRole("alert").innerText()
  })
}

/**
 * Do what ID's Security page asks of a person whose last company sign-in is too old for a critical operation: in the browser context that holds their ID session, open `<idOrigin>/security`, choose **Verify sign-in**, and return once ID brings the browser back
 * from the company directory. The session ID makes then is new, so the next authorisation through the same context carries the new sign-in time. Throws with ID's message when ID refuses.
 */
export function verifySignIn(context: BrowserContext, idOrigin: string) {
  return onPage(context, async page => {
    await page.goto(`${idOrigin}/security`)
    // Registered after the first load: only the navigation that ends the company sign-in matches.
    const back = page.waitForRequest(request => request.isNavigationRequest() && new URL(request.url()).pathname === "/security")
    await page.getByRole("button", { name: "Verify sign-in" }).click()
    await back
    await page.getByRole("heading", { name: "Account security" }).waitFor()
    assert.deepEqual(await page.getByRole("alert").allInnerTexts(), [], "ID refused Verify sign-in")
  })
}
