/** A cookie as Playwright's `context.cookies()` reads it from Chromium. */
export type BrowserCookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None" }

/** What a cookie ID sets must be on https: its exact name, `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`, no `Domain` (host-only), and a lifetime of at most `maxAgeSeconds`. */
function problemsOf(cookies: BrowserCookie[], host: string, name: string, maxAgeSeconds: number, now: number) {
  const found = cookies.filter(cookie => cookie.name === name)
  if (found.length !== 1) return [`${found.length} cookies are named ${name}, not one`]
  const cookie = found[0]!
  const problems: string[] = []
  if (!cookie.secure) problems.push(`${name} lacks Secure`)
  if (!cookie.httpOnly) problems.push(`${name} lacks HttpOnly`)
  if (cookie.sameSite !== "Lax") problems.push(`${name} is SameSite=${cookie.sameSite}, not Lax`)
  if (cookie.path !== "/") problems.push(`${name} has path ${cookie.path}, not /`)
  // A host-only cookie has no leading dot in the domain; a Domain attribute would give it one.
  if (cookie.domain !== host) problems.push(`${name} is for ${cookie.domain}, not the host alone (${host})`)
  if (!(cookie.expires > now && cookie.expires <= now + maxAgeSeconds + 5)) problems.push(`${name} expires at ${cookie.expires}, not within ${maxAgeSeconds} s of ${now}`)
  return problems
}

/**
 * What is wrong with the sign-in cookie in what a browser holds for ID's host, over https: `__Host-answerable-sign-in`, once, `Secure`, `HttpOnly`,
 * `SameSite=Lax`, path `/`, host-only, for 10 minutes at most; and no `answerable-sign-in`, the name ID uses on plain http. Empty when it is right.
 */
export function signInCookieProblems(cookies: BrowserCookie[], host: string, now = Date.now() / 1000) {
  const plain = cookies.filter(cookie => cookie.name === "answerable-sign-in").map(() => "answerable-sign-in, the name for plain http, is set on https")
  return [...problemsOf(cookies, host, "__Host-answerable-sign-in", 600, now), ...plain]
}

/**
 * What is wrong with the session cookie: Better Auth's, which on https carries the `__Secure-` prefix (`__Secure-better-auth.session_token`), once,
 * `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`, host-only, for the 7 days the session lasts at most.
 */
export function sessionCookieProblems(cookies: BrowserCookie[], host: string, now = Date.now() / 1000) {
  const plain = cookies.filter(cookie => cookie.name === "better-auth.session_token").map(() => "better-auth.session_token, the name for plain http, is set on https")
  return [...problemsOf(cookies, host, "__Secure-better-auth.session_token", 7 * 24 * 3600, now), ...plain]
}
