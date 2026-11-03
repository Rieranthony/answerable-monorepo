import { randomBytes } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";

import { magicLinkTtlMinutes } from "../../auth/magic-link.ts";
import type { PageContext } from "./gateway.ts";

/** Thirty-two random bytes, base64url. Anything else is not ID's and is replaced. */
const value = /^[A-Za-z0-9_-]{43}$/;

/** What ties a sign-in to one browser. `__Host-` needs `Secure`, and `Secure` needs https, so
 * a plain http origin, as in local development and the test fixture, drops both, here only. */
function cookieFor(context: PageContext) {
  const secure =
    new URL(context.get("environment").betterAuthUrl).protocol === "https:";
  return {
    name: secure ? "__Host-answerable-sign-in" : "answerable-sign-in",
    secure,
  };
}

/** The browser's sign-in value, when it holds one of ID's. */
export function readSignInCookie(context: PageContext) {
  const held = getCookie(context, cookieFor(context).name);
  return held !== undefined && value.test(held) ? held : null;
}

/**
 * Keep this browser's value and renew it, or give it one. A reload keeps its flow, and the
 * cookie outlives the newest link. `SameSite=Lax` and not `Strict`, or a link opened from a
 * mail client arrives without it.
 */
export function holdSignInCookie(context: PageContext) {
  const browser =
    readSignInCookie(context) ?? randomBytes(32).toString("base64url");
  const { name, secure } = cookieFor(context);
  setCookie(context, name, browser, {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "Lax",
    maxAge: magicLinkTtlMinutes * 60,
  });
  return browser;
}
