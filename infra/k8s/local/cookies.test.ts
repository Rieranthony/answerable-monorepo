import { describe, expect, test } from "bun:test"
import { type BrowserCookie, sessionCookieProblems, signInCookieProblems } from "./cookies"

const host = "id.127-0-0-1.sslip.io"
const now = 1_800_000_000

const signIn = (change: Partial<BrowserCookie> = {}): BrowserCookie => ({ name: "__Host-answerable-sign-in", value: "x", domain: host, path: "/", expires: now + 600, httpOnly: true, secure: true, sameSite: "Lax", ...change })
const session = (change: Partial<BrowserCookie> = {}): BrowserCookie => ({ name: "__Secure-better-auth.session_token", value: "x", domain: host, path: "/", expires: now + 24 * 3600, httpOnly: true, secure: true, sameSite: "Lax", ...change })

describe("the sign-in cookie", () => {
  test("is right when it is __Host-answerable-sign-in, Secure, HttpOnly, Lax, path /, host-only and ten minutes long", () => {
    expect(signInCookieProblems([signIn()], host, now)).toEqual([])
    expect(signInCookieProblems([signIn({ expires: now + 605 }), session()], host, now)).toEqual([])
  })

  test("is wrong in each attribute that differs, and says which", () => {
    expect(signInCookieProblems([signIn({ secure: false })], host, now)).toEqual(["__Host-answerable-sign-in lacks Secure"])
    expect(signInCookieProblems([signIn({ httpOnly: false })], host, now)).toEqual(["__Host-answerable-sign-in lacks HttpOnly"])
    expect(signInCookieProblems([signIn({ sameSite: "Strict" })], host, now)).toEqual(["__Host-answerable-sign-in is SameSite=Strict, not Lax"])
    expect(signInCookieProblems([signIn({ sameSite: "None" })], host, now)).toEqual(["__Host-answerable-sign-in is SameSite=None, not Lax"])
    expect(signInCookieProblems([signIn({ path: "/login" })], host, now)).toEqual(["__Host-answerable-sign-in has path /login, not /"])
    expect(signInCookieProblems([signIn({ domain: `.${host}` })], host, now)).toEqual([`__Host-answerable-sign-in is for .${host}, not the host alone (${host})`])
    expect(signInCookieProblems([signIn({ expires: now + 3600 })], host, now)).toEqual([`__Host-answerable-sign-in expires at ${now + 3600}, not within 600 s of ${now}`])
    expect(signInCookieProblems([signIn({ expires: now - 1 })], host, now)).toEqual([`__Host-answerable-sign-in expires at ${now - 1}, not within 600 s of ${now}`])
    // A session cookie with no expiry (-1) is not the ten minutes ID sets.
    expect(signInCookieProblems([signIn({ expires: -1 })], host, now)).toHaveLength(1)
  })

  test("is wrong when absent, when twice, or when the name for plain http is there instead or as well", () => {
    expect(signInCookieProblems([], host, now)).toEqual(["0 cookies are named __Host-answerable-sign-in, not one"])
    expect(signInCookieProblems([signIn(), signIn()], host, now)).toEqual(["2 cookies are named __Host-answerable-sign-in, not one"])
    expect(signInCookieProblems([signIn({ name: "answerable-sign-in" })], host, now)).toEqual([
      "0 cookies are named __Host-answerable-sign-in, not one",
      "answerable-sign-in, the name for plain http, is set on https",
    ])
    expect(signInCookieProblems([signIn(), signIn({ name: "answerable-sign-in" })], host, now)).toEqual(["answerable-sign-in, the name for plain http, is set on https"])
  })
})

describe("the session cookie", () => {
  test("is right when it is __Secure-better-auth.session_token, Secure, HttpOnly, Lax, path /, host-only and at most a week", () => {
    expect(sessionCookieProblems([session()], host, now)).toEqual([])
    expect(sessionCookieProblems([session({ expires: now + 7 * 24 * 3600 }), signIn()], host, now)).toEqual([])
  })

  test("is wrong in each attribute that differs, and says which", () => {
    const name = "__Secure-better-auth.session_token"
    expect(sessionCookieProblems([session({ secure: false })], host, now)).toEqual([`${name} lacks Secure`])
    expect(sessionCookieProblems([session({ httpOnly: false })], host, now)).toEqual([`${name} lacks HttpOnly`])
    expect(sessionCookieProblems([session({ sameSite: "None" })], host, now)).toEqual([`${name} is SameSite=None, not Lax`])
    expect(sessionCookieProblems([session({ path: "/auth" })], host, now)).toEqual([`${name} has path /auth, not /`])
    expect(sessionCookieProblems([session({ domain: `.${host}` })], host, now)).toEqual([`${name} is for .${host}, not the host alone (${host})`])
    expect(sessionCookieProblems([session({ expires: now + 8 * 24 * 3600 })], host, now)).toHaveLength(1)
  })

  test("is wrong when absent, or when the name for plain http is there instead", () => {
    expect(sessionCookieProblems([], host, now)).toEqual(["0 cookies are named __Secure-better-auth.session_token, not one"])
    expect(sessionCookieProblems([session({ name: "better-auth.session_token" })], host, now)).toEqual([
      "0 cookies are named __Secure-better-auth.session_token, not one",
      "better-auth.session_token, the name for plain http, is set on https",
    ])
  })
})
