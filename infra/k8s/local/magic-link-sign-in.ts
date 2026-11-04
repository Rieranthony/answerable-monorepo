// The kind stack's proof that a person signs in by a link and a code, and that a person with a link's account meets a directory, in real Chromium over
// https through Traefik, in a process of its own for the reason sign-in.ts gives: `bun infra/k8s/local/magic-link-sign-in.ts`, with its input as JSON on
// standard input and its result as JSON on the last line of standard output. stack.test.ts runs it and asserts on the result.
//
// Three people, each in the browser they would use. Grace, at a firm with a directory and links: the choice page, a link from the fake Postmark's mail,
// opened in the browser that asked, signed in. Bob, at a firm with links alone: the same link opened in a second browser signs nobody in, the code from the
// same mail typed where he asked signs him in, and the link then no longer works. Ada, at the firm with both, who signed in by a link first: the directory
// refuses her address as one that someone holds, ID mails a code, she enters it, and the directory then signs her in. The cookies are read from the browser
// and handed back whole; stack.test.ts holds them to `cookies.ts`.
import { chromium, type BrowserContext, type Page } from "@playwright/test"
import { readMail } from "@answerable/acceptance"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { hosts, origin, startBrowserEdge } from "./stack"
import type { BrowserCookie } from "./cookies"

/** What stack.test.ts hands over: the people, the fake Postmark's inbox, where to keep screenshots, and the stack's certificates. */
export type MagicLinkSignInInput = {
  /** A member of the firm with a directory and links, who has no account yet. */
  grace: string
  /** A member of the firm with links alone. */
  bob: string
  /** A member of the firm with a directory and links, whom the directory knows: she signs in by a link first. */
  ada: string
  /** The label of the directory's button on the choice page, such as "company sign-in". */
  directoryName: string
  postmark: { inbox: string; token: string }
  /** Where to write a PNG of each page, or nothing. */
  screenshots?: string
  stackCa: string
  originPullCert: { cert: string; key: string }
  edgeCert: { cert: string; key: string }
}

/** What a session shows at `/auth/get-session`: the person it is for, or nothing. */
type Session = { user: { email: string } } | null

/** What one page showed. */
type Seen = { heading: string; buttons: string[]; text: string }

const input = JSON.parse(await Bun.stdin.text()) as MagicLinkSignInInput

const idOrigin = origin(hosts.id)
const host = hosts.id
const tls = { ca: input.stackCa }

// The pages and the fake Postmark's inbox take the stack's CA.
const edge = startBrowserEdge({ stackCa: input.stackCa, originPullCert: input.originPullCert, serverCert: input.edgeCert })
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${edge.hostResolverRules}`] })
const problems: string[] = []

/** A browser of its own: its own cookies, as a person's phone or a second browser has. */
async function newBrowser() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  context.on("page", page => {
    page.on("console", message => message.type() === "error" && problems.push(`console error on ${new URL(page.url()).pathname}: ${message.text()}`))
    page.on("response", response => response.status() >= 500 && problems.push(`${response.status()} from ${new URL(response.url()).pathname}`))
  })
  return context
}

const cookiesOf = async (context: BrowserContext) => (await context.cookies(idOrigin)) as BrowserCookie[]

/**
 * The session this browser holds, asked of ID by opening `/auth/get-session` in a tab, with the browser's cookies. ID's pages allow a page no `fetch`
 * (`default-src 'none'`), so the page cannot ask for itself.
 */
async function sessionOf(context: BrowserContext) {
  const page = await context.newPage()
  try {
    await page.goto(`${idOrigin}/auth/get-session`)
    return JSON.parse(await page.locator("body").innerText()) as Session
  } finally {
    await page.close()
  }
}

/** What a page shows: its heading, the names of its buttons and its text. */
async function see(page: Page): Promise<Seen> {
  const heading = await page.getByRole("heading", { level: 1 }).first().innerText()
  const buttons = await page.getByRole("button").allInnerTexts()
  return { heading, buttons: buttons.map(name => name.trim()), text: await page.locator("main, body").first().innerText() }
}

let shots = 0
async function shoot(page: Page, name: string) {
  if (!input.screenshots) return
  mkdirSync(input.screenshots, { recursive: true })
  await page.screenshot({ path: join(input.screenshots, `${String(++shots).padStart(2, "0")}-${name}.png`), fullPage: true })
}

/** The first email to `to` that arrived after `after` (milliseconds), read from the fake Postmark's inbox as a process of its own must. */
async function mailTo(to: string, after = 0) {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await Bun.sleep(250)) {
    const response = await fetch(`${input.postmark.inbox}?to=${encodeURIComponent(to)}`, { headers: { "X-Postmark-Server-Token": input.postmark.token }, tls })
    const kept = (await response.json()) as { subject: string; text: string; from: string; receivedAt: number; tag: string | null }[]
    const found = kept.find(mail => mail.receivedAt > after)
    if (found) return { ...found, ...readMail(found) }
  }
  throw new Error(`No email to ${to} reached the fake Postmark within 30 s`)
}

/** Ask for a link from the sign-in form, as a person does, and answer what the next page was. */
async function startAtLogin(page: Page, email: string) {
  await page.goto(`${idOrigin}/login`)
  await page.getByLabel(/email/i).fill(email)
  await page.getByRole("button", { name: "Continue", exact: true }).click()
}

try {
  // Ada first, so that her link's request is a minute old by the time she meets her directory: the one-minute limit per address is shared.
  const adaBrowser = await newBrowser()
  const adaPage = await adaBrowser.newPage()
  await startAtLogin(adaPage, input.ada)
  await adaPage.getByRole("button", { name: "Email me a sign-in link" }).click()
  await adaPage.getByRole("heading", { name: "Check your email" }).waitFor()
  const adaAsked = Date.now()
  const adaMail = await mailTo(input.ada)
  const adaLink = await adaBrowser.newPage()
  await adaLink.goto(adaMail.link!)
  await adaLink.getByRole("button", { name: "Continue", exact: true }).click()
  await adaLink.getByRole("heading", { name: "Signed in" }).waitFor()
  const adaFirst = { session: await sessionOf(adaBrowser), cookies: await cookiesOf(adaBrowser) }

  // Grace: the choice page, the check-your-email page, the link in the browser that asked.
  const graceBrowser = await newBrowser()
  const gracePage = await graceBrowser.newPage()
  await startAtLogin(gracePage, input.grace)
  await gracePage.getByRole("button", { name: "Email me a sign-in link" }).waitFor()
  const choice = await see(gracePage)
  await shoot(gracePage, "grace-choice-page")
  await gracePage.getByRole("button", { name: "Email me a sign-in link" }).click()
  await gracePage.getByRole("heading", { name: "Check your email" }).waitFor()
  await shoot(gracePage, "grace-check-your-email")
  const checkEmail = await see(gracePage)
  const graceAsked = await cookiesOf(graceBrowser)
  const graceMail = await mailTo(input.grace)
  // The mail client opens the link in a tab of the same browser.
  const graceLink = await graceBrowser.newPage()
  await graceLink.goto(graceMail.link!)
  await graceLink.getByRole("button", { name: "Continue", exact: true }).waitFor()
  const continuePage = await see(graceLink)
  await shoot(graceLink, "grace-link-continue")
  await graceLink.getByRole("button", { name: "Continue", exact: true }).click()
  await graceLink.getByRole("heading", { name: "Signed in" }).waitFor()
  await shoot(graceLink, "grace-signed-in")
  const graceSignedIn = await see(graceLink)
  const grace = { choice, checkEmail, mail: { subject: graceMail.subject, from: graceMail.from, tag: graceMail.tag, hasCode: graceMail.code !== null }, continuePage, signedIn: graceSignedIn, cookiesAsked: graceAsked, cookies: await cookiesOf(graceBrowser), session: await sessionOf(graceBrowser) }

  // Bob: the link opened in a second browser signs nobody in; the code from the same mail, typed where he asked, does; the link then no longer works.
  const bobFirst = await newBrowser()
  const bobPage = await bobFirst.newPage()
  await startAtLogin(bobPage, input.bob)
  await bobPage.getByRole("heading", { name: "Check your email" }).waitFor()
  await shoot(bobPage, "bob-check-your-email")
  const bobMail = await mailTo(input.bob)
  const bobSecond = await newBrowser()
  const elsewhere = await bobSecond.newPage()
  await elsewhere.goto(bobMail.link!)
  await elsewhere.getByRole("link", { name: "Ask for a new link" }).waitFor()
  await shoot(elsewhere, "bob-link-in-a-second-browser")
  const second = { page: await see(elsewhere), cookies: await cookiesOf(bobSecond), session: await sessionOf(bobSecond) }
  await bobPage.getByLabel("Code").fill(bobMail.code!)
  await bobPage.getByRole("button", { name: "Sign in", exact: true }).click()
  await bobPage.getByRole("heading", { name: "Signed in" }).waitFor()
  await shoot(bobPage, "bob-signed-in-by-code")
  const bobSignedIn = { page: await see(bobPage), cookies: await cookiesOf(bobFirst), session: await sessionOf(bobFirst) }
  // The same link, now, in the browser that holds the cookie.
  const used = await bobFirst.newPage()
  await used.goto(bobMail.link!)
  await used.getByRole("link", { name: "Ask for a new link" }).waitFor()
  await shoot(used, "bob-link-after-the-code")
  const linkAfter = { page: await see(used) }
  const bob = { mail: { subject: bobMail.subject, from: bobMail.from }, second, signedIn: bobSignedIn, linkAfter }

  // Ada meets her directory in a browser with no cookie at all, once her link is a minute old.
  const wait = adaAsked + 62_000 - Date.now()
  if (wait > 0) await Bun.sleep(wait)
  const connectBrowser = await newBrowser()
  const connectPage = await connectBrowser.newPage()
  const callbacks: { path: string; status: number; setCookie: string[] }[] = []
  connectPage.on("response", async response => {
    const path = new URL(response.url()).pathname
    if (path.includes("/callback")) callbacks.push({ path, status: response.status(), setCookie: (await response.headersArray()).filter(header => header.name.toLowerCase() === "set-cookie").map(header => header.value.split("=")[0]!) })
  })
  const before = await cookiesOf(connectBrowser)
  await startAtLogin(connectPage, input.ada)
  await connectPage.getByRole("button", { name: `Continue with ${input.directoryName}` }).click()
  await connectPage.getByRole("heading", { name: "Connect your company sign-in" }).waitFor({ timeout: 60_000 })
  await shoot(connectPage, "ada-connect-your-company-sign-in")
  const connect = await see(connectPage)
  const atConnect = await cookiesOf(connectBrowser)
  const codeMail = await mailTo(input.ada, adaMail.receivedAt)
  await connectPage.getByLabel("Code").fill(codeMail.code!)
  await connectPage.getByRole("button", { name: "Connect", exact: true }).click()
  await connectPage.getByRole("heading", { name: "Signed in" }).waitFor({ timeout: 60_000 })
  await shoot(connectPage, "ada-signed-in-by-the-directory")
  const ada = {
    first: adaFirst,
    cookiesBefore: before,
    callbacks,
    connect,
    cookiesAtConnect: atConnect,
    mail: { subject: codeMail.subject, from: codeMail.from, tag: codeMail.tag, hasLink: codeMail.link !== null },
    signedIn: await see(connectPage),
    cookies: await cookiesOf(connectBrowser),
    session: await sessionOf(connectBrowser),
  }
  console.log(JSON.stringify({ host, finishedAt: Date.now() / 1000, grace, bob, ada, problems }))
} finally {
  await browser.close()
  edge.stop()
}
process.exit(0)
