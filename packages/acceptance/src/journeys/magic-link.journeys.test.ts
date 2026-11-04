// Sign-in by emailed link, end to end: a real ID process on a real Postgres, real Chromium, and a fake Postmark that ID sends its mail to as it sends it to Postmark.
// What each test reads as proof is the page a person sees, the mail the fake kept, and the rows ID wrote (sessions, accounts, the request, the audit trail).
// ID runs here as NODE_ENV=test on plain http, so the https cookie attributes (`__Host-`, `Secure`) are not asserted: the kind stack proves them (infra/k8s/local/magic-link-sign-in.ts).
//
// One firm per concern, made through the admin API as an operator makes it, and one address per person: ID lets one address have one mail a minute from one client, and every
// browser here is the same client (127.0.0.1). Where a test needs a second mail for an address inside that minute, `aMinutePasses` moves that address's request rows back in time
// (it moves their `created_at` and nothing else), which is what waiting would do.
import { createHash, randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { connect as connectDatabase } from "@answerable/mcp-postgres"
import { rowsOf } from "@answerable/mcp-postgres/testing"
import type { BrowserContext, Page } from "@playwright/test"
import { decodeJwt } from "jose"
import { z } from "zod"
import { grantOrganisation, launchBrowser, linkClient, readMail, registerClient, registerResource, serveCallback, setSsoProvider, startFakePostmark, startId, step, type Id } from "../index"
import { addDomain } from "../admin"
import type { Spare } from "../id"

const callback = "http://127.0.0.1:47603/callback"
// Test values for the fake Postmark and the application client: nothing here is a credential.
const postmarkToken = "magic-link-journey"
const app = { clientId: "magic-link-journey", resource: "https://app.magic-link.example.test/mcp", scope: "app:read" }
const signInCookie = "answerable-sign-in"
// The mail's own words and tags, from packages/emails.
const tags = { link: "sign-in", connect: "mailbox-code" }

const postmark = startFakePostmark({ token: postmarkToken })
const database = connectDatabase("postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test", { max: 2 })
const query = rowsOf(database)

let id: Id
let origin: string
let browser: Awaited<ReturnType<typeof launchBrowser>>
let directories: Record<string, Spare>
const contexts: BrowserContext[] = []

const directoryPlan = [
  // Two directory sign-ins: the first is refused for an address someone holds, the second is the one that signs in.
  { slug: "proofs", signIns: 2 },
  { slug: "proofs-changed", signIns: 1 },
  { slug: "proofs-removed", signIns: 1 },
  // One before magic links go off and one while they are off.
  { slug: "toggle-both", signIns: 2 },
  { slug: "mover", signIns: 1 },
  { slug: "due-session", signIns: 1 },
]

beforeAll(async () => {
  id = await startId({ tenants: [], spares: directoryPlan, postmark: { url: postmark.url, token: postmarkToken } })
  origin = id.manifest.idOrigin
  directories = Object.fromEntries(id.manifest.spares.map(spare => [spare.slug, spare]))
  serveCallback(callback)
  await registerResource(id.admin, { identifier: app.resource, scopes: [app.scope], accessTokenTtl: 300 })
  await registerClient(id.admin, { clientId: app.clientId, redirectUri: callback, scopes: [app.scope] })
  await linkClient(id.admin, app.clientId, app.resource)
  browser = await launchBrowser()
})
afterAll(async () => {
  await Promise.all(contexts.map(context => context.close().catch(() => {})))
  await database.$client.end()
  await id?.stop()
})

// ---- firms and people, as an operator makes them ----

type Firm = { id: string; slug: string; name: string; domain: string }

/** A firm with its domain and no directory, and sign-in by link turned on, which starts off for every new firm. */
async function firm(slug: string, name = slug): Promise<Firm> {
  const { id: organizationId } = z.object({ id: z.uuid() }).parse(await id.admin("POST", "/organizations", { slug, name }))
  await id.admin("POST", `/organizations/${organizationId}/magic-link/enable`)
  const domain = `${slug}.example.test`
  await addDomain(id.admin, organizationId, domain)
  await grantOrganisation(id.admin, organizationId, { clientId: app.clientId, resource: app.resource, scopes: [app.scope] })
  return { id: organizationId, slug, name, domain }
}

/** A firm with a company directory, one of the fixture's spares, and links turned on as well. */
async function directoryFirm(slug: string, name = slug) {
  const spare = directories[slug]!
  const { id: organizationId } = z.object({ id: z.uuid() }).parse(await id.admin("POST", "/organizations", { slug, name }))
  await id.admin("POST", `/organizations/${organizationId}/magic-link/enable`)
  await addDomain(id.admin, organizationId, spare.domain)
  await setSsoProvider(id.admin, organizationId, spare)
  await grantOrganisation(id.admin, organizationId, { clientId: app.clientId, resource: app.resource, scopes: [app.scope] })
  return { id: organizationId, slug, name, domain: spare.domain, directory: spare } satisfies Firm & { directory: Spare }
}

/** List people in a firm (the admin API's member import, which `members.import` calls), as `local@<the firm's domain>`. Returns their addresses. */
async function list(of: Firm, ...locals: string[]) {
  const addresses = locals.map(local => `${local}@${of.domain}`)
  const answer = z.object({ counts: z.object({ created: z.number(), refused: z.number() }) }).parse(await id.admin("POST", `/organizations/${of.id}/members/import`, { addresses }))
  expect(answer.counts).toMatchObject({ created: addresses.length, refused: 0 })
  return addresses
}

const userOf = async (address: string) => (await query<{ id: string }>`select id from users where email = ${address}`)[0]?.id
const memberOf = async (address: string, of: Firm) =>
  (await query<{ id: string }>`select m.id from members m join users u on u.id = m.user_id where u.email = ${address} and m.organization_id = ${of.id}`)[0]!.id

/** Prove a firm's domain as a DNS record would leave it: nobody publishes a TXT record here, so this writes what finding one leaves (the admin journeys do the same). */
const prove = (of: Firm, domain = of.domain) => query`update organization_domains set verified_at = now() where domain = ${domain} and organization_id = ${of.id}`

/** Let a minute pass for an address: its request rows move back, so that the per-address-and-client limit of one mail a minute no longer counts them. */
const aMinutePasses = (address: string) => query`update magic_link_requests set created_at = created_at - interval '2 minutes' where email = ${address}`

// ---- browsers ----

/** A browser of its own: its own cookies, as a person's phone or a second browser has. */
async function newBrowser() {
  const context = await browser.newContext()
  context.setDefaultTimeout(30_000)
  contexts.push(context)
  return context
}

type Seen = { heading: string; buttons: string[]; text: string }
/** What a page shows: its heading, the names of its buttons and its text. */
async function see(page: Page): Promise<Seen> {
  // A page with no heading (an error page of the authorisation flow, say) is read as such, so that a test fails on what it expected and not on a timeout.
  const heading = await page.getByRole("heading", { level: 1 }).first().innerText({ timeout: 5_000 }).catch(() => "(no heading)")
  const buttons = (await page.getByRole("button").allInnerTexts()).map(name => name.trim())
  return { heading, buttons, text: await page.evaluate(() => (document.querySelector("main") ?? document.body).innerText) }
}
/** The page with an address taken out, to compare what two people were shown. */
const without = (seen: Seen, ...addresses: string[]) => addresses.reduce((text, address) => text.replaceAll(address, "<address>"), seen.text)

/**
 * The session this browser holds, asked of ID by opening `/auth/get-session` in a tab with the browser's cookies. ID's pages allow a page no `fetch` (`default-src 'none'`),
 * so a page cannot ask for itself.
 */
async function sessionOf(context: BrowserContext) {
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/auth/get-session`)
    return JSON.parse(await page.locator("body").innerText()) as { user: { id: string; email: string }; session: { id: string } } | null
  } finally {
    await page.close()
  }
}

/** The sign-in form, as a person fills it: the address, then Continue. For a firm with links alone this is the "Check your email" page. */
async function askAtLogin(context: BrowserContext, address: string, path = "/login") {
  const page = await context.newPage()
  await page.goto(`${origin}${path}`)
  await page.getByLabel(/email/i).fill(address)
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.waitForLoadState()
  return page
}

/** The button of the choice page that a firm with both ways shows, for the link. */
const emailMe = (page: Page) => page.getByRole("button", { name: "Email me a sign-in link" })

/** Ask for a link and wait for the page that says to check the email; a firm with a directory as well asks which way first, and this chooses the link. `since` is when to start looking for mail. */
async function ask(context: BrowserContext, address: string) {
  const since = Date.now()
  const page = await askAtLogin(context, address)
  const checking = page.getByRole("heading", { name: "Check your email" })
  await emailMe(page).or(checking).waitFor()
  if (await emailMe(page).isVisible()) await emailMe(page).click()
  await checking.waitFor()
  return { page, since }
}

/** Sign in through the firm's company directory, which the fixture approves: with links on as well the choice page comes first, with them off ID goes straight there. */
async function viaDirectory(context: BrowserContext, address: string, { choice }: { choice: boolean }) {
  const page = await askAtLogin(context, address)
  if (choice) await page.getByRole("button", { name: /^Continue with / }).click()
  await page.getByRole("heading", { name: "Signed in" }).waitFor()
  return page
}

/** The first mail to `address` after `since`, with the link and the code read out of it. ID sends after it has answered the request, so this waits. */
async function mailTo(address: string, since: number) {
  const mail = await postmark.waitFor(address, { after: since })
  return { ...mail, ...readMail(mail), token: mail.text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? null }
}

/**
 * Prove that no mail went to `address` after `since`. Absence cannot be waited for, so a control person is asked for a link after it (the queue sends in order, five at a time,
 * each job a few statements and one call to the fake), the control's mail is awaited, and a short margin is left: a mail that was going to be sent has been sent by then.
 */
let controls = 0
async function noMail(address: string, since: number) {
  const control = `control-${++controls}@control.example.test`
  await list(controlFirm, `control-${controls}`)
  const controlSince = Date.now()
  const response = await fetch(`${origin}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: new URLSearchParams({ email: control }) })
  expect(response.status).toBe(200)
  await postmark.waitFor(control, { after: controlSince })
  await Bun.sleep(500)
  expect(postmark.messages().filter(mail => mail.to === address && mail.receivedAt > since).map(mail => mail.subject)).toEqual([])
}
// A firm only to hold the controls above; its people are never signed in.
let controlFirm: Firm

const requestsOf = (address: string) =>
  query<{ purpose: string; send_status: string; attempts: number; ended: boolean; token_identifier: string | null }>`
    select purpose, send_status, attempts, expires_at <= now() as ended, token_identifier from magic_link_requests where email = ${address} order by created_at, id`
const sessionsOf = (address: string) =>
  query<{ id: string; lifetime: number; upstream_auth_time: string | null; kind: string | null }>`
    select s.id, extract(epoch from s.expires_at - s.created_at)::int as lifetime, s.upstream_auth_time, p.kind
    from sessions s join users u on u.id = s.user_id left join sso_providers p on p.id = s.authentication_provider_id where u.email = ${address} order by s.created_at`
const accountsOf = (address: string) =>
  query<{ issuer: string; account_id: string }>`select a.issuer, a.account_id from accounts a join users u on u.id = a.user_id where u.email = ${address} and a.deleted_at is null order by a.created_at`
const auditOf = (address: string, action: string) =>
  query<{ reason: string | null; outcome: string }>`
    select reason, outcome from audit_events where action = ${action} and (target_id in (select id::text from users where email = ${address}) or target_id in (select id::text from magic_link_requests where email = ${address})
      or actor_id in (select id::text from users where email = ${address})) order by occurred_at`
/** The rows that hold a link's token in Better Auth's table: its name is the token's hash. */
const stored = async (token: string) => (await query`select 1 from verifications where identifier = ${`magic-link:${createHash("sha256").update(token).digest("base64url")}`}`).length

const elsewhere = "This link can't sign you in here"
const codeRefused = "That code didn't work"
const removed = "Your access was removed"
/** A response body as the page reads, since the HTML escapes an apostrophe. */
const readable = async (response: { text(): Promise<string> }) => (await response.text()).replaceAll("&#39;", "'")
/**
 * POST a form as a browser does, with that browser's cookies and its Origin, and read the answer unfollowed. It is `fetch` because Playwright's request context cannot read a
 * Set-Cookie under Bun. Without a browser it sends no cookie, as a mail gateway does.
 */
async function post(path: string, form: Record<string, string>, context?: BrowserContext) {
  const cookie = context ? (await context.cookies(origin)).map(item => `${item.name}=${item.value}`).join("; ") : ""
  return fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin, ...(cookie && { cookie }) }, body: new URLSearchParams(form), redirect: "manual" })
}
const wrongCode = (right: string) => (right === "12345678" ? "87654321" : "12345678")

/** Open a link in a tab of a browser and read what the page shows. */
async function open(context: BrowserContext, link: string) {
  const page = await context.newPage()
  await page.goto(link)
  await page.locator("main").waitFor()
  return page
}
/** Type a code where the person asked for the link, and read the page that followed. */
async function enterCode(page: Page, code: string) {
  await page.locator('input[name="code"]').fill(code)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.waitForLoadState()
  return see(page)
}
/** Open the link in the browser that asked and press Continue. Returns the tab. */
async function continueWith(context: BrowserContext, link: string) {
  const tab = await open(context, link)
  await tab.getByRole("button", { name: "Continue", exact: true }).click()
  await tab.waitForLoadState()
  return tab
}
/** A full sign-in by link, as a person does it in one browser. */
async function signInByLink(context: BrowserContext, address: string) {
  const { page, since } = await ask(context, address)
  const mail = await mailTo(address, since)
  const tab = await continueWith(context, mail.link!)
  await tab.getByRole("heading", { name: "Signed in" }).waitFor()
  return { page, tab, mail, since }
}

/** Run a test body and, when it fails, say which pages the browsers were on. */
const onFailure = async <T>(contextsOf: BrowserContext[], body: () => Promise<T>) => {
  try {
    return await body()
  } catch (error) {
    for (const context of contextsOf)
      for (const page of context.pages()) console.error("[acceptance] ID page:", new URL(page.url()).pathname, await page.locator("body").innerText().catch(() => "(closed)"))
    throw error
  }
}

// ---- the application's authorisation, for the tests that need a token ----

/** Where an application sends the browser, as a public client with PKCE. */
async function authorisation() {
  const metadata = z.object({ authorization_endpoint: z.url(), token_endpoint: z.url() }).parse(await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json())
  const verifier = randomBytes(32).toString("base64url")
  const state = crypto.randomUUID()
  const authorize = new URL(metadata.authorization_endpoint)
  authorize.search = new URLSearchParams({
    response_type: "code", client_id: app.clientId, redirect_uri: callback, scope: `openid offline_access ${app.scope}`, resource: app.resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state,
  }).toString()
  return { metadata, verifier, state, authorize }
}

/** What an application does with the token endpoint, as a public client with PKCE. */
async function appFlow(context: BrowserContext, address: string) {
  const { metadata, verifier, state, authorize } = await authorisation()
  const since = Date.now()
  const page = await context.newPage()
  await page.goto(authorize.href)
  // The authorisation has no session yet, so ID sends the browser to its sign-in page with the request signed into the query.
  await page.getByLabel(/email/i).fill(address)
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  const withLink = page.getByRole("button", { name: "Email me a sign-in link" })
  const checking = page.getByRole("heading", { name: "Check your email" })
  await withLink.or(checking).waitFor()
  if (await withLink.isVisible()) await withLink.click()
  await checking.waitFor()
  const mail = await mailTo(address, since)
  const tab = await context.newPage()
  await tab.goto(mail.link!)
  await tab.getByRole("button", { name: "Continue", exact: true }).click()
  // The sign-in resumes the authorisation: the organisation, then consent, then the application's callback.
  await tab.getByRole("heading", { name: "Choose an organisation" }).waitFor()
  await tab.getByRole("button", { name: "Continue", exact: true }).click()
  await tab.getByRole("heading", { name: "Access it will receive" }).waitFor()
  await tab.getByRole("button", { name: "Accept", exact: true }).click()
  await tab.waitForURL(`${callback}?**`)
  const returned = new URL(tab.url())
  expect(returned.searchParams.get("state")).toBe(state)
  expect(returned.searchParams.get("iss")).toBe(origin)
  const token = (body: Record<string, string>) =>
    fetch(metadata.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: app.clientId, resource: app.resource, ...body }) })
  const issued = z.object({ access_token: z.string(), refresh_token: z.string() }).parse(
    await (await token({ grant_type: "authorization_code", code: returned.searchParams.get("code")!, redirect_uri: callback, code_verifier: verifier })).json(),
  )
  return { ...issued, claims: decodeJwt(issued.access_token), refresh: (refreshToken = issued.refresh_token) => token({ grant_type: "refresh_token", refresh_token: refreshToken }), mail }
}

describe("sign-in by emailed link", () => {
  beforeAll(async () => {
    controlFirm = { id: z.uuid().parse((await id.admin("POST", "/organizations", { slug: "control", name: "control" })).id), slug: "control", name: "control", domain: "control.example.test" }
    await id.admin("POST", `/organizations/${controlFirm.id}/magic-link/enable`)
    await addDomain(id.admin, controlFirm.id, controlFirm.domain)
  })

  test("1. a listed person asks at /login, sees Check your email, and the fake Postmark holds one mail with a link and an 8-digit code", async () => {
    const alpha = await firm("alpha", "Alpha Firm")
    const [ada] = await list(alpha, "ada")
    const context = await newBrowser()
    await onFailure([context], async () => {
      const { page, since } = await ask(context, ada!)
      const seen = await see(page)
      expect(seen.heading).toBe("Check your email")
      expect(seen.text).toContain(`If ${ada} can sign in here, we've sent it a link and a code.`)
      expect(seen.buttons).toEqual(["Sign in"])
      const mail = await mailTo(ada!, since)
      expect(mail).toMatchObject({
        // The sender and the reply address are ID's configuration; the subject and the tag are the template's.
        from: "Answerable ID <sign-in@id.example.com>", replyTo: "support@example.com", subject: "Sign in to Alpha Firm", tag: tags.link, tracking: { opens: false, links: "None" },
      })
      expect(mail.code).toMatch(/^\d{8}$/)
      expect(mail.link).toStartWith(`${origin}/magic-link?token=`)
      expect(mail.html).toContain(mail.code!)
      expect(mail.html).toContain(mail.token!)
      expect(postmark.messages().filter(item => item.to === ada)).toHaveLength(1)
      // The browser that asked holds the cookie the link and the code are bound to.
      expect((await context.cookies(origin)).find(cookie => cookie.name === signInCookie)).toMatchObject({ httpOnly: true, sameSite: "Lax" })
      // The request is stored sent, with no attempt, and the database holds neither the token nor the code: a hash of the one and a keyed hash of the other.
      expect(await requestsOf(ada!)).toEqual([expect.objectContaining({ purpose: "link", send_status: "sent", attempts: 0, ended: false })])
      const everything = JSON.stringify([await query`select * from magic_link_requests where email = ${ada}`, await query`select * from verifications where identifier like 'magic-link:%'`])
      expect(everything).not.toContain(mail.token!)
      expect(everything).not.toContain(mail.code!)
      expect(await stored(mail.token!)).toBe(1)
      step("1. request and read mail: Check your email, one mail with a link and an 8-digit code, sender and tag as set, the database holding hashes")
    })
  })

  test("2. a mail gateway's GET and HEAD, with no cookie, consume nothing; a form-filling scanner in another browser signs nobody in and changes nothing; the link still works", async () => {
    const scans = await firm("scans", "Scans Firm")
    const [sam, other] = await list(scans, "sam", "other")
    const asking = await newBrowser()
    await onFailure([asking], async () => {
      const { since } = await ask(asking, sam!)
      const mail = await mailTo(sam!, since)
      const before = await requestsOf(sam!)
      expect(before).toEqual([expect.objectContaining({ send_status: "sent", attempts: 0, ended: false })])

      // The gateway fetches the link as a cookieless client, more than once.
      for (let round = 0; round < 3; round++) {
        const got = await fetch(mail.link!, { redirect: "manual" })
        const page = await readable(got)
        expect(got.status).toBe(200)
        expect(page).toContain(elsewhere)
        expect(page).not.toContain('action="/magic-link"')
        const head = await fetch(mail.link!, { method: "HEAD", redirect: "manual" })
        expect(head.status).toBe(200)
        expect(await head.text()).toBe("")
        expect(got.headers.get("set-cookie")).toBeNull()
      }

      // A scanner that posts the page's own form from a browser that never asked: it has no cookie, so the code finds no request to act on.
      const scanner = await newBrowser()
      const posted = await post("/magic-link", { token: mail.token! }, scanner)
      expect(posted.status).toBe(200)
      expect(posted.headers.get("set-cookie")).toBeNull()
      expect(await readable(posted)).toContain(elsewhere)
      expect((await scanner.cookies(origin)).map(cookie => cookie.name)).toEqual([])
      expect(await sessionOf(scanner)).toBeNull()

      // And one that has a cookie of its own, from asking for another person's link: it is still not the browser that asked.
      const rival = await newBrowser()
      const rivalAsked = await ask(rival, other!)
      const rivalMail = await mailTo(other!, rivalAsked.since)
      const rivalPost = await post("/magic-link", { token: mail.token! }, rival)
      expect(rivalPost.headers.get("set-cookie")).toBeNull()
      expect(await readable(rivalPost)).toContain(elsewhere)
      expect(await sessionOf(rival)).toBeNull()

      // Nothing happened to the request: no attempt, not ended, no session, and the token is still stored.
      expect(await requestsOf(sam!)).toEqual(before)
      expect(await requestsOf(other!)).toEqual([expect.objectContaining({ send_status: "sent", attempts: 0, ended: false })])
      expect(await sessionsOf(sam!)).toEqual([])
      expect(await stored(mail.token!)).toBe(1)
      expect(await stored(rivalMail.token!)).toBe(1)
      expect(await auditOf(sam!, "auth.magic_link.refused")).toEqual([])

      // The person who asked still signs in with the same link.
      const tab = await continueWith(asking, mail.link!)
      await tab.getByRole("heading", { name: "Signed in" }).waitFor()
      expect(await sessionOf(asking)).toMatchObject({ user: { email: sam } })
      expect(await sessionsOf(sam!)).toHaveLength(1)
      step("2. scanners: three GETs and HEADs without a cookie, a form POST from a browser with none and one from a browser with another cookie all changed nothing; the link then signed the person in")
    })
  })

  test("3. the link in the browser that asked shows Continue, and Continue signs the person in for 24 hours with no authority from a directory", async () => {
    const confirm = await firm("confirm", "Confirm Firm")
    const [cora] = await list(confirm, "cora")
    const context = await newBrowser()
    await onFailure([context], async () => {
      const { since } = await ask(context, cora!)
      const mail = await mailTo(cora!, since)
      const tab = await open(context, mail.link!)
      const continuing = await see(tab)
      expect(continuing).toMatchObject({ heading: "Sign in", buttons: ["Continue"] })
      expect(continuing.text).toContain(`Continue as ${cora}`)
      expect(await sessionsOf(cora!)).toEqual([])
      await tab.getByRole("button", { name: "Continue", exact: true }).click()
      await tab.getByRole("heading", { name: "Signed in" }).waitFor()
      const signedIn = await see(tab)
      expect(signedIn.text).toContain(`Signed in as ${cora}`)
      // A directory session offers to connect another work account; a link session has none to connect.
      expect(signedIn.text).not.toContain("connect a work account")
      expect(await sessionOf(context)).toMatchObject({ user: { email: cora } })
      // The session, as the database holds it: from the firm's magic-link origin, 24 hours, and no upstream sign-in time.
      expect(await sessionsOf(cora!)).toEqual([{ id: expect.any(String), lifetime: 86_400, upstream_auth_time: null, kind: "magic_link" }])
      expect(await accountsOf(cora!)).toEqual([{ issuer: "urn:answerable:magic-link", account_id: cora! }])
      expect(await requestsOf(cora!)).toEqual([expect.objectContaining({ attempts: 0, ended: true })])
      expect((await query<{ n: number }>`select count(*)::int as n from audit_events where action = 'auth.signin.succeeded' and actor_id = ${await userOf(cora!)}`)[0]!.n).toBe(1)
      step("3. confirm: Continue in the browser that asked, signed in as the person, a 24-hour magic-link session with no upstream time")
    })
  })

  test("4. the link in a second browser signs nobody in and the code typed where the person asked does; the link then no longer works; three wrong codes end the request", async () => {
    const codes = await firm("codes", "Codes Firm")
    const [bob, carol] = await list(codes, "bob", "carol")
    const first = await newBrowser()
    const second = await newBrowser()
    await onFailure([first, second], async () => {
      const { page, since } = await ask(first, bob!)
      const mail = await mailTo(bob!, since)
      const elsewhereTab = await open(second, mail.link!)
      const there = await see(elsewhereTab)
      expect(there.heading).toBe(elsewhere)
      expect(there.buttons).toEqual([])
      expect(await sessionOf(second)).toBeNull()

      // One wrong code is refused on the same page, and counts as one attempt.
      const refused = await enterCode(page, wrongCode(mail.code!))
      expect(refused.heading).toBe(codeRefused)
      expect(await requestsOf(bob!)).toEqual([expect.objectContaining({ attempts: 1, ended: false })])
      // The right one signs in, where the person asked; it was the second try.
      const signedIn = await enterCode(page, mail.code!)
      expect(signedIn.heading).toBe("Signed in")
      expect(await sessionOf(first)).toMatchObject({ user: { email: bob } })
      expect(await sessionOf(second)).toBeNull()
      expect(await requestsOf(bob!)).toEqual([expect.objectContaining({ attempts: 2, ended: true })])
      // The link that came with the code is spent, in either browser.
      for (const context of [first, second]) expect((await see(await open(context, mail.link!))).heading).toBe(elsewhere)

      // Three wrong codes end a request: the right code and the link are refused after them, and the trail holds one row.
      const third = await newBrowser()
      const asked = await ask(third, carol!)
      const carolMail = await mailTo(carol!, asked.since)
      for (let guess = 0; guess < 3; guess++) expect((await enterCode(asked.page, wrongCode(carolMail.code!))).heading).toBe(codeRefused)
      expect(await requestsOf(carol!)).toEqual([expect.objectContaining({ attempts: 3, ended: true })])
      expect((await enterCode(asked.page, carolMail.code!)).heading).toBe(codeRefused)
      expect((await see(await open(third, carolMail.link!))).heading).toBe(elsewhere)
      expect(await sessionOf(third)).toBeNull()
      expect(await sessionsOf(carol!)).toEqual([])
      expect(await auditOf(carol!, "auth.magic_link.code_exhausted")).toEqual([{ reason: "code_attempts", outcome: "denied" }])
      step("4. code from a second browser: the link showed no Continue there, the code signed in where asked and spent the link, and three wrong codes ended the request with one audit row")
    })
  })

  test("5. the app's flow: a person arrives from an OAuth client, signs in by link, reaches consent and the callback, and the token says magic_link", async () => {
    const appFirm = await firm("appfirm", "App Firm")
    const [dana] = await list(appFirm, "dana")
    const context = await newBrowser()
    await onFailure([context], async () => {
      const tokens = await appFlow(context, dana!)
      expect(tokens.claims).toMatchObject({ iss: origin, authentication_method: "magic_link", sub: await userOf(dana!), organization_id: appFirm.id })
      expect(tokens.claims.aud).toContain(app.resource)
      expect(tokens.claims.upstream_auth_time ?? null).toBeNull()
      // A refresh keeps how the person signed in.
      const refreshed = await tokens.refresh()
      expect(refreshed.status).toBe(200)
      expect(decodeJwt(z.object({ access_token: z.string() }).parse(await refreshed.json()).access_token)).toMatchObject({ authentication_method: "magic_link" })
      // D3, from the rows: the session lasts 24 hours and the grant 7 days. Nobody waits for either.
      expect(await sessionsOf(dana!)).toEqual([expect.objectContaining({ lifetime: 86_400, kind: "magic_link" })])
      const grants = await query<{ lifetime: number; kind: string }>`
        select extract(epoch from g.expires_at - g.created_at)::int as lifetime, p.kind from grant_contexts g join users u on u.id = g.user_id
        join sso_providers p on p.id = g.authentication_provider_id where u.email = ${dana}`
      expect(grants).toEqual([{ lifetime: 604_800, kind: "magic_link" }])
      step("5. the app's flow: the callback's code became a token with authentication_method magic_link; the session row lasts 24 hours and the grant row 7 days")
    })
  })

  // ---- 5b: a directory session that falls due along the way ----

  test("5b. a directory session that falls due during an application's authorisation: each page answers as itself, a reload included, and it ends with a code", async () => {
    // A refresh sets the session cookie, and on a request carrying an authorisation the provider takes that for a new sign-in and replaces the answer. A session falls due a day
    // after its last refresh, so a person can meet this in the middle of one authorisation; the application's first request has refreshed it by then in every other case.
    const steady = await directoryFirm("due-session", "Due Session Firm")
    const tester = steady.directory.email
    const expiry = async () => (await query<{ at: string }>`select s.expires_at::text as at from sessions s join users u on u.id = s.user_id where u.email = ${tester}`)[0]!.at
    const context = await newBrowser()
    await onFailure([context], async () => {
      await viaDirectory(context, tester, { choice: true })
      const { state, authorize } = await authorisation()
      const page = await context.newPage()
      await page.goto(authorize.href)
      const chooser = page.getByRole("heading", { name: "Choose an organisation" })
      await chooser.waitFor()
      await query`update sessions set expires_at = now() + interval '5 days' where user_id = (select id from users where email = ${tester})`
      const due = await expiry()
      await page.reload()
      await chooser.waitFor()
      await page.getByRole("button", { name: /^Continue/ }).click()
      const consent = page.getByRole("heading", { name: "Access it will receive" })
      await consent.waitFor()
      await page.reload()
      await consent.waitFor()
      await page.getByRole("button", { name: "Accept", exact: true }).click()
      await page.waitForURL(`${callback}?**`)
      const returned = new URL(page.url())
      expect(returned.searchParams.get("state")).toBe(state)
      expect(returned.searchParams.get("code")).toBeString()
      expect(await expiry()).toBe(due)
      step("5b. a session due for its refresh: the selection page, the consent page and their reloads answered as themselves, the callback got a code, and the session stayed as it was")
    })
  })

  // ---- 6: the switch ----

  /** What `magiclink.enable` and `magiclink.disable` commit: ID's admin call, which answers the organisation. */
  const setLinks = async (of: Firm, on: boolean) => z.object({ magicLink: z.object({ enabled: z.boolean() }) }).parse(await id.admin("POST", `/organizations/${of.id}/magic-link/${on ? "enable" : "disable"}`))

  test("6a. magiclink.disable ends a firm's link sessions and grants, a link and a code already mailed, and sends nothing while the page stays uniform; magiclink.enable lets a new request work and brings none of it back", async () => {
    const toggle = await firm("toggle", "Toggle Firm")
    const [lia, mia, moe, max, mel, ned] = await list(toggle, "lia", "mia", "moe", "max", "mel", "ned")
    const outsider = `outsider@${toggle.domain}`
    const [liaBrowser, miaBrowser, moeBrowser, maxBrowser, melBrowser] = [await newBrowser(), await newBrowser(), await newBrowser(), await newBrowser(), await newBrowser()]
    await onFailure([liaBrowser, miaBrowser, moeBrowser, maxBrowser, melBrowser], async () => {
      // Lia holds a session and a grant. The others have a link or a code in their mail: mia's and moe's are used while links are off, max's and mel's after they are back on.
      const tokens = await appFlow(liaBrowser, lia!)
      const renewed = await tokens.refresh()
      expect(renewed.status).toBe(200)
      const liaRefresh = z.object({ refresh_token: z.string() }).parse(await renewed.json()).refresh_token
      const asked = {
        mia: await ask(miaBrowser, mia!), moe: await ask(moeBrowser, moe!), max: await ask(maxBrowser, max!), mel: await ask(melBrowser, mel!),
      }
      const mails = {
        mia: await mailTo(mia!, asked.mia.since), moe: await mailTo(moe!, asked.moe.since), max: await mailTo(max!, asked.max.since), mel: await mailTo(mel!, asked.mel.since),
      }
      expect((await see(await open(liaBrowser, `${origin}/login`))).heading).toBe("Signed in")

      const off = await setLinks(toggle, false)
      expect(off.magicLink.enabled).toBe(false)
      // The session and the grant are over: the page does not say signed in, and a refresh is refused.
      expect((await see(await open(liaBrowser, `${origin}/login`))).heading).toBe("Sign in")
      const stale = await tokens.refresh(liaRefresh)
      expect([stale.status, await stale.json()]).toEqual([400, expect.objectContaining({ error: "invalid_grant" })])
      // A link opens (a GET consumes nothing) but Continue is refused, and a code typed where it was asked is refused: each ends its request with one audit row.
      expect((await see(await continueWith(miaBrowser, mails.mia.link!))).heading).toBe(elsewhere)
      expect((await enterCode(asked.moe.page, mails.moe.code!)).heading).toBe(codeRefused)
      for (const person of [mia!, moe!]) {
        expect(await auditOf(person, "auth.magic_link.refused")).toEqual([{ reason: "not_admitted", outcome: "denied" }])
        expect(await sessionsOf(person)).toEqual([])
      }
      // A new request: the same page for a listed person and for anyone else, whatever it is, and no mail.
      const sinceOff = Date.now()
      const asLia = await see(await askAtLogin(await newBrowser(), lia!))
      const asOutsider = await see(await askAtLogin(await newBrowser(), outsider))
      expect(without(asLia, lia!)).toBe(without(asOutsider, outsider))
      expect(asLia.heading).not.toBe("Check your email")
      await noMail(lia!, sinceOff)
      await noMail(outsider, sinceOff)

      const on = await setLinks(toggle, true)
      expect(on.magicLink.enabled).toBe(true)
      // A new request works, from a person who had never asked, and signs in.
      const back = await signInByLink(await newBrowser(), ned!)
      expect(await sessionOf(back.tab.context())).toMatchObject({ user: { email: ned } })
      // Nothing ended comes back: the session, the grant, and the link and the code mailed before the switch, which ID would have honoured had it stayed on.
      expect((await see(await open(liaBrowser, `${origin}/login`))).heading).toBe("Sign in")
      expect((await tokens.refresh(liaRefresh)).status).toBe(400)
      expect((await see(await continueWith(maxBrowser, mails.max.link!))).heading).toBe(elsewhere)
      expect((await enterCode(asked.mel.page, mails.mel.code!)).heading).toBe(codeRefused)
      for (const person of [max!, mel!]) {
        expect(await auditOf(person, "auth.magic_link.refused")).toEqual([{ reason: "provider_changed", outcome: "denied" }])
        expect(await sessionsOf(person)).toEqual([])
      }
      step("6a. toggle: off ended the session, the grant and the mailed link and code, with one uniform page and no mail; on let a new person in and revived none of it")
    })
  })

  test("6b. magiclink.disable and magiclink.enable leave a firm's directory sign-in alone: its session stays, and it signs in while links are off", async () => {
    const both = await directoryFirm("toggle-both", "Both Firm")
    const tester = both.directory.email
    const first = await newBrowser()
    await onFailure([first], async () => {
      // With both ways on, ID asks which; the person takes the directory.
      await viaDirectory(first, tester, { choice: true })
      expect(await sessionOf(first)).toMatchObject({ user: { email: tester } })
      await setLinks(both, false)
      expect((await see(await open(first, `${origin}/login`))).text).toContain(`Signed in as ${tester}`)
      // With links off, the sign-in page sends the person straight to the directory.
      const second = await newBrowser()
      await viaDirectory(second, tester, { choice: false })
      await setLinks(both, true)
      expect((await see(await open(first, `${origin}/login`))).text).toContain(`Signed in as ${tester}`)
      expect((await see(await open(second, `${origin}/login`))).text).toContain(`Signed in as ${tester}`)
      expect((await sessionsOf(tester)).map(session => session.kind)).toEqual(["oidc", "oidc"])
      step("6b. toggle: a directory session lived through links off and on, and the directory signed a second sign-in in while they were off")
    })
  })

  // ---- 7: who may ask ----

  test("7a. listed mode: a listed person gets a link, and anyone else at the domain sees the same page and gets no mail", async () => {
    const listed = await firm("admit-listed", "Listed Firm")
    const [member] = await list(listed, "member")
    const stranger = `stranger@${listed.domain}`
    const [one, two] = [await newBrowser(), await newBrowser()]
    await onFailure([one, two], async () => {
      const since = Date.now()
      const asMember = await ask(one, member!)
      const asStranger = await ask(two, stranger)
      expect(without(await see(asMember.page), member!)).toBe(without(await see(asStranger.page), stranger))
      expect((await mailTo(member!, since)).tag).toBe(tags.link)
      await noMail(stranger, since)
      expect(await requestsOf(stranger)).toEqual([])
      step("7a. admission: a listed person had a mail; a stranger at the same domain saw the same page and had none, and left no row")
    })
  })

  test("7b. a removed member: a new request gets the page a stranger gets and no mail, and an old link or code shows that access was removed", async () => {
    const gone = await firm("admit-removed", "Removed Firm")
    const [byLink, byCode, fresh] = await list(gone, "by-link", "by-code", "fresh")
    const stranger = `stranger@${gone.domain}`
    const [linkBrowser, codeBrowser, freshBrowser, strangerBrowser] = [await newBrowser(), await newBrowser(), await newBrowser(), await newBrowser()]
    await onFailure([linkBrowser, codeBrowser, freshBrowser, strangerBrowser], async () => {
      const links = await ask(linkBrowser, byLink!)
      const linkMail = await mailTo(byLink!, links.since)
      const codes = await ask(codeBrowser, byCode!)
      const codeMail = await mailTo(byCode!, codes.since)
      const remove = async (address: string) => id.admin("DELETE", `/organizations/${gone.id}/members/${await memberOf(address, gone)}`)
      for (const address of [byLink!, byCode!, fresh!]) await remove(address)

      expect((await see(await continueWith(linkBrowser, linkMail.link!))).heading).toBe(removed)
      expect((await enterCode(codes.page, codeMail.code!)).heading).toBe(removed)
      for (const address of [byLink!, byCode!]) {
        expect(await auditOf(address, "auth.magic_link.refused")).toEqual([{ reason: "access_removed", outcome: "denied" }])
        expect(await sessionsOf(address)).toEqual([])
      }

      // Someone removed who had not asked: the same page as a stranger gets, no mail and no row.
      const since = Date.now()
      const asRemoved = await ask(freshBrowser, fresh!)
      const asStranger = await ask(strangerBrowser, stranger)
      expect(without(await see(asRemoved.page), fresh!)).toBe(without(await see(asStranger.page), stranger))
      await noMail(fresh!, since)
      await noMail(stranger, since)
      expect(await requestsOf(fresh!)).toEqual([])
      step("7b. admission: removed members had the uniform page and no mail; an old link and an old code both said access was removed")
    })
  })

  test("7c. domain mode needs a proved domain; then anyone at it gets a link and a first sign-in makes them, a domain added later admits nobody until it is proved, and a removed person still gets no mail", async () => {
    const wide = await firm("admit-domain", "Domain Firm")
    const [gone] = await list(wide, "gone")
    const newcomer = `newcomer@${wide.domain}`
    const narrow = `narrow@${wide.domain}`
    const admission = (to: string) => id.admin("PATCH", `/organizations/${wide.id}/magic-link`, { admission: to })
    await onFailure([], async () => {
      // ID refuses to open the firm while its domain is unproved.
      await expect(admission("domain")).rejects.toThrow(/409.*domain_not_verified/)
      await prove(wide)
      expect(await admission("domain")).toMatchObject({ magicLink: { admission: "domain" } })

      // A person nobody listed asks, gets a link, and signing in makes them.
      expect(await userOf(newcomer)).toBeUndefined()
      const context = await newBrowser()
      const signedIn = await signInByLink(context, newcomer)
      expect(signedIn.mail.subject).toBe("Sign in to Domain Firm")
      expect(await sessionOf(context)).toMatchObject({ user: { email: newcomer } })
      expect(await query`select 1 from members m join users u on u.id = m.user_id where u.email = ${newcomer} and m.organization_id = ${wide.id} and m.status = 'active'`).toHaveLength(1)

      // A domain added after the switch admits nobody until it is proved, and then everyone at it.
      const late = `late.${wide.domain}`
      await addDomain(id.admin, wide.id, late)
      const lateAddress = `someone@${late}`
      const sinceLate = Date.now()
      const lateAsk = await ask(await newBrowser(), lateAddress)
      await noMail(lateAddress, sinceLate)
      expect(await requestsOf(lateAddress)).toEqual([])
      await prove(wide, late)
      const provedAsk = Date.now()
      await ask(await newBrowser(), `other@${late}`)
      expect((await mailTo(`other@${late}`, provedAsk)).tag).toBe(tags.link)
      expect(await see(lateAsk.page)).toMatchObject({ heading: "Check your email" })

      // A member removed gets no mail whichever mode the firm is in, and nor does a person of a firm back in listed mode, who is not a member.
      await id.admin("DELETE", `/organizations/${wide.id}/members/${await memberOf(gone!, wide)}`)
      const sinceGone = Date.now()
      await ask(await newBrowser(), gone!)
      await noMail(gone!, sinceGone)
      expect(await admission("listed")).toMatchObject({ magicLink: { admission: "listed" } })
      const sinceNarrow = Date.now()
      await ask(await newBrowser(), narrow)
      await noMail(narrow, sinceNarrow)
      step("7c. admission: domain mode was refused unproved, admitted and created a newcomer, ignored an unproved second domain until proved, kept removal, and narrowed back to listed")
    })
  })

  test("7d. a person with an account from another firm's directory gets the same page as anyone and no mail", async () => {
    const mover = await directoryFirm("mover", "Mover Firm")
    const tester = mover.directory.email
    const landing = await firm("landing", "Landing Firm")
    await onFailure([], async () => {
      // The person signs in through the first firm's directory, once: an account of that firm's.
      await viaDirectory(await newBrowser(), tester, { choice: true })
      expect(await accountsOf(tester)).toEqual([expect.objectContaining({ issuer: mover.directory.issuer })])
      // The domain then moves to a firm that signs in by link and admits its whole domain.
      await id.admin("DELETE", `/organizations/${mover.id}/sso-provider`)
      const [{ id: domainId }] = z.object({ items: z.array(z.object({ id: z.uuid() })) }).parse(await id.admin("GET", `/organizations/${mover.id}/domains`)).items as [{ id: string }]
      await id.admin("DELETE", `/organizations/${mover.id}/domains/${domainId}`)
      await addDomain(id.admin, landing.id, mover.domain)
      // Domain mode needs every active domain of the firm proved, its own as well.
      await prove(landing, mover.domain)
      await prove(landing)
      await id.admin("PATCH", `/organizations/${landing.id}/magic-link`, { admission: "domain" })

      const noone = `noone@${mover.domain}`
      const since = Date.now()
      const asPerson = await ask(await newBrowser(), tester)
      const asNoone = await ask(await newBrowser(), noone)
      expect(without(await see(asPerson.page), tester)).toBe(without(await see(asNoone.page), noone))
      // Someone nobody holds does get a mail in domain mode; the person with the other firm's account does not.
      expect((await mailTo(noone, since)).tag).toBe(tags.link)
      await noMail(tester, since)
      expect(await requestsOf(tester)).toEqual([])
      step("7d. admission: a person with another firm's directory account, at a domain that moved, saw the same page as a new address and had no mail")
    })
  })

  // ---- 8: firms apart ----

  test("8. a link and a code from one firm do not work in the other firm's browser, the refusals look alike, and neither request is spent by the other", async () => {
    const [a, b] = [await firm("iso-a", "Firm A"), await firm("iso-b", "Firm B")]
    const [ana] = await list(a, "ana")
    const [ben] = await list(b, "ben")
    const [inA, inB] = [await newBrowser(), await newBrowser()]
    await onFailure([inA, inB], async () => {
      const askedA = await ask(inA, ana!)
      const askedB = await ask(inB, ben!)
      const mailA = await mailTo(ana!, askedA.since)
      const mailB = await mailTo(ben!, askedB.since)
      expect(mailA.subject).toBe("Sign in to Firm A")
      expect(mailB.subject).toBe("Sign in to Firm B")

      // Each link, opened in the other firm's browser, is any other browser's link; and unknown tokens look the same.
      const unknown = `${origin}/magic-link?token=${"u".repeat(32)}`
      const pages = [await see(await open(inB, mailA.link!)), await see(await open(inA, mailB.link!)), await see(await open(inB, unknown))]
      expect(new Set(pages.map(page => page.text)).size).toBe(1)
      expect(pages[0]!.heading).toBe(elsewhere)

      // Each code, typed on the other firm's page, is a wrong code: the same page as a wrong code, counted against the page's own request alone.
      const crossed = [await enterCode(askedB.page, mailA.code!), await enterCode(askedA.page, wrongCode(mailA.code!)), await enterCode(askedA.page, mailB.code!)]
      expect(new Set(crossed.map(page => page.text)).size).toBe(1)
      expect(crossed[0]!.heading).toBe(codeRefused)
      expect(await requestsOf(ben!)).toEqual([expect.objectContaining({ attempts: 1, ended: false })])
      expect(await requestsOf(ana!)).toEqual([expect.objectContaining({ attempts: 2, ended: false })])
      expect(await sessionsOf(ana!)).toEqual([])
      expect(await sessionsOf(ben!)).toEqual([])

      // Each person still signs in at their own firm with their own code, and the session is that firm's.
      expect((await enterCode(askedA.page, mailA.code!)).heading).toBe("Signed in")
      expect((await enterCode(askedB.page, mailB.code!)).heading).toBe("Signed in")
      expect(await sessionOf(inA)).toMatchObject({ user: { email: ana } })
      expect(await sessionOf(inB)).toMatchObject({ user: { email: ben } })
      const origins = await query<{ email: string; organization: string }>`
        select u.email, o.slug as organization from sessions s join users u on u.id = s.user_id join organizations o on o.id = s.authentication_organization_id where u.email in (${ana}, ${ben}) order by u.email`
      expect(origins).toEqual([{ email: ana, organization: "iso-a" }, { email: ben, organization: "iso-b" }])
      step("8. firm isolation: crossed links and codes were refused alike and spent only the page's own request; each person then signed in at their own firm")
    })
  })

  // ---- 9: two at once ----

  test("9. two browsers posting one confirmation at once make one session and one friendly failure, for a link and for a code", async () => {
    // Twenty rounds, ten of each kind, each with a person of its own: a person has one mail a minute. The in-process races run hundreds of rounds
    // (apps/id/src/auth/magic-link-races.integration.test.ts); what these add is a real process with its own pool, so that two confirmations really are two connections
    // waiting on the same locks. A confirmation that did not take them would show as two sessions in some round, which the mutation run checks.
    // The two posts are `fetch` calls with the browser's cookie copied into each, in one `Promise.all`: Playwright's request context cannot read a Set-Cookie under Bun.
    const rounds = 10
    const race = await firm("race", "Race Firm")
    const addresses = await list(race, ...Array.from({ length: 2 * rounds }, (_, n) => `racer-${n}`))
    const reached: string[] = []
    await onFailure([], async () => {
      for (const [n, address] of addresses.entries()) {
        const byLink = n < rounds
        const since = Date.now()
        const asked = await fetch(`${origin}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: new URLSearchParams({ email: address }), redirect: "manual" })
        const cookie = asked.headers.getSetCookie().find(line => line.startsWith(`${signInCookie}=`))!.split(";")[0]!
        const mail = await mailTo(address, since)
        // Two browsers that hold the same cookie, as two windows or a double click do.
        const post = () =>
          fetch(`${origin}${byLink ? "/magic-link" : "/magic-link/code"}`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie }, body: new URLSearchParams(byLink ? { token: mail.token! } : { code: mail.code! }), redirect: "manual",
          })
        const answers = await Promise.all([post(), post()])
        expect(answers.map(answer => answer.status).toSorted()).toEqual([200, 303])
        expect(await readable(answers.find(answer => answer.status === 200)!)).toContain(byLink ? elsewhere : codeRefused)
        // The winner's cookies are a session for this person, in a browser of its own.
        const winner = await newBrowser()
        await winner.addCookies(answers.find(answer => answer.status === 303)!.headers.getSetCookie().map(line => {
          const [name, ...value] = line.split(";")[0]!.split("=")
          return { name: name!, value: value.join("="), url: origin }
        }))
        expect(await sessionOf(winner)).toMatchObject({ user: { email: address } })
        await winner.close()
        expect(await sessionsOf(address)).toHaveLength(1)
        const user = await userOf(address)
        expect((await query<{ n: number }>`select count(*)::int as n from audit_events where action = 'auth.signin.succeeded' and actor_id = ${user}`)[0]!.n).toBe(1)
        // The loser may be turned away before it reaches the database or after it waits on the winner: then it leaves one refusal, never a second sign-in.
        const refusals = await auditOf(address, "auth.magic_link.refused")
        expect(refusals.length).toBeLessThanOrEqual(1)
        for (const refusal of refusals) expect(["ended", "token_consumed"]).toContain(refusal.reason!)
        reached.push(`${byLink ? "link" : "code"}:${refusals.length}`)
      }
      step(`9. race: ${rounds} rounds of a link and ${rounds} of a code, two posts at once each: one session and one sign-in every time; the loser reached the database and left one refusal in ${reached.filter(item => item.endsWith(":1")).length} of ${2 * rounds}`)
    })
  })

  // ---- 10: used once ----

  test("10. a used link and a used code each refuse a second try, with the page any link that is not for this browser shows", async () => {
    const replay = await firm("replay", "Replay Firm")
    const [rita, rob] = await list(replay, "rita", "rob")
    const [linkBrowser, codeBrowser, elsewhereBrowser] = [await newBrowser(), await newBrowser(), await newBrowser()]
    await onFailure([linkBrowser, codeBrowser, elsewhereBrowser], async () => {
      const used = await signInByLink(linkBrowser, rita!)
      const unknown = `${origin}/magic-link?token=${"x".repeat(32)}`
      const pages = [await see(await open(linkBrowser, used.mail.link!)), await see(await open(elsewhereBrowser, used.mail.link!)), await see(await open(linkBrowser, unknown))]
      expect(new Set(pages.map(page => page.text)).size).toBe(1)
      expect(pages[0]).toMatchObject({ heading: elsewhere, buttons: [] })
      // Posting the spent link's own form, from the browser that holds the cookie, gives the same page and no second session.
      const posted = await post("/magic-link", { token: used.mail.token! }, linkBrowser)
      expect(posted.status).toBe(200)
      expect(await readable(posted)).toContain(elsewhere)
      expect(await sessionsOf(rita!)).toHaveLength(1)
      // A replay finds nothing live, so it is not a refusal at confirm: no attempt, no audit row.
      expect(await auditOf(rita!, "auth.magic_link.refused")).toEqual([])

      const asked = await ask(codeBrowser, rob!)
      const mail = await mailTo(rob!, asked.since)
      expect((await enterCode(asked.page, mail.code!)).heading).toBe("Signed in")
      const again = await post("/magic-link/code", { code: mail.code! }, codeBrowser)
      const wrong = await post("/magic-link/code", { code: wrongCode(mail.code!) }, codeBrowser)
      expect([again.status, wrong.status]).toEqual([200, 200])
      const [replayed, guessed] = [await readable(again), await readable(wrong)]
      expect(replayed).toBe(guessed)
      expect(replayed).toContain(codeRefused)
      expect(await sessionsOf(rob!)).toHaveLength(1)
      expect(await auditOf(rob!, "auth.magic_link.refused")).toEqual([])
      expect(await requestsOf(rob!)).toEqual([expect.objectContaining({ attempts: 1, ended: true })])
      expect((await query<{ n: number }>`select count(*)::int as n from audit_events where action = 'auth.signin.succeeded' and actor_id in (${await userOf(rita!)}, ${await userOf(rob!)})`)[0]!.n).toBe(2)
      step("10. replay: a used link and a used code each showed the page of a link or a code that is not for this browser, and made no second session")
    })
  })

  // ---- 11: two proofs ----

  /** Meet the directory with no cookie, as a person on another device does, and stop at the page that asks for the mailed code. */
  async function meetDirectory(context: BrowserContext, address: string) {
    const since = Date.now()
    const page = await askAtLogin(context, address)
    await page.getByRole("button", { name: /^Continue with / }).click()
    await page.getByRole("heading", { name: "Connect your company sign-in" }).waitFor()
    return { page, mail: await mailTo(address, since) }
  }
  /** Type a code on the page that connects the directory. */
  async function connect(page: Page, code: string) {
    await page.locator('input[name="code"]').fill(code)
    await page.getByRole("button", { name: "Connect", exact: true }).click()
    await page.waitForLoadState()
  }
  const connectRefused = "We couldn't connect your company sign-in"

  test("11a. a person who signed in by link meets the directory: a code from the mail connects it, and the same user signs in with the same sub; a wrong code and a replay are refused", async () => {
    const proofs = await directoryFirm("proofs", "Proofs Firm")
    const [tester] = await list(proofs, "tester")
    const byLink = await newBrowser()
    const elsewhereBrowser = await newBrowser()
    await onFailure([byLink, elsewhereBrowser], async () => {
      await signInByLink(byLink, tester!)
      const first = (await sessionOf(byLink))!
      await aMinutePasses(tester!)

      const { page, mail } = await meetDirectory(elsewhereBrowser, tester!)
      expect(mail).toMatchObject({ tag: tags.connect, subject: "Your code to connect your company sign-in", link: null })
      expect(await sessionOf(elsewhereBrowser)).toBeNull()
      expect(await accountsOf(tester!)).toEqual([{ issuer: "urn:answerable:magic-link", account_id: tester! }])

      await connect(page, wrongCode(mail.code!))
      expect((await see(page)).heading).toBe(codeRefused)
      expect(await accountsOf(tester!)).toHaveLength(1)
      await connect(page, mail.code!)
      await page.getByRole("heading", { name: "Signed in" }).waitFor()
      const second = (await sessionOf(elsewhereBrowser))!
      expect(second.user).toEqual(first.user)
      expect(second.session.id).not.toBe(first.session.id)
      expect(await query`select 1 from users where email = ${tester}`).toHaveLength(1)
      expect((await accountsOf(tester!)).map(account => account.issuer)).toEqual(["urn:answerable:magic-link", proofs.directory.issuer])
      expect((await sessionsOf(tester!)).map(session => session.kind)).toEqual(["magic_link", "oidc"])
      expect(await query`select 1 from audit_events where action = 'identity.linked' and actor_id = ${first.user.id}`).toHaveLength(1)

      // The code is spent: posted again it is refused, and nothing is connected twice.
      const again = await post("/connect-directory", { code: mail.code! }, elsewhereBrowser)
      expect(await readable(again)).toContain(codeRefused)
      expect(await accountsOf(tester!)).toHaveLength(2)
      expect(await query`select 1 from audit_events where action = 'identity.linked' and actor_id = ${first.user.id}`).toHaveLength(1)
      // The first browser's link session stands beside it.
      expect(await sessionOf(byLink)).toMatchObject({ user: first.user })
      step("11a. two proofs: a wrong code and a replay were refused; the right code connected the directory to the same user, and the directory then signed the same sub in")
    })
  })

  test("11b. the directory changed between the mail and the code: the code is refused with one audit row and connects nothing", async () => {
    const changed = await directoryFirm("proofs-changed", "Changed Firm")
    const [tester] = await list(changed, "tester")
    const context = await newBrowser()
    await onFailure([context], async () => {
      const { page, mail } = await meetDirectory(context, tester!)
      const spare = changed.directory
      await id.admin("PUT", `/organizations/${changed.id}/sso-provider`, {
        issuer: spare.issuer, domain: spare.domain,
        oidc: { credentials: "own", clientId: "replaced", clientSecret: spare.clientSecret, authorizationEndpoint: spare.authorizationEndpoint, tokenEndpoint: spare.tokenEndpoint, jwksEndpoint: spare.jwksEndpoint },
      })
      await connect(page, mail.code!)
      expect((await see(page)).heading).toBe(connectRefused)
      // Posted again, the code is just a code that does not work, and the refusal wrote one row.
      const again = await post("/connect-directory", { code: mail.code! }, context)
      expect(await readable(again)).toContain(codeRefused)
      expect(await accountsOf(tester!)).toEqual([])
      expect(await sessionsOf(tester!)).toEqual([])
      expect(await auditOf(tester!, "auth.magic_link.refused")).toEqual([{ reason: "directory_changed", outcome: "denied" }])
      expect((await requestsOf(tester!)).map(request => [request.purpose, request.ended])).toEqual([["connect_directory", true]])
      step("11b. two proofs: the directory changed after the mail, so the code was refused as directory_changed, once audited, and made no account or session")
    })
  })

  test("11c. the member removed between the mail and the code: the code is refused with one audit row and connects nothing", async () => {
    const stopped = await directoryFirm("proofs-removed", "Stopped Firm")
    const [tester] = await list(stopped, "tester")
    const context = await newBrowser()
    await onFailure([context], async () => {
      const { page, mail } = await meetDirectory(context, tester!)
      await id.admin("DELETE", `/organizations/${stopped.id}/members/${await memberOf(tester!, stopped)}`)
      await connect(page, mail.code!)
      expect((await see(page)).heading).toBe(connectRefused)
      expect(await accountsOf(tester!)).toEqual([])
      expect(await sessionsOf(tester!)).toEqual([])
      // The refusal is `not_connectable`: the person is no longer one this code could connect. `ended` is for a request that ran out of time or tries.
      expect(await auditOf(tester!, "auth.magic_link.refused")).toEqual([{ reason: "not_connectable", outcome: "denied" }])
      step("11c. two proofs: the member was removed after the mail, so the code was refused as not_connectable, once audited, and made no account or session")
    })
  })

  // ---- 12: stopping someone ----

  test("12. users_disable ends a link session, an old link and an old code show access was removed, the next request sends nothing, and the address stays blocked until it is retired", async () => {
    const stopping = await firm("stopping", "Stopping Firm")
    const [sam, sue] = await list(stopping, "sam", "sue")
    const [signed, oldLink, oldCode] = [await newBrowser(), await newBrowser(), await newBrowser()]
    await onFailure([signed, oldLink, oldCode], async () => {
      // Sam is signed in, holds a second link he has not opened, and sue holds a code she has not typed.
      await signInByLink(signed, sam!)
      await aMinutePasses(sam!)
      const links = await ask(oldLink, sam!)
      const linkMail = await mailTo(sam!, links.since)
      const codes = await ask(oldCode, sue!)
      const codeMail = await mailTo(sue!, codes.since)
      const [samId, sueId] = [(await userOf(sam!))!, (await userOf(sue!))!]
      expect(await sessionOf(signed)).toMatchObject({ user: { id: samId } })

      // users.disable is ID's POST /users/{id}/disable.
      for (const user of [samId, sueId]) await id.admin("POST", `/users/${user}/disable`)
      expect(await sessionOf(signed)).toBeNull()
      expect((await see(await open(signed, `${origin}/login`))).heading).toBe("Sign in")
      expect(await sessionsOf(sam!)).toEqual([])
      expect((await see(await continueWith(oldLink, linkMail.link!))).heading).toBe(removed)
      expect((await enterCode(codes.page, codeMail.code!)).heading).toBe(removed)
      expect(await sessionsOf(sue!)).toEqual([])

      // The next request: the uniform page, no mail and no new row. A minute has to pass first, or a limit would be why.
      await aMinutePasses(sam!)
      const asked = (await requestsOf(sam!)).length
      const next = await ask(await newBrowser(), sam!)
      await noMail(sam!, next.since)
      expect(await requestsOf(sam!)).toHaveLength(asked)

      // The address stays blocked: nobody can list it again, and nothing signs in, until staff retire it.
      const blocked = z.object({ items: z.array(z.object({ address: z.string(), outcome: z.string(), reason: z.string().optional() })) }).parse(await id.admin("POST", `/organizations/${stopping.id}/members/import`, { addresses: [sam] }))
      expect(blocked.items).toEqual([{ address: sam, outcome: "refused", reason: "disabled" }])
      await id.admin("POST", `/users/${samId}/retire-email`)
      await list(stopping, "sam")
      const successor = (await userOf(sam!))!
      expect(successor).not.toBe(samId)
      const again = await newBrowser()
      await signInByLink(again, sam!)
      expect(await sessionOf(again)).toMatchObject({ user: { id: successor, email: sam } })
      step("12. stopping: a disabled person lost the link session, an old link and an old code said access was removed, the next request got the short mail, and retiring the address let a new user, with a new id, sign in")
    })
  })
})
